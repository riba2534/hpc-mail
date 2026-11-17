import { API_SCOPES, MAX_BATCH_SEND_ITEMS, type ApiScope, type BatchSendResult, type CreatedApiKey, type MessageSummary } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);

async function call(path: string, init?: RequestInit, runtime: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const post = (token: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function failure(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function account(name: string, scopes: ApiScope[] = [...API_SCOPES], quota = { dailyOutbound: 0, dailyRecipients: 0 }) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota,
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username: name, role: 'user', passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await call('/api/api-keys', post(jwt, { name: `${name}-key`, scopes, rateLimit: 600 })), 201);
  return { id: user!.id, key: key.key, address: `${name}@hpc.email` };
}

const item = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from, to: [to], subject: `batch ${to}`, text: 'body', ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('POST /v1/messages/batch', () => {
  it('逐项独立：合法项发出，校验失败、无权发件、非对象的项各自失败；HTTP 200 并按 index 排序', async () => {
    const me = await account('batch-mixed');
    const result = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: [
      item(me.address, 'batch-a@hpc.email'),
      { from: me.address, to: [], subject: 'no recipients', text: 'x' },
      item('stranger@hpc.email', 'batch-b@hpc.email'),
      'not an object',
      item(me.address, 'batch-c@hpc.email', { cc: ['Carol <batch-d@hpc.email>'] }),
    ] })));
    expect(result.items.map((r) => [r.index, r.ok, r.httpStatus])).toEqual([[0, true, 201], [1, false, 400], [2, false, 403], [3, false, 400], [4, true, 201]]);
    expect(result).toMatchObject({ succeeded: 2, failed: 3 });
    expect(result.items[0]!.message).toMatchObject({ direction: 'outbound', status: 'delivered', address: me.address });
    expect(result.items[1]!.error).toMatchObject({ code: 'validation_failed', message: '至少需要一个收件人' });
    expect(result.items[2]!.error).toMatchObject({ code: 'forbidden' });
    expect(result.items[2]!.error!.fix).toContain('/identities');
    expect(result.items[2]!.error!.docs).toMatch(/^http:\/\/localhost\/references\/errors\.md#/);
    expect(result.items[3]!.error!.message).toContain('发信请求对象');
    expect(result.items.every((r) => r.idempotencyKey === undefined)).toBe(true);
    const sent = await db.select({ id: messages.id }).from(messages).where(eq(messages.address, me.address));
    expect(sent).toHaveLength(2);
  });

  it('带回复或转发来源的项另需 mail.read：只有 mail.send 的 Key 该项 403，其余照发', async () => {
    const me = await account('batch-scope', ['mail.send']);
    const result = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: [
      item(me.address, 'batch-e@hpc.email', { replyToMessageId: 1 }),
      item(me.address, 'batch-f@hpc.email'),
    ] })));
    expect(result.items.map((r) => [r.ok, r.httpStatus, r.error?.code])).toEqual([[false, 403, 'forbidden'], [true, 201, undefined]]);
    expect(result.items[0]!.error!.message).toContain('mail.read');
  });

  it('幂等：请求头派生每项的键，整批重试逐项重放；项自带的键优先；同键异体 409', async () => {
    const me = await account('batch-idem');
    const body = { items: [item(me.address, 'batch-g@hpc.email'), item(me.address, 'batch-h@hpc.email', { idempotencyKey: 'own-key' })] };
    const first = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, body, { 'Idempotency-Key': 'nightly-1' })));
    expect(first.items.map((r) => r.idempotencyKey)).toEqual(['nightly-1:0', 'own-key']);
    const again = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, body, { 'Idempotency-Key': 'nightly-1' })));
    expect(again.items.map((r) => r.message!.id)).toEqual(first.items.map((r) => r.message!.id));
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.address, me.address))).toHaveLength(2);
    // 同一个键已用于单发：批量里用它发别的内容是 409，与单发一致
    const single = await data<MessageSummary>(await call('/v1/messages', post(me.key, item(me.address, 'batch-i@hpc.email'), { 'Idempotency-Key': 'shared' })), 201);
    const mismatch = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: [
      item(me.address, 'batch-j@hpc.email', { idempotencyKey: 'shared' }),
      item(me.address, 'batch-i@hpc.email', { idempotencyKey: 'shared' }),
    ] })));
    expect(mismatch.items.map((r) => [r.httpStatus, r.error?.code ?? r.message!.id])).toEqual([[409, 'idempotency_mismatch'], [201, single.id]]);
    // 头太长、派生后超过 128 位：该项 400
    const long = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: [item(me.address, 'batch-k@hpc.email')] },
      { 'Idempotency-Key': 'k'.repeat(127) })));
    expect(long.items[0]).toMatchObject({ ok: false, httpStatus: 400, error: { code: 'validation_failed' } });
  });

  it('配额逐项占用：超额的项是 429，前面的项照常发出', async () => {
    const me = await account('batch-quota', [...API_SCOPES], { dailyOutbound: 2, dailyRecipients: 0 });
    const result = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: [
      item(me.address, 'batch-l@hpc.email'), item(me.address, 'batch-m@hpc.email'), item(me.address, 'batch-n@hpc.email'),
    ] })));
    expect(result.items.filter((r) => r.ok)).toHaveLength(2);
    expect(result.items.filter((r) => !r.ok).map((r) => [r.httpStatus, r.error!.code])).toEqual([[429, 'rate_limited']]);
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
  });

  it('外层不合法整体 400；缺 mail.send 403；base64 附件合计超过 10MiB 整体 413', async () => {
    const me = await account('batch-outer');
    expect((await failure(await call('/v1/messages/batch', post(me.key, { items: [] })), 400)).message).toBe('至少需要一项');
    expect((await failure(await call('/v1/messages/batch', post(me.key, {
      items: Array.from({ length: MAX_BATCH_SEND_ITEMS + 1 }, () => item(me.address, 'x@hpc.email')),
    })), 400)).message).toBe(`一次最多 ${MAX_BATCH_SEND_ITEMS} 项`);
    expect((await failure(await call('/v1/messages/batch', post(me.key, [item(me.address, 'x@hpc.email')])), 400)).code).toBe('validation_failed');
    const reader = await account('batch-reader', ['mail.read']);
    expect((await failure(await call('/v1/messages/batch', post(reader.key, { items: [item(reader.address, 'x@hpc.email')] })), 403)).message).toContain('mail.send');
    const fourMiB = btoa('a'.repeat(3 * 1024 * 1024)).repeat(1);
    const attachment = { filename: 'a.bin', contentType: 'application/octet-stream', content: fourMiB };
    const error = await failure(await call('/v1/messages/batch', post(me.key, { items: [0, 1, 2, 3].map(() =>
      item(me.address, 'x@hpc.email', { attachments: [attachment] })) })), 413);
    expect(error).toMatchObject({ code: 'payload_too_large' });
    expect(await db.select({ id: messages.id }).from(messages).where(eq(messages.address, me.address))).toEqual([]);
  });

  it('多项并发时结果仍按 index 对应各自请求', async () => {
    const me = await account('batch-order');
    const targets = Array.from({ length: 9 }, (_, i) => `batch-o${i}@hpc.email`);
    const result = await data<BatchSendResult>(await call('/v1/messages/batch', post(me.key, { items: targets.map((to) => item(me.address, to)) })));
    expect(result.items.map((r) => r.index)).toEqual(targets.map((_, i) => i));
    for (const [i, r] of result.items.entries()) {
      const row = await db.select({ recipients: messages.recipients }).from(messages).where(eq(messages.id, r.message!.id)).get();
      expect(row!.recipients.to).toEqual([targets[i]]);
    }
  });
});
