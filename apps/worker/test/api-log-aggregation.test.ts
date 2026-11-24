import type { ApiRequestLogEntry, Page } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { apiRequestLogs, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { writeApiRequestLog } from '../src/services/api-request-log.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { awayFromMinuteBoundary, MINUTE_EDGE_TIMEOUT } from './support/minute-boundary.js';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); });

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const rand = () => crypto.randomUUID().slice(0, 8);
const IP = '198.51.100.77';
const bearer = (token: string, extra: Record<string, string> = {}): RequestInit =>
  ({ headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': IP, ...extra } });
const post = (token: string, body: unknown): RequestInit => ({
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': IP, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function setup(prefix: string) {
  await updateSettings(env, { api: { enabled: true }, security: { require2fa: false } });
  const username = `${prefix}-${rand()}`;
  const [user] = await createDb(env).insert(users)
    .values({ username, role: 'user', passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await createApiKey(env, user!.id, { name: username, scopes: ['mail.read', 'mail.write'], rateLimit: 120, allowedIps: [] });
  const address = `${username}@hpc.email`;
  await createDb(env).insert(mailboxes).values({ address, domain: 'hpc.email', userId: user!.id });
  const [message] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: 'hpc.email', fromAddress: 'a@example.net', subject: 's', preview: 'p', status: 'received',
  }).returning({ id: messages.id });
  return { jwt, key, messageId: message!.id };
}

const logsOf = (apiKeyId: number) => createDb(env).select().from(apiRequestLogs).where(eq(apiRequestLogs.apiKeyId, apiKeyId)).all();

describe('/v1 请求日志按分钟聚合（R19）', () => {
  it('成功的 GET（含 304）同一分钟同一路由只写一行并累加次数与耗时；写操作与失败请求逐条记录', async () => {
    await awayFromMinuteBoundary();
    const { jwt, key, messageId } = await setup('agg');
    const first = await request(`/v1/messages/${messageId}`, bearer(key.key, { 'X-Request-ID': 'agg-first' }));
    expect(first.status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await request(`/v1/messages/${messageId}`, bearer(key.key))).status).toBe(200);
    const etag = first.headers.get('ETag')!;
    for (let i = 0; i < 2; i++) {
      expect((await request(`/v1/messages/${messageId}`, bearer(key.key, { 'If-None-Match': etag }))).status).toBe(304);
    }
    for (let i = 0; i < 2; i++) expect((await request('/v1/messages/987654321', bearer(key.key))).status).toBe(404);
    for (let i = 0; i < 2; i++) expect((await request('/v1/messages/read', post(key.key, { ids: [messageId], isRead: true }))).status).toBe(200);
    expect((await request('/v1/messages', bearer(key.key))).status).toBe(200);

    const rows = await logsOf(key.id);
    const summary = rows.map((row) => `${row.method} ${row.path} ${row.statusCode} ×${row.requestCount}`).sort();
    expect(summary).toEqual([
      'GET /v1/messages 200 ×1',
      'GET /v1/messages/:id 200 ×3',
      'GET /v1/messages/:id 304 ×2',
      'GET /v1/messages/:id 404 ×1',
      'GET /v1/messages/:id 404 ×1',
      'POST /v1/messages/read 200 ×1',
      'POST /v1/messages/read 200 ×1',
    ]);
    const detailRow = rows.find((row) => row.statusCode === 200 && row.path === '/v1/messages/:id')!;
    expect(detailRow).toMatchObject({ requestId: 'agg-first', ip: IP });
    expect(detailRow.minute).not.toBeNull();
    expect(rows.filter((row) => row.minute === null)).toHaveLength(4);

    // 列表接口带回 count，聚合行的 durationMs 为耗时之和
    const listed = await request(`/api/api-keys/${key.id}/logs`, { headers: { Authorization: `Bearer ${jwt}` } });
    const page = (await listed.json() as { data: Page<ApiRequestLogEntry> }).data;
    expect(page.items.map((item) => item.count).sort()).toEqual([1, 1, 1, 1, 1, 2, 3]);
    expect(page.items.find((item) => item.count === 3)!.durationMs).toBe(detailRow.durationMs);
  }, MINUTE_EDGE_TIMEOUT);

  it('不同分钟、不同 Key 各自成行；HEAD 与 GET 同样聚合', async () => {
    const { key } = await setup('agg-minute');
    const other = await setup('agg-other');
    const entry = { requestId: 'r', method: 'GET', path: '/v1/messages/:id', statusCode: 200, ip: IP, durationMs: 7 };
    const base = Date.UTC(2026, 10, 17, 9, 0, 1);
    vi.spyOn(Date, 'now').mockReturnValue(base);
    await writeApiRequestLog(env, true, { ...entry, apiKeyId: key.id });
    await writeApiRequestLog(env, true, { ...entry, apiKeyId: key.id, durationMs: 3 });
    await writeApiRequestLog(env, true, { ...entry, apiKeyId: other.key.id });
    await writeApiRequestLog(env, true, { ...entry, apiKeyId: key.id, method: 'HEAD' });
    vi.spyOn(Date, 'now').mockReturnValue(base + 60_000);
    await writeApiRequestLog(env, true, { ...entry, apiKeyId: key.id });
    vi.restoreAllMocks();

    const rows = (await logsOf(key.id)).map((row) => [row.method, row.minute! - Math.floor(base / 60_000), row.requestCount, row.durationMs]);
    expect(rows.sort()).toEqual([['GET', 0, 2, 10], ['GET', 1, 1, 7], ['HEAD', 0, 1, 7]]);
    expect((await logsOf(other.key.id)).map((row) => row.requestCount)).toEqual([1]);
  });

  it('中间件拒绝的请求照旧：每 Key 每分钟只写 1 行明细，不进聚合', async () => {
    const { key } = await setup('agg-reject');
    const entry = { apiKeyId: key.id, requestId: 'r', method: 'GET', path: '/v1/status', statusCode: 401, ip: IP, durationMs: 1 };
    for (let i = 0; i < 3; i++) await writeApiRequestLog(env, false, entry);
    const rows = await logsOf(key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ statusCode: 401, requestCount: 1, minute: null });
  });
});
