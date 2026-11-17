import { API_SCOPES, MAX_SEND_REQUEST_BYTES, type CreatedApiKey } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { readTextWithin } from '../src/lib/request-body.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { TEST_PASSWORD, testPasswordHash } from './key-helpers.js';

const app = createApp();
const MIB = 1024 * 1024;

/** 每次 pull 给一块 chunkBytes 字节（最多 chunks 块），只在被读取时才 pull；记录被拉取的次数与是否被取消；不带 Content-Length */
function countingStream(chunkBytes: number, chunks: number) {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      if (state.pulls > chunks) controller.close();
      else controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

async function request(path: string, init: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function apiKey(username: string) {
  await updateSettings(env, { domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] }, api: { enabled: true } });
  const user = (await createDb(env).insert(users).values({ username, role: 'user', passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true })
    .returning().get())!;
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid: await createSession(env, user.id), epoch: 0, uepoch: 0 });
  const response = await request('/api/api-keys', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'limit', scopes: API_SCOPES.filter((scope) => scope !== 'admin'), rateLimit: 600, password: TEST_PASSWORD }) });
  return { key: ((await response.json()) as { data: CreatedApiKey }).data.key, jwt };
}

describe('有上限的请求体读取（A11/CR9）', () => {
  it('readTextWithin 超过上限立即取消读取，不读完整个流；没超过时按 UTF-8 拼回文本', async () => {
    const { stream, state } = countingStream(10, 1000);
    await expect(readTextWithin(stream, 25, () => new Error('too large'))).rejects.toThrow('too large');
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(4);

    const bytes = new TextEncoder().encode('中文😀');
    const split = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } });
    expect(await readTextWithin(split, bytes.length, () => new Error('too large'))).toBe('中文😀');
    expect(await readTextWithin(null, 1, () => new Error('too large'))).toBe('');
  });

  it('发信入口：没有 Content-Length 的 chunked 请求体超过上限即 413，读到上限附近就停止', async () => {
    const { key } = await apiKey('limit-send');
    const { stream, state } = countingStream(MIB, 64);
    const response = await request('/v1/messages', { method: 'POST', body: stream,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'payload_too_large', message: expect.stringContaining('发信请求体超过') } });
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(MAX_SEND_REQUEST_BYTES / MIB + 3);

    // 上限以内的请求体照常解析（读取结果交给 parseBody 复用）
    const small = await request('/v1/messages', { method: 'POST', body: new Blob([JSON.stringify({ to: [] })]).stream(),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    expect(small.status).toBe(400);
    expect(await small.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('/mcp：先校验 Key 再读请求体，无效 Key 不读流；有效 Key 的超大 chunked 请求体 413', async () => {
    const { key } = await apiKey('limit-mcp');
    const unknown = countingStream(MIB, 64);
    const rejected = await request('/mcp', { method: 'POST', body: unknown.stream,
      headers: { Authorization: `Bearer hpcm_${'0'.repeat(64)}`, 'Content-Type': 'application/json' } });
    expect(rejected.status).toBe(401);
    expect(unknown.state.pulls).toBe(0);

    const huge = countingStream(MIB, 64);
    const tooLarge = await request('/mcp', { method: 'POST', body: huge.stream,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ id: null, error: { code: -32600, message: expect.stringContaining('请求体超过') } });
    expect(huge.state.cancelled).toBe(true);
    expect(huge.state.pulls).toBeLessThanOrEqual(MAX_SEND_REQUEST_BYTES / MIB + 3);
  });
});
