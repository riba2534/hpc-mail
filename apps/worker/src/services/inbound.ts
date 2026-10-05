import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '@hpc-mail/shared';
import PostalMime, { type Address } from 'postal-mime';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { attachments as attachmentsTable, messages } from '../db/schema.js';
import { getEmailDomain, getNameFromEmail, normalizeEmail } from '../lib/email-address.js';
import { sha256Hex } from '../lib/crypto.js';
import { htmlToText, makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { extractCodeByAi, extractCodeByRegex } from './code-extract.js';
import { resolveNotifyOwnerIds } from './mailbox.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
import { getSettings } from './setting.js';
import { bodyBytes, storeMailBody } from './mail-body.js';
import { forwardReceivedMail } from './forwarding.js';
import { enqueueMailNotifications } from './notification-jobs.js';
import { attachmentKey, getExt, putObject, sha256Hex16 } from './storage.js';

/** 未认领 catch-all 转发必须按稳定主体限额，不能让随机 local-part 刷新额度。 */
const DAILY_AI_EXTRACT_LIMIT = 500;

const encoder = new TextEncoder();

interface ParsedAttachment {
  seq: number;
  content: Uint8Array;
  filename: string;
  mimeType: string;
  contentId: string;
  disposition: string;
  size: number;
}

/**
 * 收件链路：解析 → 提码 → 正文分层/附件落 R2 → 落库 → 同步邮箱转发（原生 forward 优先，
 * 未验证目标降级中转）→ waitUntil(AI 兜底 + 通知队列)。正文/附件未完整保存则 SMTP 重试。
 */
export async function handleInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecCtx,
): Promise<void> {
  const settings = await getSettings(env);

  // 先缓冲原始 .eml（stream 只能读一次），解析与幂等摘要共用这一份字节。
  const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const rawDigest = await sha256Hex(rawBytes);

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
  const fromName = (email.from?.name || getNameFromEmail(fromAddress)).trim().slice(0, 512);

  const mapAddrs = (list: Address[] | undefined): string[] =>
    [...new Set((list ?? []).flatMap(item => item.group ?? [item])
      .map(item => normalizeEmail(item.address)).filter(Boolean))].slice(0, 200);
  const toList = mapAddrs(email.to);
  const recipients = { to: toList.length ? toList : [toAddress], cc: mapAddrs(email.cc), bcc: mapAddrs(email.bcc) };
  const replyTo = mapAddrs(email.replyTo);

  const subject = (email.subject || '').slice(0, 2048);
  const text = email.text || '';
  const html = email.html || '';
  const sourceMessageId = (email.messageId || '').slice(0, 998);
  const sourceReferences = (email.references || '').slice(0, 4096);
  const ingestKey = await sha256Hex(`${toAddress}\n${sourceMessageId}\n${rawDigest}`);
  const db = createDb(env);
  let duplicate = await db
    .select()
    .from(messages)
    .where(eq(messages.ingestKey, ingestKey))
    .get();
  if (duplicate?.deletedAt) return;
  if (duplicate && (duplicate.status === 'received' ||
    (duplicate.status === 'degraded' && !duplicate.errorDetail.includes('保存失败'))) && duplicate.rawR2Key &&
    (bodyBytes(text, html) <= 256 * 1024 || duplicate.bodyR2Key)) return;

  // 接受 SMTP 投递前必须保存原文；存储故障由 SMTP 重投恢复，不能接受丢失正文。
  const rawR2Key = `raw/${ingestKey}.eml`;
  await env.r2.put(rawR2Key, rawBytes, { httpMetadata: { contentType: 'message/rfc822' } });

  // 同步正则提码
  let code = '';
  if (settings.code_extract.enabled) {
    code = extractCodeByRegex(subject, text || htmlToText(html));
  }

  // 附件落 R2 前先算内容
  let attachmentBytes = 0;
  let attachmentsDropped = false;
  const parsedAttachments: ParsedAttachment[] = [];
  for (const [seq, att] of (email.attachments ?? []).entries()) {
    const raw = att.content as string | ArrayBuffer;
    const content = typeof raw === 'string' ? encoder.encode(raw) : new Uint8Array(raw);
    if (
      parsedAttachments.length >= MAX_ATTACHMENTS ||
      attachmentBytes + content.byteLength > MAX_ATTACHMENT_TOTAL_BYTES
    ) {
      attachmentsDropped = true;
      continue;
    }
    attachmentBytes += content.byteLength;
    parsedAttachments.push({
      seq,
      content,
      filename: att.filename || 'download',
      mimeType: att.mimeType || 'application/octet-stream',
      contentId: (att.contentId || '').replace(/^<|>$/g, ''),
      disposition: att.disposition === 'inline' ? 'inline' : 'attachment',
      size: content.byteLength,
    });
  }
  const attachmentsSize = parsedAttachments.reduce((sum, a) => sum + a.size, 0);

  const { bodyText, bodyHtml, bodyR2Key } = await storeMailBody(env, text, html, ingestKey);

  const preview = makePreview(text, html);
  const size = bodyBytes(text, html) + attachmentsSize;
  const ownerIds = duplicate?.notifyOwnerIds ?? await resolveNotifyOwnerIds(env, toAddress);

  // 消息落库：失败向上抛出触发 SMTP 重试
  let inserted: { id: number } | undefined;
  if (duplicate) {
    await db.update(messages).set({ bodyText, bodyHtml, bodyR2Key, rawR2Key, replyTo, notifyOwnerIds: ownerIds })
      .where(eq(messages.id, duplicate.id));
    inserted = { id: duplicate.id };
  } else try {
    inserted = await db.insert(messages).values({
      direction: 'inbound',
      address: toAddress,
      domain,
      fromAddress,
      fromName,
      recipients,
      replyTo,
      notifyOwnerIds: ownerIds,
      subject,
      preview,
      bodyText,
      bodyHtml,
      bodyR2Key,
      rawR2Key,
      ingestKey,
      verificationCode: code,
      messageId: sourceMessageId || null,
      inReplyTo: (email.inReplyTo || '').slice(0, 998) || null,
      references: sourceReferences,
      status: 'pending',
      errorDetail: attachmentsDropped ? '部分附件超过数量或总大小上限，请下载原始邮件查看' : '',
      isRead: false,
      size,
      createdAt: new Date(),
    }).returning({ id: messages.id }).get();
  } catch (error) {
    // 并发重复投递：另一请求已成功落库，确定性 R2 key 属于那条记录，不能删除。
    const raced = await db
      .select()
      .from(messages)
      .where(eq(messages.ingestKey, ingestKey))
      .get();
    if (raced && (raced.status === 'received' || raced.status === 'degraded')) return;
    if (!raced) throw error;
    duplicate = raced;
    inserted = { id: raced.id };
  }
  if (!inserted) throw new Error('入站邮件落库未返回 id');
  const messageId = inserted!.id;

  // 附件上传 + 落库：失败保留 pending，下次原始邮件重投修复同一条记录。
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
      // 补偿重投不重复增加附件行；每个已保存对象有稳定 key。
      const existing = await db.select({ key: attachmentsTable.r2Key }).from(attachmentsTable)
        .where(eq(attachmentsTable.messageId, messageId)).all();
      const savedKeys = new Set(existing.map(row => row.key));
      const missing = rows.filter(row => !savedKeys.has(row.r2Key));
      if (missing.length) await db.insert(attachmentsTable).values(missing).onConflictDoNothing();
    } catch (e) {
      console.error('附件入库失败:', e);
      try {
        await db.update(messages).set({ status: 'pending', errorDetail: '附件保存失败，等待投递重试恢复' })
          .where(eq(messages.id, messageId));
      } catch (updateError) { console.error('附件降级状态保存失败:', updateError); }
      throw e;
    }
  }

  const finalState = {
    status: attachmentsDropped ? 'degraded' : 'received',
    errorDetail: attachmentsDropped ? '部分附件超过数量或总大小上限，请下载原始邮件查看' : '',
  };
  const pendingRecovery = !duplicate || duplicate.status === 'pending';
  const completed = await db.update(messages).set(finalState).where(pendingRecovery
    ? and(eq(messages.id, messageId), eq(messages.status, 'pending'))
    : eq(messages.id, messageId)).returning({ id: messages.id }).get();
  // 并发修复只有将 pending 原子转为完整状态的一方执行转发与通知。
  if (!completed) return;
  // 旧完整消息补存原文时不重复转发；pending 消息从未进入后处理，恢复后正常通知。
  if (duplicate && duplicate.status !== 'pending') return;

  // 转发偏好来自收件时保存的 owner 快照；偏好读取失败不影响已经可靠落库的邮件。
  let ownerPrefs: Awaited<ReturnType<typeof getUserNotifyPrefs>>[] = [];
  try {
    ownerPrefs = await Promise.all(ownerIds.map((id) => getUserNotifyPrefs(env, id)));
  } catch (e) {
    console.error('通知偏好解析失败，跳过转发（邮件与归属快照已入库）:', e);
  }

  ctx.waitUntil(forwardReceivedMail(env, {
    messageId, ownerIds,
    fromAddress, fromName, toAddress, domain, subject, text, html, replyTo,
    attachments: parsedAttachments,
  }, ownerPrefs, message).catch(error => console.error('入站转发后处理失败:', error)));

  // 异步后处理：AI 兜底提码 + 按 owner 个人偏好的飞书/通用 webhook（各自 try/catch 隔离）
  ctx.waitUntil(
    (async () => {
      let finalCode = code;
      if (!finalCode && settings.code_extract.enabled && settings.code_extract.aiEnabled) {
        try {
          const usage = await bumpCounter(env, 'ai-extract', domain, dayWindow(), 1);
          if (usage.count <= DAILY_AI_EXTRACT_LIMIT) {
            const aiCode = await extractCodeByAi(env, { subject, text, html });
            if (aiCode) {
              finalCode = aiCode;
              await db
                .update(messages)
                .set({ verificationCode: aiCode })
                .where(eq(messages.id, messageId));
            }
          } else {
            console.warn(`域名 ${domain} 今日 AI 提码额度已用尽，跳过兜底识别`);
          }
        } catch (e) {
          console.error('AI 提码失败:', e);
        }
      }
      await enqueueMailNotifications(env, ctx, {
        ownerIds,
        message: { id: messageId, address: toAddress, fromAddress, fromName, subject,
          verificationCode: finalCode, preview, createdAt: new Date().toISOString() },
        text, html,
      });
    })(),
  );
}
