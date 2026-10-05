import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';
import { createDb } from '../src/db/client.js';
import { attachments, deliveryObjectLeases, idempotencyRecords, mailboxes, messages, users } from '../src/db/schema.js';
import { handleInbound } from '../src/services/inbound.js';
import { beginIdempotentSend } from '../src/services/idempotency.js';
import { sendMail } from '../src/services/outbound.js';
import { getMessageDetail, purgeMessages } from '../src/services/message.js';
import { updateSettings } from '../src/services/setting.js';
import { releaseMailbox } from '../src/services/mailbox.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { createApp } from '../src/app.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

async function seedUser(username: string, role: 'admin'|'user' = 'admin') {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'another.test', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
  });
  const [user] = await createDb(env).insert(users).values({ username, role, passwordHash: 'x' }).returning({ id: users.id });
  await createDb(env).insert(mailboxes).values({ address: `${username}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  return { userId: user!.id, role };
}

function incoming(to: string, raw: string, forward = vi.fn(async () => {})) {
  return { to, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!, forward, setReject: vi.fn() } as any;
}

function captureEnv() {
  const captured: { to: string; raw: string; mail: any }[] = [];
  const send = vi.fn(async (mail: any) => {
    const raw = await new Response(mail.raw).text();
    captured.push({ to: mail.to, raw, mail: await PostalMime.parse(raw) });
  });
  return { customEnv: { ...env, email: { send } } as any, send, captured };
}

const cidMime = (to: string, subject: string) => [
  'From: Sender <sender@example.net>', `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="review-cid"', '',
  '--review-cid', 'Content-Type: text/html; charset=UTF-8', '', '<p>Inline picture</p><img src="cid:review-image">',
  '--review-cid', 'Content-Type: image/png; name="picture.png"', 'Content-Disposition: inline; filename="picture.png"',
  'Content-ID: <review-image>', 'Content-Transfer-Encoding: base64', '', 'aW1hZ2UtYnl0ZXM=',
  '--review-cid--', '',
].join('\r\n');

describe('收发件功能与故障恢复', () => {
  it('external native-send bridge preserves To/Cc and hides Bcc, mixed targets receive only one copy', async () => {
    const sender = await seedUser('functional-sender');
    const { customEnv, captured } = captureEnv();
    const ctx = createExecutionContext();
    await sendMail(customEnv, ctx, sender, {
      from: { localPart: 'functional-sender', domain: 'hpc.email' },
      to: ['external-a@example.net', 'inside-a@another.test'],
      cc: ['external-a@example.net', 'external-c@example.net'],
      bcc: ['external-b@example.net', 'inside-b@another.test'],
      subject: 'functional-recipient-semantics', text: 'content',
    }, [], 'https://hpc.email');
    await waitOnExecutionContext(ctx);
    expect(captured.map(item => item.to).sort()).toEqual(['external-a@example.net', 'external-b@example.net', 'external-c@example.net']);
    for (const item of captured) {
      expect(item.mail.to.map((entry: any) => entry.address)).toEqual(['external-a@example.net', 'inside-a@another.test']);
      expect(item.mail.cc.map((entry: any) => entry.address)).toEqual(['external-a@example.net', 'external-c@example.net']);
      expect(item.mail.bcc).toBeUndefined();
    }
    const rows = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-recipient-semantics')).all();
    expect(rows.filter(row => row.direction === 'inbound')).toHaveLength(2);
    expect(rows.filter(row => row.direction === 'inbound').every(row => row.recipients.bcc.length === 0)).toBe(true);
    expect(rows.find(row => row.direction === 'outbound')?.recipients.bcc).toEqual(['external-b@example.net', 'inside-b@another.test']);
  });

  it('SMTP 与站内互投都使用收件人的个人转发', async () => {
    const sender = await seedUser('functional-forward-sender');
    const receiver = await seedUser('functional-forward-receiver', 'user');
    await updateUserNotifyPrefs(env, receiver.userId, { forward: { enabled: true, addresses: ['archive@example.net'] } });
    const { customEnv, send } = captureEnv();
    const ctx = createExecutionContext();
    await sendMail(customEnv, ctx, sender, {
      from: { localPart: 'functional-forward-sender', domain: 'hpc.email' },
      to: ['functional-forward-receiver@hpc.email'], cc: [], bcc: [], subject: 'functional-internal-forward', text: 'internal delivery',
    }, [], 'https://hpc.email');
    await waitOnExecutionContext(ctx);
    expect(send).toHaveBeenCalledOnce();
    const forward = vi.fn(async () => {});
    const ctx2 = createExecutionContext();
    await handleInbound(incoming('functional-forward-receiver@hpc.email', 'From: sender@example.net\r\nTo: functional-forward-receiver@hpc.email\r\nSubject: functional-external-forward\r\n\r\nExternal delivery', forward), customEnv, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(forward).toHaveBeenCalledWith('archive@example.net');
  });

  it('中转转发保留内联图片 Content-ID 和 inline disposition', async () => {
    const receiver = await seedUser('functional-relay-cid', 'user');
    await updateUserNotifyPrefs(env, receiver.userId, { forward: { enabled: true, addresses: ['cid-target@example.net'] } });
    const raw = cidMime('functional-relay-cid@hpc.email', 'functional-relay-cid');
    const original = await PostalMime.parse(raw);
    expect(original.attachments[0]!.contentId).toBe('<review-image>');
    const { customEnv, captured } = captureEnv();
    const ctx = createExecutionContext();
    await handleInbound(incoming('functional-relay-cid@hpc.email', raw, vi.fn(async () => { throw new Error('destination unverified'); })), customEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.mail.html).toContain('cid:review-image');
    expect(captured[0]!.mail.attachments[0].contentId).toBe('<review-image>');
    expect(captured[0]!.mail.attachments[0].disposition).toBe('inline');
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-relay-cid')).get();
    const detail = await getMessageDetail(env, receiver, row!.id);
    expect(detail.bodyHtml).not.toContain('cid:review-image');
    expect(detail.attachments[0]!.contentId).toBe('review-image');
  });

  it('入站 To/Cc 地址组成员完整保存', async () => {
    const viewer = await seedUser('functional-groups');
    const raw = 'From: sender@example.net\r\nTo: Team: functional-groups@hpc.email, colleague@example.net;\r\nCc: Reviewers: cc-one@example.net, cc-two@example.net;\r\nSubject: functional-groups\r\n\r\nPlease reply all.';
    const parsed = await PostalMime.parse(raw);
    expect(parsed.to?.[0]?.group?.map((item: any) => item.address)).toEqual(['functional-groups@hpc.email', 'colleague@example.net']);
    const ctx = createExecutionContext();
    await handleInbound(incoming('functional-groups@hpc.email', raw), env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-groups')).get();
    const detail = await getMessageDetail(env, viewer, row!.id);
    expect(detail.recipients.to).toEqual(['functional-groups@hpc.email', 'colleague@example.net']);
    expect(detail.recipients.cc).toEqual(['cc-one@example.net', 'cc-two@example.net']);
  });

  it('原邮件附件缺失时拒绝转发，不静默发送不完整附件', async () => {
    const sender = await seedUser('functional-missing-forward');
    const [source] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'functional-missing-forward@hpc.email', domain: 'hpc.email', status: 'received', subject: 'source' }).returning({ id: messages.id });
    await createDb(env).insert(attachments).values({ messageId: source!.id, r2Key: 'att/missing-functional-forward.bin', filename: 'important.bin', mimeType: 'application/octet-stream', size: 12 });
    const { customEnv, captured } = captureEnv();
    await expect(sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-missing-forward', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: 'functional-missing-forward', text: 'Important file attached', forwardAttachmentsFrom: source!.id,
    }, [], 'https://hpc.email')).rejects.toThrow('已丢失');
    expect(captured).toHaveLength(0);
  });

  it('原附件加新增附件超限时拒绝，不静默丢附件', async () => {
    const sender = await seedUser('functional-forward-cap');
    const [source] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'functional-forward-cap@hpc.email', domain: 'hpc.email', status: 'received', subject: 'ten originals' }).returning({ id: messages.id });
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const r2Key = `att/functional-forward-cap/${i}.txt`;
      await env.r2.put(r2Key, `original ${i}`);
      rows.push({ messageId: source!.id, r2Key, filename: `original-${i}.txt`, mimeType: 'text/plain', size: 10 });
    }
    await createDb(env).insert(attachments).values(rows);
    const { customEnv, captured } = captureEnv();
    await expect(sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-forward-cap', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: 'functional-forward-cap', text: 'All original files plus a new file', forwardAttachmentsFrom: source!.id,
    }, [{ filename: 'new-file.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('new file'), contentId: '', disposition: 'attachment' }], 'https://hpc.email')).rejects.toThrow('合计最多');
    expect(captured).toHaveLength(0);
  });

  it('大内联图片转独立下载链接，并同步替换 HTML CID', async () => {
    const sender = await seedUser('functional-external-cid');
    const { customEnv, captured } = captureEnv();
    await sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-external-cid', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: 'functional-external-cid', html: '<p>Inline image</p><img src="cid:large-image">',
    }, [{ filename: 'large.png', mimeType: 'image/png', bytes: new Uint8Array(4 * 1024 * 1024), contentId: 'large-image', disposition: 'inline' }], 'https://hpc.email');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.mail.html).not.toContain('cid:large-image');
    expect(captured[0]!.mail.html).toContain('<img src="https://hpc.email/api/attachments/');
    expect(captured[0]!.mail.attachments).toHaveLength(0);
    expect(captured[0]!.mail.html).toContain('附件下载');
  });

  it('长中文 Subject 和 References 合法折行，解码后完整不变', async () => {
    const sender = await seedUser('functional-long-headers');
    const references = Array.from({ length: 20 }, (_, i) => `<${String(i).padStart(4, '0')}-${'a'.repeat(40)}@example.net>`).join(' ');
    const [source] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'functional-long-headers@hpc.email', domain: 'hpc.email', status: 'received', subject: 'Original', messageId: '<original@example.net>', references }).returning({ id: messages.id });
    const { customEnv, captured } = captureEnv();
    await sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-long-headers', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: '中'.repeat(300), text: 'reply body', replyToMessageId: source!.id,
    }, [], 'https://hpc.email');
    const headerLines = captured[0]!.raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(Math.max(...headerLines.map(line => new TextEncoder().encode(line).length))).toBeLessThanOrEqual(998);
    expect(captured[0]!.mail.references).toBe(`${references} <original@example.net>`);
    expect(captured[0]!.mail.subject).toBe('中'.repeat(300));
  });

  it('normal replies preserve threading headers, Unicode body and attachment content', async () => {
    const sender = await seedUser('functional-thread-good');
    const [source] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'functional-thread-good@hpc.email', domain: 'hpc.email', status: 'received', subject: 'Original', messageId: '<original-good@example.net>', references: '<root-good@example.net>' }).returning({ id: messages.id });
    const { customEnv, captured } = captureEnv();
    const body = '中文正文和🙂表情'.repeat(200);
    const bytes = new TextEncoder().encode('actual attachment content');
    await sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-thread-good', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: 'Re: Original', text: body, replyToMessageId: source!.id,
    }, [{ filename: 'test.txt', mimeType: 'text/plain', bytes, contentId: '', disposition: 'attachment' }], 'https://hpc.email');
    expect(captured[0]!.mail.inReplyTo).toBe('<original-good@example.net>');
    expect(captured[0]!.mail.references).toBe('<root-good@example.net> <original-good@example.net>');
    expect(captured[0]!.mail.text).toBe(body);
    expect(new TextDecoder().decode(captured[0]!.mail.attachments[0].content)).toBe('actual attachment content');
    expect(Math.max(...captured[0]!.raw.split('\r\n').map(line => new TextEncoder().encode(line).length))).toBeLessThan(998);
  });

  it('90 天外部附件链接在发件人永久删除邮件后仍可下载', async () => {
    const sender = await seedUser('functional-link-lifetime');
    const { customEnv, captured } = captureEnv();
    const summary = await sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-link-lifetime', domain: 'hpc.email' }, to: ['recipient@example.net'], cc: [], bcc: [], subject: 'functional-link-lifetime', text: 'Attached file',
    }, [{ filename: 'large.bin', mimeType: 'application/octet-stream', bytes: new Uint8Array(4 * 1024 * 1024), contentId: '', disposition: 'attachment' }], 'https://hpc.email');
    const url = captured[0]!.mail.text.match(/https:\/\/hpc\.email\/api\/attachments\/\d+\?exp=\d+&sig=[^\s]+/)![0];
    expect(Number(new URL(url).searchParams.get('exp')) - Math.floor(Date.now()/1000)).toBeGreaterThan(89*86400);
    expect(captured[0]!.mail.text).toContain('链接有效期 90 天');
    const app = createApp();
    const before = await app.request(url, {}, customEnv);
    expect(before.status).toBe(200);
    await before.arrayBuffer();
    await createDb(env).update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, summary.id));
    const softDeleted = await app.request(url, {}, customEnv);
    expect(softDeleted.status).toBe(200);
    await softDeleted.arrayBuffer();
    expect(await purgeMessages(env, sender, [summary.id])).toBe(1);
    const after = await app.request(url, {}, customEnv);
    expect(after.status).toBe(200);
    expect((await after.arrayBuffer()).byteLength).toBe(4 * 1024 * 1024);
  });

  it('successful large inbound keeps full body in R2 and detail restores it; identical concurrent delivery is deduplicated', async () => {
    const viewer = await seedUser('functional-inbound-normal');
    const body = 'content '.repeat(40 * 1024);
    const raw = `From: sender@example.net\r\nTo: functional-inbound-normal@hpc.email\r\nSubject: functional-inbound-normal\r\nMessage-ID: <functional-inbound-normal@example.net>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`;
    const parsed = await PostalMime.parse(raw);
    const ctx1 = createExecutionContext();
    const ctx2 = createExecutionContext();
    await Promise.all([
      handleInbound(incoming('functional-inbound-normal@hpc.email', raw), env, ctx1),
      handleInbound(incoming('functional-inbound-normal@hpc.email', raw), env, ctx2),
    ]);
    await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);
    const rows = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-inbound-normal')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyText.length).toBe(64 * 1024);
    expect(rows[0]!.rawR2Key).not.toBeNull();
    expect(rows[0]!.bodyR2Key).not.toBeNull();
    expect((await getMessageDetail(env, viewer, rows[0]!.id)).bodyText === parsed.text).toBe(true);
    expect((await env.r2.get(rows[0]!.rawR2Key!))?.size).toBe(new TextEncoder().encode(raw).length);
  });
  it('已投递后单次结果回填失败仍成功，并通过已绑定消息恢复幂等结果', async () => {
    const sender = await seedUser('functional-status-recovery');
    const req = {
      from: { localPart: 'functional-status-recovery', domain: 'hpc.email' },
      to: ['status-receiver@another.test'], cc: [], bcc: [], subject: 'status-recovery', text: 'body',
    };
    const actor = { type: 'user' as const, id: sender.userId };
    const owner = await beginIdempotentSend(env, actor, 'status-recovery-key', req);
    if (owner.kind !== 'owner') throw new Error('expected owner');
    let failures = 0;
    const faultDb = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (failures === 0 && query.startsWith('update "messages"') && query.includes('"recipient_outcomes"')) {
          failures++;
          throw new Error('injected status failure');
        }
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const summary = await sendMail({ ...env, db: faultDb }, { waitUntil: () => {} }, sender, req, [], 'https://hpc.email', owner.handle);
    expect(summary.status).toBe('delivered');
    expect(summary.recipientOutcomes).toEqual([{ address: 'status-receiver@another.test', status: 'delivered' }]);
    expect(failures).toBe(1);
    const linked = await createDb(env).select().from(idempotencyRecords).where(eq(idempotencyRecords.key, 'status-recovery-key')).get();
    expect(linked?.messageId).toBe(summary.id);
    const replay = await beginIdempotentSend(env, actor, 'status-recovery-key', req);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.response.id).toBe(summary.id);
  });

  it('所有结果回填均失败时返回真实投递结果，pending 幂等键阻止重复发送', async () => {
    const sender = await seedUser('functional-status-unknown');
    const req = { from: { localPart: 'functional-status-unknown', domain: 'hpc.email' },
      to: ['unknown@example.net'], cc: [], bcc: [], subject: 'status-unknown', text: 'body' };
    const actor = { type: 'user' as const, id: sender.userId };
    const owner = await beginIdempotentSend(env, actor, 'status-unknown-key', req);
    if (owner.kind !== 'owner') throw new Error('expected owner');
    const { customEnv, captured } = captureEnv();
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (query.startsWith('update "messages"') && query.includes('"recipient_outcomes"')) throw new Error('persistent D1 failure');
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const summary = await sendMail({ ...customEnv, db }, { waitUntil: () => {} }, sender, req, [], 'https://hpc.email', owner.handle);
    expect(summary.status).toBe('sent');
    expect(captured).toHaveLength(1);
    const row = await createDb(env).select().from(messages).where(eq(messages.id, summary.id)).get();
    expect(row?.status).toBe('pending');
    await expect(beginIdempotentSend(env, actor, 'status-unknown-key', req)).rejects.toThrow();
    expect(captured).toHaveLength(1);
  });

  it('部分失败记录逐收件人结果，只失败的目标可用于补发', async () => {
    const sender = await seedUser('functional-partial');
    const { customEnv, captured } = captureEnv();
    const realSend = customEnv.email.send;
    customEnv.email.send = async (mail: any) => {
      if (mail.to === 'failed@example.net') throw new Error('rejected');
      return realSend(mail);
    };
    const summary = await sendMail(customEnv, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-partial', domain: 'hpc.email' }, to: ['good@example.net', 'failed@example.net'],
      cc: ['good@example.net'], bcc: ['local@another.test'], subject: 'partial-outcomes', text: 'body',
    }, [], 'https://hpc.email');
    expect(summary.status).toBe('sent');
    expect(summary.recipientOutcomes).toEqual([
      { address: 'good@example.net', status: 'sent' },
      { address: 'failed@example.net', status: 'failed', error: 'rejected' },
      { address: 'local@another.test', status: 'delivered' },
    ]);
    expect(captured).toHaveLength(1);
    const stored = await createDb(env).select().from(messages).where(eq(messages.id, summary.id)).get();
    expect(stored?.recipientOutcomes).toEqual(summary.recipientOutcomes);
  });

  it('UTF-8 正文上限在发送服务兜底，大正文与站内副本独立分层到 R2', async () => {
    const sender = await seedUser('functional-body-limit');
    const req = { from: { localPart: 'functional-body-limit', domain: 'hpc.email' },
      to: ['body-receiver@another.test'], cc: [], bcc: [], subject: 'body-limit', text: '中'.repeat(400 * 1024) };
    await expect(sendMail(env, { waitUntil: () => {} }, sender, req, [], 'https://hpc.email')).rejects.toThrow('1MB');
    const text = '中🙂'.repeat(70 * 1024);
    const summary = await sendMail(env, { waitUntil: () => {} }, sender, { ...req, text }, [], 'https://hpc.email');
    const rows = await createDb(env).select().from(messages).where(eq(messages.subject, 'body-limit')).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.bodyR2Key)).size).toBe(2);
    for (const row of rows) {
      expect(new TextEncoder().encode(row.bodyText).length).toBeLessThanOrEqual(64 * 1024);
      expect(row.bodyText).not.toContain('�');
      expect(JSON.parse(await (await env.r2.get(row.bodyR2Key!))!.text()).text).toBe(text);
    }
    expect((await getMessageDetail(env, sender, summary.id)).bodyText).toBe(text);
  });

  it.each(['raw/', 'body/'])('入站 %s 写入故障不接受丢失全文，恢复后重投完整落库', async (prefix) => {
    const name = `functional-r2-${prefix.slice(0, -1)}`;
    await seedUser(name);
    const text = 'complete '.repeat(40 * 1024);
    const raw = `From: sender@example.net\r\nTo: ${name}@hpc.email\r\nSubject: ${name}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'put') return (key: string, ...args: any[]) => {
        if (key.startsWith(prefix)) throw new Error('injected R2 outage');
        return (target.put as any)(key, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const ctx = createExecutionContext();
    await expect(handleInbound(incoming(`${name}@hpc.email`, raw), { ...env, r2 }, ctx)).rejects.toThrow('injected R2 outage');
    expect(await createDb(env).select().from(messages).where(eq(messages.subject, name)).all()).toHaveLength(0);
    const restored = createExecutionContext();
    await handleInbound(incoming(`${name}@hpc.email`, raw), env, restored);
    await waitOnExecutionContext(restored);
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, name)).get();
    expect(row?.status).toBe('received');
    expect(row?.rawR2Key).toBeTruthy();
    expect(row?.bodyR2Key).toBeTruthy();
    expect(JSON.parse(await (await env.r2.get(row!.bodyR2Key!))!.text()).text === (await PostalMime.parse(raw)).text).toBe(true);
  });

  it('入站附件故障后并发重投修复同一行/同一附件，并且只转发一次', async () => {
    const receiver = await seedUser('functional-repair-attachment', 'user');
    await updateUserNotifyPrefs(env, receiver.userId, { forward: { enabled: true, addresses: ['repaired@example.net'] } });
    const raw = cidMime('functional-repair-attachment@hpc.email', 'functional-repair-attachment');
    const forward = vi.fn(async () => {});
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'put') return (key: string, ...args: any[]) => {
        if (key.startsWith('att/')) throw new Error('attachment R2 unavailable');
        return (target.put as any)(key, ...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(handleInbound(incoming('functional-repair-attachment@hpc.email', raw, forward), { ...env, r2 }, createExecutionContext())).rejects.toThrow('attachment R2 unavailable');
    const pending = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-repair-attachment')).get();
    expect(pending?.status).toBe('pending');
    const ctx1 = createExecutionContext(), ctx2 = createExecutionContext();
    await Promise.all([
      handleInbound(incoming('functional-repair-attachment@hpc.email', raw, forward), env, ctx1),
      handleInbound(incoming('functional-repair-attachment@hpc.email', raw, forward), env, ctx2),
    ]);
    await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);
    const rows = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-repair-attachment')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pending?.id);
    expect(rows[0]!.status).toBe('received');
    expect(await createDb(env).select().from(attachments).where(eq(attachments.messageId, rows[0]!.id)).all()).toHaveLength(1);
    expect(forward).toHaveBeenCalledOnce();
  });

  it('Reply-To 地址组完整保存到详情，中转转发也使用全部 Reply-To', async () => {
    const receiver = await seedUser('functional-reply-to', 'user');
    await updateUserNotifyPrefs(env, receiver.userId, { forward: { enabled: true, addresses: ['reply-forward@example.net'] } });
    const raw = cidMime('functional-reply-to@hpc.email', 'functional-reply-to')
      .replace('From: Sender <sender@example.net>', 'From: Sender <sender@example.net>\r\nReply-To: Support: help@example.net, service@example.net;');
    const { customEnv, captured } = captureEnv();
    const ctx = createExecutionContext();
    await handleInbound(incoming('functional-reply-to@hpc.email', raw, vi.fn(async () => { throw new Error('unverified'); })), customEnv, ctx);
    await waitOnExecutionContext(ctx);
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'functional-reply-to')).get();
    expect(row?.replyTo).toEqual(['help@example.net', 'service@example.net']);
    expect((await getMessageDetail(env, receiver, row!.id)).replyTo).toEqual(row?.replyTo);
    expect(captured[0]!.mail.replyTo.map((address: any) => address.address)).toEqual(row?.replyTo);
  });

  it('站内收件与附件引用通过 D1 事务一起提交，附件引用失败则收件副本回滚', async () => {
    const sender = await seedUser('functional-atomic-internal');
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (query.startsWith('insert into "attachments"') && query.includes('select id from messages')) {
          return target.prepare('INSERT INTO intentional_missing_delivery_table VALUES (1)');
        }
        return target.prepare(query);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(sendMail({ ...env, db }, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-atomic-internal', domain: 'hpc.email' },
      to: ['atomic-receiver@another.test'], cc: [], bcc: [], subject: 'atomic-internal', text: 'body',
    }, [{ filename: 'important.txt', mimeType: 'text/plain', contentId: '', disposition: 'attachment', bytes: new TextEncoder().encode('important') }], 'https://hpc.email')).rejects.toThrow();
    const rows = await createDb(env).select().from(messages).where(eq(messages.subject, 'atomic-internal')).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('outbound');
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.recipientOutcomes[0]?.status).toBe('failed');
  });

  it('SMTP 中转的大内联图片转独立链接，正文 CID 一同替换', async () => {
    const receiver = await seedUser('functional-large-relay', 'user');
    await updateUserNotifyPrefs(env, receiver.userId, { forward: { enabled: true, addresses: ['large-relay@example.net'] } });
    const raw = cidMime('functional-large-relay@hpc.email', 'functional-large-relay')
      .replace('aW1hZ2UtYnl0ZXM=', 'AAAA'.repeat(Math.ceil(4 * 1024 * 1024 / 3)));
    const { customEnv, captured } = captureEnv();
    const ctx = createExecutionContext();
    await handleInbound(incoming('functional-large-relay@hpc.email', raw, vi.fn(async () => { throw new Error('unverified'); })), customEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.mail.attachments).toHaveLength(0);
    expect(captured[0]!.mail.html).not.toContain('cid:review-image');
    expect(captured[0]!.mail.html).toContain('<img src="https://hpc.email/api/attachments/');
    expect(captured[0]!.mail.html).toContain('90 天');
  });

  it('从含内联图的详情重发时，将本站临时下载 URL 恢复为 CID 并保留原附件', async () => {
    const sender = await seedUser('functional-resend-cid');
    const { customEnv, captured } = captureEnv();
    const req = { from: { localPart: 'functional-resend-cid', domain: 'hpc.email' },
      to: ['original@example.net'], cc: [], bcc: [], subject: 'resend-cid', html: '<img src="cid:resend-image">' };
    const original = await sendMail(customEnv, { waitUntil: () => {} }, sender, req, [{
      filename: 'inline.png', mimeType: 'image/png', contentId: 'resend-image', disposition: 'inline', bytes: new TextEncoder().encode('picture'),
    }], 'https://hpc.email');
    const detail = await getMessageDetail(env, sender, original.id);
    expect(detail.bodyHtml).toContain('/api/attachments/');
    await sendMail(customEnv, { waitUntil: () => {} }, sender, { ...req,
      to: ['retry@example.net'], html: detail.bodyHtml, forwardAttachmentsFrom: original.id,
    }, [], 'https://hpc.email');
    expect(captured[1]!.mail.html).toBe('<img src="cid:resend-image">');
    expect(captured[1]!.mail.attachments[0].contentId).toBe('<resend-image>');
    expect(captured[1]!.mail.attachments[0].disposition).toBe('inline');
  });

  it.each(['purge', 'release'])('发送尚未插入站内副本时 %s 发件历史，不提前清掉后续副本附件', async mode => {
    const name = `functional-send-cleanup-${mode}`;
    const sender = await seedUser(name);
    let internalBatch = false;
    let triggered = false;
    let protectedKey = '';
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (query.startsWith('insert into "attachments"') && query.includes('select id from messages')) internalBatch = true;
        return target.prepare(query);
      };
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (internalBatch && !triggered) {
          triggered = true;
          const row = await createDb(env).select().from(messages).where(eq(messages.subject, name)).get();
          expect(row?.status).toBe('pending');
          const att = await createDb(env).select().from(attachments).where(eq(attachments.messageId, row!.id)).get();
          protectedKey = att!.r2Key;
          if (mode === 'purge') {
            await createDb(env).update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row!.id));
            expect(await purgeMessages(env, sender, [row!.id])).toBe(1);
          } else {
            const mailbox = await createDb(env).select().from(mailboxes).where(eq(mailboxes.address, `${name}@hpc.email`)).get();
            expect((await releaseMailbox(env, sender.userId, mailbox!.id, true, true)).deletedMessages).toBe(1);
          }
          await processStorageCleanup(env);
          expect(await env.r2.get(protectedKey)).not.toBeNull();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const summary = await sendMail({ ...env, db }, { waitUntil: () => {} }, sender, {
      from: { localPart: name, domain: 'hpc.email' }, to: [`target-${mode}@another.test`],
      cc: [], bcc: [], subject: name, text: 'body',
    }, [{ filename: 'proof.txt', mimeType: 'text/plain', contentId: '', disposition: 'attachment', bytes: new TextEncoder().encode('durable bytes') }], 'https://hpc.email');
    expect(triggered).toBe(true);
    expect(summary.status).toBe('delivered');
    const incoming = await createDb(env).select().from(messages).where(eq(messages.subject, name)).get();
    expect(incoming?.direction).toBe('inbound');
    const att = await createDb(env).select().from(attachments).where(eq(attachments.messageId, incoming!.id)).get();
    expect(att?.r2Key).toBe(protectedKey);
    await processStorageCleanup(env);
    expect(await (await env.r2.get(att!.r2Key))?.text()).toBe('durable bytes');
  });

  it('sender 在附件元数据写入前释放历史时，完成发送后清除晚插入的孤儿引用', async () => {
    const sender = await seedUser('functional-late-attachment');
    let released = false;
    let key = '';
    let senderMessageId = 0;
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'put') return async (objectKey: string, ...args: any[]) => {
        const result = await (target.put as any)(objectKey, ...args);
        if (objectKey.startsWith('att/') && !released) {
          released = true; key = objectKey;
          const db = createDb(env);
          const row = await db.select().from(messages).where(eq(messages.subject, 'functional-late-attachment')).get();
          senderMessageId = row!.id;
          const mailbox = await db.select().from(mailboxes).where(eq(mailboxes.address, 'functional-late-attachment@hpc.email')).get();
          expect((await releaseMailbox(env, sender.userId, mailbox!.id, true, true)).deletedMessages).toBe(1);
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const summary = await sendMail({ ...env, r2 }, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-late-attachment', domain: 'hpc.email' },
      to: ['late-target@another.test'], cc: [], bcc: [], subject: 'functional-late-attachment', text: 'body',
    }, [{ filename: 'late.txt', mimeType: 'text/plain', contentId: '', disposition: 'attachment', bytes: new TextEncoder().encode('kept until delivered') }], 'https://hpc.email');
    expect(summary.status).toBe('delivered');
    expect(released).toBe(true);
    const db = createDb(env);
    expect(await db.select().from(attachments).where(eq(attachments.messageId, senderMessageId)).all()).toHaveLength(0);
    expect(await db.select().from(deliveryObjectLeases).where(eq(deliveryObjectLeases.r2Key, key)).all()).toHaveLength(0);
    expect(await (await env.r2.get(key))?.text()).toBe('kept until delivered');
    const incoming = await db.select().from(messages).where(eq(messages.subject, 'functional-late-attachment')).get();
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, incoming!.id));
    expect(await purgeMessages(env, { ...sender, scope: 'unclaimed' }, [incoming!.id])).toBe(1);
    expect(await env.r2.get(key)).toBeNull();
  });

  it('投递成功后发送租约释放故障保留保护引用，并返回真实发送结果', async () => {
    const sender = await seedUser('functional-lease-release-fault');
    const { customEnv, captured } = captureEnv();
    let releasing = false;
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        if (query.startsWith('delete from "delivery_object_leases"')) releasing = true;
        return target.prepare(query);
      };
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (releasing) throw new Error('lease cleanup D1 unavailable');
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const summary = await sendMail({ ...customEnv, db }, { waitUntil: () => {} }, sender, {
      from: { localPart: 'functional-lease-release-fault', domain: 'hpc.email' },
      to: ['lease-receiver@example.net'], cc: [], bcc: [], subject: 'functional-lease-release-fault', text: 'body',
    }, [{ filename: 'fault.txt', mimeType: 'text/plain', contentId: '', disposition: 'attachment', bytes: new TextEncoder().encode('sent bytes') }], 'https://hpc.email');
    expect(summary.status).toBe('sent');
    expect(summary.recipientOutcomes).toEqual([{ address: 'lease-receiver@example.net', status: 'sent' }]);
    expect(captured).toHaveLength(1);
    const att = await createDb(env).select().from(attachments).where(eq(attachments.messageId, summary.id)).get();
    expect(await createDb(env).select().from(deliveryObjectLeases).where(eq(deliveryObjectLeases.r2Key, att!.r2Key)).all()).toHaveLength(1);
    expect(await env.r2.get(att!.r2Key)).not.toBeNull();
  });

});
