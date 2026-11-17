import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemDomainHiddenZones, SystemDomainZone, SystemDomainZonesView } from '@hpc-mail/shared';
import { updateSettings } from '../src/services/setting.js';
import { SYSTEM_DOMAIN_CF_WINDOW_MINUTES } from '../src/services/zone-catalog.js';
import { FAKE_WORKER, fakeCloudflare, type FakeCloudflare } from './support/fake-cloudflare.js';
import { actor, auditActions, call, data, errorOf, insertTask, resetSystemDomains } from './support/system-domains.js';

const BASE = '/admin/system-domains';
let cf: FakeCloudflare | null = null;

afterEach(() => {
  // 列表与就绪摘要只读
  if (cf) expect(cf.writes()).toEqual([]);
  cf = null;
  vi.unstubAllGlobals();
});

const zones = async (token: string, query = '') => data<SystemDomainZonesView>(await call('GET', `${BASE}/zones${query}`, token));
const byName = (list: SystemDomainZone[], name: string) => list.find((zone) => zone.name === name)!;
const checked = (view: SystemDomainZonesView) => view.zones.filter((zone) => zone.readiness?.verdict !== 'unchecked').length;
const listCalls = (fake: FakeCloudflare) => fake.requests.filter((r) => r.method === 'GET' && r.path === '/zones' && !r.query.get('name'));

describe('zone 分类', () => {
  it('system > hosted（zone id 不一致为 inconsistent，标注管理员名下）> onboarding > available；隐藏的单独列出；带就绪摘要', async () => {
    const f = await resetSystemDomains();
    const name = (label: string) => f.domain(label);
    await updateSettings(env, { domains: { list: [{ domain: name('sys'), public: false, perUserLimit: 0 }] } });
    cf = fakeCloudflare({
      zones: [
        { name: name('sys') },
        { name: name('hosted') },
        { name: name('adminhosted') },
        { name: name('incons') },
        { name: name('onboarding'), status: 'pending' },
        { name: name('ready') },
        { name: name('pending'), status: 'pending' },
        { name: name('confirm'), catchAll: { enabled: true, actions: [{ type: 'forward', value: ['me@example.net'] }] } },
        { name: name('blocked'), catchAll: { enabled: true, actions: [{ type: 'worker', value: ['other'] }], source: 'wrangler' } },
        { name: name('hidden') },
        { name: name('elsewhere'), account: 'acct-other' },
        { name: name('invisible'), visible: false },
      ],
      registrars: { [name('ready')]: 'Cloudflare, Inc.' },
    });
    const admin = await actor('zc-admin');
    const user = await actor('zc-user', 'user');
    const hosted = (domain: string, userId: number, zoneId: string) => env.db
      .prepare("INSERT INTO hosted_domains (domain, user_id, status, zone_id) VALUES (?, ?, 'active', ?)").bind(domain, userId, zoneId).run();
    await hosted(name('hosted'), user.id, cf.zoneByName(name('hosted'))!.id);
    await hosted(name('adminhosted'), admin.id, cf.zoneByName(name('adminhosted'))!.id);
    await hosted(name('incons'), user.id, 'f'.repeat(32));
    const onboarding = await insertTask({
      domain: name('onboarding'), createdBy: admin.id, state: 'awaiting_ns', zoneId: cf.zoneByName(name('onboarding'))!.id, nextCheckAt: null,
    });
    const unlisted = await insertTask({ domain: name('new'), createdBy: admin.id, state: 'creating_zone', mode: 'new_zone', origin: 'unknown', nextCheckAt: null });
    const hidden = await data<SystemDomainHiddenZones>(await call('PUT', `${BASE}/hidden-zones`, admin.jwt, { domain: name('hidden'), hidden: true, expectedRevision: 0 }));
    expect(hidden).toEqual({ hiddenZones: [name('hidden')], revision: 1 });

    const view = await zones(admin.jwt);
    expect(view).toMatchObject({ configured: true, complete: true, hiddenRevision: 1 });
    expect(view.zones.map((zone) => [zone.name, zone.category])).toEqual([
      [name('blocked'), 'available'], [name('confirm'), 'available'], [name('onboarding'), 'onboarding'],
      [name('pending'), 'available'], [name('ready'), 'available'],
    ]);
    expect(byName(view.zones, name('ready')).readiness).toMatchObject({
      verdict: 'ready', confirmCount: 0, reasons: [], registrar: { name: 'Cloudflare, Inc.', cloudflare: true },
    });
    expect(byName(view.zones, name('pending')).readiness).toMatchObject({ verdict: 'pending', reasons: ['等待 Cloudflare 激活（NS 尚未生效）'] });
    expect(byName(view.zones, name('confirm')).readiness).toMatchObject({ verdict: 'confirm', confirmCount: 1 });
    const blocked = byName(view.zones, name('blocked')).readiness!;
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.reasons.length).toBeGreaterThan(0);
    expect(byName(view.zones, name('onboarding'))).toMatchObject({ readiness: null, onboarding: { id: onboarding, state: 'awaiting_ns' } });

    expect(view.others.map((zone) => [zone.name, zone.category, zone.owner?.isAdmin ?? null])).toEqual([
      [name('adminhosted'), 'hosted', true], [name('hosted'), 'hosted', false], [name('incons'), 'inconsistent', false], [name('sys'), 'system', null],
    ]);
    expect(byName(view.others, name('hosted')).owner).toEqual({ userId: user.id, username: user.username, isAdmin: false });
    expect(view.counts).toEqual({ available: 5, onboarding: 1, system: 1, hosted: 2, inconsistent: 1, hostedByAdmin: 1, hidden: 1 });
    expect(view.unlistedTasks.map((item) => [item.id, item.state])).toEqual([[unlisted, 'creating_zone']]);
    // 只列本账户的 zone
    expect(listCalls(cf).every((r) => r.query.get('account.id') === 'acct-test')).toBe(true);

    const onlyHidden = await zones(admin.jwt, '?hidden=1');
    expect(onlyHidden.zones.map((zone) => [zone.name, zone.hidden])).toEqual([[name('hidden'), true]]);
    expect(onlyHidden.others).toHaveLength(4);
  });

  it('列表缓存 60 秒（refresh=1 跳过）；就绪摘要每次最多预检 10 个、按 zone 缓存', async () => {
    const f = await resetSystemDomains();
    // 未激活的 zone 预检不调用 Cloudflare，只受每次 10 个的上限约束
    cf = fakeCloudflare({ zones: Array.from({ length: 30 }, (_, i) => ({ name: f.domain(`z${String(i).padStart(2, '0')}`), status: 'pending' as const })) });
    const admin = await actor('zc-admin');
    const first = await zones(admin.jwt);
    expect(first.counts.available).toBe(30);
    expect(listCalls(cf)).toHaveLength(1);
    expect(checked(first)).toBe(10);
    expect(first.zones.slice(0, 10).every((zone) => zone.readiness?.verdict === 'pending')).toBe(true);
    expect(first.zones[10]!.readiness).toEqual({ verdict: 'unchecked', confirmCount: 0, reasons: [], registrar: null, checkedAt: null });
    const second = await zones(admin.jwt);
    expect(listCalls(cf)).toHaveLength(1);
    expect(checked(second)).toBe(20);
    await zones(admin.jwt, '?refresh=1');
    expect(listCalls(cf)).toHaveLength(2);
  });

  it('就绪摘要只用额度的前 100 次，其余为 unchecked 而不报错；留给显式操作的额度仍可用', async () => {
    // 额度按 5 分钟窗口计：离窗口边界太近时等到下一个窗口，用例内的额度不被清零
    const windowMs = SYSTEM_DOMAIN_CF_WINDOW_MINUTES * 60_000;
    const toEdge = windowMs - (Date.now() % windowMs);
    if (toEdge < 3000) await new Promise((resolve) => setTimeout(resolve, toEdge + 50));
    const f = await resetSystemDomains();
    cf = fakeCloudflare({ zones: Array.from({ length: 12 }, (_, i) => ({ name: f.domain(`a${String(i).padStart(2, '0')}`) })) });
    const admin = await actor('zc-admin');
    // 列表 1 页 + 每个 zone 预占 10 次：第 10 个会超过 100
    const view = await zones(admin.jwt);
    expect(checked(view)).toBe(9);
    expect(view.zones.slice(0, 9).every((zone) => zone.readiness?.verdict === 'ready')).toBe(true);
    const precheck = await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${cf.zoneByName(f.domain('a11'))!.id}`, admin.jwt);
    expect(precheck.status).toBe(200);
  });

  it('120 个 zone 分 3 页拉全', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare({ zones: Array.from({ length: 120 }, (_, i) => ({ name: f.domain(`p${String(i).padStart(3, '0')}`), status: 'pending' as const })) });
    const admin = await actor('zc-admin');
    const view = await zones(admin.jwt);
    expect(view.counts.available).toBe(120);
    expect(view.complete).toBe(true);
    expect(listCalls(cf)).toHaveLength(3);
  });

  it('读取 Cloudflare 列表失败：500；429 时同样 429 并设置全局退避', async () => {
    await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('zc-admin');
    cf.fail({ method: 'GET', path: /^\/zones$/, status: 502 });
    expect((await errorOf(await call('GET', `${BASE}/zones`, admin.jwt), 500)).message).toContain('读取 Cloudflare 域名列表失败');
    cf.fail({ method: 'GET', path: /^\/zones$/, status: 429, retryAfter: 30 });
    expect((await errorOf(await call('GET', `${BASE}/zones?refresh=1`, admin.jwt), 429)).message).toBe('Cloudflare 接口繁忙，请稍后再试');
    const backoff = await env.db.prepare(`SELECT json_extract(value, '$.until') AS until FROM settings WHERE key = 'cf_backoff'`).first<{ until: number }>();
    expect(backoff!.until).toBeGreaterThan(Date.now() + 250_000);
  });
});

describe('隐藏列表', () => {
  it('按域名隐藏与恢复（revision CAS，已是目标状态不写入），审计 hide / unhide；最多 500 个', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('zc-admin');
    const domain = f.domain();
    const put = (body: unknown) => call('PUT', `${BASE}/hidden-zones`, admin.jwt, body);
    expect(await data<SystemDomainHiddenZones>(await put({ domain, hidden: true, expectedRevision: 0 }))).toEqual({ hiddenZones: [domain], revision: 1 });
    expect((await errorOf(await put({ domain, hidden: false, expectedRevision: 0 }), 409)).message).toBe('隐藏列表已被其他请求修改，请刷新后重试');
    expect(await data<SystemDomainHiddenZones>(await put({ domain, hidden: true, expectedRevision: 1 }))).toEqual({ hiddenZones: [domain], revision: 1 });
    expect(await data<SystemDomainHiddenZones>(await put({ domain, hidden: false, expectedRevision: 1 }))).toEqual({ hiddenZones: [], revision: 2 });
    expect((await auditActions(domain)).map((entry) => [entry.action, entry.actorName])).toEqual([
      ['system_domain.hide', admin.username], ['system_domain.unhide', admin.username],
    ]);

    await env.db.prepare(`UPDATE settings SET value = ? WHERE key = 'system_domains'`)
      .bind(JSON.stringify({ hiddenZones: Array.from({ length: 500 }, (_, i) => `h${i}.test`), revision: 9 })).run();
    expect((await errorOf(await put({ domain, hidden: true, expectedRevision: 9 }), 400)).message).toBe('最多隐藏 500 个域名');
  });
});

describe('预检的 Worker 名称', () => {
  it('catch-all 已指向本站 Worker 的 zone 不需要改写 catch-all', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain, catchAll: { enabled: true, actions: [{ type: 'worker', value: [FAKE_WORKER] }] } }] });
    const admin = await actor('zc-admin');
    const view = await zones(admin.jwt);
    expect(byName(view.zones, domain).readiness!.verdict).toBe('ready');
  });
});
