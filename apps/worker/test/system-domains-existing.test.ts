import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemDomainOnboarding, SystemDomainPrecheck, SystemDomainZonesView } from '@hpc-mail/shared';
import { createApiKey } from '../src/services/api-key.js';
import { bumpCounter } from '../src/services/rate-counter.js';
import { syncDueOnboarding } from '../src/services/system-domain.js';
import { cfWindow, MAX_SYSTEM_DOMAIN_CF_CALLS, SYSTEM_DOMAIN_CF_SCOPE } from '../src/services/zone-catalog.js';
import { FAKE_ACCOUNT, fakeCloudflare, fakeZoneId, type FakeCloudflare } from './support/fake-cloudflare.js';
import {
  actor, auditActions, call, data, errorOf, makeDue, resetSystemDomains, runtime, systemList, task,
} from './support/system-domains.js';

const BASE = '/admin/system-domains';
let cf: FakeCloudflare | null = null;

afterEach(() => {
  // 系统路径从不删除 zone（唯一例外在 lifecycle：取消本任务创建、从未激活的 zone）
  if (cf) expect(cf.zoneDeletes()).toEqual([]);
  cf = null;
  vi.unstubAllGlobals();
});

const taskCount = async () => (await env.db.prepare('SELECT COUNT(*) AS n FROM system_domain_onboarding').first<{ n: number }>())!.n;
const precheckOf = async (token: string, zoneId: string) =>
  data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${zoneId}`, token));
const create = (token: string, body: unknown) => call('POST', `${BASE}/onboardings`, token, body);
const spfOf = (fake: FakeCloudflare, domain: string) =>
  fake.recordsOf(fake.zoneByName(domain)!, domain, 'TXT').map((r) => r.content).filter((content) => content.includes('v=spf1'));

describe('已有 zone：一键接入', () => {
  it('可直接接入：后台配置 catch-all、Routing 与发信，完成后追加到系统域名列表末尾（默认仅管理员）并审计', async () => {
    const f = await resetSystemDomains({ system: ['first.test'] });
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }, { name: f.domain('other') }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('ex-admin');
    const before = await systemList();

    const created = await data<SystemDomainOnboarding>(await create(admin.jwt, { mode: 'existing_zone', zoneId }), 201);
    expect(created).toMatchObject({
      domain, mode: 'existing_zone', zoneId, zoneOrigin: 'linked', createdBy: admin.username, canDeleteZone: false,
      dashboardUrl: `https://dash.cloudflare.com/${FAKE_ACCOUNT}/${domain}`,
    });
    const done = await task(created.id);
    expect(done).toMatchObject({
      state: 'completed', errorCode: '', lastError: '', nextCheckAt: null,
      steps: { zone: { state: 'ready' }, routing: { state: 'ready' }, catchAll: { state: 'ready' }, sending: { state: 'ready' } },
    });
    expect(done.finishedAt).not.toBeNull();
    expect(done.changes.filter((c) => c.status === 'started').map((c) => c.kind)).toEqual(['catchAll.put', 'routing.enable', 'sending.create']);
    expect(done.changes.filter((c) => c.status === 'done')).toHaveLength(3);

    const after = await systemList();
    expect(after.domains.map((entry) => entry.domain)).toEqual(['first.test', domain]);
    expect(after.domains.at(-1)).toEqual({ domain, public: false, perUserLimit: 0, random: true });
    expect(after.revision).toBe(before.revision + 1);
    // 只写了这个 zone，没有碰账户里的其他 zone
    expect(cf.writes().length).toBeGreaterThan(0);
    expect(cf.writes().every((call) => call.includes(`/zones/${zoneId}/`))).toBe(true);
    expect((await auditActions(domain)).map((entry) => [entry.action, entry.actorName])).toEqual([
      ['system_domain.create', admin.username], ['system_domain.complete', 'system'],
    ]);
    expect((await auditActions(domain))[1]!.detail).toContain(`revision ${before.revision}→${before.revision + 1}`);

    // 完成后再跑定时任务、再检测：没有写入，不重复加入
    const writes = cf.writes().length;
    expect(await syncDueOnboarding(runtime)).toBe(0);
    await errorOf(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt), 409);
    expect(cf.writes()).toHaveLength(writes);
    expect((await systemList()).revision).toBe(after.revision);
    // 已是系统域名：再次接入在预检阶段就阻断
    const again = await errorOf(await create(admin.jwt, { mode: 'existing_zone', zoneId }), 409);
    expect(again.message).toBe('已是系统域名');
    expect(again.details?.precheck?.verdict).toBe('blocked');
  });

  it('需确认时 409 带最新预检；accept 不全也 409；全部确认后完成，原 catch-all 记进台账，SPF 合并后仍只有一条', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{
      name: domain, catchAll: { enabled: true, actions: [{ type: 'forward', value: ['owner@example.net'] }] },
      records: [{ type: 'TXT', name: domain, content: '"v=spf1 include:_spf.google.com ~all"' }],
    }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('ex-admin');

    const refused = await errorOf(await create(admin.jwt, { mode: 'existing_zone', zoneId }), 409);
    expect(refused.message).toBe('需要确认 3 项变更');
    const precheck = refused.details!.precheck!;
    expect(precheck).toMatchObject({ mode: 'existing_zone', zoneId, verdict: 'confirm', requiredAcks: ['catchAll.replace', 'spf.merge', 'dmarc.create'] });
    expect(precheck.checks.find((item) => item.key === 'catchAll')!.current).toContain('owner@example.net');
    const partial = await errorOf(await create(admin.jwt, {
      mode: 'existing_zone', zoneId, fingerprint: precheck.fingerprint, accept: ['catchAll.replace'],
    }), 409);
    expect(partial.message).toBe('需要确认 3 项变更');
    expect(cf.writes()).toEqual([]);
    expect(await taskCount()).toBe(0);

    const created = await data<SystemDomainOnboarding>(await create(admin.jwt, {
      mode: 'existing_zone', zoneId, fingerprint: precheck.fingerprint, accept: precheck.requiredAcks,
    }), 201);
    const done = await task(created.id);
    expect(done).toMatchObject({ state: 'completed', accepted: ['catchAll.replace', 'spf.merge', 'dmarc.create'] });
    expect(done.changes.find((c) => c.kind === 'catchAll.put' && c.status === 'started')!.before).toContain('owner@example.net');
    expect(spfOf(cf, domain)).toEqual(['"v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all"']);
    expect((await auditActions(domain))[0]!.detail).toContain('随创建一并确认：替换 catch-all、合并 SPF、写入 DMARC p=reject');
  });

  it('确认后远端又变了：指纹过期 409，带新的预检，不写入；阻断项 409，不建任务', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    const blocked = f.domain('wrangler');
    cf = fakeCloudflare({ zones: [
      { name: domain, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }] } },
      { name: blocked, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }], source: 'wrangler' } },
    ] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('ex-admin');
    const precheck = await precheckOf(admin.jwt, zoneId);
    expect(precheck.requiredAcks).toEqual(['catchAll.replace']);

    cf.zoneByName(domain)!.catchAll = { enabled: true, actions: [{ type: 'forward', value: ['new@example.net'] }], source: 'api' };
    const stale = await errorOf(await create(admin.jwt, {
      mode: 'existing_zone', zoneId, fingerprint: precheck.fingerprint, accept: precheck.requiredAcks,
    }), 409);
    expect(stale.message).toBe('Cloudflare 上的配置已变化，请重新核对后确认');
    expect(stale.details!.precheck!.fingerprint).not.toBe(precheck.fingerprint);
    expect(stale.details!.precheck!.checks.find((item) => item.key === 'catchAll')!.current).toContain('new@example.net');

    const wrangler = await errorOf(await create(admin.jwt, { mode: 'existing_zone', zoneId: cf.zoneByName(blocked)!.id }), 409);
    expect(wrangler.details!.precheck!.verdict).toBe('blocked');
    expect(wrangler.message).toBe(wrangler.details!.precheck!.checks.find((item) => item.severity === 'blocker')!.title);
    expect(cf.writes()).toEqual([]);
    expect(await taskCount()).toBe(0);
  });

  it('预检读取失败：该项 unknown 并阻断，不写入；读到 429 时设置全局退避', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('ex-admin');

    cf.fail({ method: 'GET', path: /\/email\/routing\/rules\/catch_all$/, status: 500, times: 2 });
    const precheck = await precheckOf(admin.jwt, zoneId);
    expect(precheck.verdict).toBe('blocked');
    expect(precheck.checks.find((item) => item.key === 'catchAll')).toMatchObject({ state: 'unknown', severity: 'blocker' });
    await errorOf(await create(admin.jwt, { mode: 'existing_zone', zoneId }), 409);
    expect(cf.writes()).toEqual([]);

    cf.fail({ method: 'GET', path: /\/email\/routing$/, status: 429, retryAfter: 900 });
    const throttled = await precheckOf(admin.jwt, zoneId);
    expect(throttled.checks.find((item) => item.key === 'routing')).toMatchObject({ state: 'unknown', severity: 'blocker' });
    const backoff = await env.db.prepare(`SELECT json_extract(value, '$.until') AS until FROM settings WHERE key = 'cf_backoff'`).first<{ until: number }>();
    expect(backoff!.until).toBeGreaterThan(Date.now() + 800_000);
    // 退避期内：接口 429，不再调用 Cloudflare
    const calls = cf.calls.length;
    expect((await errorOf(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${zoneId}`, admin.jwt), 429)).message)
      .toBe('Cloudflare 接口繁忙，请稍后再试');
    expect(cf.calls).toHaveLength(calls);
  });

  it('等待生效的已有 zone：先等待 NS；激活后有需确认项转为待确认，确认的指纹过期 409、accept 不全 400、确认后完成', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain, status: 'pending', catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }] } }] });
    const zone = cf.zoneByName(domain)!;
    const admin = await actor('ex-admin');

    const created = await data<SystemDomainOnboarding>(await create(admin.jwt, { mode: 'existing_zone', zoneId: zone.id }), 201);
    expect(created).toMatchObject({ state: 'awaiting_ns', zoneStatus: 'pending', precheck: { verdict: 'pending' }, nameServers: zone.nameServers });
    expect(cf.writes()).toEqual([]);

    zone.status = 'active';
    // 创建时刚核对过：15 秒内的检测直接返回当前视图
    expect((await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt))).state).toBe('awaiting_ns');
    await makeDue(created.id);
    const checked = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt));
    expect(checked).toMatchObject({ state: 'needs_confirmation', nextCheckAt: null, precheck: { requiredAcks: ['catchAll.replace'] } });
    expect(checked.activatedAt).not.toBeNull();
    expect(cf.writes()).toEqual([]);
    // 15 秒内再检测：直接返回当前视图，不调用 Cloudflare
    const calls = cf.calls.length;
    expect((await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt))).state)
      .toBe('needs_confirmation');
    expect(cf.calls).toHaveLength(calls);

    const confirm = (body: unknown) => call('POST', `${BASE}/onboardings/${created.id}/confirm`, admin.jwt, body);
    const stale = await errorOf(await confirm({ fingerprint: 'stale', accept: ['catchAll.replace'] }), 409);
    expect(stale.message).toBe('Cloudflare 上的配置已变化，请重新核对后确认');
    expect(stale.details!.precheck!.fingerprint).toBe(checked.precheck!.fingerprint);
    await errorOf(await confirm({ fingerprint: checked.precheck!.fingerprint, accept: [] }), 400);
    expect(cf.writes()).toEqual([]);

    const confirmed = await data<SystemDomainOnboarding>(await confirm({ fingerprint: checked.precheck!.fingerprint, accept: ['catchAll.replace'] }));
    expect(confirmed.accepted).toEqual(['catchAll.replace']);
    expect((await task(created.id)).state).toBe('completed');
    expect((await systemList()).domains.map((entry) => entry.domain)).toContain(domain);
    expect((await auditActions(domain)).map((entry) => entry.action)).toEqual(['system_domain.create', 'system_domain.confirm', 'system_domain.complete']);
    await errorOf(await confirm({ fingerprint: checked.precheck!.fingerprint, accept: ['catchAll.replace'] }), 409);
  });
});

describe('凭据、额度与鉴权', () => {
  it('Worker 没有凭据：zone 列表 configured=false，预检与接入 403；zone 不在账户或 Token 看不到时 404', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare({ zones: [
      { name: f.domain('else'), account: 'acct-other' },
      { name: f.domain('hidden'), visible: false },
    ] });
    const admin = await actor('ex-admin');
    const view = await data<SystemDomainZonesView>(await call('GET', `${BASE}/zones`, admin.jwt, undefined, env));
    expect(view).toMatchObject({ configured: false, zones: [], others: [] });
    await errorOf(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${f.domain()}`, admin.jwt, undefined, env), 403);
    await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, { mode: 'new_zone', domain: f.domain() }, env), 403);

    for (const name of ['else', 'hidden']) {
      const error = await errorOf(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${cf.zoneByName(f.domain(name))!.id}`, admin.jwt), 404);
      expect(error.message).toContain('其他账户');
      expect(error.message).toContain('Token 无权访问');
    }
    await errorOf(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${fakeZoneId()}`, admin.jwt), 404);
    await errorOf(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=not-a-zone`, admin.jwt), 400);
    await errorOf(await call('GET', `${BASE}/onboardings/987654`, admin.jwt), 404);
    expect(cf.writes()).toEqual([]);
  });

  it('调用额度用完时 429 且不调用 Cloudflare，定时任务跳过本轮', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain, status: 'pending' }] });
    const admin = await actor('ex-admin');
    const created = await data<SystemDomainOnboarding>(await create(admin.jwt, { mode: 'existing_zone', zoneId: cf.zoneByName(domain)!.id }), 201);
    await makeDue(created.id);

    await bumpCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow(), MAX_SYSTEM_DOMAIN_CF_CALLS);
    const calls = cf.calls.length;
    for (const path of [`/zones?refresh=1`, `/precheck?mode=new_zone&domain=${f.domain('x')}`]) {
      expect((await errorOf(await call('GET', `${BASE}${path}`, admin.jwt), 429)).message).toBe('Cloudflare 接口繁忙，请稍后再试');
    }
    await errorOf(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt), 429);
    expect(await syncDueOnboarding(runtime)).toBe(0);
    expect(cf.calls).toHaveLength(calls);
    expect((await task(created.id)).state).toBe('awaiting_ns');
  });

  it('9 个接口都只给管理员 JWT：未登录 401、普通用户 403、API Key 401', async () => {
    await resetSystemDomains();
    cf = fakeCloudflare();
    const user = await actor('ex-user', 'user');
    const admin = await actor('ex-admin');
    const key = await createApiKey(env, admin.id, { name: 'k', scopes: ['mailbox.read'], rateLimit: 60, allowedIps: [] });
    const endpoints: [string, string, unknown?][] = [
      ['GET', '/zones'], ['GET', '/precheck?mode=new_zone&domain=a.test'], ['POST', '/onboardings', { mode: 'new_zone', domain: 'a.test' }],
      ['GET', '/onboardings'], ['GET', '/onboardings/1'], ['POST', '/onboardings/1/check'],
      ['POST', '/onboardings/1/confirm', { fingerprint: 'x', accept: [] }], ['POST', '/onboardings/1/cancel'],
      ['PUT', '/hidden-zones', { domain: 'a.test', hidden: true, expectedRevision: 0 }],
    ];
    for (const [method, path, body] of endpoints) {
      await errorOf(await call(method, `${BASE}${path}`, null, body), 401);
      await errorOf(await call(method, `${BASE}${path}`, user.jwt, body), 403);
      await errorOf(await call(method, `${BASE}${path}`, key.key, body), 401);
    }
    expect(cf.calls).toEqual([]);
  });
});
