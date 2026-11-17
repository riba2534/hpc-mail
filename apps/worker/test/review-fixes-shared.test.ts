import { type CreatedApiKey, type MessageSummary } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { idempotencyRecords, mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { TEST_PASSWORD, testPasswordHash, USER_SCOPES } from './key-helpers.js';
import type { Env } from '../src/types.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const app = createApp();
const db = createDb(env);

async function call(runtime: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function account(name: string) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false }, quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false }, api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username: name, role: 'user', passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const created = await call(env, '/api/api-keys', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'k', scopes: USER_SCOPES, rateLimit: 600, password: TEST_PASSWORD }) });
  return { key: ((await created.json()) as { data: CreatedApiKey }).data.key, address: `${name}@hpc.email` };
}

function send(runtime: Env, key: string, body: unknown, idempotencyKey: string) {
  return call(runtime, '/v1/messages', { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey } });
}

describe('审查修复：共享口径', () => {
  it('幂等重放从发件行推出结果时，hasAttachments 与首次一样不计内联图（C7）', async () => {
    const owner = await account('rf-inline-replay');
    const body = { from: owner.address, to: ['peer@hpc.email'], subject: 'rf-inline-replay', html: '<img src="cid:logo">',
      attachments: [{ filename: 'logo.png', contentType: 'image/png', content: btoa('png'), contentId: 'logo' }] };
    const first = await send(env, owner.key, body, 'rf-inline-replay-key');
    expect(first.status).toBe(201);
    expect(((await first.json()) as { data: MessageSummary }).data.hasAttachments).toBe(false);
    // 模拟结果缓存回填失败：记录仍是 pending、只绑定了发件行，重放时由发件行重新推出响应
    await db.update(idempotencyRecords).set({ status: 'pending', responseJson: null })
      .where(eq(idempotencyRecords.key, 'rf-inline-replay-key'));
    const replay = await send(env, owner.key, body, 'rf-inline-replay-key');
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { data: MessageSummary }).data.hasAttachments).toBe(false);
  });

  it('IDN 域名与 UTF-8 本地部分的收件人照常可发（C4）', async () => {
    const owner = await account('rf-idn');
    const captured: string[] = [];
    const runtime = { ...env, email: { send: vi.fn(async (mail: { to: string; raw: string }) => {
      captured.push(mail.to);
      await PostalMime.parse(await new Response(mail.raw).text());
    }) } } as unknown as Env;
    const response = await send(runtime, owner.key, { from: owner.address, to: ['张三 <z@例子.com>', 'jörg@bücher.de'],
      subject: 'rf-idn', text: 'hi' }, 'rf-idn-key');
    expect(response.status, await response.clone().text()).toBe(201);
    expect(captured.sort()).toEqual(['jörg@bücher.de', 'z@例子.com']);
  });
});
