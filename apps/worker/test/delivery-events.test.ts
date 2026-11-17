import type { DeliveryEventsOverview, EmailSuppression, MessageSummary, Page, RecipientOutcome } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, emailDeliveryRefs, emailSuppressions, mailboxes, messages, notificationJobs, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import {
  handleDeliveryEventBatch, parseDeliveryEvent, processDeliveryEvent, summarizeOutcomes, type DeliveryUserEvent,
} from '../src/services/delivery-events.js';
import { handleInbound } from '../src/services/inbound.js';
import { getNotificationHealth } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { sendMail } from '../src/services/outbound.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const app = createApp();
const db = createDb(env);
let sequence = 0;

afterEach(() => vi.unstubAllGlobals());

/** send_email 的替身：按收件人返回 Cloudflare 消息 ID（withId=false 时不返回，模拟没有返回值的情况） */
function mailEnv(opts: { withId?: boolean } = {}) {
  const sent: { from: string; to: string }[] = [];
  const send = vi.fn(async (mail: { from: string; to: string }) => {
    sent.push({ from: mail.from, to: mail.to });
    return opts.withId === false ? undefined : { messageId: `cf-${sent.length}-${mail.to}` };
  });
  return { runtime: { ...env, email: { send } } as unknown as Env, sent, send };
}

async function fixture() {
  const prefix = `de${++sequence}`;
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'another.test', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
  });
  const user = (await db.insert(users).values({ username: `${prefix}-owner`, role: 'user', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
  const address = `${prefix}-owner@hpc.email`;
  await db.insert(mailboxes).values([
    { address, domain: 'hpc.email', userId: user.id },
    { address: `${prefix}-owner@another.test`, domain: 'another.test', userId: user.id },
  ]);
  return { prefix, user, address, sender: { userId: user.id, role: 'user' as const }, ext: (name: string) => `${prefix}-${name}@example.net` };
}

async function send(runtime: Env, sender: { userId: number; role: 'user' }, from: string, to: string[], subject: string) {
  const ctx = createExecutionContext();
  const [localPart, domain] = from.split('@') as [string, string];
  const summary = await sendMail(runtime, ctx, sender, { from: { localPart, domain }, to, cc: [], bcc: [], subject, text: 'hello' }, [], 'https://hpc.email');
  await waitOnExecutionContext(ctx);
  return summary;
}

function event(type: string, fields: { messageId: string; sender: string; recipient: string; at?: string;
  smtp?: [string, string, string]; bounceType?: string; extra?: Record<string, unknown> }) {
  const [code, enhanced, response] = fields.smtp ?? [];
  return {
    type: `cf.email.sending.message.${type}`,
    source: { type: 'email.sending', zoneId: 'zone-1', domain: fields.sender.split('@')[1] },
    payload: {
      eventId: crypto.randomUUID(), messageId: fields.messageId, sender: fields.sender, recipient: fields.recipient,
      subject: 'x', terminal: type !== 'deferred',
      delivery: { status: type, ...(code ? { smtpStatusCode: code, smtpEnhancedStatusCode: enhanced, smtpResponse: response } : {}) },
      ...(fields.bounceType ? { bounce: { type: fields.bounceType, classification: fields.bounceType === 'hard' ? 'permanent_failure' : 'temporary_failure', reason: response } } : {}),
      ...fields.extra,
    },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: fields.at ?? new Date().toISOString() },
  };
}

const outbound = (id: number) => db.select().from(messages).where(eq(messages.id, id)).get();
const outcomeOf = (row: { recipientOutcomes: RecipientOutcome[] } | undefined, address: string) =>
  row!.recipientOutcomes.find((item) => item.address === address)!;

describe('投递事件解析', () => {
  it('终态事件规整为状态、SMTP 码与原因；deferred、未知类型与缺字段的消息忽略', () => {
    const bounced = parseDeliveryEvent(event('bounced', { messageId: 'm1', sender: 'A@hpc.email', recipient: 'B@Example.net',
      smtp: ['550', '5.1.1', '550 5.1.1 User unknown'], bounceType: 'hard', at: '2026-06-01T02:48:57.132Z' }));
    expect(bounced).toMatchObject({ type: 'bounced', sender: 'a@hpc.email', recipient: 'b@example.net', smtpStatus: '550 5.1.1',
      error: '550 5.1.1 User unknown', at: Date.parse('2026-06-01T02:48:57.132Z'), bounce: { type: 'hard' } });
    expect(parseDeliveryEvent(event('failed', { messageId: 'm', sender: 'a@hpc.email', recipient: 'b@x.net',
      extra: { failure: { reason: 'delivery_failed' } } }))?.error).toBe('Cloudflare 投递失败（delivery_failed）');
    expect(parseDeliveryEvent(event('rejected', { messageId: 'm', sender: 'a@hpc.email', recipient: 'b@x.net',
      extra: { rejection: { reason: 'suppressed', party: 'recipient', detail: 'Recipient is suppressed' } } }))?.error)
      .toBe('Cloudflare 拒绝投递（suppressed：Recipient is suppressed）');
    expect(parseDeliveryEvent(event('delivered', { messageId: 'm', sender: 'a@hpc.email', recipient: 'b@x.net' }))?.error).toBe('');
    expect(parseDeliveryEvent(event('deferred', { messageId: 'm', sender: 'a@hpc.email', recipient: 'b@x.net' }))).toBeNull();
    expect(parseDeliveryEvent({ type: 'cf.r2.bucket.created', payload: {} })).toBeNull();
    expect(parseDeliveryEvent(event('delivered', { messageId: 'm', sender: 'a@hpc.email', recipient: '' }))).toBeNull();
    expect(parseDeliveryEvent('not json')).toBeNull();
  });

  it('整体状态：还有 sent 为 sent；全部失败或退信为 failed；投诉算已送达', () => {
    expect(summarizeOutcomes([{ address: 'a', status: 'delivered' }, { address: 'b', status: 'sent' }]).status).toBe('sent');
    expect(summarizeOutcomes([{ address: 'a', status: 'complained' }, { address: 'b', status: 'bounced', error: 'x' }]))
      .toEqual({ status: 'delivered', errorDetail: '部分收件人失败: b: x' });
    expect(summarizeOutcomes([{ address: 'a', status: 'bounced', error: 'x' }, { address: 'b', status: 'failed', error: 'y' }]))
      .toEqual({ status: 'failed', errorDetail: '全部收件人投递失败: a: x; b: y' });
  });
});

describe('外发回执回写与抑制名单', () => {
  it('按 send() 返回的消息 ID 回写逐收件人结果与整体状态，退信进入抑制名单并产生推送事件', async () => {
    const f = await fixture();
    const { runtime } = mailEnv();
    const a = f.ext('a');
    const b = f.ext('b');
    const summary = await send(runtime, f.sender, f.address, [a, b], `${f.prefix}-receipts`);
    expect(summary.status).toBe('sent');
    const refs = await db.select().from(emailDeliveryRefs).where(eq(emailDeliveryRefs.messageId, summary.id)).all();
    expect(refs.map((ref) => [ref.recipient, ref.providerMessageId, ref.kind]).sort()).toEqual([
      [a, `cf-1-${a}`, 'message'], [b, `cf-2-${b}`, 'message'],
    ].sort());
    expect(refs.every((ref) => ref.rfcMessageId && !ref.rfcMessageId.startsWith('<') && ref.sender === f.address)).toBe(true);

    const userEvents: DeliveryUserEvent[] = [];
    const delivered = event('delivered', { messageId: `cf-1-${a}`, sender: f.address, recipient: a, smtp: ['250', '2.0.0', '250 OK'] });
    expect(await processDeliveryEvent(env, delivered, { userEvents })).toBe('applied');
    let row = await outbound(summary.id);
    expect(outcomeOf(row, a)).toMatchObject({ status: 'delivered', event: 'delivered', smtpStatus: '250 2.0.0' });
    expect(outcomeOf(row, a).error).toBeUndefined();
    expect(row!.status).toBe('sent');
    // 重复投递的同一事件不改动、不重复推送
    expect(await processDeliveryEvent(env, delivered, { userEvents })).toBe('unchanged');

    const bounced = event('bounced', { messageId: `cf-2-${b}`, sender: f.address, recipient: b,
      smtp: ['550', '5.1.1', '550 5.1.1 User unknown'], bounceType: 'hard' });
    expect(await processDeliveryEvent(env, bounced, { userEvents })).toBe('applied');
    row = await outbound(summary.id);
    expect(outcomeOf(row, b)).toMatchObject({ status: 'bounced', event: 'bounced', smtpStatus: '550 5.1.1', error: '550 5.1.1 User unknown' });
    expect(row!.status).toBe('delivered');
    expect(row!.errorDetail).toBe(`部分收件人失败: ${b}: 550 5.1.1 User unknown`);
    expect(userEvents.map((item) => [item.event, item.userId, item.data.recipient, item.data.messageId])).toEqual([
      ['mail.delivered', f.user.id, a, summary.id], ['mail.bounced', f.user.id, b, summary.id],
    ]);
    const suppression = await db.select().from(emailSuppressions).where(eq(emailSuppressions.address, b)).get();
    expect(suppression).toMatchObject({ sendingDomain: 'hpc.email', reason: 'hard_bounce', expiresAt: null });
    expect((await db.select().from(emailDeliveryRefs).where(eq(emailDeliveryRefs.messageId, summary.id)).all())
      .every((ref) => ref.resolvedAt !== null)).toBe(true);
  });

  it('乱序到达的旧事件不覆盖新结果；全部退信时整体变为 failed', async () => {
    const f = await fixture();
    const { runtime } = mailEnv();
    const a = f.ext('a');
    const summary = await send(runtime, f.sender, f.address, [a], `${f.prefix}-order`);
    const later = new Date(Date.now()).toISOString();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    expect(await processDeliveryEvent(env, event('bounced', { messageId: `cf-1-${a}`, sender: f.address, recipient: a, at: later,
      smtp: ['552', '5.2.2', '552 mailbox full'], bounceType: 'soft' }))).toBe('applied');
    expect(await processDeliveryEvent(env, event('delivered', { messageId: `cf-1-${a}`, sender: f.address, recipient: a, at: earlier })))
      .toBe('unchanged');
    const row = await outbound(summary.id);
    expect(outcomeOf(row, a).status).toBe('bounced');
    expect(row!.status).toBe('failed');
    expect(row!.errorDetail).toBe(`全部收件人投递失败: ${a}: 552 mailbox full`);
    // 软退信只抑制 24 小时
    const suppression = await db.select().from(emailSuppressions).where(eq(emailSuppressions.address, a)).get();
    expect(suppression?.reason).toBe('soft_bounce');
    expect(suppression!.expiresAt!.getTime()).toBe(Date.parse(later) + 24 * 3600_000);
  });

  it('全部收件人被抑制时 422 recipient_suppressed，不建发件行也不调用 send；部分抑制时只拦被抑制的收件人', async () => {
    const f = await fixture();
    const blocked = f.ext('blocked');
    const other = f.ext('other');
    await processDeliveryEvent(env, event('complained', { messageId: 'unrelated', sender: `x@hpc.email`, recipient: blocked }));
    const { runtime, sent } = mailEnv();
    await expect(send(runtime, f.sender, f.address, [blocked], `${f.prefix}-all-suppressed`)).rejects.toMatchObject({
      code: 'recipient_suppressed',
      hints: { details: { suppressed: [{ address: blocked, reason: 'complaint', sendingDomain: 'hpc.email', expiresAt: null }] },
        docs: '/references/errors.md#recipient_suppressed' },
    });
    expect(sent).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.subject, `${f.prefix}-all-suppressed`)).all()).toEqual([]);

    const partial = await send(runtime, f.sender, f.address, [blocked, other], `${f.prefix}-partial`);
    expect(sent.map((item) => item.to)).toEqual([other]);
    expect(partial.status).toBe('sent');
    expect(outcomeOf({ recipientOutcomes: partial.recipientOutcomes! }, blocked)).toMatchObject({
      status: 'failed', code: 'recipient_suppressed', error: expect.stringContaining('hpc.email 的抑制名单'),
    });
    // 抑制只对这个发信域名生效
    await send(runtime, f.sender, `${f.prefix}-owner@another.test`, [blocked], `${f.prefix}-other-domain`);
    expect(sent.map((item) => item.to)).toEqual([other, blocked]);
  });

  it('API 返回 422 recipient_suppressed 错误信封，过期的抑制不再拦截', async () => {
    const f = await fixture();
    const target = f.ext('expired');
    await env.db.prepare(`INSERT INTO email_suppressions (address, sending_domain, reason, detail, expires_at, updated_at)
      VALUES (?, 'hpc.email', 'soft_bounce', '', ?, ?)`).bind(target, Date.now() + 60_000, Date.now()).run();
    const sid = await createSession(env, f.user.id);
    const token = await signToken(env.jwt_secret, { sub: f.user.id, sid, epoch: 0, uepoch: 0 });
    const { runtime } = mailEnv();
    const request = () => {
      const ctx = createExecutionContext();
      return app.request('/api/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { localPart: `${f.prefix}-owner`, domain: 'hpc.email' }, to: [target], subject: `${f.prefix}-api`, text: 'x' }) }, runtime, ctx)
        .then(async (response) => { await waitOnExecutionContext(ctx); return response; });
    };
    const rejected = await request();
    expect(rejected.status).toBe(422);
    const body = await rejected.json() as { error: { code: string; fix: string; details: { suppressed: unknown[] } } };
    expect(body.error.code).toBe('recipient_suppressed');
    expect(body.error.fix).toContain('管理员');
    expect(body.error.details.suppressed).toHaveLength(1);
    await env.db.prepare('UPDATE email_suppressions SET expires_at = ? WHERE address = ?').bind(Date.now() - 1, target).run();
    expect((await request()).status).toBe(201);
  });

  it('发件结果还在 pending、或对应关系还没写入时稍后重试；旧事件与别处发出的邮件直接确认', async () => {
    const f = await fixture();
    const pending = (await db.insert(messages).values({ direction: 'outbound', address: f.address, domain: 'hpc.email',
      fromAddress: f.address, status: 'pending', recipientOutcomes: [{ address: f.ext('p'), status: 'sent' }] }).returning().get())!;
    await env.db.prepare(`INSERT INTO email_delivery_refs (provider_message_id, kind, message_id, sender, recipient, created_at)
      VALUES (?, 'message', ?, ?, ?, ?)`).bind(`${f.prefix}-pending`, pending.id, f.address, f.ext('p'), Date.now()).run();
    const pendingEvent = event('delivered', { messageId: `${f.prefix}-pending`, sender: f.address, recipient: f.ext('p') });
    expect(await processDeliveryEvent(env, pendingEvent, { attempts: 1 })).toBe('retry');
    expect(await processDeliveryEvent(env, pendingEvent, { attempts: 4 })).toBe('ignored');
    const unknown = event('delivered', { messageId: `${f.prefix}-missing`, sender: f.address, recipient: f.ext('q') });
    expect(await processDeliveryEvent(env, unknown, { attempts: 1 })).toBe('retry');
    expect(await processDeliveryEvent(env, unknown, { attempts: 4 })).toBe('unmatched');
    const old = event('delivered', { messageId: `${f.prefix}-missing`, sender: f.address, recipient: f.ext('q'),
      at: new Date(Date.now() - 3600_000).toISOString() });
    expect(await processDeliveryEvent(env, old, { attempts: 1 })).toBe('unmatched');
  });

  it('send() 没有返回消息 ID 时按本站 Message-ID 关联，再不行按唯一一条未回执的发件人与收件人兜底', async () => {
    const f = await fixture();
    const { runtime } = mailEnv({ withId: false });
    const a = f.ext('rfc');
    const first = await send(runtime, f.sender, f.address, [a], `${f.prefix}-rfc`);
    const ref = await db.select().from(emailDeliveryRefs).where(eq(emailDeliveryRefs.messageId, first.id)).get();
    expect(ref?.providerMessageId).toBeNull();
    // 另一条未回执的同对记录让兜底无法分辨，只能靠 Message-ID 命中
    const decoy = await env.db.prepare(`INSERT INTO email_delivery_refs (kind, message_id, sender, recipient, created_at)
      VALUES ('message', 0, ?, ?, ?) RETURNING id`).bind(f.address, a, Date.now()).first<{ id: number }>();
    expect(await processDeliveryEvent(env, event('delivered', { messageId: `<${ref!.rfcMessageId}>`, sender: f.address, recipient: a })))
      .toBe('applied');
    expect(outcomeOf(await outbound(first.id), a).status).toBe('delivered');
    await env.db.prepare('DELETE FROM email_delivery_refs WHERE id = ?').bind(decoy!.id).run();

    const second = await send(runtime, f.sender, f.address, [a], `${f.prefix}-pair`);
    expect(await processDeliveryEvent(env, event('delivered', { messageId: 'platform-id', sender: f.address, recipient: a })))
      .toBe('applied');
    expect(outcomeOf(await outbound(second.id), a).status).toBe('delivered');
    // 同一发件人与收件人有两条未回执的记录时无法分辨，不回写
    const third = await send(runtime, f.sender, f.address, [a], `${f.prefix}-pair-3`);
    const fourth = await send(runtime, f.sender, f.address, [a], `${f.prefix}-pair-4`);
    expect(await processDeliveryEvent(env, event('delivered', { messageId: 'platform-id-2', sender: f.address, recipient: a }), { attempts: 4 }))
      .toBe('unmatched');
    expect(outcomeOf(await outbound(third.id), a).status).toBe('sent');
    expect(outcomeOf(await outbound(fourth.id), a).status).toBe('sent');
  });

  it('中转转发在 Cloudflare 侧最终失败时，转发记录改为失败并在通知健康里可见', async () => {
    const f = await fixture();
    await updateUserNotifyPrefs(env, f.user.id, { forward: { enabled: true, addresses: [f.ext('fwd')] } });
    const { runtime } = mailEnv();
    const ctx = createExecutionContext();
    await handleInbound({ to: f.address, from: 'sender@example.org', headers: new Headers(),
      raw: new Response(`From: sender@example.org\r\nTo: ${f.address}\r\nSubject: ${f.prefix}-relay\r\n\r\nbody`).body!,
      forward: vi.fn(async () => { throw new Error('destination not verified'); }), setReject: vi.fn() } as unknown as ForwardableEmailMessage, runtime, ctx);
    await waitOnExecutionContext(ctx);
    const job = await db.select().from(notificationJobs).where(eq(notificationJobs.target, f.ext('fwd'))).get();
    expect(job).toMatchObject({ status: 'succeeded', forwardMode: 'relay' });
    const ref = await db.select().from(emailDeliveryRefs).where(eq(emailDeliveryRefs.recipient, f.ext('fwd'))).get();
    expect(ref).toMatchObject({ kind: 'forward', sender: 'no-reply@hpc.email', ownerIds: [f.user.id], providerMessageId: `cf-1-${f.ext('fwd')}` });

    expect(await processDeliveryEvent(env, event('bounced', { messageId: ref!.providerMessageId!, sender: 'no-reply@hpc.email',
      recipient: f.ext('fwd'), smtp: ['550', '5.1.1', '550 5.1.1 No such user'], bounceType: 'hard' }))).toBe('applied');
    const failed = await db.select().from(notificationJobs).where(eq(notificationJobs.id, job!.id)).get();
    expect(failed).toMatchObject({ status: 'failed', lastError: 'Cloudflare 侧最终投递失败：550 5.1.1 550 5.1.1 No such user' });
    const health = await getNotificationHealth(env, f.user.id);
    const forward = health.channels.find((channel) => channel.channel === 'forward')!;
    expect(forward.latest?.status).toBe('failed');
    expect(forward.failedCount).toBeGreaterThanOrEqual(1);
  });

  it('抑制条目：投诉长期有效且不被更短的退信覆盖，一般硬退信 7 天', async () => {
    const f = await fixture();
    const target = f.ext('mixed');
    await processDeliveryEvent(env, event('complained', { messageId: 'x', sender: 'a@hpc.email', recipient: target }));
    await processDeliveryEvent(env, event('bounced', { messageId: 'y', sender: 'a@hpc.email', recipient: target,
      smtp: ['421', '4.7.0', 'try later'], bounceType: 'soft' }));
    expect(await db.select().from(emailSuppressions).where(eq(emailSuppressions.address, target)).get())
      .toMatchObject({ reason: 'complaint', expiresAt: null });
    const policy = f.ext('policy');
    const at = new Date().toISOString();
    await processDeliveryEvent(env, event('bounced', { messageId: 'z', sender: 'a@hpc.email', recipient: policy, at,
      smtp: ['550', '5.7.1', 'blocked by policy'], bounceType: 'hard' }));
    const row = await db.select().from(emailSuppressions).where(eq(emailSuppressions.address, policy)).get();
    expect(row?.reason).toBe('hard_bounce');
    expect(row!.expiresAt!.getTime()).toBe(Date.parse(at) + 7 * 86_400_000);
  });
});

describe('Queue consumer 与管理接口', () => {
  it('逐条确认或延迟重投：处理异常与需要等待的消息重投，其余确认', async () => {
    const f = await fixture();
    const message = (body: unknown, attempts = 1) => ({ id: crypto.randomUUID(), timestamp: new Date(), body, attempts,
      ack: vi.fn(), retry: vi.fn() });
    const ignored = message({ type: 'cf.email.sending.message.deferred', payload: {} });
    const waiting = message(event('delivered', { messageId: `${f.prefix}-none`, sender: f.address, recipient: f.ext('w') }));
    const broken = message(event('delivered', { messageId: `${f.prefix}-none`, sender: f.address, recipient: f.ext('w') }));
    const brokenEnv = { ...env, db: { ...env.db, batch: async () => { throw new Error('D1 unavailable'); }, prepare: env.db.prepare.bind(env.db) } } as unknown as Env;
    const waitUntil = vi.fn();
    await handleDeliveryEventBatch({ queue: 'hpc-mail-email-events', messages: [ignored, waiting], metadata: {} as MessageBatchMetadata,
      retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>, env, { waitUntil });
    expect(ignored.ack).toHaveBeenCalledOnce();
    expect(waiting.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    await handleDeliveryEventBatch({ queue: 'hpc-mail-email-events', messages: [broken], metadata: {} as MessageBatchMetadata,
      retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>, brokenEnv, { waitUntil });
    expect(broken.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(broken.ack).not.toHaveBeenCalled();
  });

  it('管理员查看与解除抑制条目，解除写审计；普通用户无权访问', async () => {
    const f = await fixture();
    const admin = (await db.insert(users).values({ username: `${f.prefix}-admin`, role: 'admin', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const token = async (id: number) => signToken(env.jwt_secret, { sub: id, sid: await createSession(env, id), epoch: 0, uepoch: 0 });
    const adminToken = await token(admin.id);
    const target = f.ext('listed');
    await processDeliveryEvent(env, event('complained', { messageId: 'x', sender: 'a@hpc.email', recipient: target }));
    const call = async (method: string, path: string, jwt: string) => {
      const ctx = createExecutionContext();
      const response = await app.request(`/api${path}`, { method, headers: { Authorization: `Bearer ${jwt}` } }, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    const listed = await call('GET', `/admin/suppressions?q=${encodeURIComponent(f.prefix)}`, adminToken);
    expect(listed.status).toBe(200);
    const page = (await listed.json() as { data: Page<EmailSuppression> }).data;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ address: target, sendingDomain: 'hpc.email', reason: 'complaint', expiresAt: null, detail: expect.any(String) });
    expect((await call('GET', '/admin/suppressions', await token(f.user.id))).status).toBe(403);
    expect((await call('DELETE', `/admin/suppressions/${page.items[0]!.id}`, adminToken)).status).toBe(200);
    expect((await call('DELETE', `/admin/suppressions/${page.items[0]!.id}`, adminToken)).status).toBe(404);
    expect(await db.select().from(emailSuppressions).where(eq(emailSuppressions.address, target)).get()).toBeUndefined();
    expect(await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, target)).get()).toMatchObject({ action: 'suppression.delete' });

    const overview = await call('GET', '/admin/delivery-events', adminToken);
    expect((await overview.json() as { data: DeliveryEventsOverview }).data).toMatchObject({
      enabled: true, credentials: false, queue: 'hpc-mail-email-events', subscriptions: expect.any(Array),
    });
  });

  it('发件摘要类型：201 响应里的逐收件人结果保持原有字段', async () => {
    const f = await fixture();
    const { runtime } = mailEnv();
    const summary: MessageSummary = await send(runtime, f.sender, f.address, [f.ext('shape')], `${f.prefix}-shape`);
    expect(summary.recipientOutcomes).toEqual([{ address: f.ext('shape'), status: 'sent' }]);
  });
});

/** 截获经 env.db 发出的语句与绑定参数，逐条取 EXPLAIN QUERY PLAN（D1 没有 STAT4，小数据上的计划即线上计划） */
async function capturePlans(run: (e: Env) => Promise<unknown>): Promise<{ sql: string; plan: string }[]> {
  const statements: { sql: string; params: unknown[] }[] = [];
  const proxied = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const entry = { sql: query, params: [] as unknown[] };
        statements.push(entry);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { entry.params = args; return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await run({ ...env, db: proxied } as Env);
  const out: { sql: string; plan: string }[] = [];
  for (const statement of statements) {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
    out.push({ sql: statement.sql.replace(/\s+/g, ' '), plan: plan.results.map((row) => row.detail).join(' | ') });
  }
  return out;
}

describe('查询计划', () => {
  it('回执查找、发件回写、转发回写、抑制查询与清理都走索引，不扫全表', async () => {
    const f = await fixture();
    const { runtime } = mailEnv();
    const summary = await send(runtime, f.sender, f.address, [f.ext('plan')], `${f.prefix}-plan`);
    const plans = await capturePlans(async (e) => {
      await processDeliveryEvent(e, event('bounced', { messageId: `cf-1-${f.ext('plan')}`, sender: f.address, recipient: f.ext('plan'),
        smtp: ['550', '5.1.1', 'unknown'], bounceType: 'hard' }));
      await processDeliveryEvent(e, event('delivered', { messageId: 'none', sender: f.address, recipient: f.ext('none') }), { attempts: 9 });
      await env.db.prepare(`INSERT INTO email_delivery_refs (provider_message_id, kind, message_id, sender, recipient, owner_ids, created_at)
        VALUES (?, 'forward', ?, 'no-reply@hpc.email', ?, ?, ?)`).bind(`${f.prefix}-fwd`, summary.id, f.ext('fwd'), `[${f.user.id}]`, Date.now()).run();
      await processDeliveryEvent(e, event('failed', { messageId: `${f.prefix}-fwd`, sender: 'no-reply@hpc.email', recipient: f.ext('fwd') }));
      const { lookupSuppressions, cleanupExpiredSuppressions } = await import('../src/services/suppression.js');
      const { cleanupDeliveryRefs } = await import('../src/services/delivery-events.js');
      await lookupSuppressions(e, [f.ext('plan'), f.ext('other')]);
      await cleanupDeliveryRefs(e);
      await cleanupExpiredSuppressions(e);
    });
    const expected: [RegExp, RegExp][] = [
      [/FROM email_delivery_refs WHERE provider_message_id/, /USING INDEX idx_delivery_refs_provider/],
      [/FROM email_delivery_refs WHERE rfc_message_id/, /USING INDEX idx_delivery_refs_rfc/],
      [/INDEXED BY idx_delivery_refs_pending_pair/, /USING INDEX idx_delivery_refs_pending_pair \(recipient=\? AND sender=\?\)/],
      [/^INSERT INTO email_suppressions/, /.*/],
      [/FROM messages WHERE id = \? AND direction/, /USING INTEGER PRIMARY KEY/],
      [/^UPDATE messages SET recipient_outcomes/, /USING INTEGER PRIMARY KEY/],
      [/^UPDATE notification_jobs/, /USING INDEX notification_jobs_dedupe_key_unique \(dedupe_key=\?\)/],
      [/FROM email_suppressions WHERE address IN/, /USING INDEX idx_suppressions_address_domain \(address=\?\)/],
      [/DELETE FROM email_delivery_refs/, /USING (COVERING )?INDEX idx_delivery_refs_created \(created_at<\?\)/],
      [/DELETE FROM email_suppressions/, /USING (COVERING )?INDEX idx_suppressions_expires/],
    ];
    for (const [sql, plan] of expected) {
      const matched = plans.filter((item) => sql.test(item.sql));
      expect(matched.length, sql.source).toBeGreaterThan(0);
      for (const item of matched) expect(item.plan, item.sql).toMatch(plan);
    }
    for (const item of plans) expect(item.plan, item.sql).not.toMatch(/SCAN (email_delivery_refs|email_suppressions|messages|notification_jobs)\b(?! USING)/);
  });
});
