import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HOSTED_DOMAIN_BATCH, type ApiScope, type HostedDomain, type HostedDomainBatchCheckItem, type HostedDomainBatchCreateItem, type HostedDomainBatchResult,
} from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, apiRequestLogs, hostedDomainMembers, hostedDomains, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { apiKeyAuth } from '../src/middleware/api-key-auth.js';
import { requireAuth } from '../src/middleware/auth.js';
import hostedDomainBatch from '../src/routes/hosted-domain-batch.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import v1HostedDomainBatch from '../src/routes/v1/hosted-domain-batch.js';
import { createApiKey } from '../src/services/api-key.js';
import {
  HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, MAX_HOSTED_CHECKS_PER_MINUTE, MAX_HOSTED_CREATES_PER_MINUTE,
  MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE,
} from '../src/services/hosted-domain.js';
import { bumpCounter, minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { AppContext, Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const ACCOUNT = 'acct-batch';

/** 只实现添加与预配置用到的 Cloudflare 接口（与 hosted-domains.test.ts 的假实现同一行为），记录每次调用 */
function fakeCloudflare() {
  const zones = new Map<string, { id: string; name: string }>();
  const calls: string[] = [];
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown) => json({ success: true, errors: [], result, result_info: { total_count: Array.isArray(result) ? result.length : 1 } });
  const zoneView = (zone: { id: string; name: string }) => ({ id: zone.id, name: zone.name, status: 'pending',
    name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], original_name_servers: ['ns1.registrar.example'],
    original_registrar: 'Example Registrar, Inc.', activated_on: null, created_on: new Date().toISOString() });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'cloudflare-dns.com') return json({ Status: 0, Answer: [] });
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    if (path === '/zones' && method === 'GET') {
      return ok([...zones.values()].filter((zone) => zone.name === url.searchParams.get('name')).map(zoneView));
    }
    if (path === '/zones' && method === 'POST') {
      const zone = { id: `zone-${++seq}`, name: String((JSON.parse(String(init!.body)) as { name: string }).name) };
      zones.set(zone.id, zone);
      return ok(zoneView(zone));
    }
    const zone = zones.get(path.split('/')[2] ?? '');
    if (!zone) return json({ success: false, errors: [{ code: 9109, message: 'Invalid zone identifier' }], result: null }, 403);
    if (path.endsWith('/email/routing/rules/catch_all')) {
      return ok(method === 'PUT' ? { enabled: true, actions: [{ type: 'worker', value: ['hpc-cloud-mail'] }] } : { enabled: false, actions: [] });
    }
    if (path.endsWith('/email/sending/subdomains')) return ok(method === 'POST' ? { tag: `sub-${zone.id}`, name: zone.name } : []);
    if (path.endsWith('/dns/status')) return ok({ status: 'unconfigured', errors: [], records: [] });
    if (path === `/zones/${zone.id}` && method === 'GET') return ok(zoneView(zone));
    return json({ success: false, errors: [{ code: 9999, message: `unexpected ${method} ${path}` }], result: null }, 400);
  }));
  return { calls };
}

const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: 'hpc-cloud-mail' };
const hostedSettings = { enabled: true, maxPerUser: 0, maxPendingPerUser: 1, maxPendingTotal: 100, pendingDays: 7, autoClaimLimit: 0 };

let sequence = 0;
async function fixture() {
  const prefix = `hb${++sequence}`;
  await db.delete(hostedDomainMembers);
  await db.delete(hostedDomains);
  await updateSettings(env, {
    domains: { list: [{ domain: `${prefix}-system.test`, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false }, api: { enabled: true }, hosted_domains: hostedSettings,
  });
  async function actor(suffix: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  return { prefix, domain: (name: string) => `${prefix}-${name}.test`, actor };
}

async function call(method: string, path: string, token: string, body?: unknown, target: { request: Hono<AppContext>['request'] } = app) {
  const ctx = createExecutionContext();
  const response = await target.request(path, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
type CreateResult = HostedDomainBatchResult<HostedDomainBatchCreateItem>;
type CheckResult = HostedDomainBatchResult<HostedDomainBatchCheckItem>;

const minute = () => minuteWindow(1);
const counter = async (scope: string, subject: string) => (await readCounter(env, scope, subject, minute())).count;
const siteCalls = () => counter(HOSTED_DNS_SITE_RATE_SCOPE, 'all');
const errors = (result: { items: Array<{ ok: boolean; error?: { code: string; message: string } }> }) =>
  result.items.map((item) => (item.ok ? 'ok' : `${item.error!.code}:${item.error!.message.startsWith('未处理') ? 'skipped' : 'tried'}`));

beforeEach(async () => {
  await env.db.prepare('DELETE FROM rate_counters WHERE scope IN (?, ?, ?)')
    .bind(HOSTED_DNS_SITE_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE).run();
});
afterEach(() => vi.unstubAllGlobals());

describe('批量添加托管域名', () => {
  it('逐项添加并返回各自结果：冲突只影响该项，计数与 Cloudflare 调用和单个添加相同', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    const rival = await f.actor('rival', 'admin');
    await data(await call('POST', '/api/hosted-domains', rival.jwt, { domain: f.domain('taken') }), 201);
    const before = cf.calls.length;
    const result = await data<CreateResult>(await call('POST', '/api/hosted-domains/batch', admin.jwt,
      { domains: [f.domain('one'), f.domain('taken'), f.domain('two')] }));
    expect(errors(result)).toEqual(['ok', 'conflict:tried', 'ok']);
    expect(result).toMatchObject({ succeeded: 2, failed: 1 });
    expect(result.items.map((item) => item.domain)).toEqual([f.domain('one'), f.domain('taken'), f.domain('two')]);
    const first = result.items[0] as { ok: true; hostedDomain: HostedDomain };
    expect(first.hostedDomain).toMatchObject({ domain: f.domain('one'), status: 'pending', role: 'owner', ownerUserId: admin.id });
    expect((result.items[1] as { ok: false; error: { message: string } }).error.message).toBe('该域名已被其他用户托管');
    // 每个成功的添加：查 zone、建 zone 2 次 + 后台预配置 5 次；被占位守卫拒绝的不调 Cloudflare、不占全站额度
    expect(cf.calls.length - before).toBe(14);
    expect(await siteCalls()).toBe(7 + 14);
    expect(await counter(HOSTED_CREATE_RATE_SCOPE, String(admin.id))).toBe(3);
    const audits = await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.actorId, admin.id), eq(adminAuditLogs.action, 'hosted_domain.create'))).all();
    expect(audits.map((row) => row.target).sort()).toEqual([f.domain('one'), f.domain('two')]);
  });

  it('pending 上限是账户级错误：之后的项不再尝试、不计数', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const result = await data<CreateResult>(await call('POST', '/api/hosted-domains/batch', owner.jwt,
      { domains: [f.domain('a'), f.domain('b'), f.domain('c')] }));
    expect(errors(result)).toEqual(['ok', 'forbidden:tried', 'forbidden:skipped']);
    expect((result.items[2] as { ok: false; error: { message: string } }).error.message).toBe('未处理：你还有域名在等待 NS 生效，请先完成或删除后再添加');
    expect(await counter(HOSTED_CREATE_RATE_SCOPE, String(owner.id))).toBe(2);
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
  });

  it('个人每分钟次数不够时，额度外的项未处理：不推高计数、不调 Cloudflare', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    await bumpCounter(env, HOSTED_CREATE_RATE_SCOPE, String(admin.id), minute(), MAX_HOSTED_CREATES_PER_MINUTE - 2);
    const result = await data<CreateResult>(await call('POST', '/api/hosted-domains/batch', admin.jwt,
      { domains: ['a', 'b', 'c', 'd'].map(f.domain) }));
    expect(errors(result)).toEqual(['ok', 'ok', 'rate_limited:skipped', 'rate_limited:skipped']);
    expect((result.items[3] as { ok: false; error: { message: string; fix: string } }).error).toMatchObject({
      message: `未处理：本分钟的添加次数已用完（每人每分钟 ${MAX_HOSTED_CREATES_PER_MINUTE} 次）`, fix: '约 1 分钟后只用未处理的项重试' });
    expect(await counter(HOSTED_CREATE_RATE_SCOPE, String(admin.id))).toBe(MAX_HOSTED_CREATES_PER_MINUTE);
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(2);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.domain, f.domain('c'))).get()).toBeUndefined();
  });

  it('全站 Cloudflare 额度不够时，额度外的项未处理，不占额度也不占个人次数', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    // 剩 3 次调用：只够一次添加（占位 2 次）
    await bumpCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minute(), MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - 3);
    const result = await data<CreateResult>(await call('POST', '/api/hosted-domains/batch', admin.jwt, { domains: ['a', 'b', 'c'].map(f.domain) }));
    expect(errors(result)).toEqual(['ok', 'rate_limited:skipped', 'rate_limited:skipped']);
    expect((result.items[1] as { ok: false; error: { message: string } }).error.message).toBe('未处理：当前域名操作较多');
    expect(await counter(HOSTED_CREATE_RATE_SCOPE, String(admin.id))).toBe(1);
    // 成功那一项：占位 2 次 + 后台预配置 5 次（只计数不拒绝）
    expect(await siteCalls()).toBe(MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE - 3 + 7);
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
  });

  it('整个请求的前置条件：功能关闭 403、重复或超过上限 400，都不计数', async () => {
    fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    const cases: Array<[unknown, number]> = [
      [{ domains: [f.domain('x'), f.domain('X')] }, 400],
      [{ domains: Array.from({ length: MAX_HOSTED_DOMAIN_BATCH + 1 }, (_, i) => f.domain(`n${i}`)) }, 400],
      [{ domains: [] }, 400],
    ];
    for (const [body, status] of cases) expect((await call('POST', '/api/hosted-domains/batch', admin.jwt, body)).status).toBe(status);
    await updateSettings(env, { hosted_domains: { ...hostedSettings, enabled: false } });
    const off = await call('POST', '/api/hosted-domains/batch', admin.jwt, { domains: [f.domain('off')] });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ error: { code: 'forbidden', message: '本站未开启域名托管' } });
    await updateSettings(env, { hosted_domains: hostedSettings });
    const ctx = createExecutionContext();
    const missing = await app.request('/api/hosted-domains/batch', { method: 'POST',
      headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ domains: [f.domain('nocreds')] }) }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(missing.status).toBe(403);
    expect(await counter(HOSTED_CREATE_RATE_SCOPE, String(admin.id))).toBe(0);
    expect(await siteCalls()).toBe(0);
  });
});

describe('批量立即检测', () => {
  it('逐项检测：无权访问的 not_found、成员 forbidden 只影响该项；个人次数不够的项未处理', async () => {
    fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const stranger = await f.actor('stranger', 'admin');
    const create = async (token: string, name: string) => data<HostedDomain>(await call('POST', '/api/hosted-domains', token, { domain: f.domain(name) }), 201);
    const mine = await create(owner.jwt, 'mine');
    // 普通用户只能有一个 pending 域名：第一个视为已生效
    await db.update(hostedDomains).set({ status: 'active' }).where(eq(hostedDomains.id, mine.id));
    const mine2 = await create(owner.jwt, 'mine2');
    const shared = await create(stranger.jwt, 'shared');
    const foreign = await create(stranger.jwt, 'foreign');
    await db.insert(hostedDomainMembers).values({ domainId: shared.id, userId: member.id, grantedBy: stranger.id });

    const result = await data<CheckResult>(await call('POST', '/api/hosted-domains/batch-check', member.jwt, { ids: [shared.id, foreign.id] }));
    expect(errors(result)).toEqual(['forbidden:tried', 'not_found:tried']);
    expect(result.items.map((item) => item.id)).toEqual([shared.id, foreign.id]);

    const own = await data<CheckResult>(await call('POST', '/api/hosted-domains/batch-check', owner.jwt, { ids: [mine.id, foreign.id, mine2.id] }));
    expect(errors(own)).toEqual(['ok', 'not_found:tried', 'ok']);
    expect((own.items[0] as { ok: true; hostedDomain: HostedDomain }).hostedDomain).toMatchObject({ id: mine.id, role: 'owner' });
    expect(await counter(HOSTED_CHECK_RATE_SCOPE, String(owner.id))).toBe(3);

    await bumpCounter(env, HOSTED_CHECK_RATE_SCOPE, String(owner.id), minute(), MAX_HOSTED_CHECKS_PER_MINUTE - 4);
    const limited = await data<CheckResult>(await call('POST', '/api/hosted-domains/batch-check', owner.jwt, { ids: [mine.id, mine2.id] }));
    expect(errors(limited)).toEqual(['ok', 'rate_limited:skipped']);
    expect(await counter(HOSTED_CHECK_RATE_SCOPE, String(owner.id))).toBe(MAX_HOSTED_CHECKS_PER_MINUTE);
  });
});

describe('/v1 批量接口', () => {
  // domain.* 由并行的 PR3b 加进 API_SCOPES；这里绕过请求 schema 直接建 Key
  async function keyFor(userId: number, scopes: string[]) {
    return (await createApiKey(env, userId, { name: `batch-${scopes.join('-')}`, scopes: scopes as ApiScope[], rateLimit: 120, allowedIps: [] })).key;
  }

  it('需要 domain.write；审计记为 API Key；每个请求只鉴权一次', async () => {
    fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    const reader = await keyFor(admin.id, ['domain.read']);
    const denied = await call('POST', '/v1/hosted-domains/batch', reader, { domains: [f.domain('denied')] });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'forbidden', fix: expect.stringContaining('domain.write') } });

    const writer = await keyFor(admin.id, ['domain.write']);
    const created = await data<CreateResult>(await call('POST', '/v1/hosted-domains/batch', writer, { domains: [f.domain('k1'), f.domain('k2')] }));
    expect(errors(created)).toEqual(['ok', 'ok']);
    const audit = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, f.domain('k1'))).get();
    expect(audit?.actorName).toMatch(new RegExp(`^${f.prefix}-admin（API Key #\\d+）$`));
    const ids = created.items.map((item) => (item as { hostedDomain: HostedDomain }).hostedDomain.id);
    const checked = await data<CheckResult>(await call('POST', '/v1/hosted-domains/batch-check', writer, { ids }));
    expect(errors(checked)).toEqual(['ok', 'ok']);
    const logs = await db.select().from(apiRequestLogs).all();
    expect(logs.filter((row) => row.path === '/v1/hosted-domains/batch').map((row) => row.statusCode).sort()).toEqual([200, 403]);
    expect(logs.filter((row) => row.path === '/v1/hosted-domains/batch-check')).toHaveLength(1);
  });

  it('与同前缀、用 use(*) 挂了鉴权的子应用无论谁先挂载，都只鉴权与计数一次', async () => {
    fakeCloudflare();
    const f = await fixture();
    const admin = await f.actor('admin', 'admin');
    const key = await keyFor(admin.id, ['domain.write']);
    const sibling = (auth: typeof apiKeyAuth) => {
      const sub = new Hono<AppContext>();
      sub.use('*', auth);
      sub.get('/', (c) => c.json({ data: [] }));
      return sub;
    };
    const userCount = async (scope: string) => counter(scope, String(admin.id));
    for (const siblingFirst of [true, false]) {
      const v1 = new Hono<AppContext>();
      if (siblingFirst) v1.route('/hosted-domains', sibling(apiKeyAuth));
      v1.route('/hosted-domains', v1HostedDomainBatch);
      if (!siblingFirst) v1.route('/hosted-domains', sibling(apiKeyAuth));
      const before = await userCount('api-user');
      await data<CheckResult>(await call('POST', '/hosted-domains/batch-check', key, { ids: [999999] }, v1));
      expect(await userCount('api-user'), `sibling first: ${siblingFirst}`).toBe(before + 1);

      const api = new Hono<AppContext>();
      if (siblingFirst) api.route('/hosted-domains', sibling(requireAuth));
      api.route('/hosted-domains', hostedDomainBatch);
      if (!siblingFirst) api.route('/hosted-domains', sibling(requireAuth));
      const authBefore = await userCount('auth-user');
      await data<CheckResult>(await call('POST', '/hosted-domains/batch-check', admin.jwt, { ids: [999999] }, api));
      expect(await userCount('auth-user'), `sibling first: ${siblingFirst}`).toBe(authBefore + 1);
    }
  });
});

describe('OpenAPI', () => {
  it('两份规格都描述批量添加与检测，/v1 标注 domain.write，单次上限一致', () => {
    for (const [spec, scope] of [[buildSessionOpenApiSpec('https://mail.example'), undefined], [buildOpenApiSpec('https://mail.example'), 'domain.write']] as const) {
      for (const [path, request] of [['/hosted-domains/batch', 'BatchCreateHostedDomainsRequest'], ['/hosted-domains/batch-check', 'BatchCheckHostedDomainsRequest']]) {
        const operation = (spec.paths as Record<string, Record<string, Record<string, unknown>>>)[path!]!.post!;
        expect(operation['x-required-scopes']).toEqual(scope ? [scope] : undefined);
        expect(operation.requestBody).toMatchObject({ content: { 'application/json': { schema: { $ref: `#/components/schemas/${request}` } } } });
      }
      const schemas = spec.components.schemas as Record<string, { properties: Record<string, { maxItems?: number }> }>;
      expect(schemas.BatchCreateHostedDomainsRequest!.properties.domains!.maxItems).toBe(MAX_HOSTED_DOMAIN_BATCH);
      expect(schemas.BatchCheckHostedDomainsRequest!.properties.ids!.maxItems).toBe(MAX_HOSTED_DOMAIN_BATCH);
      expect(schemas).toHaveProperty('HostedDomain');
    }
  });
});
