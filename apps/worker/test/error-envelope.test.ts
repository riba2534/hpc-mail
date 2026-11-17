import { type ApiErrorBody, type CreatedApiKey } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { AppError } from '../src/lib/errors.js';
import { signToken } from '../src/lib/jwt.js';
import { DEFAULT_ERROR_HINTS, onError } from '../src/middleware/error.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { AppContext } from '../src/types.js';
import errorsDoc from '../../web/public/references/errors.md?raw';

const app = createApp();
const origin = 'https://mail.example';

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(`${origin}${path}`, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function keyWithScopes(username: string, scopes: string[]) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    api: { enabled: true }, security: { require2fa: false },
  });
  const [user] = await createDb(env).insert(users).values({ username, role: 'user', passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const response = await request('/api/api-keys', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'k', scopes, rateLimit: 120 }) });
  return ((await response.json()) as { data: CreatedApiKey }).data.key;
}

const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const anchors = new Set([...errorsDoc.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!)));

describe('错误信封的 fix / docs / details', () => {
  it('scope 不足给出改正建议与绝对文档链接', async () => {
    const key = await keyWithScopes('envelope-scope', ['mail.read']);
    const response = await request('/v1/mailboxes', { headers: { Authorization: `Bearer ${key}` } });
    expect(response.status).toBe(403);
    const body = await response.json() as ApiErrorBody;
    expect(body.error.code).toBe('forbidden');
    expect(body.error.fix).toContain('mailbox.read');
    expect(body.error.docs).toBe(`${origin}/references/errors.md#forbidden-scope`);
  });

  it('不允许的邮件头返回 header_not_allowed 并列出被拒的头', async () => {
    const key = await keyWithScopes('envelope-headers', ['mail.send']);
    const response = await request('/v1/messages', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'envelope-headers@hpc.email', to: ['a@example.net'], subject: 's', text: 't',
        headers: { 'Message-ID': '<x@y>', 'X-Ok': '1', Subject: 'x' } }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as ApiErrorBody;
    expect(body.error).toMatchObject({ code: 'header_not_allowed', details: { headers: ['Message-ID', 'Subject'] } });
    expect(body.error.fix).toBeTruthy();
    expect(body.error.docs).toBe(`${origin}/references/errors.md#header_not_allowed`);
  });

  it('抛错处没给建议时按错误码补默认值，给了以抛错处为准；普通错误不带可选字段', async () => {
    const probe = new Hono<AppContext>();
    probe.onError(onError);
    probe.get('/default', () => { throw new AppError('send_in_progress', 'busy'); });
    probe.get('/custom', () => { throw new AppError('delivery_failed', 'all failed', {
      fix: 'custom fix', details: { messageId: 7, recipientOutcomes: [{ address: 'a@b.co', status: 'failed', error: 'rejected' }] },
    }); });
    probe.get('/plain', () => { throw new AppError('not_found', 'missing'); });
    const read = async (path: string) => (await probe.request(`${origin}${path}`)).json() as Promise<ApiErrorBody>;
    expect((await read('/default')).error).toEqual({ code: 'send_in_progress', message: 'busy',
      fix: DEFAULT_ERROR_HINTS.send_in_progress!.fix, docs: `${origin}/references/errors.md#send_in_progress` });
    expect((await read('/custom')).error).toEqual({ code: 'delivery_failed', message: 'all failed', fix: 'custom fix',
      docs: `${origin}/references/errors.md#delivery_failed`, details: { messageId: 7, recipientOutcomes: [{ address: 'a@b.co', status: 'failed', error: 'rejected' }] } });
    expect((await probe.request(`${origin}/custom`)).status).toBe(422);
    expect((await read('/plain')).error).toEqual({ code: 'not_found', message: 'missing' });
  });

  it('代码里引用的每个错误文档锚点都存在', () => {
    const referenced = [...Object.values(DEFAULT_ERROR_HINTS).map((hint) => hint!.docs!),
      '/references/errors.md#forbidden-scope', '/references/errors.md#forbidden-sender',
      '/references/errors.md#header_not_allowed', '/references/errors.md#payload_too_large', '/references/errors.md#recipient_suppressed'];
    for (const docs of referenced) {
      const [file, anchor] = docs.split('#') as [string, string];
      expect(file).toBe('/references/errors.md');
      expect(anchors.has(anchor), anchor).toBe(true);
    }
  });
});
