import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomainTombstones, hostedDomains, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { syncHostedDomain } from '../src/services/hosted-domain.js';
import { HOSTED_TOMBSTONE_RETENTION_DAYS, purgeHostedTombstones, tombstoneStatement } from '../src/services/hosted-tombstone.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import migration0024 from '../migrations/0024_hosted_domain_hardening.sql?raw';

const app = createApp();
const db = createDb(env);
const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: 'acct-test', worker_name: 'hpc-cloud-mail' };
const OURS = ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Fake {
  /** rdap.org 按域名返回的 NS；不在表里返回 404 */
  rdap?: Record<string, string[]>;
  /** DoH NS：'servfail' 或答案列表；缺省为空答案 */
  doh?: Record<string, string[] | 'servfail'>;
}

/** 假 RDAP、DoH 与最小的 Cloudflare：只记录调用，建 zone 返回固定 NS */
function stubNetwork(fake: Fake = {}) {
  const cf: string[] = [];
  const lookups: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const zones = new Map<string, { id: string; name: string; status: string; created_on: string }>();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.hostname === 'rdap.org') {
      const name = decodeURIComponent(url.pathname.split('/').pop()!);
      lookups.push(`rdap ${name}`);
      const ns = fake.rdap?.[name];
      return ns ? json({ ldhName: name, nameservers: ns.map((ldhName) => ({ ldhName: `${ldhName.toUpperCase()}.` })) }) : json({ errorCode: 404 }, 404);
    }
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name')!;
      const type = url.searchParams.get('type');
      if (type !== 'NS') return json({ Status: 0, Answer: [] });
      lookups.push(`doh ${name}`);
      const answer = fake.doh?.[name];
      if (answer === 'servfail') return json({ Status: 2 });
      return json({ Status: 0, Answer: (answer ?? []).map((data) => ({ name, type: 2, data: `${data}.` })) });
    }
    const path = url.pathname.replace('/client/v4', '');
    cf.push(`${method} ${path}`);
    const ok = (result: unknown) => json({ success: true, errors: [], result });
    if (method === 'GET' && path === '/zones') return ok([...zones.values()].filter((zone) => zone.name === url.searchParams.get('name')));
    if (method === 'POST' && path === '/zones') {
      const name = (JSON.parse(String(init!.body)) as { name: string }).name;
      const zone = { id: `z-${name}`, name, status: 'pending', created_on: new Date().toISOString() };
      zones.set(zone.id, zone);
      return ok({ ...zone, name_servers: OURS, original_name_servers: [], original_registrar: '' });
    }
    const zoneId = /^\/zones\/([^/]+)$/.exec(path)?.[1];
    if (zoneId && method === 'GET') {
      const zone = zones.get(zoneId);
      return zone ? ok({ ...zone, name_servers: OURS }) : json({ success: false, errors: [{ code: 7003, message: 'no route' }], result: null }, 404);
    }
    if (zoneId && method === 'DELETE') { zones.delete(zoneId); return ok({ id: zoneId }); }
    // 预配置（catch-all、发信接入）与本测试无关：一律失败，后台任务只记日志
    return json({ success: false, errors: [{ code: 10000, message: 'not faked' }], result: null }, 400);
  }));
  return { cf, lookups, zones };
}

let sequence = 0;
async function fixture() {
  const prefix = `tb${++sequence}`;
  await updateSettings(env, {
    domains: { list: [{ domain: `${prefix}-system.test`, public: true, perUserLimit: 0 }] },
    hosted_domains: { enabled: true, maxPerUser: 10, maxPendingPerUser: 10, maxPendingTotal: 100, pendingDays: 7, autoClaimLimit: 0 },
  });
  const actor = async (suffix: string, role: 'admin' | 'user' = 'user') => {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  };
  return { prefix, domain: (name: string) => `${prefix}-${name}.test`, actor };
}

async function add(jwt: string, domain: string) {
  const ctx = createExecutionContext();
  const response = await app.request('/api/hosted-domains', { method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) }, runtime, ctx);
  await waitOnExecutionContext(ctx);
  const body = await response.json() as { error?: { code: string; message: string } };
  return { status: response.status, error: body.error };
}
const tombstone = (domain: string) => db.select().from(hostedDomainTombstones).where(eq(hostedDomainTombstones.domain, domain)).get();
const hostedRow = (domain: string) => db.select().from(hostedDomains).where(eq(hostedDomains.domain, domain)).get();
async function bury(domain: string, userId: number, deletedAt = new Date()) {
  await db.insert(hostedDomainTombstones).values({ domain, userId, nameServers: OURS, reason: 'delete', deletedAt });
}

describe('托管域名墓碑', () => {
  it('删除与到期删除记录时写墓碑（前所有者与本站分配的 NS），守卫不成立时不写', async () => {
    const f = await fixture();
    const owner = await f.actor('owner');
    const net = stubNetwork();
    // 删除：zone 与记录一并清掉
    net.zones.set('z-del', { id: 'z-del', name: f.domain('del'), status: 'active', created_on: new Date().toISOString() });
    const [deleting] = await db.insert(hostedDomains).values({ domain: f.domain('del'), userId: owner.id, status: 'deleting', zoneId: 'z-del',
      nameServers: OURS, createdAt: new Date(Date.now() - DAY) }).returning();
    await syncHostedDomain(runtime, deleting!.id);
    expect(await hostedRow(f.domain('del'))).toBeUndefined();
    expect(await tombstone(f.domain('del'))).toMatchObject({ userId: owner.id, nameServers: OURS, reason: 'delete' });

    // 到期：NS 迟迟未改，zone 仍是 pending
    net.zones.set('z-exp', { id: 'z-exp', name: f.domain('exp'), status: 'pending', created_on: new Date(Date.now() - 30 * DAY).toISOString() });
    const [expired] = await db.insert(hostedDomains).values({ domain: f.domain('exp'), userId: owner.id, status: 'pending', zoneId: 'z-exp',
      nameServers: OURS, createdAt: new Date(Date.now() - 30 * DAY) }).returning();
    await syncHostedDomain(runtime, expired!.id);
    expect(await hostedRow(f.domain('exp'))).toBeUndefined();
    expect(await tombstone(f.domain('exp'))).toMatchObject({ userId: owner.id, reason: 'expire' });

    // 守卫不成立（记录没删）就不留墓碑；新记录没有 NS 时保留旧墓碑的 NS
    const [kept] = await db.insert(hostedDomains).values({ domain: f.domain('kept'), userId: owner.id, status: 'active', nameServers: OURS }).returning();
    await env.db.batch([tombstoneStatement(env, 'delete', "id = ? AND status = 'deleting'", [kept!.id])]);
    expect(await tombstone(f.domain('kept'))).toBeUndefined();
    const [bare] = await db.insert(hostedDomains).values({ domain: f.domain('del'), userId: owner.id, status: 'deleting' }).returning();
    await env.db.batch([tombstoneStatement(env, 'delete', 'id = ?', [bare!.id])]);
    expect(await tombstone(f.domain('del'))).toMatchObject({ nameServers: OURS });
  });

  it('他人添加：公开委派仍指向本站分配的 NS 时 409，不占位、不调 Cloudflare', async () => {
    const f = await fixture();
    const before = await f.actor('before');
    const rival = await f.actor('rival');
    await bury(f.domain('rdap'), before.id);
    const net = stubNetwork({ rdap: { [f.domain('rdap')]: OURS }, doh: { [f.domain('doh')]: OURS } });
    const viaRdap = await add(rival.jwt, f.domain('rdap'));
    expect(viaRdap).toMatchObject({ status: 409, error: { code: 'conflict', message: expect.stringContaining('仍指向本站分配的地址') } });
    // 没有墓碑（例如迁移前删除、审计已过期）时，委派指向本账户的 NS 同样拒绝；RDAP 查不到就看 DoH
    await db.insert(hostedDomains).values({ domain: f.domain('live'), userId: before.id, status: 'active', nameServers: OURS });
    expect((await add(rival.jwt, f.domain('doh'))).status).toBe(409);
    expect(net.lookups).toEqual([`rdap ${f.domain('rdap')}`, `rdap ${f.domain('doh')}`, `doh ${f.domain('doh')}`]);
    expect(net.cf).toEqual([]);
    expect(await hostedRow(f.domain('rdap'))).toBeUndefined();
    expect(await hostedRow(f.domain('doh'))).toBeUndefined();
  });

  it('委派查不到：有他人墓碑时拒绝，没有时放行；委派已改走、前所有者、管理员放行', async () => {
    const f = await fixture();
    const before = await f.actor('before');
    const rival = await f.actor('rival');
    const admin = await f.actor('admin', 'admin');
    for (const name of ['unknown', 'moved', 'mine', 'admin']) await bury(f.domain(name), before.id);
    const net = stubNetwork({
      doh: { [f.domain('unknown')]: 'servfail', [f.domain('fresh')]: 'servfail', [f.domain('mine')]: 'servfail' },
      rdap: { [f.domain('moved')]: ['ns1.elsewhere.example', 'ns2.elsewhere.example'], [f.domain('admin')]: OURS },
    });
    expect(await add(rival.jwt, f.domain('unknown'))).toMatchObject({ status: 409, error: { message: expect.stringContaining('暂时无法确认') } });
    expect((await add(rival.jwt, f.domain('fresh'))).status).toBe(201);
    expect((await add(rival.jwt, f.domain('moved'))).status).toBe(201);
    expect((await add(before.jwt, f.domain('mine'))).status).toBe(201);
    net.lookups.length = 0;
    expect((await add(admin.jwt, f.domain('admin'))).status).toBe(201);
    expect(net.lookups).toEqual([]);
    // 过了保留期的墓碑不再给前所有者优先权，也不再触发「查不到就拒绝」
    await bury(f.domain('old'), before.id, new Date(Date.now() - (HOSTED_TOMBSTONE_RETENTION_DAYS + 1) * DAY));
    stubNetwork({ doh: { [f.domain('old')]: 'servfail' } });
    expect((await add(rival.jwt, f.domain('old'))).status).toBe(201);
  });

  it('每日维护清除过期墓碑；迁移 0024 按审计日志回填此前删除的域名', async () => {
    const f = await fixture();
    const user = await f.actor('owner');
    await bury(f.domain('stale'), user.id, new Date(Date.now() - (HOSTED_TOMBSTONE_RETENTION_DAYS + 1) * DAY));
    await bury(f.domain('recent'), user.id);
    expect(await purgeHostedTombstones(env)).toBeGreaterThanOrEqual(1);
    expect(await tombstone(f.domain('stale'))).toBeUndefined();
    expect(await tombstone(f.domain('recent'))).toBeDefined();

    await db.insert(adminAuditLogs).values([
      { actorId: user.id, action: 'hosted_domain.create', target: f.domain('gone'), detail: 'zone z1，NS ada.ns.cloudflare.com / bob.ns.cloudflare.com', createdAt: new Date(1000) },
      { actorId: 0, action: 'hosted_domain.expire', target: f.domain('gone'), detail: '到期', createdAt: new Date(5000) },
      { actorId: user.id, action: 'hosted_domain.create', target: f.domain('alive'), detail: 'zone z2，NS ada.ns.cloudflare.com / bob.ns.cloudflare.com' },
    ]);
    await db.insert(hostedDomains).values({ domain: f.domain('alive'), userId: user.id, status: 'active' });
    const backfill = (migration0024 as string).split('--> statement-breakpoint').pop()!;
    await env.db.prepare(backfill).run();
    expect(await tombstone(f.domain('gone'))).toMatchObject({ userId: user.id, nameServers: OURS, reason: 'backfill', deletedAt: new Date(5000) });
    expect(await tombstone(f.domain('alive'))).toBeUndefined();
  });
});
