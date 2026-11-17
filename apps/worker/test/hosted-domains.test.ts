import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain, HostedDomainMember, HostedDomainTransferResult, Mailbox } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomainMembers, hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import {
  HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, MAX_HOSTED_CHECKS_PER_MINUTE, MAX_HOSTED_CREATES_PER_MINUTE,
  MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE, syncDueHostedDomains, syncHostedDomain,
} from '../src/services/hosted-domain.js';
import { bumpCounter, minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { handleInbound } from '../src/services/inbound.js';
import { sendMail } from '../src/services/outbound.js';
import { createSession } from '../src/services/session.js';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const ACCOUNT = 'acct-test';
const WORKER = 'hpc-cloud-mail';

interface FakeZone {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'moved';
  routing: { enabled: boolean; status: string };
  catchAll: { enabled: boolean; actions: { type: string; value: string[] }[] } | null;
  sending: { tag: string; name: string; status: string } | null;
}

/** 有状态的假 Cloudflare API：只实现托管域名用到的接口，并记录每次调用 */
function fakeCloudflare(opts: { dnssec?: string[]; existing?: string[]; createError?: number } = {}) {
  const zones = new Map<string, FakeZone>();
  const calls: string[] = [];
  let seq = 0;
  for (const name of opts.existing ?? []) {
    zones.set(`zone-existing-${name}`, { id: `zone-existing-${name}`, name, status: 'active', routing: { enabled: false, status: 'unconfigured' }, catchAll: null, sending: null });
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], result, ...extra });
  const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], result: null }, status);
  const zoneView = (zone: FakeZone) => ({
    id: zone.id, name: zone.name, status: zone.status, name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    original_name_servers: ['ns1.registrar.example', 'ns2.registrar.example'], original_registrar: 'Example Registrar, Inc.',
    activated_on: zone.status === 'active' ? new Date().toISOString() : null, created_on: new Date().toISOString(),
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    // 他人添加前的公开委派预检：RDAP 默认查不到，DoH 的 NS 默认为空（委派已知且不指向本站）
    if (url.hostname === 'rdap.org') return json({ errorCode: 404 }, 404);
    if (url.hostname === 'cloudflare-dns.com') {
      const name = url.searchParams.get('name') ?? '';
      const answer = url.searchParams.get('type') === 'DS' && opts.dnssec?.includes(name) ? [{ name, type: 43, data: '2371 13 2 ABC' }] : [];
      return json({ Status: 0, Answer: answer });
    }
    expect(url.origin).toBe('https://api.cloudflare.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === `/accounts/${ACCOUNT}/tokens/verify`) return ok({ id: 'tok', status: 'active' });
    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      const status = url.searchParams.get('status');
      const list = [...zones.values()].filter((zone) => (!name || zone.name === name) && (!status || zone.status === status));
      return ok(list.map(zoneView), { result_info: { total_count: list.length } });
    }
    if (path === '/zones' && method === 'POST') {
      if (opts.createError) return fail(400, opts.createError, 'zone rejected');
      const name = String(body.name);
      if ([...zones.values()].some((zone) => zone.name === name)) return fail(400, 1061, 'already exists');
      const zone: FakeZone = { id: `zone-${++seq}`, name, status: 'pending', routing: { enabled: false, status: 'unconfigured' }, catchAll: null, sending: null };
      zones.set(zone.id, zone);
      return ok(zoneView(zone));
    }
    const match = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    const zone = match ? zones.get(match[1]!) : undefined;
    // 与真实 Cloudflare 一致：不存在的 zone 返回 403/9109，和无权限难以区分
    if (!zone) return fail(403, 9109, 'Invalid zone identifier');
    const rest = match![2] ?? '';
    if (rest === '' && method === 'GET') return ok(zoneView(zone));
    if (rest === '' && method === 'DELETE') { zones.delete(zone.id); return ok({ id: zone.id }); }
    if (rest === '/activation_check') return ok({ id: zone.id });
    if (rest === '/email/routing' && method === 'GET') return ok(zone.routing);
    if (rest === '/email/routing/dns' && method === 'POST') {
      if (zone.status !== 'active') return fail(400, 2009, 'Active zone required');
      // 与真实 Cloudflare 一致：name 只用于子域，传根域名返回 2007
      if (body.name !== undefined && !String(body.name).endsWith(`.${zone.name}`)) {
        return fail(400, 2007, `Invalid Input: must be a subdomains of ${zone.name}`);
      }
      zone.routing = { enabled: true, status: 'ready' };
      return ok(zone.routing);
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'GET') return ok(zone.catchAll ?? { enabled: false, actions: [{ type: 'drop', value: [] }] });
    if (rest === '/email/routing/rules/catch_all' && method === 'PUT') {
      zone.catchAll = { enabled: Boolean(body.enabled), actions: body.actions as FakeZone['catchAll'] extends infer T ? T extends { actions: infer A } ? A : never : never };
      return ok(zone.catchAll);
    }
    if (rest === '/email/sending/subdomains' && method === 'GET') return ok(zone.sending ? [{ tag: zone.sending.tag, name: zone.sending.name }] : []);
    if (rest === '/email/sending/subdomains' && method === 'POST') {
      zone.sending = { tag: `sub-${zone.id}`, name: String(body.name), status: zone.status === 'active' ? 'ready' : 'unconfigured' };
      return ok({ tag: zone.sending.tag, name: zone.sending.name, enabled: true });
    }
    const sending = rest.match(/^\/email\/sending\/subdomains\/([^/]+)(\/.*)?$/);
    if (sending) {
      if (!zone.sending || zone.sending.tag !== sending[1]) return fail(404, 1001, 'subdomain not found');
      if (sending[2] === '/dns/status') return ok({ status: zone.sending.status, errors: [], records: [] });
      if (sending[2] === '/dns' && method === 'POST') { zone.sending.status = 'ready'; return ok({ status: 'ready', errors: [], records: [] }); }
      if (!sending[2] && method === 'DELETE') { zone.sending = null; return ok({}); }
    }
    return fail(400, 9999, `unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { zones, calls, fetchMock, zoneByName: (name: string) => [...zones.values()].find((zone) => zone.name === name) };
}

const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: WORKER };

let sequence = 0;
async function fixture(hosted: Partial<{ maxPerUser: number; maxPendingPerUser: number; maxPendingTotal: number; pendingDays: number; autoClaimLimit: number }> = {}) {
  const prefix = `hd${++sequence}`;
  await db.delete(hostedDomainMembers);
  await db.delete(hostedDomains);
  await updateSettings(env, {
    domains: { list: [{ domain: `${prefix}-system.test`, public: true, perUserLimit: 0 }] },
    mailbox_policy: { perUserLimit: 1, reservedLocalParts: ['admin', 'postmaster'] },
    code_extract: { enabled: false, aiEnabled: false }, quota: { dailyOutbound: 0, dailyRecipients: 0 },
    hosted_domains: { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 0, ...hosted },
  });
  async function actor(suffix: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  return { prefix, domain: (name = 'mail') => `${prefix}-${name}.test`, actor };
}

async function call(method: string, path: string, token: string, body?: unknown, runtimeEnv: Env = runtime) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtimeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

/** 建域名并模拟用户改好 NS、定时任务完成开通 */
async function activeDomain(cf: ReturnType<typeof fakeCloudflare>, owner: { jwt: string }, domain: string): Promise<HostedDomain> {
  const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain }), 201);
  cf.zoneByName(domain)!.status = 'active';
  await syncHostedDomain(runtime, created.id);
  return data<HostedDomain>(await call('GET', `/hosted-domains/${created.id}`, owner.jwt));
}

async function receive(address: string, label: string, runtimeEnv: Env = runtime) {
  const raw = `From: sender@example.net\r\nTo: ${address}\r\nMessage-ID: <${label}@example.net>\r\nSubject: hosted\r\nContent-Type: text/plain\r\n\r\nhello`;
  const ctx = createExecutionContext();
  const rejected: string[] = [];
  await handleInbound({ to: address, from: 'sender@example.net', raw: new Response(raw).body!, headers: new Headers(),
    forward: async () => {}, setReject: (reason: string) => { rejected.push(reason); },
  } as unknown as ForwardableEmailMessage, runtimeEnv, ctx);
  await waitOnExecutionContext(ctx);
  const stored = await db.select().from(messages).where(eq(messages.messageId, `<${label}@example.net>`)).get();
  return { rejected, stored };
}

/** 在第一条匹配 pattern 的 SQL 执行前（在 batch 里时为整个 batch 执行前）插入并发写入，用来确定性地复现交错 */
function beforeStatement(base: Env, pattern: RegExp, hook: () => Promise<void>): Env {
  let triggered = false;
  const fire = async () => {
    if (triggered) return;
    triggered = true;
    await hook();
  };
  const intercepted = new WeakSet<D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, intercept: boolean): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), intercept);
        const method = Reflect.get(target, property);
        if (typeof method !== 'function') return method;
        return async (...args: unknown[]) => {
          if (intercept && ['first', 'all', 'run', 'raw'].includes(String(property))) await fire();
          return method.apply(target, args);
        };
      },
    });
    if (intercept) intercepted.add(proxy);
    return proxy;
  };
  return { ...base, db: new Proxy(base.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => wrap(target.prepare(query), pattern.test(query));
    if (property === 'batch') {
      return async (statements: D1PreparedStatement[]) => {
        if (statements.some((statement) => intercepted.has(statement))) await fire();
        return target.batch(statements);
      };
    }
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) };
}

const siteCalls = async () => (await readCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1))).count;

// 同一文件的用例共享 D1，且都在同一分钟内跑完：每个用例从空的分钟计数开始，避免累计到上限
beforeEach(async () => {
  await env.db.prepare('DELETE FROM rate_counters WHERE scope IN (?, ?, ?)')
    .bind(HOSTED_DNS_SITE_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('添加托管域名', () => {
  it('建 zone 返回 NS 与原 NS，预先接入 catch-all 与发信，Email Routing 等 NS 生效后补齐', async () => {
    const cf = fakeCloudflare({ dnssec: [] });
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain }), 201);
    expect(created).toMatchObject({
      domain, status: 'pending', role: 'owner', ownerUserId: owner.id,
      nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      originalNameServers: ['ns1.registrar.example', 'ns2.registrar.example'],
      steps: { nameServers: 'waiting', routing: 'waiting', catchAll: 'waiting', sending: 'waiting' },
      warnings: [],
    });
    expect(created.expiresAt).not.toBeNull();
    // 预配置在响应之后完成：catch-all 已指向本站，发信接入等 NS 生效后才就绪
    expect((await data<HostedDomain>(await call('GET', `/hosted-domains/${created.id}`, owner.jwt))).steps)
      .toEqual({ nameServers: 'waiting', routing: 'waiting', catchAll: 'ready', sending: 'waiting' });
    expect(cf.calls).toContain('PUT /zones/zone-1/email/routing/rules/catch_all');
    expect(cf.calls).toContain('POST /zones/zone-1/email/sending/subdomains');
    expect(cf.calls.some((entry) => entry.endsWith('/email/routing/dns'))).toBe(false);
    expect(cf.zones.get('zone-1')!.catchAll!.actions).toEqual([{ type: 'worker', value: [WORKER] }]);

    // NS 未生效时定时任务只读 zone 状态
    await syncHostedDomain(runtime, created.id);
    expect((await db.select().from(hostedDomains).where(eq(hostedDomains.id, created.id)).get())!.status).toBe('pending');

    cf.zones.get('zone-1')!.status = 'active';
    await syncDueHostedDomains(runtime);
    // pending 刚核对过，要等下一轮；用户点「立即检测」跳过等待
    const checked = await data<HostedDomain>(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt));
    expect(checked).toMatchObject({ status: 'pending' });
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 60_000) }).where(eq(hostedDomains.id, created.id));
    const active = await data<HostedDomain>(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt));
    expect(active).toMatchObject({ status: 'active', steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' }, lastError: '', expiresAt: null });
    expect(cf.zones.get('zone-1')!.routing).toEqual({ enabled: true, status: 'ready' });
    expect(await data<string[]>(await call('GET', '/domains', owner.jwt))).toEqual([`${f.prefix}-system.test`, domain]);
    expect((await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.action, 'hosted_domain.create'), eq(adminAuditLogs.target, domain))).all())).toHaveLength(1);
  });

  it('DNSSEC 未关闭时给出提示；同名 zone 已在站长账户、系统域名与本站已有历史的域名一律拒绝', async () => {
    const f = await fixture();
    const owner = await f.actor('owner');
    const signed = f.domain('signed');
    const cf = fakeCloudflare({ dnssec: [signed], existing: [f.domain('exists')] });
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: signed }), 201);
    expect(created.warnings.join('')).toContain('DNSSEC');
    await call('DELETE', `/hosted-domains/${created.id}`, owner.jwt);

    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('exists') }), 409)).message).toContain('Cloudflare 账户');
    expect(cf.zones.has(`zone-existing-${f.domain('exists')}`)).toBe(true);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('exists'))).get()).toBeUndefined();

    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: `${f.prefix}-system.test` }), 409)).message).toContain('系统域名');

    const used = f.domain('used');
    await db.insert(messages).values({ direction: 'inbound', address: `old@${used}`, domain: used, status: 'received' });
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: used }), 409)).message).toContain('历史');
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
  });

  it('Cloudflare 拒绝时释放占位并给出可读原因；功能未配置凭据时 403', async () => {
    const f = await fixture();
    const owner = await f.actor('owner');
    fakeCloudflare({ createError: 1099 });
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain() }), 400)).message).toContain('根域名');
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain())).get()).toBeUndefined();

    fakeCloudflare({ createError: 1118 });
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain() }), 429)).code).toBe('rate_limited');

    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain() }, env), 403)).message).toContain('未开启');
    const config = await (await app.request('/api/config', {}, env)).json() as { data: { hostedDomainsEnabled: boolean } };
    expect(config.data.hostedDomainsEnabled).toBe(false);
    const enabled = await (await app.request('/api/config', {}, runtime)).json() as { data: { hostedDomainsEnabled: boolean } };
    expect(enabled.data.hostedDomainsEnabled).toBe(true);
  });

  it('普通用户受同时等待生效数与总数限制，管理员不受个人上限', async () => {
    fakeCloudflare();
    const f = await fixture({ maxPerUser: 2, maxPendingPerUser: 1 });
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('a') }), 201);
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('b') }), 403)).message).toContain('等待 NS 生效');
    await db.update(hostedDomains).set({ status: 'active' }).where(eq(hostedDomains.domain, f.domain('a')));
    await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('b') }), 201);
    await db.update(hostedDomains).set({ status: 'active' }).where(eq(hostedDomains.domain, f.domain('b')));
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('c') }), 403)).message).toContain('最多托管 2 个');
    await data<HostedDomain>(await call('POST', '/hosted-domains', admin.jwt, { domain: f.domain('d') }), 201);
    await data<HostedDomain>(await call('POST', '/hosted-domains', admin.jwt, { domain: f.domain('e') }), 201);
  });

  it('等待超过期限自动删除 zone 与记录；用户删除 pending 域名立即清理', async () => {
    const cf = fakeCloudflare();
    const f = await fixture({ pendingDays: 3 });
    const owner = await f.actor('owner');
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain() }), 201);
    await db.update(hostedDomains).set({ createdAt: new Date(Date.now() - 4 * 86_400_000), checkedAt: null }).where(eq(hostedDomains.id, created.id));
    expect(await syncDueHostedDomains(runtime)).toBe(1);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, created.id)).get()).toBeUndefined();
    expect(cf.zoneByName(f.domain())).toBeUndefined();

    const again = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain() }), 201);
    await data(await call('DELETE', `/hosted-domains/${again.id}`, owner.jwt));
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, again.id)).get()).toBeUndefined();
    expect(cf.zoneByName(f.domain())).toBeUndefined();
  });

  it('管理员不能把托管域名再加为系统域名', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    await activeDomain(cf, owner, f.domain());
    const settings = await data<{ domains: { revision: number } }>(await call('GET', '/admin/settings', admin.jwt));
    const response = await call('PUT', '/admin/settings', admin.jwt, {
      domains: { list: [{ domain: `${f.prefix}-system.test`, public: true, perUserLimit: 0 }, { domain: f.domain(), public: false, perUserLimit: 0 }] },
      expectedDomainsRevision: settings.domains.revision,
    });
    expect((await errorOf(response, 409)).message).toContain('已被用户托管');
  });

  it('托管创建与管理员加系统域名交错：占位语句里的守卫拒绝托管，不建 zone', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain('race');
    // 托管创建已读过系统列表（此时不含该域名），在占位语句执行前，管理员把它加为系统域名
    const racing = beforeStatement(runtime, /INSERT INTO hosted_domains/i, async () => {
      const current = await getSettingsFresh(env);
      await updateSettings(env, {
        domains: { list: [...current.domains.list, { domain, public: false, perUserLimit: 0 }] },
        expectedDomainsRevision: current.domains.revision ?? 0,
      });
    });
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain }, racing), 409)).message).toContain('系统域名');
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, domain)).get()).toBeUndefined();
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(0);
    expect((await getSettingsFresh(env)).domains.list.map((entry) => entry.domain)).toContain(domain);
  });

  it('管理员加系统域名与托管创建交错：域名列表 CAS 里的守卫拒绝写入，revision 不变', async () => {
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    const domain = f.domain('race');
    const settings = await data<{ domains: { revision: number } }>(await call('GET', '/admin/settings', admin.jwt));
    // 管理员的请求已通过校验，在 CAS 执行前，用户把同一域名占位为托管域名
    const racing = beforeStatement(runtime, /INSERT INTO settings \(key, value\)\s+SELECT 'domains'/i, async () => {
      await db.insert(hostedDomains).values({ domain, userId: owner.id, status: 'pending' });
    });
    const response = await call('PUT', '/admin/settings', admin.jwt, {
      domains: { list: [{ domain: `${f.prefix}-system.test`, public: true, perUserLimit: 0 }, { domain, public: false, perUserLimit: 0 }] },
      expectedDomainsRevision: settings.domains.revision,
    }, racing);
    expect((await errorOf(response, 409)).message).toContain('已被用户托管');
    const after = await getSettingsFresh(env);
    expect(after.domains.list.map((entry) => entry.domain)).not.toContain(domain);
    expect(after.domains.revision).toBe(settings.domains.revision);
  });

  it('只有 revision 变化时仍返回原来的并发修改提示', async () => {
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    const settings = await data<{ domains: { revision: number } }>(await call('GET', '/admin/settings', admin.jwt));
    const response = await call('PUT', '/admin/settings', admin.jwt, {
      domains: { list: [{ domain: `${f.prefix}-system.test`, public: true, perUserLimit: 0 }] },
      expectedDomainsRevision: settings.domains.revision + 1,
    });
    expect((await errorOf(response, 409)).message).toContain('已被其他请求修改');
  });
});

describe('托管域名的收件与认领', () => {
  it('未认领地址的来信自动认领给所有者并通知所有者；暂停后拒收', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    const { rejected, stored } = await receive(`anything@${domain}`, `${f.prefix}-1`);
    expect(rejected).toEqual([]);
    expect(stored).toMatchObject({ address: `anything@${domain}`, notifyOwnerIds: [owner.id] });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.address, `anything@${domain}`)).get())!.userId).toBe(owner.id);
    expect((await data<HostedDomain>(await call('GET', `/hosted-domains/${hosted.id}`, owner.jwt))).mailboxCount).toBe(1);

    await data<HostedDomain>(await call('POST', `/admin/hosted-domains/${hosted.id}/suspend`, admin.jwt));
    const blocked = await receive(`other@${domain}`, `${f.prefix}-2`);
    expect(blocked.rejected).toEqual(['收件域名已停用']);
    expect(blocked.stored).toBeUndefined();
    expect((await errorOf(await call('POST', '/mailboxes', owner.jwt, { localPart: 'new', domain }), 403)).message).toContain('已停用');

    const resumed = await data<HostedDomain>(await call('POST', `/admin/hosted-domains/${hosted.id}/resume`, admin.jwt));
    expect(resumed.status).toBe('active');
    expect((await receive(`other@${domain}`, `${f.prefix}-3`)).stored?.notifyOwnerIds).toEqual([owner.id]);
  });

  it('所有者认领不占全站上限且不受保留前缀；成员受成员上限与保留前缀约束；其他人不可认领', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const stranger = await f.actor('stranger');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    // 全站每人上限为 1：先认领一个系统域名地址，托管域名仍可继续认领
    await data<Mailbox>(await call('POST', '/mailboxes', owner.jwt, { localPart: 'sys', domain: `${f.prefix}-system.test` }), 201);
    await data<Mailbox>(await call('POST', '/mailboxes', owner.jwt, { localPart: 'admin', domain }), 201);
    await data(await call('POST', '/mailboxes/batch', owner.jwt, { items: [{ localPart: 'b1', domain }, { localPart: 'b2', domain }] }));
    expect(await db.select().from(mailboxes).where(and(eq(mailboxes.userId, owner.id), eq(mailboxes.domain, domain))).all()).toHaveLength(3);

    expect((await errorOf(await call('POST', '/mailboxes', stranger.jwt, { localPart: 'x', domain }), 403)).message).toContain('无权');
    expect(await data<string[]>(await call('GET', '/domains', stranger.jwt))).not.toContain(domain);
    expect(await errorOf(await call('GET', `/hosted-domains/${hosted.id}`, stranger.jwt), 404)).toMatchObject({ code: 'not_found' });

    await data<HostedDomainMember[]>(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt, { userIds: [member.id], expectedOwnerId: owner.id }));
    await data<HostedDomain>(await call('PUT', `/hosted-domains/${hosted.id}`, owner.jwt, { memberLimit: 2 }));
    expect(await data<string[]>(await call('GET', '/domains', member.jwt))).toContain(domain);
    expect((await errorOf(await call('POST', '/mailboxes', member.jwt, { localPart: 'postmaster', domain }), 403)).message).toContain('保留');
    const batch = await data<{ claimed: Mailbox[]; stoppedBy: { message: string } | null }>(await call('POST', '/mailboxes/batch', member.jwt, {
      items: [{ localPart: 'm1', domain }, { localPart: 'm2', domain }, { localPart: 'm3', domain }],
    }));
    expect(batch.claimed.map((box) => box.address)).toEqual([`m1@${domain}`, `m2@${domain}`]);
    expect(batch.stoppedBy?.message).toContain('最多认领 2 个');
    // 成员看不到域名设置与成员名单
    expect((await errorOf(await call('GET', `/hosted-domains/${hosted.id}/members`, member.jwt), 403)).code).toBe('forbidden');
    expect((await data<HostedDomain>(await call('GET', `/hosted-domains/${hosted.id}`, member.jwt))).role).toBe('member');

    // 已禁用的现有成员留在名单里不妨碍添加别人；新增已禁用用户被拒
    const later = await f.actor('later');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, member.id));
    const kept = await data<HostedDomainMember[]>(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt,
      { userIds: [member.id, later.id], expectedOwnerId: owner.id }));
    expect(kept.map((m) => [m.userId, m.status])).toEqual([[member.id, 'disabled'], [later.id, 'active']]);
    await db.update(users).set({ status: 'active' }).where(eq(users.id, member.id));
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, stranger.id));
    expect((await errorOf(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt,
      { userIds: [member.id, later.id, stranger.id], expectedOwnerId: owner.id }), 400)).message).toContain('启用中');

    // 移除成员：已认领地址保留，不能再新增
    await data(await call('DELETE', `/hosted-domains/${hosted.id}/members/${member.id}`, owner.jwt));
    expect(await db.select().from(mailboxes).where(and(eq(mailboxes.userId, member.id), eq(mailboxes.domain, domain))).all()).toHaveLength(2);
    expect((await errorOf(await call('POST', '/mailboxes', member.jwt, { localPart: 'm4', domain }), 403)).message).toContain('无权');
  });

  it('从托管域名发信要求发信已就绪；站内投递到未认领地址同样归所有者', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const sender = await f.actor('sender');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    const box = await data<Mailbox>(await call('POST', '/mailboxes', owner.jwt, { localPart: 'me', domain }), 201);
    await db.update(hostedDomains).set({ sendingStatus: 'unconfigured' }).where(eq(hostedDomains.id, hosted.id));
    const send = (fromId: number, to: string, userId: number) => sendMail(runtime, { waitUntil: () => {} }, { userId, role: 'user' },
      { from: { mailboxId: fromId }, to: [to], cc: [], bcc: [], subject: 'hi', text: 'hi' } as never, [], 'https://hpc.email');
    await expect(send(box.id, 'friend@example.org', owner.id)).rejects.toMatchObject({ message: '该域名的发信尚未生效或已停用' });

    const own = await data<Mailbox>(await call('POST', '/mailboxes', sender.jwt, { localPart: 'sender', domain: `${f.prefix}-system.test` }), 201);
    await send(own.id, `fresh@${domain}`, sender.id);
    const delivered = await db.select().from(messages).where(and(eq(messages.address, `fresh@${domain}`), eq(messages.direction, 'inbound'))).get();
    expect(delivered).toMatchObject({ sendChannel: 'internal', notifyOwnerIds: [owner.id] });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.address, `fresh@${domain}`)).get())!.userId).toBe(owner.id);
  });
});

describe('托管域名的异常与上限', () => {
  it('自动认领达到上限后新地址拒收，已认领地址照常收信；手动认领不受限', async () => {
    const cf = fakeCloudflare();
    const f = await fixture({ autoClaimLimit: 2 });
    const owner = await f.actor('owner');
    const domain = f.domain();
    await activeDomain(cf, owner, domain);
    expect((await receive(`a@${domain}`, `${f.prefix}-l1`)).stored).toBeDefined();
    expect((await receive(`b@${domain}`, `${f.prefix}-l2`)).stored).toBeDefined();
    const over = await receive(`c@${domain}`, `${f.prefix}-l3`);
    expect(over.rejected).toEqual(['收件域名的地址数已达上限']);
    expect(over.stored).toBeUndefined();
    expect(await db.select().from(mailboxes).where(eq(mailboxes.address, `c@${domain}`)).get()).toBeUndefined();
    expect((await receive(`a@${domain}`, `${f.prefix}-l4`)).stored?.notifyOwnerIds).toEqual([owner.id]);
    await data<Mailbox>(await call('POST', '/mailboxes', owner.jwt, { localPart: 'manual', domain }), 201);
  });

  it('自动认领默认不限：没有保存过该设置或设为 0 时，新地址的来信一律认领给所有者', async () => {
    const cf = fakeCloudflare();
    const f = await fixture({ autoClaimLimit: 0 });
    const owner = await f.actor('owner');
    const domain = f.domain();
    await activeDomain(cf, owner, domain);
    for (const local of ['u1', 'u2', 'u3']) {
      const { rejected, stored } = await receive(`${local}@${domain}`, `${f.prefix}-${local}`);
      expect(rejected).toEqual([]);
      expect(stored?.notifyOwnerIds).toEqual([owner.id]);
    }
    // 线上从未保存过 hosted_domains 设置：收件 SQL 直读设置表，缺省按 0（不限）处理。
    // 先把域内地址堆到旧默认上限 1000 以上，确认缺省值不再拦截新地址
    await env.db.prepare("DELETE FROM settings WHERE key = 'hosted_domains'").run();
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO mailboxes (address, domain, user_id, display_name) SELECT 'bulk' || i || '@' || ?1, ?1, ?2, '' FROM n`)
      .bind(domain, owner.id).run();
    for (const local of ['u4', 'u5']) {
      const { rejected, stored } = await receive(`${local}@${domain}`, `${f.prefix}-${local}`);
      expect(rejected).toEqual([]);
      expect(stored?.notifyOwnerIds).toEqual([owner.id]);
    }
    const claimed = await db.select().from(mailboxes).where(eq(mailboxes.domain, domain)).all();
    expect(claimed).toHaveLength(1005);
    expect(claimed.every((row) => row.userId === owner.id)).toBe(true);
  });

  it('Cloudflare 一次超时不清空已就绪的发信状态；确定的错误才判为未就绪', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const hosted = await activeDomain(cf, owner, f.domain());
    const original = cf.fetchMock.getMockImplementation()!;
    cf.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('/dns/status')) return new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: 'busy' }] }), { status: 503 });
      return original(input, init);
    });
    await syncHostedDomain(runtime, hosted.id);
    expect((await db.select().from(hostedDomains).where(eq(hostedDomains.id, hosted.id)).get())).toMatchObject({ status: 'active', sendingStatus: 'ready' });
    cf.fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('/dns/status')) return new Response(JSON.stringify({ success: true, result: { status: 'misconfigured', errors: [{ code: 'dkim.conflict' }] } }), { status: 200 });
      return original(input, init);
    });
    // 已生效很久的域名巡检发现问题直接转为 error（刚激活的处于 30 分钟开通宽限期）
    await db.update(hostedDomains).set({ activatedAt: new Date(Date.now() - 86_400_000) }).where(eq(hostedDomains.id, hosted.id));
    await syncHostedDomain(runtime, hosted.id);
    const row = (await db.select().from(hostedDomains).where(eq(hostedDomains.id, hosted.id)).get())!;
    expect(row).toMatchObject({ status: 'error', sendingStatus: 'misconfigured' });
    expect(row.lastError).toContain('dkim.conflict');
  });

  it('建 zone 超时保留占位，定时任务按名称找回本次创建的 zone', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    const original = cf.fetchMock.getMockImplementation()!;
    cf.fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      // Cloudflare 实际建好了，但响应没送达
      if ((init?.method ?? 'GET') === 'POST' && new URL(String(input)).pathname.endsWith('/zones')) throw new Error('timeout');
      return response;
    });
    expect((await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain }), 500)).message).toContain('10 分钟');
    const reserved = (await db.select().from(hostedDomains).where(eq(hostedDomains.domain, domain)).get())!;
    expect(reserved.zoneId).toBeNull();
    cf.fetchMock.mockImplementation(original);
    await db.update(hostedDomains).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(hostedDomains.id, reserved.id));
    await syncHostedDomain(runtime, reserved.id);
    expect((await db.select().from(hostedDomains).where(eq(hostedDomains.id, reserved.id)).get())!.zoneId).toBe(cf.zoneByName(domain)!.id);
  });

  it('zone 被外部删除后：已生效的域名标记为已迁走，等待中的域名删除记录；查不到时不做破坏性判断', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const active = await activeDomain(cf, owner, f.domain('a'));
    cf.zones.delete(cf.zoneByName(f.domain('a'))!.id);
    await syncHostedDomain(runtime, active.id);
    expect((await db.select().from(hostedDomains).where(eq(hostedDomains.id, active.id)).get())!.status).toBe('moved');

    const other = await f.actor('other');
    const pending = await data<HostedDomain>(await call('POST', '/hosted-domains', other.jwt, { domain: f.domain('b') }), 201);
    // 账户列表查询失败：不能确认 zone 不存在，保留记录
    const original = cf.fetchMock.getMockImplementation()!;
    const zoneId = cf.zoneByName(f.domain('b'))!.id;
    cf.zones.delete(zoneId);
    cf.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/zones')) return new Response('{}', { status: 502 });
      return original(input, init);
    });
    await syncHostedDomain(runtime, pending.id);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, pending.id)).get()).toBeDefined();
    cf.fetchMock.mockImplementation(original);
    await syncHostedDomain(runtime, pending.id);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, pending.id)).get()).toBeUndefined();
  });
});

describe('托管域名的过户与删除', () => {
  it('过户：连同地址与历史，撤销旧邮箱共享，保留成员并审计；旧归属重试返回 transferred=false', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const target = await f.actor('target');
    const member = await f.actor('member');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    await receive(`inbox@${domain}`, `${f.prefix}-t1`);
    const box = (await db.select().from(mailboxes).where(eq(mailboxes.address, `inbox@${domain}`)).get())!;
    await db.insert(mailboxShares).values({ mailboxId: box.id, userId: member.id, grantedBy: owner.id });
    await data(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt, { userIds: [member.id, target.id], expectedOwnerId: owner.id }));

    const stale = await call('POST', `/hosted-domains/${hosted.id}/transfer`, owner.jwt, { userId: target.id, expectedOwnerId: target.id, includeMailboxes: true });
    expect((await errorOf(stale, 409)).code).toBe('conflict');
    const result = await data<HostedDomainTransferResult>(await call('POST', `/hosted-domains/${hosted.id}/transfer`, owner.jwt,
      { userId: target.id, expectedOwnerId: owner.id, includeMailboxes: true }));
    // 原所有者过户后不再有权限，不返回域名详情
    expect(result).toMatchObject({ transferred: true, previousUserId: owner.id, movedMailboxes: 1, domain: null });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())!.userId).toBe(target.id);
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id)).all()).toEqual([]);
    const members = await data<HostedDomainMember[]>(await call('GET', `/hosted-domains/${hosted.id}/members`, target.jwt));
    expect(members.map((m) => m.userId)).toEqual([member.id]);
    expect(await errorOf(await call('GET', `/hosted-domains/${hosted.id}`, owner.jwt), 404)).toMatchObject({ code: 'not_found' });
    const retry = await data<HostedDomainTransferResult>(await call('POST', `/hosted-domains/${hosted.id}/transfer`, target.jwt,
      { userId: target.id, expectedOwnerId: owner.id, includeMailboxes: true }));
    expect(retry.transferred).toBe(false);
    const audits = await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.action, 'hosted_domain.transfer'), eq(adminAuditLogs.target, domain))).all();
    expect(audits).toHaveLength(1);
    // 新邮件归新所有者
    expect((await receive(`later@${domain}`, `${f.prefix}-t2`)).stored?.notifyOwnerIds).toEqual([target.id]);
  });

  it('不带地址过户时原所有者保留地址；普通用户过户受对方上限约束，管理员不受限', async () => {
    const cf = fakeCloudflare();
    const f = await fixture({ maxPerUser: 1 });
    const owner = await f.actor('owner');
    const full = await f.actor('full');
    const admin = await f.actor('admin', 'admin');
    const a = await activeDomain(cf, owner, f.domain('a'));
    await activeDomain(cf, full, f.domain('b'));
    await data<Mailbox>(await call('POST', '/mailboxes', owner.jwt, { localPart: 'keep', domain: f.domain('a') }), 201);
    const blocked = await call('POST', `/hosted-domains/${a.id}/transfer`, owner.jwt, { userId: full.id, expectedOwnerId: owner.id, includeMailboxes: false });
    expect((await errorOf(blocked, 403)).message).toContain('上限');
    const forced = await data<HostedDomainTransferResult>(await call('POST', `/hosted-domains/${a.id}/transfer`, admin.jwt,
      { userId: full.id, expectedOwnerId: owner.id, includeMailboxes: false }));
    expect(forced).toMatchObject({ transferred: true, movedMailboxes: 0, domain: { ownerUserId: full.id, role: 'admin' } });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.address, `keep@${f.domain('a')}`)).get())!.userId).toBe(owner.id);
  });

  it('删除：拒收、永久删除该域全部邮件、释放地址、删除 Cloudflare 发信接入与 zone 后移除记录', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    await data(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt, { userIds: [member.id], expectedOwnerId: owner.id }));
    await receive(`a@${domain}`, `${f.prefix}-d1`);
    await receive(`b@${domain}`, `${f.prefix}-d2`);
    const zoneId = cf.zoneByName(domain)!.id;
    expect((await errorOf(await call('DELETE', `/hosted-domains/${hosted.id}`, member.jwt), 403)).code).toBe('forbidden');
    await data(await call('DELETE', `/hosted-domains/${hosted.id}`, owner.jwt));
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, hosted.id)).get()).toBeUndefined();
    expect(await db.select().from(messages).where(eq(messages.domain, domain)).all()).toEqual([]);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.domain, domain)).all()).toEqual([]);
    expect(await db.select().from(hostedDomainMembers).where(eq(hostedDomainMembers.domainId, hosted.id)).all()).toEqual([]);
    expect(cf.calls).toContain(`DELETE /zones/${zoneId}/email/sending/subdomains/sub-${zoneId}`);
    expect(cf.calls).toContain(`DELETE /zones/${zoneId}`);
    // 删除后其他用户可重新添加，看不到任何旧邮件
    const other = await f.actor('other');
    const again = await data<HostedDomain>(await call('POST', '/hosted-domains', other.jwt, { domain }), 201);
    expect(again.mailboxCount).toBe(0);
  });

  it('删除时 Cloudflare 失败保留 deleting 状态并拒收，下轮定时任务重试完成', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    const hosted = await activeDomain(cf, owner, domain);
    const original = cf.fetchMock.getMockImplementation()!;
    cf.fetchMock.mockImplementation(async (input, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'boom' }] }), { status: 500 });
      return original(input, init);
    });
    await data(await call('DELETE', `/hosted-domains/${hosted.id}`, owner.jwt));
    const row = (await db.select().from(hostedDomains).where(eq(hostedDomains.id, hosted.id)).get())!;
    expect(row).toMatchObject({ status: 'deleting' });
    expect(row.lastError).toContain('boom');
    expect((await receive(`late@${domain}`, `${f.prefix}-late`)).rejected).toEqual(['收件域名已停用']);
    cf.fetchMock.mockImplementation(original);
    await syncDueHostedDomains(runtime);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, hosted.id)).get()).toBeUndefined();
  });
});

describe('添加与立即检测的 Cloudflare 调用额度', () => {
  it(`每人每分钟最多添加 ${MAX_HOSTED_CREATES_PER_MINUTE} 次，失败的也计；超出后 429，不再调用 Cloudflare`, async () => {
    // Cloudflare 拒绝建 zone 时会释放占位，没有个人上限就能无限重试，每次消耗两次调用
    const cf = fakeCloudflare({ createError: 1099 });
    const f = await fixture();
    const owner = await f.actor('owner');
    for (let i = 0; i < MAX_HOSTED_CREATES_PER_MINUTE; i++) {
      await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain(`try${i}`) }), 400);
    }
    expect(cf.calls).toHaveLength(MAX_HOSTED_CREATES_PER_MINUTE * 2);
    expect(await siteCalls()).toBe(MAX_HOSTED_CREATES_PER_MINUTE * 2);
    const limited = await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('more') }), 429);
    expect(limited).toMatchObject({ code: 'rate_limited' });
    expect(cf.calls).toHaveLength(MAX_HOSTED_CREATES_PER_MINUTE * 2);
    expect(await siteCalls()).toBe(MAX_HOSTED_CREATES_PER_MINUTE * 2);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('more'))).get()).toBeUndefined();
    // 其他用户不受影响
    const other = await f.actor('other');
    await errorOf(await call('POST', '/hosted-domains', other.jwt, { domain: f.domain('other') }), 400);
    expect(cf.calls).toHaveLength(MAX_HOSTED_CREATES_PER_MINUTE * 2 + 2);
  });

  it('添加与删除按实际 Cloudflare 调用数计入全站额度；占位被拒的不计；额度不够时 429、不占位也不计数', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const rival = await f.actor('rival');
    // 一次成功添加：查 zone、建 zone，加后台预配置 catch-all 与发信，共 7 次
    const taken = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('taken') }), 201);
    expect(taken.status).toBe('pending');
    expect(cf.calls).toHaveLength(7);
    const afterCreate = await siteCalls();
    expect(afterCreate).toBe(cf.calls.length);

    await errorOf(await call('POST', '/hosted-domains', rival.jwt, { domain: f.domain('taken') }), 409);
    // 自己已有的占位（建 zone 超时留下、还没有 zone_id）：重复添加被拒，也不计
    const stuck = await f.actor('stuck');
    await db.insert(hostedDomains).values({ domain: f.domain('stuck'), userId: stuck.id, status: 'pending' });
    expect((await errorOf(await call('POST', '/hosted-domains', stuck.jwt, { domain: f.domain('stuck') }), 409)).message).toContain('已经添加过');
    expect(await siteCalls()).toBe(afterCreate);

    // 剩余额度不够一次添加：拒绝、不占位、不调用 Cloudflare，也不再推高计数
    await bumpCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1), MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - afterCreate - 1);
    const callsBefore = cf.calls.length;
    const busy = await errorOf(await call('POST', '/hosted-domains', rival.jwt, { domain: f.domain('busy') }), 429);
    expect(busy).toMatchObject({ code: 'rate_limited' });
    expect(cf.calls).toHaveLength(callsBefore);
    expect(await siteCalls()).toBe(MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - 1);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('busy'))).get()).toBeUndefined();

    // 删除：撤发信接入、核对 zone 身份、删 zone，共 3 次；额度满时照常执行，只计数
    await data(await call('DELETE', `/hosted-domains/${taken.id}`, owner.jwt));
    expect(cf.calls.slice(callsBefore)).toHaveLength(3);
    expect(await siteCalls()).toBe(MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE + 2);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, taken.id)).get()).toBeUndefined();
  });

  it('功能关闭或缺凭据时立即检测 403，不占全站额度', async () => {
    fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('off') }), 201);
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 60_000) }).where(eq(hostedDomains.id, created.id));
    const base = await siteCalls();
    await updateSettings(env, { hosted_domains: { enabled: false, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 0 } });
    for (let i = 0; i < 5; i++) await errorOf(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt), 403);
    expect(await siteCalls()).toBe(base);
    await updateSettings(env, { hosted_domains: { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 0 } });
    await errorOf(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt, undefined, env), 403);
    expect(await siteCalls()).toBe(base);
  });

  it(`立即检测：每人每分钟 ${MAX_HOSTED_CHECKS_PER_MINUTE} 次（被节流、无权限的也计）；只有真正核对的才占全站额度`, async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const stranger = await f.actor('stranger');
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('check') }), 201);
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 60_000) }).where(eq(hostedDomains.id, created.id));
    const base = await siteCalls();

    // 无关用户：404，计入他自己的个人次数，不占全站额度
    await errorOf(await call('POST', `/hosted-domains/${created.id}/check`, stranger.jwt), 404);
    expect(await siteCalls()).toBe(base);

    // 第一次过了节流间隔，真正核对；之后 15 秒内的都被节流，不再调用 Cloudflare
    const callsBefore = cf.calls.length;
    await data(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt));
    const checkCalls = cf.calls.length - callsBefore;
    expect(checkCalls).toBeGreaterThan(0);
    expect(await siteCalls()).toBe(base + 4);
    for (let i = 1; i < MAX_HOSTED_CHECKS_PER_MINUTE; i++) await data(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt));
    expect(cf.calls.length - callsBefore).toBe(checkCalls);
    expect(await siteCalls()).toBe(base + 4);
    expect(await errorOf(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt), 429)).toMatchObject({ code: 'rate_limited' });
  });

  it('立即检测：全站额度用尽时 429，不调用 Cloudflare', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('busy-check') }), 201);
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 60_000) }).where(eq(hostedDomains.id, created.id));
    await bumpCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1), MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - (await siteCalls()) - 1);
    const callsBefore = cf.calls.length;
    expect(await errorOf(await call('POST', `/hosted-domains/${created.id}/check`, owner.jwt), 429)).toMatchObject({ code: 'rate_limited' });
    expect(cf.calls).toHaveLength(callsBefore);
  });
});

describe('托管域名的 Cloudflare 调用序列基准', () => {
  // 系统域名接入会在 cloudflare.ts、定时任务与互斥守卫上改动共享代码；这里锁住托管域名从添加、生效到删除
  // 对 Cloudflare 的完整调用序列，任何改动导致托管行为变化都会在这里显式暴露
  it('添加 → NS 生效后补齐 → 删除', async () => {
    const cf = fakeCloudflare({ dnssec: [] });
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain('golden');
    const created = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain }), 201);
    const zoneId = cf.zoneByName(domain)!.id;
    const afterCreate = [...cf.calls];
    cf.calls.length = 0;

    cf.zones.get(zoneId)!.status = 'active';
    await syncHostedDomain(runtime, created.id);
    const afterActivate = [...cf.calls];
    cf.calls.length = 0;

    await data(await call('DELETE', `/hosted-domains/${created.id}`, owner.jwt));
    const afterDelete = [...cf.calls];

    const z = `/zones/${zoneId}`;
    expect({ afterCreate, afterActivate, afterDelete }).toEqual({
      // 先确认账户里没有同名 zone，建 zone 后预先接入 catch-all 与发信（Email Routing 要等 zone 生效）
      afterCreate: [
        'GET /zones', 'POST /zones',
        `GET ${z}/email/routing/rules/catch_all`, `PUT ${z}/email/routing/rules/catch_all`,
        `GET ${z}/email/sending/subdomains`, `POST ${z}/email/sending/subdomains`,
        `GET ${z}/email/sending/subdomains/sub-${zoneId}/dns/status`,
      ],
      // 生效后开启 Email Routing、复核 catch-all，并补齐发信 DNS
      afterActivate: [
        `GET ${z}`, `GET ${z}/email/routing`, `POST ${z}/email/routing/dns`,
        `GET ${z}/email/routing/rules/catch_all`,
        `GET ${z}/email/sending/subdomains/sub-${zoneId}/dns/status`, `POST ${z}/email/sending/subdomains/sub-${zoneId}/dns`,
      ],
      // 删除先撤发信接入，再读出 zone 核对名称与创建时间后删除
      afterDelete: [`DELETE ${z}/email/sending/subdomains/sub-${zoneId}`, `GET ${z}`, `DELETE ${z}`],
    });
  });
});

describe('管理员', () => {
  it('管理员可在任何人的托管域名下认领地址，并过户或共享其中的地址（含自动认领给所有者的）', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const other = await f.actor('other');
    const admin = await f.actor('admin', 'admin');
    const domain = f.domain();
    await activeDomain(cf, owner, domain);
    // 认领弹窗的域名来源：管理员看得到他人的托管域名，其他普通用户看不到
    expect(await data<string[]>(await call('GET', '/domains', admin.jwt))).toContain(domain);
    expect(await data<string[]>(await call('GET', '/domains', other.jwt))).not.toContain(domain);
    expect(await data<{ address: string; available: boolean }>(await call('GET', `/mailboxes/availability?localPart=postmaster&domain=${domain}`, admin.jwt)))
      .toMatchObject({ available: true });
    const claimed = await data<Mailbox>(await call('POST', '/mailboxes', admin.jwt, { localPart: 'postmaster', domain }), 201);
    expect(claimed.userId).toBe(admin.id);
    const batch = await data<{ claimed: Mailbox[]; stoppedBy: unknown }>(await call('POST', '/mailboxes/batch', admin.jwt, {
      items: [{ localPart: 'ops1', domain }, { localPart: 'ops2', domain }],
    }));
    expect(batch).toMatchObject({ stoppedBy: null });
    expect(batch.claimed.map((box) => box.userId)).toEqual([admin.id, admin.id]);

    // 自动认领给所有者的地址：管理员过户给其他用户（保留历史），再共享给所有者只读
    await receive(`auto@${domain}`, `${f.prefix}-adm1`);
    const auto = (await db.select().from(mailboxes).where(eq(mailboxes.address, `auto@${domain}`)).get())!;
    expect(auto.userId).toBe(owner.id);
    const moved = await data<{ transferred: boolean; mailbox: Mailbox }>(await call('POST', `/admin/mailboxes/${auto.id}/transfer`, admin.jwt,
      { userId: other.id, expectedOwnerId: owner.id }));
    expect(moved).toMatchObject({ transferred: true, mailbox: { userId: other.id, messageCount: 1 } });
    const shared = await data<{ grantees: { userId: number }[] }>(await call('PUT', '/admin/mailbox-shares', admin.jwt,
      { mailboxId: auto.id, userIds: [owner.id], expectedOwnerId: other.id }));
    expect(shared.grantees.map((grantee) => grantee.userId)).toEqual([owner.id]);
    // 过户后新来信归新主人
    expect((await receive(`auto@${domain}`, `${f.prefix}-adm2`)).stored?.notifyOwnerIds).toEqual([other.id]);
  });

  it('删除拥有托管域名的用户前须先过户或删除；成员被删除时移出成员名单', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const admin = await f.actor('admin', 'admin');
    const hosted = await activeDomain(cf, owner, f.domain());
    await data(await call('PUT', `/hosted-domains/${hosted.id}/members`, owner.jwt, { userIds: [member.id], expectedOwnerId: owner.id }));
    expect((await errorOf(await call('DELETE', `/admin/users/${owner.id}`, admin.jwt), 409)).message).toContain('托管域名');
    await data(await call('DELETE', `/admin/users/${member.id}`, admin.jwt));
    expect(await db.select().from(hostedDomainMembers).where(eq(hostedDomainMembers.domainId, hosted.id)).all()).toEqual([]);
  });

  it('列出全站托管域名，健康检查返回凭据与 zone 数量', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    await activeDomain(cf, owner, f.domain('a'));
    await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('b') }), 201);
    const all = await data<HostedDomain[]>(await call('GET', '/admin/hosted-domains', admin.jwt));
    expect(all.map((item) => item.domain).sort()).toEqual([f.domain('a'), f.domain('b')]);
    expect(all.every((item) => item.role === 'admin')).toBe(true);
    expect((await data<HostedDomain[]>(await call('GET', '/admin/hosted-domains?status=pending', admin.jwt))).map((item) => item.domain)).toEqual([f.domain('b')]);
    expect((await data<HostedDomain[]>(await call('GET', `/admin/hosted-domains?q=${f.prefix}-owner`, admin.jwt)))).toHaveLength(2);
    expect(await data(await call('GET', '/admin/hosted-domains/health', admin.jwt))).toMatchObject({
      enabled: true, configured: true, tokenValid: true, error: '', accountZones: 2, accountPendingZones: 1,
    });
    expect((await errorOf(await call('GET', '/admin/hosted-domains', owner.jwt), 403)).code).toBe('forbidden');
    expect(await data(await call('GET', '/admin/hosted-domains/health', admin.jwt, undefined, env))).toMatchObject({ configured: false, tokenValid: null });
    // 管理员个人列表只含自己的域名
    expect(await data<HostedDomain[]>(await call('GET', '/hosted-domains', admin.jwt))).toEqual([]);
  });
});
