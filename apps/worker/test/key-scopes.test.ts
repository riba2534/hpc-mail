import type { ApiKeySelf, ApiScope, CreatedApiKey, MessageSummary, Page, SendIdentities } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { apiKeys, hostedDomains, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { handleInbound } from '../src/services/inbound.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import migration0022 from '../migrations/0022_key_scopes_account_security.sql?raw';
import { grantLegacyAdminScope, TEST_PASSWORD, testPasswordHash } from './key-helpers.js';

const app = createApp();
const db = createDb(env);
const IP = '203.0.113.7';
let seq = 0;

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', IP);
  const response = await app.request(path, { ...init, headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string, body: unknown, method = 'POST'): RequestInit =>
  ({ method, headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string; docs?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function setup() {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'scope.test', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 50, dailyRecipients: 100 },
    security: { require2fa: false },
    api: { enabled: true },
  });
}

async function account(name: string, role: 'admin' | 'user' = 'user') {
  await setup();
  const username = `ks-${name}-${++seq}`;
  const [user] = await db.insert(users).values({ username, role, passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  return { id: user!.id, username, jwt };
}

async function keyFor(jwt: string, body: Record<string, unknown> = {}) {
  return data<CreatedApiKey>(await request('/api/api-keys', json(jwt, {
    name: `k-${++seq}`, scopes: ['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write'] as ApiScope[],
    rateLimit: 600, password: TEST_PASSWORD, ...body,
  })), 201);
}

async function own(userId: number, address: string) {
  return (await db.insert(mailboxes).values({ address, domain: address.split('@')[1]!, userId }).returning().get())!;
}

async function receive(address: string, subject: string) {
  const messageId = `<ks-${++seq}@example.net>`;
  const raw = `From: Sender <sender@example.net>\r\nTo: ${address}\r\nMessage-ID: ${messageId}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody\r\n`;
  const ctx = createExecutionContext();
  await handleInbound({ to: address, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
  return (await db.select().from(messages).where(eq(messages.messageId, messageId)).get())!;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('管理员 Key 需要显式 admin scope', () => {
  it('没有 admin scope 的管理员 Key 按普通用户执行：不能跨用户、不能用别人的邮箱发信，受外发配额', async () => {
    const admin = await account('plain-admin', 'admin');
    const other = await account('plain-other');
    const box = await own(other.id, `ks-other-${seq}@hpc.email`);
    const key = (await keyFor(admin.jwt)).key;
    expect((await request('/v1/mailboxes?all=1', { headers: auth(key) })).status).toBe(403);
    expect((await request('/v1/messages?scope=unclaimed', { headers: auth(key) })).status).toBe(403);
    expect((await request('/v1/messages', json(key, { from: { mailboxId: box.id }, to: ['x@hpc.email'], subject: 's', text: 't' }))).status).toBe(403);
    const status = await data<{ role: string }>(await request('/v1/status', { headers: auth(key) }));
    expect(status.role).toBe('user');
    const me = await data<ApiKeySelf>(await request('/v1/me', { headers: auth(key) }));
    expect(me.user.role).toBe('admin');
    expect(me.key.effectiveRole).toBe('user');
    expect(me.outbound).toMatchObject({ exempt: false, dailyLimit: 50 });
  });

  it('带 admin scope 的 Key 恢复管理员能力（存量 Key 与新建 Key 都是）', async () => {
    const admin = await account('scoped-admin', 'admin');
    const legacy = await keyFor(admin.jwt);
    await grantLegacyAdminScope(env, legacy.id);
    expect((await request('/v1/mailboxes?all=1', { headers: auth(legacy.key) })).status).toBe(200);
    const created = await keyFor(admin.jwt, { scopes: ['mailbox.read', 'admin'], allowedIps: [IP], expiresAt: inDays(30) });
    expect(created.scopes).toContain('admin');
    expect((await request('/v1/mailboxes?all=1', { headers: auth(created.key) })).status).toBe(200);
    expect((await data<ApiKeySelf>(await request('/v1/me', { headers: auth(created.key) }))).key.effectiveRole).toBe('admin');
    // 白名单外的来源 IP 照常拒绝
    expect((await request('/v1/mailboxes?all=1', { headers: { ...auth(created.key), 'CF-Connecting-IP': '198.51.100.1' } })).status).toBe(403);
  });

  it('只有管理员能授予 admin，且必须有 IP 白名单与不超过 90 天的有效期；修改时按结果校验', async () => {
    const user = await account('grant-user');
    const admin = await account('grant-admin', 'admin');
    const create = (jwt: string, body: Record<string, unknown>) => request('/api/api-keys', json(jwt, {
      name: 'admin-key', scopes: ['mailbox.read', 'admin'], rateLimit: 60, password: TEST_PASSWORD, ...body,
    }));
    expect((await errorOf(await create(user.jwt, { allowedIps: [IP], expiresAt: inDays(30) }), 403)).code).toBe('forbidden');
    expect((await errorOf(await create(admin.jwt, { expiresAt: inDays(30) }), 400)).message).toContain('IP 白名单');
    expect((await errorOf(await create(admin.jwt, { allowedIps: [IP] }), 400)).message).toContain('有效期');
    expect((await errorOf(await create(admin.jwt, { allowedIps: [IP], expiresAt: inDays(91) }), 400)).message).toContain('90');
    const plain = await keyFor(admin.jwt);
    expect((await request(`/api/api-keys/${plain.id}`, json(admin.jwt, { scopes: ['mailbox.read', 'admin'] }, 'PUT'))).status).toBe(400);
    expect((await request(`/api/api-keys/${plain.id}`, json(user.jwt, { scopes: ['mailbox.read', 'admin'] }, 'PUT'))).status).toBe(404);
    const upgraded = await data<CreatedApiKey>(await request(`/api/api-keys/${plain.id}`,
      json(admin.jwt, { scopes: ['mailbox.read', 'admin'], allowedIps: [IP], expiresAt: inDays(10) }, 'PUT')));
    expect(upgraded.scopes).toContain('admin');
    expect((await request(`/api/api-keys/${plain.id}`, json(admin.jwt, { expiresAt: null }, 'PUT'))).status).toBe(400);
    const userKey = await keyFor(user.jwt);
    expect((await request(`/api/api-keys/${userKey.id}`, json(user.jwt, { scopes: ['mail.read', 'admin'], allowedIps: [IP], expiresAt: inDays(5) }, 'PUT'))).status).toBe(403);
    // 存量管理员 Key（迁移加上的 admin，没有白名单）只改名照常可以
    const legacy = await keyFor(admin.jwt);
    await grantLegacyAdminScope(env, legacy.id);
    expect((await request(`/api/api-keys/${legacy.id}`, json(admin.jwt, { name: 'renamed' }, 'PUT'))).status).toBe(200);
  });

  it('迁移 0022 只给管理员未吊销的 Key 加 admin scope，重复执行不会加两次', async () => {
    const admin = await account('mig-admin', 'admin');
    const user = await account('mig-user');
    const adminKey = await keyFor(admin.jwt);
    const userKey = await keyFor(user.jwt);
    const update = migration0022.split('--> statement-breakpoint').map((part) => part.trim()).find((part) => part.startsWith('UPDATE'))!;
    await env.db.prepare(update).run();
    await env.db.prepare(update).run();
    const scopesOf = async (id: number) => (await db.select({ scopes: apiKeys.scopes }).from(apiKeys).where(eq(apiKeys.id, id)).get())!.scopes;
    expect((await scopesOf(adminKey.id)).filter((scope) => scope === 'admin')).toHaveLength(1);
    expect(await scopesOf(userKey.id)).not.toContain('admin');
  });
});

describe('创建 Key 前重新验证密码', () => {
  it('缺少密码 403 reauth_required，密码错误 403 reauth_failed，都不创建', async () => {
    const user = await account('reauth');
    const body = { name: 'k', scopes: ['mail.read'], rateLimit: 60 };
    expect((await errorOf(await request('/api/api-keys', json(user.jwt, body)), 400)).code).toBe('validation_failed');
    expect((await errorOf(await request('/api/api-keys', json(user.jwt, { ...body, password: 'wrong-password' })), 403)).code).toBe('reauth_failed');
    expect(await db.select().from(apiKeys).where(eq(apiKeys.userId, user.id)).all()).toHaveLength(0);
  });

  it('allowedMailboxIds 只能是自己当前认领的邮箱', async () => {
    const user = await account('owned-ids');
    const other = await account('owned-ids-other');
    const mine = await own(user.id, `ks-mine-${seq}@hpc.email`);
    const theirs = await own(other.id, `ks-theirs-${seq}@hpc.email`);
    expect((await request('/api/api-keys', json(user.jwt, { name: 'k', scopes: ['mail.read'], password: TEST_PASSWORD, allowedMailboxIds: [mine.id, theirs.id] }))).status).toBe(400);
    const created = await keyFor(user.jwt, { allowedMailboxIds: [mine.id, mine.id], allowedDomains: ['Scope.Test'] });
    expect(created.allowedMailboxIds).toEqual([mine.id]);
    expect(created.allowedDomains).toEqual(['scope.test']);
  });
});

describe('限定到邮箱的 Key', () => {
  it('读取、等待、未读数、变更、发信、回复来源与邮箱管理都只在范围内', async () => {
    const user = await account('restrict');
    const allowed = await own(user.id, `ks-allowed-${seq}@hpc.email`);
    const hidden = await own(user.id, `ks-hidden-${seq}@hpc.email`);
    const key = (await keyFor(user.jwt, { allowedMailboxIds: [allowed.id] })).key;
    const inAllowed = await receive(allowed.address, 'allowed mail');
    const inHidden = await receive(hidden.address, 'hidden mail');

    const page = await data<Page<MessageSummary>>(await request('/v1/messages', { headers: auth(key) }));
    expect(page.items.map((item) => item.id)).toEqual([inAllowed.id]);
    expect((await request(`/v1/messages/${inHidden.id}`, { headers: auth(key) })).status).toBe(404);
    expect((await request(`/v1/messages/${inHidden.id}/raw`, { headers: auth(key) })).status).toBe(404);
    expect((await request(`/v1/messages/${inAllowed.id}`, { headers: auth(key) })).status).toBe(200);
    expect((await errorOf(await request(`/v1/messages?address=${hidden.address}`, { headers: auth(key) }), 403)).docs).toContain('#key-restricted');
    expect((await request(`/v1/messages/wait?address=${hidden.address}&timeout=1`, { headers: auth(key) })).status).toBe(403);
    const waited = await data<{ message: MessageSummary | null }>(await request(`/v1/messages/wait?afterId=${inAllowed.id - 1}&timeout=1`, { headers: auth(key) }));
    expect(waited.message?.id).toBe(inAllowed.id);
    expect((await data<{ unread: number }>(await request('/v1/messages/unread-count', { headers: auth(key) }))).unread).toBe(1);
    expect((await data<{ changed: number }>(await request('/v1/messages/read', json(key, { ids: [inAllowed.id, inHidden.id], isRead: true })))).changed).toBe(1);
    expect((await db.select().from(messages).where(eq(messages.id, inHidden.id)).get())!.isRead).toBe(false);
    expect((await data<{ deleted: number }>(await request('/v1/messages/delete', json(key, { ids: [inHidden.id] })))).deleted).toBe(0);

    const send = (body: Record<string, unknown>) => request('/v1/messages', json(key, { to: [allowed.address], subject: 's', text: 't', ...body }));
    expect((await send({ from: { mailboxId: hidden.id } })).status).toBe(403);
    expect((await send({ from: hidden.address })).status).toBe(403);
    expect((await send({ from: allowed.address, replyToMessageId: inHidden.id })).status).toBe(403);
    expect((await send({ from: allowed.address, forwardAttachmentsFrom: inHidden.id })).status).toBe(403);
    expect((await send({ from: { mailboxId: allowed.id }, replyToMessageId: inAllowed.id })).status).toBe(201);

    const boxes = await data<{ id: number }[]>(await request('/v1/mailboxes', { headers: auth(key) }));
    expect(boxes.map((box) => box.id)).toEqual([allowed.id]);
    const identities = await data<SendIdentities>(await request('/v1/identities', { headers: auth(key) }));
    expect(identities.identities.map((item) => item.mailboxId)).toEqual([allowed.id]);
    expect((await data<{ domains: string[] }>(await request('/v1/domains', { headers: auth(key) }))).domains).toEqual([]);
    expect((await request(`/v1/mailboxes/${hidden.id}`, json(key, { displayName: 'x' }, 'PUT'))).status).toBe(403);
    expect((await request(`/v1/mailboxes/${hidden.id}`, { method: 'DELETE', headers: auth(key) })).status).toBe(403);
    expect((await request('/v1/mailboxes', json(key, { localPart: `ks-new-${seq}`, domain: 'hpc.email' }))).status).toBe(403);
    expect((await request('/v1/mailboxes/random-plan?count=1&strategy=uniform', { headers: auth(key) })).status).toBe(403);
    expect((await request(`/v1/mailboxes/${allowed.id}`, json(key, { displayName: 'ok' }, 'PUT'))).status).toBe(200);
  });

  it('释放后重新认领得到新 id，旧 Key 不再覆盖这个地址', async () => {
    const user = await account('reclaim');
    const box = await own(user.id, `ks-reclaim-${seq}@hpc.email`);
    const key = (await keyFor(user.jwt, { allowedMailboxIds: [box.id] })).key;
    const mail = await receive(box.address, 'before release');
    expect((await request(`/v1/messages/${mail.id}`, { headers: auth(key) })).status).toBe(200);
    await db.delete(mailboxes).where(eq(mailboxes.id, box.id));
    const again = await own(user.id, box.address);
    expect(again.id).not.toBe(box.id);
    expect((await request(`/v1/messages/${mail.id}`, { headers: auth(key) })).status).toBe(404);
    expect((await data<Page<MessageSummary>>(await request('/v1/messages', { headers: auth(key) }))).items).toEqual([]);
  });
});

describe('限定到域名的 Key', () => {
  it('只能在允许的域名认领，新认领的地址立即可见；其他域名的邮件不可见', async () => {
    const user = await account('domain');
    const key = (await keyFor(user.jwt, { allowedDomains: ['scope.test'] })).key;
    expect((await request('/v1/mailboxes', json(key, { localPart: `ks-dom-${seq}`, domain: 'hpc.email' }))).status).toBe(403);
    const claimed = await data<{ id: number; address: string }>(await request('/v1/mailboxes', json(key, { localPart: `ks-dom-${seq}`, domain: 'scope.test' })), 201);
    const other = await own(user.id, `ks-dom-other-${seq}@hpc.email`);
    const visible = await receive(claimed.address, 'scoped');
    await receive(other.address, 'outside');
    const page = await data<Page<MessageSummary>>(await request('/v1/messages', { headers: auth(key) }));
    expect(page.items.map((item) => item.id)).toEqual([visible.id]);
    expect((await data<{ domains: string[] }>(await request('/v1/domains', { headers: auth(key) }))).domains).toEqual(['scope.test']);
    expect((await request('/v1/messages?domain=hpc.email', { headers: auth(key) })).status).toBe(403);
    expect((await request(`/v1/mailboxes/availability?localPart=x${seq}&domain=hpc.email`, { headers: auth(key) })).status).toBe(403);
  });
});

describe('限定范围的 Key 与托管域名接口', () => {
  it('列表只含 allowedDomains 里的托管域名，按 id 访问或添加范围外的域名 403', async () => {
    const user = await account('hosted');
    const mine = (await db.insert(hostedDomains).values({ domain: `ks-mine-${seq}.test`, userId: user.id, status: 'active', zoneId: `z-mine-${seq}` }).returning().get())!;
    const other = (await db.insert(hostedDomains).values({ domain: `ks-other-${seq}.test`, userId: user.id, status: 'active', zoneId: `z-other-${seq}` }).returning().get())!;
    const key = (await keyFor(user.jwt, { scopes: ['domain.read', 'domain.write'], allowedDomains: [mine.domain] })).key;
    const list = await data<{ id: number }[]>(await request('/v1/hosted-domains', { headers: auth(key) }));
    expect(list.map((item) => item.id)).toEqual([mine.id]);
    expect((await request(`/v1/hosted-domains/${other.id}`, { headers: auth(key) })).status).toBe(403);
    expect((await request(`/v1/hosted-domains/${other.id}/dns-records`, { headers: auth(key) })).status).toBe(403);
    expect((await errorOf(await request('/v1/hosted-domains', json(key, { domain: 'brand-new.test' })), 403)).docs).toContain('#key-restricted');
    expect((await errorOf(await request('/v1/hosted-domains/batch-check', json(key, { ids: [mine.id, other.id] })), 403)).docs).toContain('#key-restricted');
  });
});
