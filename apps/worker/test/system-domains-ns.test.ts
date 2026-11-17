import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain, SystemDomainOnboarding, SystemDomainPrecheck } from '@hpc-mail/shared';
import { syncDueOnboarding } from '../src/services/system-domain.js';
import { fakeCloudflare, type FakeCloudflare, type FakeOptions } from './support/fake-cloudflare.js';
import {
  actor, auditActions, call, data, errorOf, makeDue, onboardNewZone, resetSystemDomains, runtime, systemList, task,
} from './support/system-domains.js';

const BASE = '/admin/system-domains';
const MINUTE = 60_000;
let cf: FakeCloudflare | null = null;

afterEach(() => {
  if (cf) expect(cf.zoneDeletes()).toEqual([]);
  cf = null;
  vi.unstubAllGlobals();
});

const precheckNew = async (token: string, domain: string) =>
  data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${domain}`, token));
const zoneCreates = (fake: FakeCloudflare) => fake.calls.filter((c) => c === 'POST /zones');
const taskCount = async () => (await env.db.prepare('SELECT COUNT(*) AS n FROM system_domain_onboarding').first<{ n: number }>())!.n;

describe('新建 zone', () => {
  it('预检要求确认改 NS；确认后建 zone 等待 NS，生效前不碰收发配置，激活后定时任务补齐并加入系统域名列表', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ registrars: { [domain]: 'Example Registrar, Inc.' } });
    const admin = await actor('ns-admin');

    const precheck = await precheckNew(admin.jwt, domain);
    expect(precheck).toMatchObject({
      mode: 'new_zone', zoneId: null, verdict: 'confirm', requiredAcks: ['ns.change'], dnssec: 'off', steps: [],
      registrar: { name: 'Example Registrar, Inc.', cloudflare: false },
    });
    expect(precheck.checks.find((item) => item.key === 'nameServers')).toMatchObject({ severity: 'confirm', ack: 'ns.change' });
    expect(precheck.checks.find((item) => item.key === 'nameServers')!.impact).toContain('整个域名的 DNS');
    const refused = await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, { mode: 'new_zone', domain }), 409);
    expect(refused.message).toBe('需要确认 1 项变更');
    expect(zoneCreates(cf)).toEqual([]);

    const created = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt, {
      mode: 'new_zone', domain, fingerprint: precheck.fingerprint, accept: ['ns.change'],
    }), 201);
    const zone = cf.zoneByName(domain)!;
    expect(created).toMatchObject({
      state: 'awaiting_ns', zoneId: zone.id, zoneOrigin: 'created', zoneStatus: 'pending', nameServers: zone.nameServers,
      originalNameServers: ['ns1.registrar.example', 'ns2.registrar.example'], dnssec: 'off', canDeleteZone: true,
      accepted: ['ns.change'], steps: { zone: { state: 'waiting' } },
    });
    expect(created.changes.map((c) => [c.kind, c.status, c.target])).toEqual([['zone.create', 'started', null], ['zone.create', 'done', zone.id]]);
    expect(zoneCreates(cf)).toHaveLength(1);

    // 生效前：定时任务只读 zone，不开启路由（pending zone 会返回 2009）
    await makeDue(created.id);
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect((await task(created.id)).state).toBe('awaiting_ns');
    expect(cf.writes()).toEqual(['POST /zones']);

    zone.status = 'active';
    await makeDue(created.id);
    expect(await syncDueOnboarding(runtime)).toBe(1);
    const done = await task(created.id);
    expect(done).toMatchObject({ state: 'completed', canDeleteZone: false, steps: { zone: { state: 'ready' }, sending: { state: 'ready' } } });
    expect(done.activatedAt).not.toBeNull();
    // 本站新建的 zone：catch-all 直接改写，不需要确认
    expect(done.accepted).toEqual(['ns.change']);
    expect((await systemList()).domains.at(-1)).toEqual({ domain, public: false, perUserLimit: 0, random: true });
    expect((await auditActions(domain)).map((entry) => entry.action)).toEqual(['system_domain.create', 'system_domain.complete']);
  });

  it('账户已有同名 zone、同名查询失败时都阻断，不建 zone', async () => {
    const f = await resetSystemDomains();
    const existing = f.domain('exists');
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: existing }] });
    const admin = await actor('ns-admin');
    const exists = await precheckNew(admin.jwt, existing);
    expect(exists.verdict).toBe('blocked');
    expect(exists.checks.find((item) => item.key === 'zone')!.title).toBe('该域名已在 Cloudflare 账户中，请在可接入列表中接入');
    await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, {
      mode: 'new_zone', domain: existing, fingerprint: exists.fingerprint, accept: ['ns.change'],
    }), 409);

    const ok = await precheckNew(admin.jwt, domain);
    for (const failure of [{ status: 502 }, { mode: 'throw' as const }, { status: 403, code: 10000 }]) {
      cf.fail({ method: 'GET', path: /^\/zones$/, ...failure });
      const error = await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, {
        mode: 'new_zone', domain, fingerprint: ok.fingerprint, accept: ['ns.change'],
      }), 409);
      expect(error.message).toBe('无法确认 Cloudflare 账户中是否已有同名 zone');
      expect(error.details!.precheck!.checks.find((item) => item.key === 'zone')!.state).toBe('unknown');
    }
    expect(zoneCreates(cf)).toEqual([]);
    expect(await taskCount()).toBe(0);
  });

  it('Cloudflare 拒绝建 zone：任务失败并审计，返回可读原因；1061 引导到可接入列表', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    const cases: [number, number, string][] = [
      [1049, 400, '该域名尚未注册，请先在注册商完成注册'],
      [1099, 400, '请填写已注册的根域名（例如 example.com，而不是 mail.example.com）'],
      [1105, 429, 'Cloudflare 提示该域名尝试次数过多，请 3 小时后再试'],
      [1061, 409, '该域名已在 Cloudflare 账户中，请在可接入列表中接入'],
    ];
    for (const [code, status, message] of cases) {
      const domain = f.domain(`r${code}`);
      cf.fail({ method: 'POST', path: /^\/zones$/, status: 400, code });
      const error = await errorOf(await onboardNewZone(admin, domain), status);
      expect(error.message).toBe(message);
      const [row] = (await env.db.prepare('SELECT id FROM system_domain_onboarding WHERE domain = ?').bind(domain).all<{ id: number }>()).results;
      expect(await task(row!.id)).toMatchObject({ state: 'failed', errorCode: 'create_failed', lastError: message, zoneId: null });
      expect((await auditActions(domain)).map((entry) => [entry.action, entry.actorName])).toEqual([
        ['system_domain.create', admin.username], ['system_domain.fail', 'system'],
      ]);
    }
    expect(cf.zones.size).toBe(0);
  });

  it('DNSSEC 三态：开启与检测失败给出提示，检测失败不等于未开启；等待 NS 时刷新', async () => {
    const f = await resetSystemDomains();
    const admin = await actor('ns-admin');
    const cases: [FakeOptions, string, string][] = [
      [{ ds: [f.domain('on')] }, f.domain('on'), 'on'],
      [{}, f.domain('off'), 'off'],
      [{ doh: 'servfail' }, f.domain('servfail'), 'unknown'],
      [{ doh: 'http500' }, f.domain('http'), 'unknown'],
      [{ doh: 'throw' }, f.domain('throw'), 'unknown'],
    ];
    for (const [opts, domain, expected] of cases) {
      vi.unstubAllGlobals();
      cf = fakeCloudflare(opts);
      const precheck = await precheckNew(admin.jwt, domain);
      expect(precheck.dnssec).toBe(expected);
      const item = precheck.checks.find((check) => check.key === 'dnssec')!;
      expect(item.severity).toBe(expected === 'off' ? 'none' : 'info');
      if (expected === 'unknown') expect(item.title).toBe('DNSSEC 检测失败（不等于未开启）');
      const created = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt, {
        mode: 'new_zone', domain, fingerprint: precheck.fingerprint, accept: ['ns.change'],
      }), 201);
      expect(created.dnssec).toBe(expected);
      expect(created.precheck!.dnssec).toBe(expected);
    }
    // 等待 NS 时重新检测：关闭 DNSSEC 后刷新为 off
    vi.unstubAllGlobals();
    const domain = f.domain('on');
    const id = (await env.db.prepare('SELECT id FROM system_domain_onboarding WHERE domain = ?').bind(domain).first<{ id: number }>())!.id;
    cf = fakeCloudflare({ zones: [{ id: (await task(id)).zoneId!, name: domain, status: 'pending' }] });
    await makeDue(id);
    await syncDueOnboarding(runtime);
    expect((await task(id)).dnssec).toBe('off');
  });

  it('手动检测：等待 NS 时请 Cloudflare 立即复查，15 秒内重复返回当前视图', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    const created = await data<SystemDomainOnboarding>(await onboardNewZone(admin, domain), 201);
    await makeDue(created.id);
    const checked = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt));
    expect(checked.state).toBe('awaiting_ns');
    expect(cf.calls.filter((c) => c.endsWith('/activation_check'))).toHaveLength(1);
    const calls = cf.calls.length;
    await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt));
    expect(cf.calls).toHaveLength(calls);
  });
});

describe('建 zone 结果不明与 zone 消失', () => {
  it('建 zone 超时但实际已建：保留 creating_zone，10 分钟后按名称找回，来源为 unknown（不可删除），不重复建', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    cf.fail({ method: 'POST', path: /^\/zones$/, mode: 'apply-then-throw' });
    const created = await data<SystemDomainOnboarding>(await onboardNewZone(admin, domain), 201);
    expect(created).toMatchObject({ state: 'creating_zone', zoneId: null, errorCode: 'cf_transient', lastError: 'Cloudflare 暂时没有响应，系统约 10 分钟内确认' });
    expect(created.changes.map((c) => c.status)).toEqual(['started', 'unknown']);

    // 10 分钟内：定时任务不去 Cloudflare 找回
    await env.db.prepare('UPDATE system_domain_onboarding SET next_check_at = ? WHERE id = ?').bind(Date.now() - 1, created.id).run();
    const calls = cf.calls.length;
    await syncDueOnboarding(runtime);
    expect((await task(created.id)).state).toBe('creating_zone');
    expect(cf.calls).toHaveLength(calls);

    // 时间推进到占位 10 分钟以后；zone 的创建时间不早于占位时间 - 1 分钟，采纳
    cf.zoneByName(domain)!.createdOn = new Date(Date.now() - 11 * MINUTE).toISOString();
    await makeDue(created.id, { createdAgoMs: 11 * MINUTE });
    expect(await syncDueOnboarding(runtime)).toBe(1);
    const adopted = await task(created.id);
    expect(adopted).toMatchObject({ state: 'awaiting_ns', zoneId: cf.zoneByName(domain)!.id, zoneOrigin: 'unknown', canDeleteZone: false });
    expect(zoneCreates(cf)).toHaveLength(1);
    await errorOf(await call('POST', `${BASE}/onboardings/${created.id}/cancel`, admin.jwt, { deleteCreatedZone: true }), 400);
    const cancelled = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/cancel`, admin.jwt));
    expect(cancelled.state).toBe('cancelled');
    expect(cf.zoneByName(domain)).toBeDefined();
  });

  it('找回时：没建成为 create_failed；同名 zone 比占位早为 zone_replaced；查询失败保持原状、不建不删', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    const reserve = async (name: string) => {
      cf!.fail({ method: 'POST', path: /^\/zones$/, mode: 'throw' });
      return (await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain(name)), 201)).id;
    };
    const missing = await reserve('missing');
    const replaced = await reserve('replaced');
    const flaky = await reserve('flaky');
    cf.addZone({ name: f.domain('replaced'), createdOn: new Date(Date.now() - 60 * MINUTE).toISOString() });
    for (const id of [missing, replaced, flaky]) await makeDue(id, { createdAgoMs: 11 * MINUTE });

    const flakyDomain = f.domain('flaky');
    const original = cf.fetchMock.getMockImplementation()!;
    cf.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith('/zones') && url.searchParams.get('name') === flakyDomain) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: 'oops' }] }), { status: 502 });
      }
      return original(input, init);
    });
    expect(await syncDueOnboarding(runtime, { limit: 5 })).toBe(3);
    expect(await task(missing)).toMatchObject({ state: 'failed', errorCode: 'create_failed' });
    expect(await task(replaced)).toMatchObject({ state: 'failed', errorCode: 'zone_replaced', zoneId: null });
    expect(await task(flaky)).toMatchObject({ state: 'creating_zone', errorCode: 'cf_transient', zoneId: null });
    expect(zoneCreates(cf)).toHaveLength(3);
    expect((await auditActions(f.domain('missing'))).map((entry) => entry.action)).toContain('system_domain.fail');
  });

  it('等待 NS 时 zone 被外部删除：failed(zone_missing)，不删除任何东西；长期未生效不自动删除 zone', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    const gone = (await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('gone')), 201)).id;
    const slow = (await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('slow')), 201)).id;
    cf.zones.delete(cf.zoneByName(f.domain('gone'))!.id);
    await makeDue(gone);
    await makeDue(slow, { createdAgoMs: 30 * 24 * 60 * MINUTE });
    expect(await syncDueOnboarding(runtime)).toBe(2);
    expect(await task(gone)).toMatchObject({ state: 'failed', errorCode: 'zone_missing', zoneStatus: 'missing', steps: { zone: { state: 'error' } } });
    expect(await task(slow)).toMatchObject({ state: 'awaiting_ns' });
    expect(cf.zoneByName(f.domain('slow'))).toBeDefined();
  });
});

describe('等待 NS 的 zone 配额', () => {
  it('托管 pending 与系统新建、未激活的 zone 共用 hosted_domains.maxPendingTotal，双向计入', async () => {
    const f = await resetSystemDomains({ maxPendingTotal: 2 });
    cf = fakeCloudflare();
    const admin = await actor('ns-admin');
    const owner = await actor('ns-owner', 'user');
    await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('hosted') }), 201);
    await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('one')), 201);

    // 已满：系统预检阻断、接入 409；托管添加同样被拒
    const full = await precheckNew(admin.jwt, f.domain('two'));
    expect(full.checks.find((item) => item.key === 'capacity')).toMatchObject({ severity: 'blocker', title: '等待 NS 生效的域名已达 2 个上限' });
    await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, {
      mode: 'new_zone', domain: f.domain('two'), fingerprint: full.fingerprint, accept: ['ns.change'],
    }), 409);
    const hosted = await errorOf(await call('POST', '/hosted-domains', admin.jwt, { domain: f.domain('hosted2') }), 429);
    expect(hosted.message).toBe('当前等待生效的域名较多，请稍后再试');
    // 已有 zone 的接入不占这份额度
    const existing = cf.addZone({ name: f.domain('existing') });
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${existing.id}`, admin.jwt));
    expect(precheck.checks.find((item) => item.key === 'capacity')!.severity).toBe('none');
    expect(zoneCreates(cf)).toHaveLength(2);
  });
});
