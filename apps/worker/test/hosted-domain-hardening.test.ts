import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedApiKey, HostedDomain } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomainMembers, hostedDomains, mailboxes, messages, users, webhookDeliveries, webhookEndpoints } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import {
  CloudflareApiError, deleteZone, getZone, isTransientCloudflareError, type CloudflareCredentials,
} from '../src/services/cloudflare.js';
import {
  HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_DNS_SITE_RATE_SCOPE, syncDueHostedDomains, syncHostedDomain,
} from '../src/services/hosted-domain.js';
import { handleInbound } from '../src/services/inbound.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { TEST_PASSWORD, testPasswordHash } from './key-helpers.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const ACCOUNT = 'acct-hardening';
const WORKER = 'hpc-cloud-mail';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FEISHU_HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/hardening-hook-0001';

interface FakeZone {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'moved';
  createdOn: string;
  nameServers: string[];
  routing: { enabled: boolean; status: string };
  catchAll: { enabled: boolean; actions: unknown[] } | null;
  sending: { tag: string; name: string; status: string } | null;
}

/**
 * 有状态的假 Cloudflare（含 RDAP、DoH、飞书与 PushDeer）：blind 模拟 Token 可见范围变窄（任何 zone 都读不到、列表为空），
 * forbidden 里的 zone 返回不带 9109 的 403，createMode 控制建 zone 的响应
 */
function fakeCloudflare() {
  const zones = new Map<string, FakeZone>();
  const calls: string[] = [];
  const notices: { channel: 'feishu' | 'pushdeer'; body: string }[] = [];
  const state = { blind: false, forbidden: new Set<string>(), createMode: 'ok' as 'ok' | 'non-json' | 'timeout' };
  let seq = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], result, ...extra });
  const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], result: null }, status);
  const add = (name: string, status: FakeZone['status'] = 'active', createdOn = new Date().toISOString()) => {
    const n = ++seq;
    const zone: FakeZone = {
      id: `hz-${n}`, name, status, createdOn, nameServers: [`ns${n}a.ns.cloudflare.com`, `ns${n}b.ns.cloudflare.com`],
      routing: { enabled: false, status: 'unconfigured' }, catchAll: null, sending: null,
    };
    zones.set(zone.id, zone);
    return zone;
  };
  const view = (zone: FakeZone) => ({
    id: zone.id, name: zone.name, status: zone.status, name_servers: zone.nameServers,
    original_name_servers: ['ns1.registrar.example', 'ns2.registrar.example'], original_registrar: 'Example Registrar, Inc.',
    activated_on: zone.status === 'active' ? new Date().toISOString() : null, created_on: zone.createdOn,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.hostname === 'rdap.org') return new Response('not found', { status: 404 });
    if (url.hostname === 'cloudflare-dns.com') return json({ Status: 0, Answer: [] });
    if (url.hostname === 'open.feishu.cn') {
      notices.push({ channel: 'feishu', body: String(init?.body ?? '') });
      return json({ code: 0 });
    }
    if (url.hostname === 'api2.pushdeer.com') {
      notices.push({ channel: 'pushdeer', body: String(init?.body ?? '') });
      return json({ code: 0 });
    }
    expect(url.origin).toBe('https://api.cloudflare.com');
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === '/zones' && method === 'GET') {
      if (state.blind) return ok([], { result_info: { total_count: 0 } });
      const name = url.searchParams.get('name');
      const list = [...zones.values()].filter((zone) => !name || zone.name === name);
      return ok(list.map(view), { result_info: { total_count: list.length } });
    }
    if (path === '/zones' && method === 'POST') {
      const name = String(body.name);
      if ([...zones.values()].some((zone) => zone.name === name)) return fail(400, 1061, 'already exists');
      const zone = add(name, 'pending');
      if (state.createMode === 'non-json') return new Response('<html>upstream hiccup</html>', { status: 200 });
      if (state.createMode === 'timeout') throw new Error('timeout');
      return ok(view(zone));
    }
    const match = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    if (state.blind) return fail(403, 9109, 'Invalid zone identifier');
    if (match && state.forbidden.has(match[1]!)) return fail(403, 10000, 'Authentication error');
    const zone = match ? zones.get(match[1]!) : undefined;
    if (!zone) return fail(403, 9109, 'Invalid zone identifier');
    const rest = match![2] ?? '';
    if (rest === '' && method === 'GET') return ok(view(zone));
    if (rest === '' && method === 'DELETE') { zones.delete(zone.id); return ok({ id: zone.id }); }
    if (rest === '/activation_check') return ok({ id: zone.id });
    if (rest === '/email/routing' && method === 'GET') return ok(zone.routing);
    if (rest === '/email/routing/dns' && method === 'POST') {
      if (zone.status !== 'active') return fail(400, 2009, 'Active zone required');
      zone.routing = { enabled: true, status: 'ready' };
      return ok(zone.routing);
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'GET') return ok(zone.catchAll ?? { enabled: false, actions: [{ type: 'drop' }] });
    if (rest === '/email/routing/rules/catch_all' && method === 'PUT') {
      zone.catchAll = { enabled: Boolean(body.enabled), actions: body.actions as unknown[] };
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
      if (sending[2] === '/dns/status') return ok({ status: zone.sending.status, errors: [] });
      if (sending[2] === '/dns' && method === 'POST') { zone.sending.status = 'ready'; return ok({ status: 'ready', errors: [] }); }
      if (!sending[2] && method === 'DELETE') { zone.sending = null; return ok({}); }
    }
    return fail(400, 9999, `unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  /** 已就绪的 zone：收件路由、catch-all 与发信都已配置好，核对只读 */
  const ready = (name: string) => {
    const zone = add(name, 'active');
    zone.routing = { enabled: true, status: 'ready' };
    zone.catchAll = { enabled: true, actions: [{ type: 'worker', value: [WORKER] }] };
    zone.sending = { tag: `sub-${zone.id}`, name, status: 'ready' };
    return zone;
  };
  return { zones, calls, notices, state, add, ready, byName: (name: string) => [...zones.values()].find((zone) => zone.name === name) };
}

const runtime: Env = { ...env, cf_api_token: 'test-token', cf_account_id: ACCOUNT, worker_name: WORKER };

let sequence = 0;
async function fixture() {
  const prefix = `hh${++sequence}`;
  await db.delete(hostedDomainMembers);
  await db.delete(hostedDomains);
  await updateSettings(env, {
    domains: { list: [{ domain: `${prefix}-system.test`, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    hosted_domains: { enabled: true, maxPerUser: 5, maxPendingPerUser: 3, maxPendingTotal: 20, pendingDays: 7, autoClaimLimit: 0 },
  });
  async function actor(suffix: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: await testPasswordHash(), authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  return { prefix, domain: (name = 'mail') => `${prefix}-${name}.test`, actor };
}

/** 直接落一条已生效的托管域名（zone 在假 Cloudflare 里已就绪），绕过创建流程方便构造各种状态 */
async function seed(cf: ReturnType<typeof fakeCloudflare>, userId: number, domain: string,
  patch: Partial<typeof hostedDomains.$inferInsert> = {}, zone: { status?: FakeZone['status']; absent?: boolean } = {}) {
  const fake = cf.ready(domain);
  if (zone.status) fake.status = zone.status;
  if (zone.absent) cf.zones.delete(fake.id);
  return (await db.insert(hostedDomains).values({
    domain, userId, status: 'active', zoneId: fake.id, nameServers: fake.nameServers, zoneStatus: 'active', routingStatus: 'ready',
    catchAllReady: true, sendingStatus: 'ready', sendingTag: `sub-${fake.id}`, activatedAt: new Date(Date.now() - 30 * DAY),
    checkedAt: new Date(Date.now() - 2 * DAY), createdAt: new Date(Date.now() - 40 * DAY), ...patch,
  }).returning().get())!;
}

const rowOf = async (id: number) => (await db.select().from(hostedDomains).where(eq(hostedDomains.id, id)).get())!;

async function call(method: string, path: string, token: string, body?: unknown, prefix: '/api' | '/v1' = '/api') {
  const ctx = createExecutionContext();
  const response = await app.request(`${prefix}${path}`, { method,
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
async function errorOf(response: Response, status: number): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function receive(address: string, label: string) {
  const raw = `From: sender@example.net\r\nTo: ${address}\r\nMessage-ID: <${label}@example.net>\r\nSubject: hosted\r\nContent-Type: text/plain\r\n\r\nhello`;
  const ctx = createExecutionContext();
  const rejected: string[] = [];
  await handleInbound({ to: address, from: 'sender@example.net', raw: new Response(raw).body!, headers: new Headers(),
    forward: async () => {}, setReject: (reason: string) => { rejected.push(reason); },
  } as unknown as ForwardableEmailMessage, runtime, ctx);
  await waitOnExecutionContext(ctx);
  const stored = await db.select().from(messages).where(eq(messages.messageId, `<${label}@example.net>`)).get();
  return { rejected, stored };
}

async function enableNotices(userId: number) {
  await db.update(users).set({ notifyPrefs: {
    feishu: { enabled: true, webhookUrl: FEISHU_HOOK, secret: '', contentLevel: 'summary' },
    webhook: { enabled: false, url: '', secret: '' },
    forward: { enabled: false, addresses: [] },
    pushdeer: { enabled: true, endpoint: '', pushkey: 'PDU-hardening' },
  } }).where(eq(users.id, userId));
}

const siteCalls = async () => (await readCounter(env, HOSTED_DNS_SITE_RATE_SCOPE, 'all', minuteWindow(1))).count;

beforeEach(async () => {
  await env.db.prepare('DELETE FROM rate_counters WHERE scope IN (?, ?, ?)')
    .bind(HOSTED_DNS_SITE_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE).run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zone 失踪判定（X04）', () => {
  const creds = (probe?: string): CloudflareCredentials => ({
    token: 'test-token', accountId: ACCOUNT, workerName: WORKER, probeZone: probe ? { id: probe } : null,
  });

  it('不带 9109 的 403（如 Token 无权限）不当作失踪，也不按名称查找', async () => {
    const cf = fakeCloudflare();
    const zone = cf.ready('forbidden.example');
    cf.state.forbidden.add(zone.id);
    const error = await getZone(creds(), zone.id, zone.name).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(403);
    expect(cf.calls).toEqual([`GET /zones/${zone.id}`]);
    // 删除同理：读不到 zone 不能当作已删除
    await expect(deleteZone(creds(), zone.id, zone.name)).rejects.toBeInstanceOf(CloudflareApiError);
    expect(cf.zones.has(zone.id)).toBe(true);
  });

  it('按名称列不到后还要通过可见性自检：参照 zone 读得到或账户里还有 zone 才判为不存在', async () => {
    const cf = fakeCloudflare();
    const probe = cf.ready('probe.example');
    expect(await getZone(creds(probe.id), 'hz-gone', 'gone.example')).toBeNull();
    expect(cf.calls).toEqual(['GET /zones/hz-gone', 'GET /zones', `GET /zones/${probe.id}`]);

    cf.calls.length = 0;
    expect(await getZone(creds(), 'hz-gone', 'gone.example')).toBeNull();
    expect(cf.calls).toEqual(['GET /zones/hz-gone', 'GET /zones', 'GET /zones']);

    // 参照 zone 就是被判定的这个时不用它，改列账户
    cf.calls.length = 0;
    expect(await getZone(creds('hz-gone'), 'hz-gone', 'gone.example')).toBeNull();
    expect(cf.calls).toEqual(['GET /zones/hz-gone', 'GET /zones', 'GET /zones']);
  });

  it('Token 可见范围变窄（参照 zone 读不到、账户列表为空）时不下结论，按结果不确定抛出', async () => {
    const cf = fakeCloudflare();
    const probe = cf.ready('probe.example');
    cf.state.blind = true;
    for (const probeId of [probe.id, undefined]) {
      const error = await getZone(creds(probeId), 'hz-gone', 'gone.example').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect(isTransientCloudflareError(error)).toBe(true);
      expect((error as Error).message).toContain('无法确认 zone 已不存在');
      await expect(deleteZone(creds(probeId), 'hz-gone', 'gone.example')).rejects.toSatisfy(isTransientCloudflareError);
    }
  });

  it('2xx/3xx 但响应体解析失败或 success:false 视为结果不确定（R46）', () => {
    expect(isTransientCloudflareError(new CloudflareApiError(200, [], 'HTTP 200'))).toBe(true);
    expect(isTransientCloudflareError(new CloudflareApiError(302, [], 'HTTP 302'))).toBe(true);
    expect(isTransientCloudflareError(new CloudflareApiError(400, [1061], 'exists'))).toBe(false);
    expect(isTransientCloudflareError(new CloudflareApiError(403, [10000], 'auth'))).toBe(false);
  });

  it('曾生效的域名首次查不到 zone：转为 error 照常收信，25 分钟内复查不变，之后判为 moved/missing 并只提醒一次', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    await enableNotices(owner.id);
    const domain = f.domain();
    await seed(cf, owner.id, f.domain('probe'));
    const row = await seed(cf, owner.id, domain);
    cf.zones.delete(row.zoneId!);

    await syncHostedDomain(runtime, row.id);
    const first = await rowOf(row.id);
    expect(first).toMatchObject({ status: 'error', zoneStatus: 'active', syncLeaseUntil: null });
    expect(first.zoneMissingAt).not.toBeNull();
    expect(first.lastError).toContain('约 30 分钟后复核，期间照常收信');
    expect((await receive(`fresh@${domain}`, `${f.prefix}-m1`)).stored?.notifyOwnerIds).toEqual([owner.id]);
    // 上面这封来信本身会按所有者偏好推送，只看之后的迁走提醒
    cf.notices.length = 0;

    await db.update(hostedDomains).set({ zoneMissingAt: new Date(Date.now() - 20 * MINUTE) }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(await rowOf(row.id)).toMatchObject({ status: 'error', zoneStatus: 'active' });
    expect(cf.notices).toEqual([]);

    await db.update(hostedDomains).set({ zoneMissingAt: new Date(Date.now() - 26 * MINUTE) }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneStatus: 'missing', syncLeaseUntil: null });
    expect(cf.notices.map((notice) => notice.channel).sort()).toEqual(['feishu', 'pushdeer']);
    expect(cf.notices[0]!.body).toContain(domain);
    expect(cf.notices[0]!.body).toContain('重新接入');
    expect((await receive(`late@${domain}`, `${f.prefix}-m2`)).rejected).not.toEqual([]);

    // 再次巡检仍是 moved，不重复提醒
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 2 * DAY) }).where(eq(hostedDomains.id, row.id));
    expect(await syncDueHostedDomains(runtime)).toBeGreaterThanOrEqual(1);
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneStatus: 'missing' });
    expect(cf.notices).toHaveLength(2);
  });

  it('读到 zone 就清掉失踪记录；自检失败或 403 时保留原状态只记错误', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const row = await seed(cf, owner.id, f.domain());
    const zone = cf.zones.get(row.zoneId!)!;
    cf.zones.delete(zone.id);
    // 没有其他托管域名可做参照，账户里也没有别的 zone：不判失踪
    await syncHostedDomain(runtime, row.id);
    let current = await rowOf(row.id);
    expect(current).toMatchObject({ status: 'active', zoneMissingAt: null, syncLeaseUntil: null });
    expect(current.lastError).toContain('无法确认 zone 已不存在');

    cf.ready(f.domain('elsewhere'));
    await syncHostedDomain(runtime, row.id);
    expect((await rowOf(row.id)).status).toBe('error');

    // zone 又能读到（例如误删后恢复）：回到 active 并清掉失踪记录
    cf.zones.set(zone.id, zone);
    await syncHostedDomain(runtime, row.id);
    current = await rowOf(row.id);
    expect(current).toMatchObject({ status: 'active', zoneMissingAt: null, lastError: '' });

    cf.state.forbidden.add(zone.id);
    await syncHostedDomain(runtime, row.id);
    current = await rowOf(row.id);
    expect(current).toMatchObject({ status: 'active', zoneMissingAt: null });
    expect(current.lastError).toContain('Authentication error');
  });

  it('从未生效的 pending 域名一次确认（含自检）即删除记录', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    cf.ready(f.domain('elsewhere'));
    const row = await seed(cf, owner.id, f.domain(), { status: 'pending', zoneStatus: 'pending', activatedAt: null }, { absent: true });
    await syncHostedDomain(runtime, row.id);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, row.id)).get()).toBeUndefined();
  });

  it('曾生效后又回到 pending 的域名不按未生效处理：首次只记录失踪时间', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    cf.ready(f.domain('elsewhere'));
    const row = await seed(cf, owner.id, f.domain(), { status: 'pending', zoneStatus: 'pending' }, { absent: true });
    await syncHostedDomain(runtime, row.id);
    const current = await rowOf(row.id);
    expect(current).toMatchObject({ status: 'pending' });
    expect(current.zoneMissingAt).not.toBeNull();
    expect(current.lastError).not.toContain('照常收信');
  });
});

describe('moved 提醒（R15）', () => {
  it('转入 moved 只提醒一次（飞书与 PushDeer），文案带 NS 与 7 天期限；没配置通知的所有者不发', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const quiet = await f.actor('quiet');
    await enableNotices(owner.id);
    const row = await seed(cf, owner.id, f.domain());
    const other = await seed(cf, quiet.id, f.domain('quiet'));
    cf.zones.get(row.zoneId!)!.status = 'moved';
    cf.zones.get(other.zoneId!)!.status = 'moved';

    expect(await syncDueHostedDomains(runtime)).toBe(2);
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneStatus: 'moved' });
    expect(cf.notices).toHaveLength(2);
    const feishu = cf.notices.find((notice) => notice.channel === 'feishu')!.body;
    expect(feishu).toContain(f.domain());
    expect(feishu).toContain(row.nameServers[0]);
    expect(feishu).toContain('7 天');
    const view = await data<HostedDomain>(await call('GET', `/hosted-domains/${row.id}`, owner.jwt));
    expect(view.warnings.join('')).toContain('7 天后删除');
    expect(view.warnings.join('')).toContain('重新接入');

    // zone 仍在的 moved 每 30 分钟复查：到期再核对，不重复提醒
    await db.update(hostedDomains).set({ checkedAt: new Date(Date.now() - 31 * MINUTE) });
    expect(await syncDueHostedDomains(runtime)).toBe(2);
    expect(cf.notices).toHaveLength(2);
  });

  it('用户点立即检测发现迁走时提醒放进 waitUntil', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    await enableNotices(owner.id);
    const row = await seed(cf, owner.id, f.domain());
    cf.zones.get(row.zoneId!)!.status = 'moved';
    const checked = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/check`, owner.jwt));
    expect(checked.status).toBe('moved');
    expect(cf.notices).toHaveLength(2);
  });
});

describe('巡检租约与分批（R28）', () => {
  it('到期条件：pending 按创建时长退避，zone 仍在的 moved 与 error 每 30 分钟，active 与 zone 已删除的 moved 每天', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const ago = (ms: number) => new Date(Date.now() - ms);
    const pending = (name: string, created: number, checked: number) => seed(cf, owner.id, f.domain(name), {
      status: 'pending', zoneStatus: 'pending', activatedAt: null, createdAt: ago(created), checkedAt: ago(checked),
    }, { status: 'pending' });
    const cases = {
      fresh_due: await pending('p1', 30 * MINUTE, 5 * MINUTE),
      fresh_wait: await pending('p2', 30 * MINUTE, 3 * MINUTE),
      day_wait: await pending('p3', 5 * 60 * MINUTE, 10 * MINUTE),
      day_due: await pending('p4', 5 * 60 * MINUTE, 16 * MINUTE),
      old_wait: await pending('p5', 3 * DAY, 30 * MINUTE),
      old_due: await pending('p6', 3 * DAY, 61 * MINUTE),
      moved_due: await seed(cf, owner.id, f.domain('m1'), { status: 'moved', zoneStatus: 'moved', checkedAt: ago(31 * MINUTE) }, { status: 'moved' }),
      missing_wait: await seed(cf, owner.id, f.domain('m2'), { status: 'moved', zoneStatus: 'missing', checkedAt: ago(31 * MINUTE) }, { status: 'moved' }),
      missing_due: await seed(cf, owner.id, f.domain('m3'), { status: 'moved', zoneStatus: 'missing', checkedAt: ago(25 * 60 * MINUTE) }, { status: 'moved' }),
      error_due: await seed(cf, owner.id, f.domain('e1'), { status: 'error', checkedAt: ago(31 * MINUTE) }),
      error_wait: await seed(cf, owner.id, f.domain('e2'), { status: 'error', checkedAt: ago(29 * MINUTE) }),
      active_wait: await seed(cf, owner.id, f.domain('a1'), { checkedAt: ago(23 * 60 * MINUTE) }),
      active_due: await seed(cf, owner.id, f.domain('a2'), { checkedAt: ago(25 * 60 * MINUTE) }),
    };
    const processed = await syncDueHostedDomains(runtime, 50);
    const checked = Object.entries(cases).filter(([, row]) => cf.calls.includes(`GET /zones/${row.zoneId}`)).map(([name]) => name).sort();
    expect(checked).toEqual(Object.keys(cases).filter((name) => name.endsWith('_due')).sort());
    expect(processed).toBe(checked.length);
    expect((await db.select().from(hostedDomains).all()).every((row) => row.syncLeaseUntil === null)).toBe(true);
  });

  it('两个并发巡检领到的域名不相交，每个域名只核对一次', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(await seed(cf, owner.id, f.domain(`c${i}`), {}, { status: 'moved' }));
    const [a, b] = await Promise.all([syncDueHostedDomains(runtime, 2), syncDueHostedDomains(runtime, 2)]);
    expect(a + b).toBe(rows.length);
    for (const row of rows) expect(cf.calls.filter((entry) => entry === `GET /zones/${row.zoneId}`)).toHaveLength(1);
    expect((await db.select().from(hostedDomains).all()).every((row) => row.status === 'moved' && row.syncLeaseUntil === null)).toBe(true);
  });

  it('租约被占时立即检测与核对都不调用 Cloudflare、不占全站额度；租约过期后可以重新领取', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const row = await seed(cf, owner.id, f.domain());
    const held = new Date(Date.now() + 2 * MINUTE);
    await db.update(hostedDomains).set({ syncLeaseUntil: held }).where(eq(hostedDomains.id, row.id));
    const before = await siteCalls();
    const view = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/check`, owner.jwt));
    expect(view.status).toBe('active');
    await syncHostedDomain(runtime, row.id);
    expect(await syncDueHostedDomains(runtime)).toBe(0);
    expect(cf.calls).toEqual([]);
    expect(await siteCalls()).toBe(before);
    expect((await rowOf(row.id)).syncLeaseUntil?.getTime()).toBe(held.getTime());

    await db.update(hostedDomains).set({ syncLeaseUntil: new Date(Date.now() - 1000) }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(cf.calls).toContain(`GET /zones/${row.zoneId}`);
    expect((await rowOf(row.id)).syncLeaseUntil).toBeNull();
  });

  it('出错与提前返回的分支也释放租约', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    // 查询 Cloudflare 失败：只记错误
    const failing = await seed(cf, owner.id, f.domain('fail'));
    cf.state.forbidden.add(failing.zoneId!);
    // 刚占位、还没有 zone_id：等创建请求回填，不处理
    const reserved = (await db.insert(hostedDomains).values({ domain: f.domain('reserved'), userId: owner.id, status: 'pending' }).returning().get())!;
    // 删除中但 Cloudflare 删除失败
    const deleting = await seed(cf, owner.id, f.domain('deleting'), { status: 'deleting' });
    cf.state.forbidden.add(deleting.zoneId!);
    for (const row of [failing, reserved, deleting]) {
      await syncHostedDomain(runtime, row.id);
      expect((await rowOf(row.id)).syncLeaseUntil, row.domain).toBeNull();
    }
    expect((await rowOf(deleting.id)).status).toBe('deleting');
  });
});

describe('重新接入（R15）', () => {
  it('zone 已被删除：新建 zone 回到 pending，分配新 NS，保留生效时间、地址、邮件与成员', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const member = await f.actor('member');
    const domain = f.domain();
    // 账户里的其他 zone：可见性自检能列出账户 zone
    cf.ready(f.domain('elsewhere'));
    const row = await seed(cf, owner.id, domain, {
      status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - 3 * DAY),
    }, { absent: true });
    await db.insert(hostedDomainMembers).values({ domainId: row.id, userId: member.id, grantedBy: owner.id });
    await db.insert(mailboxes).values({ address: `keep@${domain}`, domain, userId: owner.id });
    await db.insert(messages).values({ direction: 'inbound', address: `keep@${domain}`, domain, status: 'received', subject: 'history' });

    expect((await errorOf(await call('POST', `/hosted-domains/${row.id}/reconnect`, member.jwt), 403)).code).toBe('forbidden');
    const view = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt));
    const zone = cf.byName(domain)!;
    expect(view).toMatchObject({
      status: 'pending', nameServers: zone.nameServers, activatedAt: row.activatedAt!.toISOString(), expiresAt: expect.any(String),
      lastError: '', mailboxCount: 1, memberCount: 1,
    });
    expect(view.nameServers).not.toEqual(row.nameServers);
    const current = await rowOf(row.id);
    expect(current).toMatchObject({ zoneId: zone.id, zoneMissingAt: null, syncLeaseUntil: null, sendingTag: `sub-${zone.id}`, catchAllReady: true });
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.domain, domain)).all()).toHaveLength(1);
    const audit = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.reconnect'), eq(adminAuditLogs.target, domain))).get();
    expect(audit?.detail).toContain(zone.id);
    expect(audit?.detail).toContain(zone.nameServers[0]);

    // 用户改好新 NS 后照常开通，旧地址继续收信
    zone.status = 'active';
    await syncHostedDomain(runtime, row.id);
    expect((await rowOf(row.id)).status).toBe('active');
    expect((await receive(`keep@${domain}`, `${f.prefix}-r1`)).stored?.notifyOwnerIds).toEqual([owner.id]);
  });

  it('zone 仍在：请 Cloudflare 复查 NS 后核对一次，NS 改回则恢复；不新建 zone', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    const row = await seed(cf, owner.id, f.domain(), { status: 'moved', zoneStatus: 'moved' }, { status: 'moved' });
    const still = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt));
    expect(still.status).toBe('moved');
    expect(cf.calls).toContain(`PUT /zones/${row.zoneId}/activation_check`);

    cf.zones.get(row.zoneId!)!.status = 'active';
    const back = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, admin.jwt));
    expect(back).toMatchObject({ status: 'active', role: 'admin' });
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(0);
    expect((await rowOf(row.id)).zoneId).toBe(row.zoneId);
  });

  it('建 zone 结果不确定时 500，再点时采用上次建出的 zone；同名外来 zone 不接管', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    cf.ready(f.domain('elsewhere'));
    const row = await seed(cf, owner.id, domain, {
      status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - 60 * MINUTE),
    }, { absent: true });
    cf.state.createMode = 'timeout';
    expect((await errorOf(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt), 500)).message).toContain('重新接入');
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneId: row.zoneId, syncLeaseUntil: null });
    cf.state.createMode = 'ok';
    const adopted = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt));
    expect(adopted.status).toBe('pending');
    expect((await rowOf(row.id)).zoneId).toBe(cf.byName(domain)!.id);
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
    expect((await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, domain)).get())?.detail).toContain('采用上次中断时建出的');

    const foreignDomain = f.domain('foreign');
    const foreign = await seed(cf, owner.id, foreignDomain, {
      status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - 60 * MINUTE),
    }, { absent: true });
    cf.add(foreignDomain, 'active', '2020-01-01T00:00:00Z');
    const before = cf.calls.length;
    expect((await errorOf(await call('POST', `/hosted-domains/${foreign.id}/reconnect`, owner.jwt), 409)).message).toContain('不能接管');
    expect(cf.calls.slice(before)).not.toContain('POST /zones');
    expect(await rowOf(foreign.id)).toMatchObject({ status: 'moved', zoneId: foreign.zoneId, syncLeaseUntil: null });
  });

  it('/v1 用 domain.write 的 Key 重新接入，审计记为 API Key；只有 domain.read 的 Key 403', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    await updateSettings(env, { api: { enabled: true }, security: { require2fa: false } });
    const owner = await f.actor('owner');
    const key = async (scopes: string[]) => (await data<CreatedApiKey>(await call('POST', '/api-keys', owner.jwt,
      { name: `reconnect-${scopes.join('-')}`, scopes, rateLimit: 600, password: TEST_PASSWORD }), 201));
    const reader = await key(['domain.read']);
    const writer = await key(['domain.read', 'domain.write']);
    const domain = f.domain();
    cf.ready(f.domain('elsewhere'));
    const row = await seed(cf, owner.id, domain, { status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - DAY) }, { absent: true });
    expect((await errorOf(await call('POST', `/hosted-domains/${row.id}/reconnect`, reader.key, undefined, '/v1'), 403)).code).toBe('forbidden');
    expect((await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, writer.key, undefined, '/v1'))).status).toBe('pending');
    const audit = await db.select().from(adminAuditLogs)
      .where(and(eq(adminAuditLogs.action, 'hosted_domain.reconnect'), eq(adminAuditLogs.target, domain))).get();
    expect(audit?.actorName).toBe(`${owner.username}（API Key #${writer.id}）`);
  });

  it('只接受 moved；其他人 404；正在核对时直接返回当前状态', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const stranger = await f.actor('stranger');
    const active = await seed(cf, owner.id, f.domain('active'));
    // 正被核对的非 moved 域名同样 409，不当作「正在核对」返回 200
    await db.update(hostedDomains).set({ syncLeaseUntil: new Date(Date.now() + MINUTE) }).where(eq(hostedDomains.id, active.id));
    expect(await errorOf(await call('POST', `/hosted-domains/${active.id}/reconnect`, owner.jwt), 409))
      .toMatchObject({ code: 'conflict', message: '只有名称服务器已改走的域名可以重新接入' });
    const moved = await seed(cf, owner.id, f.domain('moved'), { status: 'moved', zoneStatus: 'missing' }, { absent: true });
    expect((await errorOf(await call('POST', `/hosted-domains/${moved.id}/reconnect`, stranger.jwt), 404)).code).toBe('not_found');
    await db.update(hostedDomains).set({ syncLeaseUntil: new Date(Date.now() + MINUTE) }).where(eq(hostedDomains.id, moved.id));
    const before = await siteCalls();
    expect((await data<HostedDomain>(await call('POST', `/hosted-domains/${moved.id}/reconnect`, owner.jwt))).status).toBe('moved');
    expect(cf.calls).toEqual([]);
    expect(await siteCalls()).toBe(before);
  });
});

describe('中断的创建占位', () => {
  it('按名称找不到 zone 时先做可见性自检，Token 看不到账户就保留占位', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const reserved = (await db.insert(hostedDomains).values({
      domain: f.domain(), userId: owner.id, status: 'pending', createdAt: new Date(Date.now() - 11 * MINUTE),
    }).returning().get())!;
    cf.state.blind = true;
    await expect(syncHostedDomain(runtime, reserved.id)).rejects.toSatisfy(isTransientCloudflareError);
    expect(await rowOf(reserved.id)).toMatchObject({ zoneId: null, syncLeaseUntil: null });
    cf.state.blind = false;
    cf.ready(f.domain('elsewhere'));
    await syncHostedDomain(runtime, reserved.id);
    expect(await db.select().from(hostedDomains).where(eq(hostedDomains.id, reserved.id)).get()).toBeUndefined();
  });
});

describe('建 zone 返回 2xx 但响应体无法解析（R46）', () => {
  it('保留占位并提示稍后查看，定时任务按名称找回', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    cf.state.createMode = 'non-json';
    const error = await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain }), 500);
    expect(error).toMatchObject({ code: 'internal' });
    expect(error.message).toContain('稍后');
    const reserved = (await db.select().from(hostedDomains).where(eq(hostedDomains.domain, domain)).get())!;
    expect(reserved.zoneId).toBeNull();
    cf.state.createMode = 'ok';
    await db.update(hostedDomains).set({ createdAt: new Date(Date.now() - 11 * MINUTE) }).where(eq(hostedDomains.id, reserved.id));
    await syncHostedDomain(runtime, reserved.id);
    expect(await rowOf(reserved.id)).toMatchObject({ zoneId: cf.byName(domain)!.id, syncLeaseUntil: null });
  });
});

describe('修复轮 A19：重新接入占等待生效额度，并按 pendingDays 到期撤回', () => {
  async function movedAway(cf: ReturnType<typeof fakeCloudflare>, userId: number, domain: string) {
    return seed(cf, userId, domain, { status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - 3 * DAY) }, { absent: true });
  }
  const pendingSettings = (patch: { maxPendingPerUser?: number; maxPendingTotal?: number }) => updateSettings(env, {
    hosted_domains: { enabled: true, maxPerUser: 5, maxPendingPerUser: 3, maxPendingTotal: 20, pendingDays: 7, autoClaimLimit: 0, ...patch },
  });

  it('所有者的等待数已满时 403、全站等待数已满时 429，都不建 zone；管理员不受个人额度限制', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const admin = await f.actor('admin', 'admin');
    cf.ready(f.domain('elsewhere'));
    await pendingSettings({ maxPendingPerUser: 1 });
    await db.insert(hostedDomains).values({ domain: f.domain('waiting'), userId: owner.id, status: 'pending', zoneId: 'zone-waiting' });
    const first = await movedAway(cf, owner.id, f.domain('first'));
    const second = await movedAway(cf, owner.id, f.domain('second'));
    expect(await errorOf(await call('POST', `/hosted-domains/${first.id}/reconnect`, owner.jwt), 403))
      .toMatchObject({ code: 'forbidden', message: expect.stringContaining('等待 NS 生效') });
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toEqual([]);
    expect((await rowOf(first.id)).status).toBe('moved');

    // 管理员替所有者重新接入：不看所有者的个人额度，仍受全站额度约束
    expect((await data<HostedDomain>(await call('POST', `/hosted-domains/${first.id}/reconnect`, admin.jwt))).status).toBe('pending');
    await pendingSettings({ maxPendingPerUser: 5, maxPendingTotal: 2 });
    expect(await errorOf(await call('POST', `/hosted-domains/${second.id}/reconnect`, admin.jwt), 429))
      .toMatchObject({ code: 'rate_limited', message: expect.stringContaining('等待生效的域名较多') });
    expect(cf.calls.filter((entry) => entry === 'POST /zones')).toHaveLength(1);
    expect((await rowOf(second.id)).status).toBe('moved');
  });

  it('重建出的 pending 给出 expiresAt，按 pendingDays 到期后删除新 zone 回到 moved，地址与邮件保留', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    cf.ready(f.domain('elsewhere'));
    await pendingSettings({});
    const row = await movedAway(cf, owner.id, domain);
    await db.insert(mailboxes).values({ address: `keep@${domain}`, domain, userId: owner.id });
    await db.insert(messages).values({ direction: 'inbound', address: `keep@${domain}`, domain, status: 'received', subject: 'history' });
    const view = await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt));
    expect(view.status).toBe('pending');
    expect(Date.parse(view.expiresAt!)).toBeGreaterThan(Date.now() + 6 * DAY);
    const zone = cf.byName(domain)!;

    // 7 天内照常等待
    await syncHostedDomain(runtime, row.id);
    expect((await rowOf(row.id)).status).toBe('pending');

    // 到期：新 zone 也是 8 天前建的，撤回接入
    const longAgo = new Date(Date.now() - 8 * DAY);
    zone.createdOn = longAgo.toISOString();
    await db.update(hostedDomains).set({ createdAt: longAgo, checkedAt: null }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneStatus: 'missing', syncLeaseUntil: null });
    expect(cf.calls).toContain(`DELETE /zones/${zone.id}`);
    expect(cf.byName(domain)).toBeUndefined();
    expect(await db.select().from(mailboxes).where(eq(mailboxes.domain, domain)).all()).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.domain, domain)).all()).toHaveLength(1);
  });
});

describe("修复轮二 A19'：重新接入到期撤回同样发 moved 事件与提醒", () => {
  it('到期撤回时入队 hosted_domain.moved Webhook，并按个人偏好提醒一次', async () => {
    const cf = fakeCloudflare();
    const f = await fixture();
    const owner = await f.actor('owner');
    const domain = f.domain();
    cf.ready(f.domain('elsewhere'));
    await enableNotices(owner.id);
    await db.insert(webhookEndpoints).values({ userId: owner.id, url: 'https://hooks.example.com/hpc', secret: 'whsec_dGVzdA==',
      events: ['hosted_domain.moved'], accessRole: 'user' });
    const row = await seed(cf, owner.id, domain, { status: 'moved', zoneStatus: 'missing', zoneMissingAt: new Date(Date.now() - 3 * DAY) }, { absent: true });
    expect((await data<HostedDomain>(await call('POST', `/hosted-domains/${row.id}/reconnect`, owner.jwt))).status).toBe('pending');
    cf.notices.length = 0;

    const longAgo = new Date(Date.now() - 8 * DAY);
    cf.byName(domain)!.createdOn = longAgo.toISOString();
    await db.update(hostedDomains).set({ createdAt: longAgo, checkedAt: null }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(await rowOf(row.id)).toMatchObject({ status: 'moved', zoneStatus: 'missing' });
    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.userId, owner.id)).all();
    expect(queued.map((delivery) => delivery.eventType)).toEqual(['hosted_domain.moved']);
    expect(cf.notices.map((notice) => notice.channel).sort()).toEqual(['feishu', 'pushdeer']);
    expect(cf.notices[0]!.body).toContain(domain);

    // 之后的巡检不再重复
    await db.update(hostedDomains).set({ checkedAt: null }).where(eq(hostedDomains.id, row.id));
    await syncHostedDomain(runtime, row.id);
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.userId, owner.id)).all()).toHaveLength(1);
    expect(cf.notices).toHaveLength(2);
  });
});
