import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HOSTED_DNS_REQUESTS_PER_MINUTE, type ApiScope, type CreatedApiKey, type HostedDnsRecord, type HostedDomain,
} from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomainMembers, hostedDomains, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { HOSTED_DNS_RATE_SCOPE } from '../src/services/hosted-dns.js';
import {
  HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, MAX_HOSTED_CHECKS_PER_MINUTE, MAX_HOSTED_CREATES_PER_MINUTE,
  MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE,
} from '../src/services/hosted-domain.js';
import { bumpCounter, minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { grantLegacyAdminScope, TEST_PASSWORD, testPasswordHash } from './key-helpers.js';
import type { Env } from '../src/types.js';

/**
 * /v1 托管域名：与 /api 共用 service，这里核对 Key 的 scope、可见范围、只用 JWT 的操作不存在，
 * 以及额度、限流、DNS 冲突规则与 /api 一致（计数与 /api 共用）。Cloudflare 全部用假接口。
 */

const app = createApp();
const db = createDb(env);
const ACCOUNT = 'acct-test';
const WORKER = 'hpc-cloud-mail';
const DOMAIN_SCOPES: ApiScope[] = ['domain.read', 'domain.write'];
/** 第 2 期之前「完全访问」的五个 scope：已有 Key 不自动获得新 scope */
const LEGACY_FULL: ApiScope[] = ['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write'];

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied: boolean;
  ttl: number;
  meta: Record<string, boolean>;
  comment: string | null;
  modified_on: string;
}

interface FakeZone {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'moved';
  routing: { enabled: boolean; status: string };
  catchAll: { enabled: boolean; actions: unknown } | null;
  sending: { tag: string; name: string; status: string } | null;
  records: Map<string, FakeRecord>;
}

let recordSeq = 0;
const rid = () => (++recordSeq).toString(16).padStart(32, '0');
const MAIL_META = { email_routing: true, read_only: true };

function record(fields: Partial<FakeRecord> & Pick<FakeRecord, 'type' | 'name' | 'content'>): FakeRecord {
  return { id: rid(), proxied: false, ttl: 1, meta: {}, comment: null, modified_on: '2026-11-01T00:00:00.000Z', ...fields };
}

/** 与线上一致的邮箱记录：根域 SPF 与 _dmarc 没有 meta 标记 */
function mailRecords(domain: string): FakeRecord[] {
  return [
    record({ type: 'MX', name: domain, content: 'route1.mx.cloudflare.net', priority: 10, meta: MAIL_META }),
    record({ type: 'TXT', name: domain, content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"' }),
    record({ type: 'TXT', name: `cf2024-1._domainkey.${domain}`, content: '"v=DKIM1; p=MIIB"', meta: MAIL_META }),
    record({ type: 'TXT', name: `_dmarc.${domain}`, content: '"v=DMARC1; p=reject;"' }),
  ];
}

/** 有状态的假 Cloudflare：建 zone、开通收发与 DNS 记录，记录每次调用 */
function fakeCloudflare(opts: { createError?: number } = {}) {
  const zones = new Map<string, FakeZone>();
  const calls: string[] = [];
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);
  const zoneView = (zone: FakeZone) => ({
    id: zone.id, name: zone.name, status: zone.status, name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    original_name_servers: ['ns1.registrar.example', 'ns2.registrar.example'], original_registrar: 'Example Registrar, Inc.',
    activated_on: zone.status === 'active' ? new Date().toISOString() : null, created_on: new Date().toISOString(),
  });
  const newZone = (id: string, name: string, status: FakeZone['status']): FakeZone =>
    ({ id, name, status, routing: { enabled: false, status: 'unconfigured' }, catchAll: null, sending: null, records: new Map() });

  function dnsRoute(zone: FakeZone, method: string, recordId: string | undefined, url: URL, body: Record<string, unknown>): Response {
    if (!recordId && method === 'GET') {
      const all = [...zone.records.values()];
      return ok(all, { result_info: { page: 1, per_page: Number(url.searchParams.get('per_page') ?? 100), count: all.length, total_count: all.length, total_pages: 1 } });
    }
    if (!recordId && method === 'POST') {
      const created = record({ type: String(body.type), name: String(body.name), content: String(body.content ?? ''), ttl: Number(body.ttl ?? 1),
        proxied: Boolean(body.proxied), comment: body.comment ? String(body.comment) : null,
        ...(body.priority === undefined ? {} : { priority: Number(body.priority) }) });
      zone.records.set(created.id, created);
      return ok(created);
    }
    const existing = recordId ? zone.records.get(recordId) : undefined;
    if (!existing) return fail(404, 81044, 'Record does not exist.');
    if (method === 'GET') return ok(existing);
    if (method === 'PATCH') {
      const updated = { ...existing, ...(body.content === undefined ? {} : { content: String(body.content) }), name: String(body.name ?? existing.name),
        ttl: Number(body.ttl ?? existing.ttl), modified_on: '2026-11-17T00:00:00.000Z' };
      zone.records.set(existing.id, updated);
      return ok(updated);
    }
    if (method === 'DELETE') {
      zone.records.delete(existing.id);
      return ok({ id: existing.id });
    }
    return fail(400, 9999, `unexpected ${method}`);
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    // 他人添加前的公开委派预检：RDAP 查不到、DoH 的 NS 为空，按「委派已知且不指向本站」放行
    if (url.hostname === 'rdap.org') return json({ errorCode: 404 }, 404);
    if (url.hostname === 'cloudflare-dns.com') return json({ Status: 0, Answer: [] });
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      const list = [...zones.values()].filter((zone) => !name || zone.name === name);
      return ok(list.map(zoneView), { result_info: { total_count: list.length } });
    }
    if (path === '/zones' && method === 'POST') {
      if (opts.createError) return fail(400, opts.createError, 'zone rejected');
      const zone = newZone(`zone-${++seq}`, String(body.name), 'pending');
      zones.set(zone.id, zone);
      return ok(zoneView(zone));
    }
    const match = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    const zone = match ? zones.get(match[1]!) : undefined;
    // 与真实 Cloudflare 一致：不存在的 zone 返回 403/9109
    if (!zone) return fail(403, 9109, 'Invalid zone identifier');
    const rest = match![2] ?? '';
    const dns = rest.match(/^\/dns_records(?:\/([^/]+))?$/);
    if (dns) return dnsRoute(zone, method, dns[1], url, body);
    if (rest === '' && method === 'GET') return ok(zoneView(zone));
    if (rest === '/activation_check') return ok({ id: zone.id });
    if (rest === '/email/routing' && method === 'GET') return ok(zone.routing);
    if (rest === '/email/routing/dns' && method === 'POST') {
      if (zone.status !== 'active') return fail(400, 2009, 'Active zone required');
      zone.routing = { enabled: true, status: 'ready' };
      return ok(zone.routing);
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'GET') return ok(zone.catchAll ?? { enabled: false, actions: [{ type: 'drop', value: [] }] });
    if (rest === '/email/routing/rules/catch_all' && method === 'PUT') {
      zone.catchAll = { enabled: Boolean(body.enabled), actions: body.actions };
      return ok(zone.catchAll);
    }
    if (rest === '/email/sending/subdomains' && method === 'GET') return ok(zone.sending ? [{ tag: zone.sending.tag, name: zone.sending.name }] : []);
    if (rest === '/email/sending/subdomains' && method === 'POST') {
      zone.sending = { tag: `sub-${zone.id}`, name: String(body.name), status: zone.status === 'active' ? 'ready' : 'unconfigured' };
      return ok({ tag: zone.sending.tag, name: zone.sending.name, enabled: true });
    }
    const sending = rest.match(/^\/email\/sending\/subdomains\/([^/]+)(\/.*)?$/);
    const subdomain = zone.sending;
    if (sending && subdomain && subdomain.tag === sending[1]) {
      if (sending[2] === '/dns/status') return ok({ status: subdomain.status, errors: [], records: [] });
      if (sending[2] === '/dns' && method === 'POST') { subdomain.status = 'ready'; return ok({ status: 'ready', errors: [], records: [] }); }
    }
    return fail(400, 9999, `unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    zones, calls,
    writes: () => calls.filter((entry) => !entry.startsWith('GET ')),
    zoneByName: (name: string) => [...zones.values()].find((zone) => zone.name === name),
    /** 直接放一个已生效、带邮箱记录的 zone */
    activeZone: (id: string, name: string) => {
      const zone = newZone(id, name, 'active');
      for (const item of mailRecords(name)) zone.records.set(item.id, item);
      zones.set(id, zone);
      return zone;
    },
  };
}

const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: WORKER };
const HOSTED = { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 0 };

let sequence = 0;
async function fixture() {
  const prefix = `v1hd${++sequence}`;
  await db.delete(hostedDomainMembers);
  await db.delete(hostedDomains);
  await updateSettings(env, {
    domains: { list: [{ domain: `${prefix}-system.test`, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    security: { require2fa: false },
    api: { enabled: true },
    hosted_domains: HOSTED,
  });
  // 计数在同一文件的用例之间共享，每个用例从零开始
  await env.db.prepare('DELETE FROM rate_counters WHERE scope IN (?, ?, ?, ?)')
    .bind(HOSTED_DNS_SITE_RATE_SCOPE, HOSTED_DNS_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE).run();

  /** 用户、JWT 与一把指定 scope 的 Key（经 /api/api-keys 创建，与真实流程一致） */
  async function actor(suffix: string, scopes: ApiScope[] = DOMAIN_SCOPES, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: await testPasswordHash(), authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    // admin scope 按存量管理员 Key 的形态直接补上
    const granted = scopes.filter((scope) => scope !== 'admin');
    const created = await data<CreatedApiKey>(await api('POST', '/api-keys', jwt, { name: `${suffix}-agent`, scopes: granted, rateLimit: 600, password: TEST_PASSWORD }), 201);
    expect(created.scopes).toEqual(granted);
    if (role === 'admin' && scopes.includes('admin')) await grantLegacyAdminScope(env, created.id);
    return { id: user.id, username: user.username, jwt, key: created.key, keyId: created.id };
  }
  /** 直接落一行已生效的托管域名，并在假 Cloudflare 建好带邮箱记录的 zone */
  async function hosted(cf: ReturnType<typeof fakeCloudflare>, owner: { id: number }, name = 'site') {
    const domain = `${prefix}-${name}.test`;
    const zoneId = `zone-${prefix}-${name}`;
    const row = (await db.insert(hostedDomains).values({ domain, userId: owner.id, status: 'active', zoneId }).returning().get())!;
    cf.activeZone(zoneId, domain);
    return { id: row.id, domain, zoneId };
  }
  return { prefix, domain: (name = 'mail') => `${prefix}-${name}.test`, actor, hosted };
}

async function send(prefix: '/api' | '/v1', method: string, path: string, token: string, body?: unknown, runtimeEnv: Env = runtime) {
  const ctx = createExecutionContext();
  const response = await app.request(`${prefix}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtimeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const api = (method: string, path: string, jwt: string, body?: unknown, runtimeEnv?: Env) => send('/api', method, path, jwt, body, runtimeEnv);
const v1 = (method: string, path: string, key: string, body?: unknown, runtimeEnv?: Env) => send('/v1', method, path, key, body, runtimeEnv);

async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number): Promise<{ code: string; message: string; fix?: string }> {
  const body = await response.json() as { error: { code: string; message: string; fix?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}
const counter = async (scope: string, subject: string) => (await readCounter(env, scope, subject, minuteWindow(1))).count;
const siteCalls = () => counter(HOSTED_DNS_SITE_RATE_SCOPE, 'all');

/** 离整分钟太近时等到下一分钟，避免计数窗口在用例中途切换 */
/** 最多等 margin 再开始，用例超时要留出这段等待 */
const MINUTE_EDGE_TIMEOUT = 30_000;
async function awayFromMinuteEdge(margin = 10_000) {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < margin) await new Promise((resolve) => setTimeout(resolve, left + 50));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/v1 接入自有域名', () => {
  it('提交域名返回要改的 NS；详情与列表和 /api 相同；检测推进到 active 后可认领地址，审计记为用户名（API Key #id）', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner', [...DOMAIN_SCOPES, 'mailbox.read', 'mailbox.write']);
    const domain = f.domain();

    const created = await data<HostedDomain>(await v1('POST', '/hosted-domains', owner.key, { domain }), 201);
    expect(created).toMatchObject({
      domain, status: 'pending', role: 'owner', ownerUserId: owner.id,
      nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      originalNameServers: ['ns1.registrar.example', 'ns2.registrar.example'],
      steps: { nameServers: 'waiting', routing: 'waiting' },
    });
    expect(created.expiresAt).not.toBeNull();
    expect(cf.calls.slice(0, 2)).toEqual(['GET /zones', 'POST /zones']);

    const viaKey = await data<HostedDomain>(await v1('GET', `/hosted-domains/${created.id}`, owner.key));
    expect(viaKey).toEqual(await data<HostedDomain>(await api('GET', `/hosted-domains/${created.id}`, owner.jwt)));
    expect(await data<HostedDomain[]>(await v1('GET', '/hosted-domains', owner.key)))
      .toEqual(await data<HostedDomain[]>(await api('GET', '/hosted-domains', owner.jwt)));

    // 用户在注册商改好 NS 后检测：开通收发，域名出现在可认领列表
    cf.zoneByName(domain)!.status = 'active';
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 60_000) }).where(eq(hostedDomains.id, created.id));
    const active = await data<HostedDomain>(await v1('POST', `/hosted-domains/${created.id}/check`, owner.key));
    expect(active).toMatchObject({ status: 'active', steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, expiresAt: null });
    expect((await data<{ domains: string[] }>(await v1('GET', '/domains', owner.key))).domains).toContain(domain);
    expect(await data<{ address: string }>(await v1('POST', '/mailboxes', owner.key, { localPart: 'hello', domain }), 201))
      .toMatchObject({ address: `hello@${domain}` });

    const audit = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.create'), eq(adminAuditLogs.target, domain))).all();
    expect(audit.map((row) => [row.actorId, row.actorName])).toEqual([[owner.id, `${owner.username}（API Key #${owner.keyId}）`]]);
  });

  it('缺 scope 时 403 并写明缺哪个，不计数、不调用 Cloudflare；已有 Key 不自动获得新 scope', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const legacy = await f.actor('legacy', LEGACY_FULL);
    const reader = await f.actor('reader', ['domain.read']);
    const writer = await f.actor('writer', ['domain.write']);
    const site = await f.hosted(cf, reader);
    const recordId = [...cf.zones.get(site.zoneId)!.records.keys()][0]!;
    const record = { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' };
    const reads = [['GET', '/hosted-domains'], ['GET', `/hosted-domains/${site.id}`], ['GET', `/hosted-domains/${site.id}/dns-records`]] as const;
    const writes = [
      ['POST', '/hosted-domains', { domain: f.domain('new') }], ['POST', `/hosted-domains/${site.id}/check`, undefined],
      ['POST', `/hosted-domains/${site.id}/dns-records`, record], ['PUT', `/hosted-domains/${site.id}/dns-records/${recordId}`, record],
      ['DELETE', `/hosted-domains/${site.id}/dns-records/${recordId}`, undefined],
    ] as const;

    for (const [method, path] of reads) {
      for (const key of [legacy.key, writer.key]) {
        const error = await errorOf(await v1(method, path, key), 403);
        expect(error).toMatchObject({ code: 'forbidden', message: '需要 API scope: domain.read', fix: expect.stringContaining('domain.read') });
      }
    }
    for (const [method, path, body] of writes) {
      for (const key of [legacy.key, reader.key]) {
        const error = await errorOf(await v1(method, path, key, body), 403);
        expect(error).toMatchObject({ code: 'forbidden', message: '需要 API scope: domain.write', fix: expect.stringContaining('domain.write') });
      }
    }
    expect(cf.calls).toEqual([]);
    for (const user of [legacy, reader, writer]) {
      for (const scope of [HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE, HOSTED_DNS_RATE_SCOPE]) expect(await counter(scope, String(user.id))).toBe(0);
    }
    expect(await siteCalls()).toBe(0);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('new'))).get()).toBeUndefined();

    // 只有 domain.read 的所有者能读，读到的与 /api 一致
    expect(await data<HostedDnsRecord[]>(await v1('GET', `/hosted-domains/${site.id}/dns-records`, reader.key)))
      .toEqual(await data<HostedDnsRecord[]>(await api('GET', `/hosted-domains/${site.id}/dns-records`, reader.jwt)));
  });

  it('可见范围与 /api 一致：成员能看进度、DNS 与检测 403，无关用户 404，管理员 Key 管理他人域名但列表只含自己的', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const stranger = await f.actor('stranger');
    const admin = await f.actor('admin', [...DOMAIN_SCOPES, 'admin'], 'admin');
    const site = await f.hosted(cf, owner);
    await db.insert(hostedDomainMembers).values({ domainId: site.id, userId: member.id, grantedBy: owner.id });

    expect((await data<HostedDomain[]>(await v1('GET', '/hosted-domains', member.key))).map((item) => [item.id, item.role])).toEqual([[site.id, 'member']]);
    expect(await data<HostedDomain>(await v1('GET', `/hosted-domains/${site.id}`, member.key)))
      .toEqual(await data<HostedDomain>(await api('GET', `/hosted-domains/${site.id}`, member.jwt)));
    for (const [method, path] of [['GET', `/hosted-domains/${site.id}/dns-records`], ['POST', `/hosted-domains/${site.id}/check`]] as const) {
      expect((await errorOf(await v1(method, path, member.key), 403)).code).toBe('forbidden');
      expect((await errorOf(await v1(method, path, stranger.key), 404)).code).toBe('not_found');
    }
    expect((await errorOf(await v1('GET', `/hosted-domains/${site.id}`, stranger.key), 404)).code).toBe('not_found');
    expect((await errorOf(await v1('POST', `/hosted-domains/${site.id}/dns-records`, stranger.key,
      { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' }), 404)).code).toBe('not_found');
    expect(await data<HostedDomain[]>(await v1('GET', '/hosted-domains', stranger.key))).toEqual([]);
    expect(cf.calls).toEqual([]);

    expect(await data<HostedDomain>(await v1('GET', `/hosted-domains/${site.id}`, admin.key))).toMatchObject({ role: 'admin' });
    expect(await data<HostedDomain[]>(await v1('GET', '/hosted-domains', admin.key))).toEqual([]);
    const created = await data<HostedDnsRecord>(await v1('POST', `/hosted-domains/${site.id}/dns-records`, admin.key,
      { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' }), 201);
    expect(created).toMatchObject({ type: 'A', name: 'www', kind: 'user' });
    const audit = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.dns'), eq(adminAuditLogs.target, site.domain))).all();
    expect(audit.map((row) => row.actorName)).toEqual([`${admin.username}（API Key #${admin.keyId}）`]);
  });

  it('删除、改成员上限、成员管理与过户只能用 JWT：/v1 返回 404，域名与成员不变', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', [...DOMAIN_SCOPES, 'admin'], 'admin');
    const other = await f.actor('other');
    const site = await f.hosted(cf, owner);
    await db.insert(hostedDomainMembers).values({ domainId: site.id, userId: other.id, grantedBy: owner.id });
    const jwtOnly = [
      ['DELETE', `/hosted-domains/${site.id}`, undefined],
      ['PUT', `/hosted-domains/${site.id}`, { memberLimit: 5 }],
      ['GET', `/hosted-domains/${site.id}/members`, undefined],
      ['PUT', `/hosted-domains/${site.id}/members`, { userIds: [], expectedOwnerId: owner.id }],
      ['DELETE', `/hosted-domains/${site.id}/members/${other.id}`, undefined],
      ['POST', `/hosted-domains/${site.id}/transfer`, { userId: other.id, expectedOwnerId: owner.id, includeMailboxes: true }],
    ] as const;
    for (const key of [owner.key, admin.key]) {
      for (const [method, path, body] of jwtOnly) {
        expect((await errorOf(await v1(method, path, key, body), 404)).code, `${method} ${path}`).toBe('not_found');
      }
    }
    // /v1/admin 只对管理员 Key 开放；那里没有暂停，GET /v1/admin/hosted-domains 是只读查询（不是 JWT 的管理列表）
    expect((await errorOf(await v1('POST', `/admin/hosted-domains/${site.id}/suspend`, owner.key), 403)).code).toBe('forbidden');
    expect((await errorOf(await v1('POST', `/admin/hosted-domains/${site.id}/suspend`, admin.key), 404)).code).toBe('not_found');
    expect((await data<{ id: number }[]>(await v1('GET', `/admin/hosted-domains?domains=${site.domain}`, admin.key))).map((item) => item.id))
      .toEqual([site.id]);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, site.id)).get())
      .toMatchObject({ status: 'active', userId: owner.id, memberLimit: 0 });
    expect(await db.select().from(hostedDomainMembers).where(eq(hostedDomainMembers.domainId, site.id)).all()).toHaveLength(1);
    expect(cf.calls).toEqual([]);
    // 同一操作用 JWT 仍然可用
    expect(await data(await api('GET', `/hosted-domains/${site.id}/members`, owner.jwt))).toHaveLength(1);
  });
});

describe('/v1 托管域名 DNS 解析', () => {
  it('列表与 /api 相同；邮箱记录只读，冲突记录在调用 Cloudflare 写接口前 400；增改删记审计', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const site = await f.hosted(cf, owner);
    const path = `/hosted-domains/${site.id}/dns-records`;
    const list = await data<HostedDnsRecord[]>(await v1('GET', path, owner.key));
    expect(list).toEqual(await data<HostedDnsRecord[]>(await api('GET', path, owner.jwt)));
    expect(list.map((item) => item.kind)).toEqual(['mail', 'mail', 'mail', 'mail']);

    for (const input of [
      { type: 'MX', name: '@', ttl: 1, content: 'mx.other.example', priority: 10 },
      { type: 'TXT', name: '@', ttl: 1, content: 'v=spf1 -all' },
      { type: 'TXT', name: '_dmarc', ttl: 1, content: 'v=DMARC1; p=none' },
      { type: 'CNAME', name: '@', ttl: 1, content: 'cname.vercel-dns.com' },
    ]) {
      const viaKey = await errorOf(await v1('POST', path, owner.key, input), 400);
      expect(viaKey.code).toBe('validation_failed');
      expect(viaKey).toEqual(await errorOf(await api('POST', path, owner.jwt, input), 400));
    }
    const mx = list.find((item) => item.type === 'MX')!;
    const input = { type: 'MX', name: '@', ttl: 1, content: 'mx.other.example', priority: 10 };
    expect(await errorOf(await v1('PUT', `${path}/${mx.id}`, owner.key, input), 403)).toEqual({ code: 'forbidden', message: mx.lockedReason });
    expect(await errorOf(await v1('DELETE', `${path}/${mx.id}`, owner.key), 403)).toEqual({ code: 'forbidden', message: mx.lockedReason });
    expect((await errorOf(await v1('DELETE', `${path}/not-a-record-id`, owner.key), 404)).message).toBe('解析记录不存在');
    expect(cf.writes()).toEqual([]);

    const www = await data<HostedDnsRecord>(await v1('POST', path, owner.key, { type: 'A', name: 'www', ttl: 1, content: '203.0.113.10' }), 201);
    expect(www).toMatchObject({ type: 'A', name: 'www', content: '203.0.113.10', proxied: false, kind: 'user' });
    const updated = await data<HostedDnsRecord>(await v1('PUT', `${path}/${www.id}`, owner.key, { type: 'A', name: 'www', ttl: 300, content: '203.0.113.11' }));
    expect(updated).toMatchObject({ id: www.id, content: '203.0.113.11', ttl: 300 });
    expect(await data(await v1('DELETE', `${path}/${www.id}`, owner.key))).toEqual({ success: true });
    expect(cf.writes()).toEqual([`POST /zones/${site.zoneId}/dns_records`, `PATCH /zones/${site.zoneId}/dns_records/${www.id}`,
      `DELETE /zones/${site.zoneId}/dns_records/${www.id}`]);
    const audit = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.dns'), eq(adminAuditLogs.target, site.domain))).orderBy(adminAuditLogs.id).all();
    expect(audit.map((row) => [row.actorName, row.detail])).toEqual([
      [`${owner.username}（API Key #${owner.keyId}）`, '新增 A www → 203.0.113.10'],
      [`${owner.username}（API Key #${owner.keyId}）`, '修改 A www：203.0.113.10 → 203.0.113.11'],
      [`${owner.username}（API Key #${owner.keyId}）`, '删除 A www → 203.0.113.11'],
    ]);
  });
});

describe('/v1 托管域名的额度、限流与开关与 /api 共用', () => {
  it(`添加：每人每分钟 ${MAX_HOSTED_CREATES_PER_MINUTE} 次由 JWT 与 Key 合计；同时等待生效数受限；全站额度用尽 429`, async () => {
    await awayFromMinuteEdge();
    const cf = fakeCloudflare({ createError: 1099 });
    const f = await fixture();
    const owner = await f.actor('owner');
    for (let i = 0; i < MAX_HOSTED_CREATES_PER_MINUTE; i++) {
      const call = i % 2 ? v1('POST', '/hosted-domains', owner.key, { domain: f.domain(`try${i}`) })
        : api('POST', '/hosted-domains', owner.jwt, { domain: f.domain(`try${i}`) });
      await errorOf(await call, 400);
    }
    const callsBefore = cf.calls.length;
    expect(await errorOf(await v1('POST', '/hosted-domains', owner.key, { domain: f.domain('more') }), 429))
      .toMatchObject({ code: 'rate_limited', message: '添加域名过于频繁，请稍后再试' });
    expect(cf.calls).toHaveLength(callsBefore);

    // 等待生效数：已有一个 pending 时普通用户不能再添加
    const second = await f.actor('second');
    await db.insert(hostedDomains).values({ domain: f.domain('waiting'), userId: second.id, status: 'pending', zoneId: 'zone-waiting' });
    expect(await errorOf(await v1('POST', '/hosted-domains', second.key, { domain: f.domain('next') }), 403))
      .toMatchObject({ code: 'forbidden', message: expect.stringContaining('等待 NS 生效') });

    // 全站 Cloudflare 额度不够一次添加：429，不占位、不调用 Cloudflare
    const third = await f.actor('third');
    await bumpCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1), MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - (await siteCalls()) - 1);
    expect(await errorOf(await v1('POST', '/hosted-domains', third.key, { domain: f.domain('busy') }), 429))
      .toMatchObject({ code: 'rate_limited' });
    expect(cf.calls).toHaveLength(callsBefore);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('busy'))).get()).toBeUndefined();
  }, MINUTE_EDGE_TIMEOUT);

  it(`检测每人每分钟 ${MAX_HOSTED_CHECKS_PER_MINUTE} 次、DNS 每人每分钟 ${MAX_HOSTED_DNS_REQUESTS_PER_MINUTE} 次，与 /api 共用计数；超出 429 不调用 Cloudflare`, async () => {
    await awayFromMinuteEdge();
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const site = await f.hosted(cf, owner);
    await bumpCounter(env, HOSTED_CHECK_RATE_SCOPE, String(owner.id), minuteWindow(1), MAX_HOSTED_CHECKS_PER_MINUTE - 1);
    await bumpCounter(env, HOSTED_DNS_RATE_SCOPE, String(owner.id), minuteWindow(1), MAX_HOSTED_DNS_REQUESTS_PER_MINUTE - 1);
    // 最后一次额度给 /api，之后 /v1 被拒
    await data(await api('GET', `/hosted-domains/${site.id}/dns-records`, owner.jwt));
    await data(await api('POST', `/hosted-domains/${site.id}/check`, owner.jwt));
    const callsBefore = cf.calls.length;
    expect(await errorOf(await v1('GET', `/hosted-domains/${site.id}/dns-records`, owner.key), 429))
      .toMatchObject({ code: 'rate_limited', message: '解析操作过于频繁，请稍后再试' });
    expect(await errorOf(await v1('POST', `/hosted-domains/${site.id}/check`, owner.key), 429))
      .toMatchObject({ code: 'rate_limited', message: '检测过于频繁，请稍后再试' });
    expect(cf.calls).toHaveLength(callsBefore);

    // 全站额度用尽：其他用户的 DNS 请求同样 429
    const admin = await f.actor('admin', [...DOMAIN_SCOPES, 'admin'], 'admin');
    await bumpCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1), MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - (await siteCalls()));
    expect(await errorOf(await v1('GET', `/hosted-domains/${site.id}/dns-records`, admin.key), 429))
      .toMatchObject({ code: 'rate_limited', message: '当前解析操作较多，请稍后再试' });
    expect(cf.calls).toHaveLength(callsBefore);
  }, MINUTE_EDGE_TIMEOUT);

  it('关闭托管开关时添加与检测 403、DNS 仍可用；Worker 没有 Cloudflare 凭据时全部 403', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const site = await f.hosted(cf, owner);
    await updateSettings(env, { hosted_domains: { ...HOSTED, enabled: false } });
    for (const [path, body] of [['/hosted-domains', { domain: f.domain('off') }], [`/hosted-domains/${site.id}/check`, undefined]] as const) {
      expect(await errorOf(await v1('POST', path, owner.key, body), 403)).toEqual({ code: 'forbidden', message: '本站未开启域名托管' });
    }
    expect(await data<HostedDnsRecord[]>(await v1('GET', `/hosted-domains/${site.id}/dns-records`, owner.key))).toHaveLength(4);
    expect(await data<HostedDomain>(await v1('GET', `/hosted-domains/${site.id}`, owner.key))).toMatchObject({ id: site.id });

    await updateSettings(env, { hosted_domains: HOSTED });
    for (const [method, path, body] of [['POST', '/hosted-domains', { domain: f.domain('nocreds') }],
      ['POST', `/hosted-domains/${site.id}/check`, undefined], ['GET', `/hosted-domains/${site.id}/dns-records`, undefined]] as const) {
      expect(await errorOf(await v1(method, path, owner.key, body, env), 403)).toEqual({ code: 'forbidden', message: '本站未开启域名托管' });
    }
    expect(cf.calls).toEqual(['GET /zones/' + site.zoneId + '/dns_records']);
  });
});
