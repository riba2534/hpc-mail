import {
  MAX_DRAFTS_PER_USER, type ApiScope, type CreatedApiKey, type Draft, type DraftSummary, type MessageSummary, type Page,
  type SingleUploadResult,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { apiKeys, draftAttachments, drafts, idempotencyRecords, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { TEST_PASSWORD, testPasswordHash, USER_SCOPES } from './key-helpers.js';
import { DRAFT_SENDING_LEASE_MS, dispatchDueDrafts, purgeSentDrafts } from '../src/services/drafts.js';
import { runDraftAttachmentCleanup } from '../src/services/scheduled.js';
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
const MINUTE = 60_000;

/** 外发走 mock 的 send_email；fail 返回原因时该目标被明确拒收（E_DELIVERY_FAILED） */
function mailEnv(fail: (to: string) => string | null = () => null) {
  const send = vi.fn(async (mail: { to: string }) => {
    const reason = fail(mail.to);
    if (reason) throw Object.assign(new Error(reason), { code: 'E_DELIVERY_FAILED' });
  });
  return { ...env, email: { send } } as unknown as Env;
}

async function call(path: string, init?: RequestInit, runtime: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const req = (token: string, method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function failure(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string; fix?: string; details?: Record<string, unknown> } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function account(name: string, scopes: ApiScope[] = USER_SCOPES, role: 'user' | 'admin' = 'user') {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username: name, role, passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const created = await data<CreatedApiKey>(await call('/api/api-keys', req(jwt, 'POST', { name: `${name}-agent`, scopes, rateLimit: 600, password: TEST_PASSWORD })), 201);
  return { id: user!.id, jwt, key: created.key, keyId: created.id, address: `${name}@hpc.email` };
}

const complete = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from, to: [to], subject: `draft to ${to}`, text: 'hello', ...extra });
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();
const row = (id: number) => db.select().from(drafts).where(eq(drafts.id, id)).get();

/** 把草稿的 send_at 挪到过去，模拟到点 */
async function makeDue(id: number) {
  await db.update(drafts).set({ sendAt: new Date(Date.now() - MINUTE) }).where(eq(drafts.id, id));
}

async function dispatch(runtime: Env = env) {
  const ctx = createExecutionContext();
  const report = await dispatchDueDrafts(runtime, ctx);
  await waitOnExecutionContext(ctx);
  return report;
}

describe('草稿的增删改查与权限', () => {
  it('Agent 用 Key 创建、网页列出并看到来源；别人看不到；读写 scope 与来源邮件的 mail.read', async () => {
    const me = await account('draft-crud');
    const other = await account('draft-other');
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', {
      to: ['Bob <bob-crud@hpc.email>'], subject: '待审', html: '<p>请确认</p>',
    })), 201);
    expect(created).toMatchObject({ status: 'draft', version: 1, createdVia: 'api', apiKeyName: 'draft-crud-agent', from: null,
      to: [{ address: 'bob-crud@hpc.email', name: 'Bob' }], subject: '待审', html: '<p>请确认</p>', text: '', sendAt: null, messageId: null });
    const listed = await data<Page<DraftSummary>>(await call('/api/drafts', req(me.jwt, 'GET')));
    expect(listed.items.map((item) => [item.id, item.createdVia, item.apiKeyName, item.preview])).toEqual([[created.id, 'api', 'draft-crud-agent', '请确认']]);
    expect(listed.items[0]).not.toHaveProperty('html');
    for (const [method, path] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/send']] as const) {
      const response = await call(`/v1/drafts/${created.id}${path}`, req(other.key, method, method === 'PATCH' ? { subject: 'x' } : undefined));
      expect((await failure(response, 404)).code, `${method}${path}`).toBe('not_found');
    }
    expect((await data<Page<DraftSummary>>(await call('/api/drafts', req(other.jwt, 'GET')))).items).toEqual([]);

    const reader = await account('draft-reader', ['mail.read']);
    expect((await data<Page<DraftSummary>>(await call('/v1/drafts', req(reader.key, 'GET')))).items).toEqual([]);
    expect((await failure(await call('/v1/drafts', req(reader.key, 'POST', { subject: 's' })), 403)).message).toContain('mail.send');
    const sender = await account('draft-sender', ['mail.send']);
    await data(await call('/v1/drafts', req(sender.key, 'GET')));
    expect((await failure(await call('/v1/drafts', req(sender.key, 'POST', { replyToMessageId: 1 })), 403)).message).toContain('mail.read');
    const boxOnly = await account('draft-box', ['mailbox.read']);
    expect((await failure(await call('/v1/drafts', req(boxOnly.key, 'GET')), 403)).message).toContain('mail.read 或 mail.send');
  });

  it('PATCH 缺省保持、null 清空；expectedVersion 不一致 409 并给出当前版本；DELETE 后 404', async () => {
    const me = await account('draft-patch');
    const created = await data<Draft>(await call('/api/drafts', req(me.jwt, 'POST', complete(me.address, 'p1@hpc.email', { cc: ['c@hpc.email'] }))), 201);
    expect(created.createdVia).toBe('web');
    const patched = await data<Draft>(await call(`/api/drafts/${created.id}`, req(me.jwt, 'PATCH', { subject: '新主题', from: null, expectedVersion: 1 })));
    expect(patched).toMatchObject({ version: 2, subject: '新主题', from: null, text: 'hello', cc: [{ address: 'c@hpc.email', name: '' }] });
    const stale = await failure(await call(`/api/drafts/${created.id}`, req(me.jwt, 'PATCH', { subject: 'x', expectedVersion: 1 })), 409);
    expect(stale).toMatchObject({ code: 'draft_state_conflict', details: { draftStatus: 'draft', draftVersion: 2 } });
    expect(await data(await call(`/api/drafts/${created.id}`, req(me.jwt, 'DELETE')))).toEqual({ success: true });
    expect((await failure(await call(`/api/drafts/${created.id}`, req(me.jwt, 'GET')), 404)).code).toBe('not_found');
  });

  it('创建的 Idempotency-Key：同体重放 200 同一份，异体 409；不带键各建一份', async () => {
    const me = await account('draft-idem');
    const body = complete(me.address, 'i@hpc.email');
    const first = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', body, { 'Idempotency-Key': 'agent-draft-1' })), 201);
    const again = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', body, { 'Idempotency-Key': 'agent-draft-1' })), 200);
    expect(again.id).toBe(first.id);
    expect((await failure(await call('/v1/drafts', req(me.key, 'POST', { ...body, subject: 'other' }, { 'Idempotency-Key': 'agent-draft-1' })), 409)).code)
      .toBe('idempotency_mismatch');
    // 网页会话的同名键是另一个命名空间
    expect((await data<Draft>(await call('/api/drafts', req(me.jwt, 'POST', body, { 'Idempotency-Key': 'agent-draft-1' })), 201)).id).not.toBe(first.id);
    const count = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.userId, me.id));
    expect(count).toHaveLength(2);
  });

  it(`未发送的草稿最多 ${MAX_DRAFTS_PER_USER} 份，已发送的不计入`, async () => {
    const me = await account('draft-limit');
    const now = Date.now();
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO drafts (user_id, status, content, created_via, created_at, updated_at) SELECT ?, 'draft', '{}', 'web', ?, ? FROM n`)
      .bind(MAX_DRAFTS_PER_USER, me.id, now, now).run();
    const error = await failure(await call('/v1/drafts', req(me.key, 'POST', { subject: 'one more' })), 409);
    expect(error.code).toBe('draft_limit_reached');
    expect(error.fix).toContain('GET /drafts');
    await env.db.prepare(`UPDATE drafts SET status = 'sent' WHERE id = (SELECT id FROM drafts WHERE user_id = ? LIMIT 1)`).bind(me.id).run();
    await data(await call('/v1/drafts', req(me.key, 'POST', { subject: 'one more' })), 201);
  });

  it('长正文与邮件同一口径落 R2，读取返回全文；改正文后旧对象登记清理', async () => {
    const me = await account('draft-body');
    const html = `<p>${'长'.repeat(5000)}</p>`;
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', { html, text: 't' })), 201);
    const stored = await row(created.id);
    expect(stored!.bodyR2Key).toBeTruthy();
    expect(stored!.bodyHtml).toBe('');
    expect((await data<Draft>(await call(`/v1/drafts/${created.id}`, req(me.key, 'GET')))).html).toBe(html);
    await data(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', { html: '<p>short</p>' })));
    const job = await env.db.prepare('SELECT COUNT(*) AS n FROM storage_cleanup_jobs WHERE r2_key = ?').bind(stored!.bodyR2Key).first<{ n: number }>();
    expect(job!.n).toBe(1);

    // 只改一段时另一段按全文沿用：D1 里只有截断的搜索文本（只有 HTML 时还是 HTML 转出的文字），不能当成原文写回
    const text = '文'.repeat(5000);
    const longText = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', { text, html })), 201);
    const patched = await data<Draft>(await call(`/v1/drafts/${longText.id}`, req(me.key, 'PATCH', { html: '<p>short</p>' })));
    expect([patched.text, patched.html]).toEqual([text, '<p>short</p>']);
    const htmlOnly = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', { html })), 201);
    const retexted = await data<Draft>(await call(`/v1/drafts/${htmlOnly.id}`, req(me.key, 'PATCH', { text: 'plain' })));
    expect([retexted.text, retexted.html]).toEqual(['plain', html]);
    const rehtml = await data<Draft>(await call(`/v1/drafts/${htmlOnly.id}`, req(me.key, 'PATCH', { html: '<p>x</p>' })));
    expect([rehtml.text, rehtml.html]).toEqual(['plain', '<p>x</p>']);
  });
});

describe('草稿附件', () => {
  it('base64 附件转存并被草稿引用；替换后旧附件释放；被引用的附件不能直接删除、不能放进别的草稿、不按 24h 过期', async () => {
    const me = await account('draft-att');
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', {
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: btoa('aaa') }],
    })), 201);
    expect(created.attachments).toMatchObject([{ filename: 'a.txt', mimeType: 'text/plain', size: 3, contentId: '', disposition: 'attachment' }]);
    const token = created.attachments[0]!.token;
    const pinned = await db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get();
    expect(pinned).toMatchObject({ draftId: created.id, status: 'ready' });

    const deleteError = await failure(await call(`/v1/uploads/${token}`, req(me.key, 'DELETE')), 409);
    expect(deleteError).toMatchObject({ code: 'draft_state_conflict' });
    expect(deleteError.fix).toContain(`PATCH /drafts/${created.id}`);
    const otherDraft = await failure(await call('/v1/drafts', req(me.key, 'POST', { attachmentTokens: [token] })), 400);
    expect(otherDraft.message).toContain(`草稿 #${created.id}`);
    const direct = await failure(await call('/v1/messages', req(me.key, 'POST', { ...complete(me.address, 'x@hpc.email'), attachmentTokens: [token] })), 400);
    expect(direct.message).toContain('附件不存在或无权使用');

    await db.update(draftAttachments).set({ createdAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(draftAttachments.token, token));
    await runDraftAttachmentCleanup(env);
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get()).toBeTruthy();

    // 保留原附件并加一张内联图
    const kept = await data<Draft>(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', {
      attachmentTokens: [token], attachments: [{ filename: 'logo.png', contentType: 'image/png', content: btoa('png'), contentId: 'logo' }],
    })));
    expect(kept.attachments.map((a) => [a.filename, a.contentId, a.disposition])).toEqual([['logo.png', 'logo', 'inline'], ['a.txt', '', 'attachment']]);
    // 清空附件：两份都释放（删行、登记对象清理）
    const cleared = await data<Draft>(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', { attachmentTokens: [] })));
    expect(cleared.attachments).toEqual([]);
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
    const jobs = await env.db.prepare(`SELECT COUNT(*) AS n FROM storage_cleanup_jobs WHERE r2_key LIKE ?`).bind(`draft/${me.id}/%`).first<{ n: number }>();
    expect(jobs!.n).toBe(2);
  });

  it('引用已上传的附件；删除草稿时释放它', async () => {
    const me = await account('draft-upload');
    const upload = await data<SingleUploadResult>(await call('/v1/uploads?filename=r.pdf&mimeType=application%2Fpdf', {
      method: 'POST', headers: { Authorization: `Bearer ${me.key}`, 'Content-Length': '3' }, body: 'pdf',
    }), 201);
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', { attachmentTokens: [upload.token] })), 201);
    expect(created.attachments.map((a) => a.token)).toEqual([upload.token]);
    await data(await call(`/v1/drafts/${created.id}`, req(me.key, 'DELETE')));
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.token, upload.token)).get()).toBeUndefined();
  });
});

describe('立即发送', () => {
  it('发送成功：与 POST /messages 同样的 201；草稿 sent、附件回收；再发重放原结果；已发送不能改', async () => {
    const me = await account('draft-send');
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'send-peer@hpc.email', {
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: btoa('aaa') }],
    }))), 201);
    const sent = await data<MessageSummary>(await call(`/api/drafts/${created.id}/send`, req(me.jwt, 'POST')), 201);
    expect(sent).toMatchObject({ direction: 'outbound', status: 'delivered', address: me.address, hasAttachments: true });
    expect(await row(created.id)).toMatchObject({ status: 'sent', messageId: sent.id, attempt: 1 });
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
    const replay = await data<MessageSummary>(await call(`/v1/drafts/${created.id}/send`, req(me.key, 'POST')), 201);
    expect(replay.id).toBe(sent.id);
    expect(await db.select({ id: messages.id }).from(messages).where(and(eq(messages.address, me.address), eq(messages.direction, 'outbound')))).toHaveLength(1);
    expect((await failure(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', { subject: 'late' })), 409)).details).toMatchObject({ draftStatus: 'sent' });
  });

  it('全部收件人被拒收：422 delivery_failed，草稿 failed 并保留附件；修正后可再发', async () => {
    const me = await account('draft-reject');
    const runtime = mailEnv((to) => (to.endsWith('@bad.example') ? 'mailbox does not exist' : null));
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'x@bad.example', {
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: btoa('aaa') }],
    }))), 201);
    const error = await failure(await call(`/v1/drafts/${created.id}/send`, req(me.key, 'POST'), runtime), 422);
    expect(error.code).toBe('delivery_failed');
    const failed = await row(created.id);
    expect(failed).toMatchObject({ status: 'failed', messageId: error.details!.messageId });
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toHaveLength(1);
    await data(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', { to: ['ok@good.example'] })));
    const sent = await data<MessageSummary>(await call(`/v1/drafts/${created.id}/send`, req(me.key, 'POST'), runtime), 201);
    expect(sent.status).toBe('sent');
    expect(await row(created.id)).toMatchObject({ status: 'sent', messageId: sent.id, attempt: 2 });
  });

  it('发送前的 4xx（不完整、发件人无权）不外发，草稿回到原状态并记下原因', async () => {
    const me = await account('draft-4xx');
    const incomplete = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', { subject: 'no body' })), 201);
    expect((await failure(await call(`/v1/drafts/${incomplete.id}/send`, req(me.key, 'POST')), 400)).message).toContain('草稿还不能发送');
    expect(await row(incomplete.id)).toMatchObject({ status: 'draft', messageId: null });
    const scheduled = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete('stranger@hpc.email', 'y@hpc.email', { sendAt: inMinutes(10) }))), 201);
    expect((await failure(await call(`/v1/drafts/${scheduled.id}/send`, req(me.key, 'POST')), 403)).code).toBe('forbidden');
    const after = await row(scheduled.id);
    expect(after).toMatchObject({ status: 'scheduled', messageId: null });
    expect(after!.errorDetail).toBeTruthy();
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.address, 'stranger@hpc.email'))).toEqual([]);
  });
});

describe('定时发送', () => {
  it('sendAt 范围与完整性：太近、太远、内容不完整都拒绝；PATCH sendAt:null 取消定时', async () => {
    const me = await account('draft-sched');
    expect((await failure(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'a@hpc.email', { sendAt: inMinutes(0.5) }))), 400)).message)
      .toContain('1 分钟');
    expect((await failure(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'a@hpc.email', { sendAt: inMinutes(31 * 24 * 60) }))), 400)).message)
      .toContain('30 天');
    const incomplete = await failure(await call('/v1/drafts', req(me.key, 'POST', { subject: 's', sendAt: inMinutes(10) })), 400);
    expect(incomplete.message).toContain('草稿还不能发送');
    expect(await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.userId, me.id))).toEqual([]);
    const scheduled = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'a@hpc.email', { sendAt: inMinutes(10) }))), 201);
    expect(scheduled.status).toBe('scheduled');
    expect(await row(scheduled.id)).toMatchObject({ scheduledByKeyId: me.keyId, scheduledAuthVersion: 0 });
    // 定时中的草稿改内容后仍须完整
    expect((await failure(await call(`/v1/drafts/${scheduled.id}`, req(me.key, 'PATCH', { to: [] })), 400)).message).toContain('至少需要一个收件人');
    const cancelled = await data<Draft>(await call(`/v1/drafts/${scheduled.id}`, req(me.key, 'PATCH', { sendAt: null })));
    expect(cancelled).toMatchObject({ status: 'draft', sendAt: null });
  });

  it('到点由每分钟的 cron 发出，未到点不动；cron 分派只跑草稿派发', async () => {
    const me = await account('draft-cron');
    const due = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'cron-a@hpc.email', { sendAt: inMinutes(5) }))), 201);
    const later = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'cron-b@hpc.email', { sendAt: inMinutes(5) }))), 201);
    await makeDue(due.id);
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    const sent = await row(due.id);
    expect(sent).toMatchObject({ status: 'sent', attempt: 1 });
    expect(await db.select({ status: messages.status }).from(messages).where(eq(messages.id, sent!.messageId!)).get()).toEqual({ status: 'delivered' });
    expect(await row(later.id)).toMatchObject({ status: 'scheduled', attempt: 0 });
    // 空闲时再跑一次什么都不做
    expect(await dispatch()).toEqual({ sent: 0, failed: 0, recovered: 0 });
  });

  it('到点复核：安排它的 Key 被吊销、账户改密（auth_version 变化）后取消发送并写明原因', async () => {
    const me = await account('draft-revoke');
    const byKey = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'r1@hpc.email', { sendAt: inMinutes(5) }))), 201);
    const byWeb = await data<Draft>(await call('/api/drafts', req(me.jwt, 'POST', complete(me.address, 'r2@hpc.email', { sendAt: inMinutes(5) }))), 201);
    expect(await row(byWeb.id)).toMatchObject({ scheduledByKeyId: null, scheduledAuthVersion: 0 });
    await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, me.keyId));
    await makeDue(byKey.id);
    await makeDue(byWeb.id);
    await dispatch();
    expect(await row(byKey.id)).toMatchObject({ status: 'failed', errorDetail: expect.stringContaining('API Key 已失效') });
    expect(await row(byWeb.id)).toMatchObject({ status: 'sent' });

    const other = await account('draft-revoke2');
    const draft = await data<Draft>(await call('/api/drafts', req(other.jwt, 'POST', complete(other.address, 'r3@hpc.email', { sendAt: inMinutes(5) }))), 201);
    await db.update(users).set({ authVersion: 1 }).where(eq(users.id, other.id));
    await makeDue(draft.id);
    await dispatch();
    expect(await row(draft.id)).toMatchObject({ status: 'failed', errorDetail: expect.stringContaining('账户安全状态已变化') });
    expect(await db.select({ id: messages.id }).from(messages).where(and(eq(messages.address, other.address), eq(messages.direction, 'outbound')))).toEqual([]);
  });

  it('定时发送遇到发送前的 4xx：标 failed，不再自动重试', async () => {
    const me = await account('draft-cron4xx');
    const draft = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'x@hpc.email', { sendAt: inMinutes(5) }))), 201);
    await db.update(mailboxes).set({ userId: 999_999 }).where(eq(mailboxes.address, me.address));
    await makeDue(draft.id);
    expect(await dispatch()).toMatchObject({ failed: 1 });
    expect(await row(draft.id)).toMatchObject({ status: 'failed', messageId: null });
  });
});

describe('发送中断的恢复', () => {
  async function staleDraft(name: string, overrides: Partial<typeof drafts.$inferInsert>) {
    const me = await account(name);
    const draft = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, `${name}-to@hpc.email`, { sendAt: inMinutes(5) }))), 201);
    await db.update(drafts).set({ status: 'sending', attempt: 1, claimedAt: new Date(Date.now() - DRAFT_SENDING_LEASE_MS - MINUTE), ...overrides })
      .where(eq(drafts.id, draft.id));
    return { me, id: draft.id };
  }

  it('幂等记录已绑定发件行：按发件行定结果（sent 或 failed），绝不重发', async () => {
    const { me, id } = await staleDraft('draft-stale-bound', {});
    const [message] = await db.insert(messages).values({ direction: 'outbound', address: me.address, domain: 'hpc.email', status: 'sent',
      fromAddress: me.address, subject: 's', preview: 'p' }).returning({ id: messages.id });
    await db.insert(idempotencyRecords).values({ actorType: 'draft', actorId: id, key: '1', requestHash: 'h', status: 'pending',
      messageId: message!.id, updatedAt: new Date() });
    expect(await dispatch()).toMatchObject({ recovered: 1 });
    expect(await row(id)).toMatchObject({ status: 'sent', messageId: message!.id, errorDetail: expect.stringContaining('待确认') });
  });

  it('没有绑定：标记幂等记录失败（迟到的绑定不会外发），安排过定时的重排，超过 3 次标失败', async () => {
    const { id } = await staleDraft('draft-stale-free', {});
    await db.insert(idempotencyRecords).values({ actorType: 'draft', actorId: id, key: '1', requestHash: 'h', status: 'pending', updatedAt: new Date() });
    await dispatch();
    expect(await row(id)).toMatchObject({ status: 'scheduled', messageId: null });
    const record = await db.select().from(idempotencyRecords).where(and(eq(idempotencyRecords.actorType, 'draft'), eq(idempotencyRecords.actorId, id))).get();
    expect(record!.status).toBe('failed');
    const { id: exhausted } = await staleDraft('draft-stale-max', { attempt: 3 });
    await dispatch();
    expect(await row(exhausted)).toMatchObject({ status: 'failed' });
    const { id: never } = await staleDraft('draft-stale-now', { sendAt: null });
    await dispatch();
    expect(await row(never)).toMatchObject({ status: 'failed' });
  });
});

describe('保留期', () => {
  it('已发送超过 7 天的草稿被删除，未到期与未发送的保留', async () => {
    const me = await account('draft-purge');
    const now = Date.now();
    const insert = (status: string, sentAt: number | null) => env.db.prepare(`INSERT INTO drafts (user_id, status, content, created_via, created_at, updated_at, sent_at)
      VALUES (?, ?, '{}', 'web', ?, ?, ?) RETURNING id`).bind(me.id, status, now, now, sentAt).first<{ id: number }>();
    const old = await insert('sent', now - 8 * 86_400_000);
    const fresh = await insert('sent', now - 86_400_000);
    const unsent = await insert('draft', null);
    expect(await purgeSentDrafts(env, now)).toBeGreaterThanOrEqual(1);
    expect(await row(old!.id)).toBeUndefined();
    expect(await row(fresh!.id)).toBeTruthy();
    expect(await row(unsent!.id)).toBeTruthy();
  });
});

describe('人审：发送时锁定审阅过的版本', () => {
  it('审阅后被 Agent 改过就 409 不发；版本一致才发；已发送的带旧版本仍重放原结果', async () => {
    const me = await account('draft-review');
    const created = await data<Draft>(await call('/v1/drafts', req(me.key, 'POST', complete(me.address, 'review-a@hpc.email'))), 201);
    const changed = await data<Draft>(await call(`/v1/drafts/${created.id}`, req(me.key, 'PATCH', { to: ['review-b@hpc.email'] })));
    const stale = await failure(await call(`/api/drafts/${created.id}/send`, req(me.jwt, 'POST', { expectedVersion: created.version })), 409);
    expect(stale).toMatchObject({ code: 'draft_state_conflict', details: { draftStatus: 'draft', draftVersion: changed.version } });
    expect(await db.select({ id: messages.id }).from(messages).where(and(eq(messages.address, me.address), eq(messages.direction, 'outbound')))).toEqual([]);
    const sent = await data<MessageSummary>(await call(`/api/drafts/${created.id}/send`, req(me.jwt, 'POST', { expectedVersion: changed.version })), 201);
    expect(sent.recipientsTo).toEqual(['review-b@hpc.email']);
    const replay = await data<MessageSummary>(await call(`/api/drafts/${created.id}/send`, req(me.jwt, 'POST', { expectedVersion: changed.version })), 201);
    expect(replay.id).toBe(sent.id);
    expect((await failure(await call(`/api/drafts/${created.id}/send`, req(me.jwt, 'POST', { expectedVersion: 'x' })), 400)).code).toBe('validation_failed');
  });
});

describe('限定范围的 Key（PR4a）', () => {
  async function restricted(name: string) {
    const me = await account(name);
    const [inScope] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, me.address));
    await db.insert(mailboxes).values({ address: `${name}-other@hpc.email`, domain: 'hpc.email', userId: me.id });
    const created = await data<CreatedApiKey>(await call('/api/api-keys', req(me.jwt, 'POST', {
      name: `${name}-narrow`, scopes: USER_SCOPES, rateLimit: 600, password: TEST_PASSWORD, allowedMailboxIds: [inScope!.id],
    })), 201);
    return { ...me, narrowKey: created.key, narrowKeyId: created.id, other: `${name}-other@hpc.email`, inScopeId: inScope!.id };
  }

  it('只能用范围内的发件地址；只看得到、改得了自己创建的草稿', async () => {
    const me = await restricted('draft-narrow');
    const denied = await failure(await call('/v1/drafts', req(me.narrowKey, 'POST', complete(me.other, 'n1@hpc.email'))), 403);
    expect(denied.message).toContain('限定了可用的邮箱或域名');
    const mine = await data<Draft>(await call('/v1/drafts', req(me.narrowKey, 'POST', complete(me.address, 'n1@hpc.email'))), 201);
    expect((await failure(await call(`/v1/drafts/${mine.id}`, req(me.narrowKey, 'PATCH', { from: me.other })), 403)).code).toBe('forbidden');
    // 回复、转发引用的来源邮件同样要在范围内
    const hidden = (await db.insert(messages).values({ direction: 'inbound', address: me.other, domain: 'hpc.email',
      fromAddress: 'x@ext.test', subject: 'hidden', preview: '', status: 'received' }).returning({ id: messages.id }))[0]!.id;
    for (const ref of [{ replyToMessageId: hidden }, { forwardAttachmentsFrom: hidden }]) {
      expect((await failure(await call('/v1/drafts', req(me.narrowKey, 'POST', complete(me.address, 'n1@hpc.email', ref))), 403)).code).toBe('forbidden');
      expect((await failure(await call(`/v1/drafts/${mine.id}`, req(me.narrowKey, 'PATCH', ref)), 403)).code).toBe('forbidden');
    }
    const web = await data<Draft>(await call('/api/drafts', req(me.jwt, 'POST', complete(me.other, 'n2@hpc.email'))), 201);
    const listed = await data<Page<DraftSummary>>(await call('/v1/drafts', req(me.narrowKey, 'GET')));
    expect(listed.items.map((item) => item.id)).toEqual([mine.id]);
    for (const [method, path] of [['GET', ''], ['DELETE', ''], ['POST', '/send']] as const) {
      expect((await failure(await call(`/v1/drafts/${web.id}${path}`, req(me.narrowKey, method)), 404)).code, `${method}${path}`).toBe('not_found');
    }
    // 不限范围的 Key 照常看到全部
    expect((await data<Page<DraftSummary>>(await call('/v1/drafts', req(me.key, 'GET')))).items.map((item) => item.id)).toEqual([web.id, mine.id]);
  });

  it('到点时 Key 已不再覆盖发件地址：取消发送', async () => {
    const me = await restricted('draft-narrow-cron');
    const draft = await data<Draft>(await call('/v1/drafts', req(me.narrowKey, 'POST', complete(me.address, 'n3@hpc.email', { sendAt: inMinutes(5) }))), 201);
    await db.update(apiKeys).set({ allowedMailboxIds: [me.inScopeId + 100_000] }).where(eq(apiKeys.id, me.narrowKeyId));
    await makeDue(draft.id);
    await dispatch();
    expect(await row(draft.id)).toMatchObject({ status: 'failed', errorDetail: expect.stringContaining('不再覆盖这个发件地址') });
  });
});
