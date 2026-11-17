import type { ApiScope, CreatedApiKey, MessageDetail, MessageSummary } from '@hpc-mail/shared';
import { API_SCOPES } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { hostedDomainMembers, hostedDomains, mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
const db = createDb(env);
const SYSTEM = 'anyp-sys.example';
const HOSTED = { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7 };

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function json(token: string, body: unknown): RequestInit {
  return { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function result<T>(response: Response, status: number): Promise<T> {
  const body = await response.json() as { data?: T; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return (body.data ?? body.error) as T;
}

async function actor(username: string) {
  await updateSettings(env, {
    domains: { list: [{ domain: SYSTEM, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 200, dailyRecipients: 500 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username, role: 'user', passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const scopes: ApiScope[] = [...API_SCOPES];
  const key = (await result<CreatedApiKey>(await request('/api/api-keys', json(jwt, { name: 'k', scopes, rateLimit: 600 })), 201)).key;
  return { id: user!.id, jwt, key };
}

/** 站内收件人：系统域名上由 inbox 用户认领的地址，发信走站内投递，不需要 send_email */
async function setup(prefix: string, hosted: Partial<typeof hostedDomains.$inferInsert> = {}) {
  const owner = await actor(`${prefix}-owner`);
  const member = await actor(`${prefix}-member`);
  const inbox = await actor(`${prefix}-inbox`);
  const domain = `${prefix}.example`;
  const [row] = await db.insert(hostedDomains).values({ domain, userId: owner.id, status: 'active', sendingStatus: 'ready', ...hosted }).returning();
  await db.insert(hostedDomainMembers).values({ domainId: row!.id, userId: member.id, grantedBy: owner.id });
  const to = `${prefix}-in@${SYSTEM}`;
  await db.insert(mailboxes).values({ address: to, domain: SYSTEM, userId: inbox.id });
  return { owner, member, inbox, domain, to };
}

const send = (token: string, from: unknown, to: string) => request('/v1/messages', json(token, { from, to: [to], subject: 'hi', text: 'body' }));
const ownerOf = async (address: string) => (await db.select().from(mailboxes).where(eq(mailboxes.address, address)).get())?.userId;

describe('托管域名所有者用本域任意前缀发信', () => {
  it('未认领的地址发出时自动认领给所有者，发件记录在他名下可见；三种 from 写法都可用', async () => {
    const f = await setup('anyp-a');
    const sent = await result<MessageSummary>(await send(f.owner.key, { localPart: 'billing', domain: f.domain }, f.to), 201);
    expect(sent).toMatchObject({ address: `billing@${f.domain}`, status: 'delivered' });
    expect(await ownerOf(`billing@${f.domain}`)).toBe(f.owner.id);
    expect(await result<MessageDetail>(await request(`/v1/messages/${sent.id}`, { headers: { Authorization: `Bearer ${f.owner.key}` } }), 200))
      .toMatchObject({ id: sent.id, direction: 'outbound' });

    await result(await send(f.owner.key, `Support Team <support@${f.domain}>`, f.to), 201);
    await result(await send(f.owner.key, { address: `ops@${f.domain}`, name: 'Ops' }, f.to), 201);
    expect(await ownerOf(`support@${f.domain}`)).toBe(f.owner.id);
    expect(await ownerOf(`ops@${f.domain}`)).toBe(f.owner.id);
    // 网页会话同样可用
    await result(await request('/api/messages/send', json(f.owner.jwt, { from: { localPart: 'web', domain: f.domain }, to: [f.to], subject: 's', text: 't' })), 201);
    expect(await ownerOf(`web@${f.domain}`)).toBe(f.owner.id);
  });

  it('成员不能用任意前缀，也不会因此产生认领', async () => {
    const f = await setup('anyp-b');
    const error = await result<{ code: string }>(await send(f.member.key, { localPart: 'boss', domain: f.domain }, f.to), 403);
    expect(error.code).toBe('forbidden');
    expect(await ownerOf(`boss@${f.domain}`)).toBeUndefined();
  });

  it('地址已被成员认领时所有者不能冒用', async () => {
    const f = await setup('anyp-c');
    await db.insert(mailboxes).values({ address: `alice@${f.domain}`, domain: f.domain, userId: f.member.id });
    expect((await result<{ code: string }>(await send(f.owner.key, { localPart: 'alice', domain: f.domain }, f.to), 403)).code).toBe('forbidden');
    expect(await ownerOf(`alice@${f.domain}`)).toBe(f.member.id);
  });

  it('发信未就绪、域名暂停时不放开，也不认领', async () => {
    const waiting = await setup('anyp-d', { status: 'provisioning', sendingStatus: '' });
    expect((await result<{ code: string }>(await send(waiting.owner.key, { localPart: 'x', domain: waiting.domain }, waiting.to), 403)).code).toBe('forbidden');
    expect(await ownerOf(`x@${waiting.domain}`)).toBeUndefined();
    const paused = await setup('anyp-e', { status: 'suspended', sendingStatus: 'ready' });
    expect((await result<{ code: string }>(await send(paused.owner.key, { localPart: 'x', domain: paused.domain }, paused.to), 403)).code)
      .toBe('forbidden');
    expect(await ownerOf(`x@${paused.domain}`)).toBeUndefined();
  });

  it('不受收件自动认领上限 autoClaimLimit 约束（与所有者手动认领同一口径）', async () => {
    const f = await setup('anyp-f');
    await db.insert(mailboxes).values({ address: `taken@${f.domain}`, domain: f.domain, userId: f.owner.id });
    await updateSettings(env, { hosted_domains: { ...HOSTED, autoClaimLimit: 1 } });
    try {
      await result(await send(f.owner.key, { localPart: 'second', domain: f.domain }, f.to), 201);
      expect(await ownerOf(`second@${f.domain}`)).toBe(f.owner.id);
    } finally {
      await updateSettings(env, { hosted_domains: { ...HOSTED, autoClaimLimit: 0 } });
    }
  });
});
