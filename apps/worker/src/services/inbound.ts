import { EXTERNAL_MESSAGE_MAX_BYTES } from '@hpc-mail/shared';
import PostalMime from 'postal-mime';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments as attachmentsTable, messages } from '../db/schema.js';
import { getEmailDomain, getNameFromEmail, normalizeEmail } from '../lib/email-address.js';
import { encodeBodyBase64, foldBase64, sanitizeFilename, sanitizeMimeType } from '../lib/mime.js';
import { htmlToText, makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { extractCodeByAi, extractCodeByRegex } from './code-extract.js';
import { sendFeishuNotification } from './feishu.js';
import { resolveNotifyOwnerIds } from './mailbox.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { getSettings } from './setting.js';
import { sendNotifyWebhook } from './webhook-notify.js';
import { attachmentKey, bodyKey, getExt, putJson, putObject, sha256Hex16 } from './storage.js';

/** 单个收件地址每日可触发的转发上限（防「1 进 N 出」放大式滥用） */
const DAILY_FORWARD_LIMIT = 200;
/** 转发计数类别（rate_counters.scope） */
const FORWARD_SCOPE = 'fwd';

const D1_BODY_LIMIT = 256 * 1024;
const TRUNCATE_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLen(s: string): number {
  return encoder.encode(s).length;
}

/**
 * 按**字节**截断（此前用 String.slice 按 UTF-16 码元截，中文一个字符 3 字节，
 * 「64KB 截断」实际能写进 D1 近 192KB，text+html 合计约 384KB——远超设计值）。
 * TextDecoder 的 fatal:false 会把末尾截断的多字节序列替换成 U+FFFD，不会产生非法字符串。
 */
function truncateBytes(s: string, maxBytes: number): string {
  const bytes = encoder.encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  return decoder.decode(bytes.subarray(0, maxBytes));
}

interface ParsedAttachment {
  seq: number;
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
  size: number;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);

interface RelayMail {
  fromAddress: string;
  fromName: string;
  toAddress: string;
  domain: string;
  subject: string;
  text: string;
  html: string;
  attachments: ParsedAttachment[];
}

/**
 * 中转转发：原生 forward() 仅对 Email Routing 已验证 destination 生效，目标未验证时
 * 降级为 send_email binding 以 no-reply@收件域名 重新打包发送——保留原始标题/正文/附件，
 * Reply-To 指回原发件人，正文顶部加转发元信息块。
 */
async function relayForward(env: Env, target: string, mail: RelayMail): Promise<void> {
  // 动态 import：`cloudflare:email`/`mimetext` 静态加载会让 vitest 的 workerd 崩（同 outbound.ts）
  const [{ EmailMessage }, { createMimeMessage, Mailbox }] = await Promise.all([
    import('cloudflare:email'),
    import('mimetext/browser'),
  ]);
  const sender = `no-reply@${mail.domain}`;
  const origin = mail.fromName ? `${mail.fromName} <${mail.fromAddress}>` : mail.fromAddress;
  const metaLines = [
    `原始发件人: ${origin}`,
    `原收件地址: ${mail.toAddress}`,
    '直接回复本邮件将发送给原始发件人。',
  ];

  // send_email 对单封邮件有硬限（EXTERNAL_MESSAGE_MAX_BYTES 是留了余量的阈值）。
  // 此前这里把附件无条件全塞进 MIME，超限时 send 直接抛错、调用方只打一行 console.error，
  // 结果是「转发静默丢失」——用户以为压根没收到这封信。超限就改为不带附件并在正文说明。
  const bodyBytes = new TextEncoder().encode(mail.text + mail.html).length;
  const attachmentBytes = mail.attachments.reduce(
    (sum, a) => sum + Math.ceil((a.content.byteLength * 4) / 3),
    0,
  );
  const dropAttachments =
    mail.attachments.length > 0 && bodyBytes + attachmentBytes > EXTERNAL_MESSAGE_MAX_BYTES;
  if (dropAttachments) {
    const totalMb = (mail.attachments.reduce((s, a) => s + a.content.byteLength, 0) / 1024 / 1024).toFixed(1);
    metaLines.push(
      `注意：原邮件的 ${mail.attachments.length} 个附件（共 ${totalMb} MB）超出转发大小限制，未随本信转发，请登录 https://${mail.domain} 查看下载。`,
    );
  }

  const msg = createMimeMessage();
  msg.setSender({ name: `${mail.fromName || mail.fromAddress} (via HPC Mail)`, addr: sender });
  msg.setRecipient(target);
  msg.setSubject(mail.subject || '(无主题)');
  msg.setHeader('X-HPC-Mail-Relay', '1');
  // mimetext 对 Reply-To 这类已知头校验值类型，必须传 Mailbox 对象（传字符串会抛错）
  if (mail.fromAddress) msg.setHeader('Reply-To', new Mailbox(mail.fromAddress));
  msg.addMessage({
    contentType: 'text/plain',
    charset: 'UTF-8',
    encoding: 'base64',
    data: encodeBodyBase64(
      `———— HPC Mail 转发 ————\n${metaLines.join('\n')}\n————————————————\n\n${mail.text || htmlToText(mail.html)}`,
    ),
  });
  if (mail.html) {
    const metaHtml =
      '<div style="margin:0 0 16px;padding:10px 14px;border-left:3px solid #8b8fa3;background:#f5f6f8;color:#4b4f5c;font-size:12px;line-height:1.9">' +
      '<div style="font-weight:600">HPC Mail 转发</div>' +
      metaLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') +
      '</div>';
    msg.addMessage({
      contentType: 'text/html',
      charset: 'UTF-8',
      encoding: 'base64',
      data: encodeBodyBase64(metaHtml + mail.html),
    });
  }
  if (!dropAttachments) {
    for (const a of mail.attachments) {
      // 折行成 76 字符/行：不折行时整个附件是一整行，超 SMTP 998 字节行限会被下游 MTA 拒收。
      // filename/mimeType 必须清洗：它们来自站外发件人，而 mimetext 是裸拼进头的
      msg.addAttachment({
        filename: sanitizeFilename(a.filename),
        contentType: sanitizeMimeType(a.mimeType),
        data: foldBase64(uint8ToBase64(a.content)),
      });
    }
  }
  await env.email.send(new EmailMessage(sender, target, msg.asRaw()));
}

/**
 * 收件链路：解析 → 提码 → 正文分层/附件落 R2 → 落库 → 同步邮箱转发（原生 forward 优先，
 * 未验证目标降级中转）→ waitUntil(AI 兜底 + 飞书)。仅落库失败 throw（触发 SMTP 重试）。
 */
export async function handleInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecCtx,
): Promise<void> {
  const settings = await getSettings(env);

  // 先缓冲原始 .eml（stream 只能读一次），解析用缓冲区；同时存档到 R2 供下载/排查 DKIM。
  // 存档在解析**之前**：畸形 MIME 解析失败时也要留下原文
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  let rawR2Key: string | null = null;
  try {
    const key = `raw/${crypto.randomUUID().replace(/-/g, '')}.eml`;
    await env.r2.put(key, rawBytes, { httpMetadata: { contentType: 'message/rfc822' } });
    rawR2Key = key;
  } catch (e) {
    console.error('原始邮件存档失败:', e);
  }

  // 解析失败降级为最小记录，不再 throw：抛出去会让 SMTP 一直重投直到超时退信，
  // 这封信一次都进不了库，管理员看不到任何痕迹。原文已在 R2，可下载排查
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(rawBytes);
  } catch (e) {
    console.error('MIME 解析失败，按最小记录落库:', e);
    email = {
      from: { address: '', name: '' },
      to: [],
      cc: [],
      bcc: [],
      subject: '(邮件解析失败)',
      text: '原始邮件无法解析，请下载 .eml 原文查看。',
      html: '',
      attachments: [],
      headers: [],
    } as unknown as Awaited<ReturnType<typeof PostalMime.parse>>;
  }

  const toAddress = normalizeEmail(message.to);
  const domain = getEmailDomain(toAddress);
  const fromAddress = normalizeEmail(email.from?.address);
  const fromName = (email.from?.name || getNameFromEmail(fromAddress)).trim();

  const mapAddrs = (list: { address?: string }[] | undefined): string[] =>
    (list ?? []).map((x) => normalizeEmail(x.address)).filter(Boolean);
  const toList = mapAddrs(email.to);
  const recipients = {
    to: toList.length ? toList : [toAddress],
    cc: mapAddrs(email.cc),
    bcc: mapAddrs(email.bcc),
  };

  const subject = email.subject || '';
  const text = email.text || '';
  const html = email.html || '';

  // 同步正则提码
  let code = '';
  if (settings.code_extract.enabled) {
    code = extractCodeByRegex(subject, text || htmlToText(html));
  }

  // 附件落 R2 前先算内容
  const parsedAttachments: ParsedAttachment[] = (email.attachments ?? []).map((att, seq) => {
    const raw = att.content as string | ArrayBuffer;
    const content = typeof raw === 'string' ? encoder.encode(raw) : new Uint8Array(raw);
    return {
      seq,
      content,
      filename: att.filename || 'download',
      mimeType: att.mimeType || 'application/octet-stream',
      contentId: (att.contentId || '').replace(/^<|>$/g, ''),
      disposition: att.disposition === 'inline' ? 'inline' : 'attachment',
      size: content.byteLength,
    };
  });
  const attachmentsSize = parsedAttachments.reduce((sum, a) => sum + a.size, 0);

  // 正文分层：>256KB 存 64KB 截断 + 完整 JSON 落 R2
  let bodyText = text;
  let bodyHtml = html;
  let bodyR2Key: string | null = null;
  if (byteLen(text) + byteLen(html) > D1_BODY_LIMIT) {
    const key = bodyKey();
    try {
      await putJson(env, key, { text, html });
      bodyR2Key = key;
    } catch (e) {
      console.error('正文溢出落 R2 失败，降级仅存截断:', e);
    }
    bodyText = truncateBytes(text, TRUNCATE_BYTES);
    bodyHtml = truncateBytes(html, TRUNCATE_BYTES);
  }

  const preview = makePreview(text, html);
  const size = byteLen(text) + byteLen(html) + attachmentsSize;

  const db = createDb(env);
  // 消息落库：失败向上抛出触发 SMTP 重试
  const inserted = await db
    .insert(messages)
    .values({
      direction: 'inbound',
      address: toAddress,
      domain,
      fromAddress,
      fromName,
      recipients,
      subject,
      preview,
      bodyText,
      bodyHtml,
      bodyR2Key,
      rawR2Key,
      verificationCode: code,
      messageId: email.messageId ?? null,
      inReplyTo: email.inReplyTo ?? null,
      status: 'received',
      isRead: false,
      size,
      createdAt: new Date(),
    })
    .returning({ id: messages.id })
    .get();
  const messageId = inserted!.id;

  // 附件上传 + 落库（best-effort，不阻断收件成功）
  if (parsedAttachments.length) {
    try {
      const rows = [];
      for (const att of parsedAttachments) {
        const hash16 = await sha256Hex16(att.content);
        const key = attachmentKey(messageId, att.seq, hash16, getExt(att.filename));
        await putObject(env, key, att.content, att.mimeType);
        rows.push({
          messageId,
          r2Key: key,
          filename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
          contentId: att.contentId,
          disposition: att.disposition,
        });
      }
      await db.insert(attachmentsTable).values(rows);
    } catch (e) {
      console.error('附件入库失败:', e);
    }
  }

  // 归属解析：收件地址所属用户 → 其个人偏好；未认领地址归全部管理员，按各自个人偏好处理。
  // 整体 try/catch：这几个调用都在 D1 落库**之后**，结果只用于转发/通知。裸 await 的话
  // 一次 D1 读超时就会让 handler reject → SMTP 重投 → 上一轮已成功的 insert 变成重复入库
  // （同一封信在收件箱里出现多份，验证码邮件尤其容易误判）。约定是只有落库失败才 throw。
  let ownerPrefs: Awaited<ReturnType<typeof getUserNotifyPrefs>>[] = [];
  try {
    const ownerIds = await resolveNotifyOwnerIds(env, toAddress);
    ownerPrefs = await Promise.all(ownerIds.map((id) => getUserNotifyPrefs(env, id)));
  } catch (e) {
    console.error('归属/通知偏好解析失败，跳过转发与通知（邮件已入库）:', e);
  }

  // 同步邮箱转发（按 owner 的个人转发目标，去重；逐地址 try/catch）
  // 已验证 destination 走原生 forward()（原样转发，保留原始邮件头/签名）；
  // 未验证目标 forward() 会抛错，降级 relayForward 中转重发，任意外部邮箱均可送达。
  // 防环路：中转副本带 X-HPC-Mail-Relay 头，再次入站不重复转发；目标为收件地址自身时跳过。
  const isRelayedCopy = message.headers.get('x-hpc-mail-relay') !== null;
  const forwardTargets = isRelayedCopy
    ? []
    : [
        ...new Set(ownerPrefs.filter((p) => p.forward.enabled).flatMap((p) => p.forward.addresses)),
      ].filter((t) => normalizeEmail(t) !== toAddress);
  // 转发是一条无需登录即可触发的外发通道：任何人往公开域名的地址群发，每封都会被以
  // 我们的域名重新投递给最多 5 个目标（1 进 5 出的放大器，烧的是发件域名信誉）。
  // 外发配额只管 sendMail，这里补一个按收件地址计的日上限。
  const relayWindow = dayWindow();
  for (const target of forwardTargets) {
    let quotaOk = true;
    try {
      const used = await bumpCounter(env, FORWARD_SCOPE, toAddress, relayWindow, 1);
      quotaOk = used.count <= DAILY_FORWARD_LIMIT;
    } catch (e) {
      // 计数失败不阻断转发（可用性优先），但要留痕
      console.error('转发配额计数失败，本次放行:', e);
    }
    if (!quotaOk) {
      console.warn(`转发到 ${target} 跳过：${toAddress} 今日转发已达 ${DAILY_FORWARD_LIMIT} 封上限`);
      continue;
    }
    try {
      await message.forward(target);
    } catch (forwardErr) {
      try {
        await relayForward(env, target, {
          fromAddress,
          fromName,
          toAddress,
          domain,
          subject,
          text,
          html,
          attachments: parsedAttachments,
        });
      } catch (relayErr) {
        console.error(`转发到 ${target} 失败（原生 forward 与中转均未成功）:`, forwardErr, relayErr);
      }
    }
  }

  // 异步后处理：AI 兜底提码 + 按 owner 个人偏好的飞书/通用 webhook（各自 try/catch 隔离）
  ctx.waitUntil(
    (async () => {
      let finalCode = code;
      if (!finalCode && settings.code_extract.enabled && settings.code_extract.aiEnabled) {
        try {
          const aiCode = await extractCodeByAi(env, { subject, text, html });
          if (aiCode) {
            finalCode = aiCode;
            await db
              .update(messages)
              .set({ verificationCode: aiCode })
              .where(eq(messages.id, messageId));
          }
        } catch (e) {
          console.error('AI 提码失败:', e);
        }
      }
      for (const prefs of ownerPrefs) {
        try {
          await sendFeishuNotification(prefs.feishu, {
            subject,
            fromAddress,
            fromName,
            toAddress,
            code: finalCode,
            body: text || htmlToText(html),
          });
        } catch (e) {
          console.error('飞书通知失败:', e);
        }
        try {
          await sendNotifyWebhook(prefs.webhook, {
            event: 'mail.received',
            message: {
              id: messageId,
              address: toAddress,
              fromAddress,
              fromName,
              subject,
              verificationCode: finalCode,
              preview,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (e) {
          console.error('通用 webhook 失败:', e);
        }
      }
    })(),
  );
}
