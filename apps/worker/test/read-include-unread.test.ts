import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { MarkReadResult } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
const rand = () => crypto.randomUUID().slice(0, 8);

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const post = (authorization: string, body: unknown): RequestInit =>
  ({ method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.data;
}

async function account(prefix: string, role: 'admin' | 'user' = 'user') {
  await updateSettings(env, { api: { enabled: true } });
  const [user] = await createDb(env).insert(users)
    .values({ username: `${prefix}-${rand()}`, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = `Bearer ${await signToken(env.jwt_secret, { sub: user!.id, sid, uepoch: 0 })}`;
  const key = await createApiKey(env, user!.id, { name: `${prefix}-key`, scopes: ['mail.read', 'mail.write'], rateLimit: 1000, allowedIps: [] });
  const address = `${prefix}-${rand()}@read-unread.test`;
  const [box] = await createDb(env).insert(mailboxes).values({ address, domain: 'read-unread.test', userId: user!.id }).returning({ id: mailboxes.id });
  return { id: user!.id, jwt, key: `Bearer ${key.key}`, address, boxId: box!.id };
}

async function mail(address: string) {
  const [row] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@example.net',
    subject: 'hello', preview: 'hello', status: 'received',
  }).returning({ id: messages.id });
  return row!.id;
}

const unreadCount = async (jwt: string) =>
  (await data<{ unread: number }>(await request('/api/messages/unread-count', { headers: { Authorization: jwt } }))).unread;

describe('POST /api/messages/read 的 includeUnread', () => {
  it('个人视图带回标记后的未读数，与 GET /unread-count 一致；不带 includeUnread 时不返回', async () => {
    const owner = await account('ru-owner');
    const viewer = await account('ru-viewer');
    await createDb(env).insert(mailboxShares).values({ mailboxId: owner.boxId, userId: viewer.id, grantedBy: owner.id });
    const [a, b] = [await mail(viewer.address), await mail(viewer.address)];
    await mail(owner.address);

    const marked = await data<MarkReadResult>(await request('/api/messages/read', post(viewer.jwt, { ids: [a], isRead: true, includeUnread: true })));
    expect(marked).toEqual({ changed: 1, unread: 1 });
    expect(marked.unread).toBe(await unreadCount(viewer.jwt));

    const mine = await data<MarkReadResult>(await request('/api/messages/read?scope=mine', post(viewer.jwt, { ids: [b], isRead: true, includeUnread: true })));
    expect(mine).toEqual({ changed: 1, unread: 0 });

    const plain = await data<MarkReadResult>(await request('/api/messages/read', post(viewer.jwt, { ids: [a], isRead: false })));
    expect(plain).toEqual({ changed: 1 });
    expect(await unreadCount(viewer.jwt)).toBe(1);
  });

  it('管理员 scope=unclaimed 不返回个人未读数；/v1 的 /read 契约不变', async () => {
    const admin = await account('ru-admin', 'admin');
    const stray = await mail(`nobody-${rand()}@read-unread.test`);
    const unclaimed = await data<MarkReadResult>(await request('/api/messages/read?scope=unclaimed',
      post(admin.jwt, { ids: [stray], isRead: true, includeUnread: true })));
    expect(unclaimed).toEqual({ changed: 1 });

    const user = await account('ru-v1');
    const id = await mail(user.address);
    const v1 = await data<MarkReadResult>(await request('/v1/messages/read', post(user.key, { ids: [id], isRead: true, includeUnread: true })));
    expect(v1).toEqual({ changed: 1 });
  });
});
