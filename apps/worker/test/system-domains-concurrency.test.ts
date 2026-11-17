import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemDomainOnboarding, SystemDomainPrecheck } from '@hpc-mail/shared';
import { syncDueOnboarding } from '../src/services/system-domain.js';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';
import { fakeCloudflare, type FakeCloudflare } from './support/fake-cloudflare.js';
import {
  actor, app, auditActions, beforeStatement, call, data, errorOf, insertTask, onboardExisting, onboardNewZone, resetSystemDomains, runtime,
  systemList, task,
} from './support/system-domains.js';

const BASE = '/admin/system-domains';
/** domains 的 CAS（domainsCasSql：手动保存与完成写入共用） */
const FINALIZE_CAS = /INSERT INTO settings \(key, value\)\s+SELECT 'domains'/;
let cf: FakeCloudflare | null = null;

afterEach(() => {
  if (cf) expect(cf.zoneDeletes()).toEqual([]);
  cf = null;
  vi.unstubAllGlobals();
});

const zoneCreates = (fake: FakeCloudflare) => fake.calls.filter((c) => c === 'POST /zones');
const writeKinds = (fake: FakeCloudflare, zoneId: string) => fake.writesTo(zoneId).map((c) => c.replace(zoneId, 'Z'));
const addToSystemList = async (domain: string) => {
  const current = await getSettingsFresh(env);
  await updateSettings(env, {
    domains: { list: [...current.domains.list, { domain, public: false, perUserLimit: 0 }] },
    expectedDomainsRevision: current.domains.revision ?? 0,
  });
};

describe('三方同名互斥', () => {
  it('托管占位与系统接入交错：各自的守卫写在占位语句里，后执行的一方 409，不建 zone', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('cc-admin');
    const owner = await actor('cc-owner', 'user');

    // 托管占位之前，同名接入任务先占位
    const first = f.domain('first');
    const racingHosted = beforeStatement(runtime, /INSERT INTO hosted_domains/, async () => {
      await insertTask({ domain: first, createdBy: admin.id, state: 'creating_zone', mode: 'new_zone', origin: 'unknown' });
    });
    const hosted = await errorOf(await call('POST', '/hosted-domains', owner.jwt, { domain: first }, racingHosted), 409);
    expect(hosted.message).toBe('该域名正在作为本站的系统域名接入');

    // 接入占位之前，同名托管先占位
    const second = f.domain('second');
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${second}`, admin.jwt));
    const racingTask = beforeStatement(runtime, /INSERT INTO system_domain_onboarding/, async () => {
      await env.db.prepare("INSERT INTO hosted_domains (domain, user_id, status) VALUES (?, ?, 'pending')").bind(second, owner.id).run();
    });
    const system = await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt,
      { mode: 'new_zone', domain: second, fingerprint: precheck.fingerprint, accept: ['ns.change'] }, racingTask), 409);
    expect(system.message).toBe('已被用户托管');
    expect(system.details!.precheck!.checks.find((item) => item.key === 'occupancy')!.severity).toBe('blocker');
    expect(zoneCreates(cf)).toEqual([]);
    expect((await env.db.prepare('SELECT COUNT(*) AS n FROM system_domain_onboarding WHERE domain = ?').bind(second).first<{ n: number }>())!.n).toBe(0);
  });

  it('系统域名列表 CAS 与接入任务互斥：进行中的域名不能手动加入列表（含交错），已在列表的域名不能占位', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('cc-admin');
    const busy = f.domain('busy');
    const id = await insertTask({ domain: busy, createdBy: admin.id, state: 'needs_confirmation', zoneId: 'a'.repeat(32) });
    const before = await systemList();
    const put = await errorOf(await call('PUT', '/admin/settings', admin.jwt, {
      domains: { list: [{ domain: busy, public: false, perUserLimit: 0 }] }, expectedDomainsRevision: before.revision,
    }), 409);
    expect(put.message).toBe(`${busy} 正在自动接入（任务 #${id}），请在接入完成或取消后再修改`);

    // CAS 执行前插入接入任务：守卫在同一条语句里，列表不变
    const racing = f.domain('racing');
    const racingSettings = beforeStatement(env, FINALIZE_CAS, async () => {
      await insertTask({ domain: racing, createdBy: admin.id, state: 'creating_zone', mode: 'new_zone', origin: 'unknown' });
    });
    await expect(updateSettings(racingSettings, {
      domains: { list: [{ domain: racing, public: false, perUserLimit: 0 }] }, expectedDomainsRevision: before.revision,
    })).rejects.toThrow('正在自动接入');
    expect(await systemList()).toEqual(before);

    // 接入占位前，管理员把同名域名加进了列表
    const listed = f.domain('listed');
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${listed}`, admin.jwt));
    const racingTask = beforeStatement(runtime, /INSERT INTO system_domain_onboarding/, () => addToSystemList(listed));
    const error = await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt,
      { mode: 'new_zone', domain: listed, fingerprint: precheck.fingerprint, accept: ['ns.change'] }, racingTask), 409);
    expect(error.message).toBe('已是系统域名');
    expect(zoneCreates(cf)).toEqual([]);
  });

  it('同名并发发起：恰好一个成功，Cloudflare 只建一次 zone；同一请求重放返回 200 与原任务，换方式 409', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('cc-admin');
    const domain = f.domain();
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${domain}`, admin.jwt));
    const body = { mode: 'new_zone', domain, fingerprint: precheck.fingerprint, accept: ['ns.change'] };
    const responses = await Promise.all([1, 2, 3].map(() => call('POST', `${BASE}/onboardings`, admin.jwt, body)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.every((status) => status === 201 || status === 200 || status === 409)).toBe(true);
    expect(zoneCreates(cf)).toHaveLength(1);

    const replay = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt, body), 200);
    expect(replay.domain).toBe(domain);
    const other = await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt, { mode: 'existing_zone', zoneId: replay.zoneId }), 409);
    expect(other.message).toBe(`该域名正在以其他方式接入（任务 #${replay.id}），请先取消`);
    expect(zoneCreates(cf)).toHaveLength(1);
  });

  it('系统域名与进行中的任务合计 64 个封顶', async () => {
    const f = await resetSystemDomains({ system: Array.from({ length: 63 }, (_, i) => `cap${i}.test`) });
    cf = fakeCloudflare();
    const admin = await actor('cc-admin');
    await insertTask({ domain: f.domain('pending'), createdBy: admin.id, state: 'awaiting_ns', zoneId: 'b'.repeat(32), nextCheckAt: null });
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=new_zone&domain=${f.domain()}`, admin.jwt));
    expect(precheck.checks.find((item) => item.key === 'capacity')).toMatchObject({ severity: 'blocker', title: '系统域名已达 64 个上限（含正在接入的）' });
    expect((await errorOf(await call('POST', `${BASE}/onboardings`, admin.jwt,
      { mode: 'new_zone', domain: f.domain(), fingerprint: precheck.fingerprint, accept: ['ns.change'] }), 409)).message)
      .toBe('系统域名已达 64 个上限（含正在接入的）');
    expect(zoneCreates(cf)).toEqual([]);
  });
});

describe('完成写入与 revision', () => {
  it('CAS 冲突一次：重读后重试，保留其他管理员的修改，revision 连续', async () => {
    const f = await resetSystemDomains({ system: ['keep.test'] });
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const admin = await actor('cc-admin');
    const start = await systemList();
    const racing = beforeStatement(runtime, FINALIZE_CAS, () => addToSystemList(f.domain('manual')));
    const created = await data<SystemDomainOnboarding>(await onboardExisting(admin, cf.zoneByName(domain)!.id, racing), 201);
    expect((await task(created.id)).state).toBe('completed');
    const after = await systemList();
    expect(after.domains.map((entry) => entry.domain)).toEqual(['keep.test', f.domain('manual'), domain]);
    expect(after.revision).toBe(start.revision + 2);
  });

  it('连续冲突超过 3 次：停在 finalizing（settings_conflict）且没有部分写入，下一轮定时任务完成', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const admin = await actor('cc-admin');
    let n = 0;
    const racing = beforeStatement(runtime, FINALIZE_CAS, () => addToSystemList(f.domain(`m${++n}`)), 3);
    const created = await data<SystemDomainOnboarding>(await onboardExisting(admin, cf.zoneByName(domain)!.id, racing), 201);
    const stuck = await task(created.id);
    expect(stuck).toMatchObject({ state: 'finalizing', errorCode: 'settings_conflict' });
    expect((await systemList()).domains.map((entry) => entry.domain)).not.toContain(domain);
    expect((await auditActions(domain)).map((entry) => entry.action)).toEqual(['system_domain.create']);

    const writes = cf.writes().length;
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect((await task(created.id)).state).toBe('completed');
    expect((await systemList()).domains.map((entry) => entry.domain)).toEqual([f.domain('m1'), f.domain('m2'), f.domain('m3'), domain]);
    expect(cf.writes()).toHaveLength(writes);
  });

  it('冲突期间域名已出现在列表里：视为完成，不重复加入，不改管理员设的公开范围与上限', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const admin = await actor('cc-admin');
    const racing = beforeStatement(runtime, FINALIZE_CAS, async () => {
      // 绕过守卫直接写入（例如运维在控制台改了设置）
      const current = await getSettingsFresh(env);
      await env.db.prepare("UPDATE settings SET value = ? WHERE key = 'domains'").bind(JSON.stringify({
        list: [...current.domains.list, { domain, public: true, perUserLimit: 3 }], revision: (current.domains.revision ?? 0) + 1,
      })).run();
    });
    const created = await data<SystemDomainOnboarding>(await onboardExisting(admin, cf.zoneByName(domain)!.id, racing), 201);
    expect((await task(created.id)).state).toBe('completed');
    const entries = (await systemList()).domains.filter((entry) => entry.domain === domain);
    expect(entries).toEqual([{ domain, public: true, perUserLimit: 3 }]);
    // 完成时记下的 revision 是写入后的实际值
    const revision = (await systemList()).revision;
    expect((await env.db.prepare('SELECT settings_revision AS r FROM system_domain_onboarding WHERE id = ?').bind(created.id).first<{ r: number }>())!.r)
      .toBe(revision);
    expect((await auditActions(domain)).at(-1)!.detail).toContain(`revision ${revision}`);
  });

  it('取消与完成竞争：取消先写入则完成的 CAS 不生效、任务取消；完成先写入则取消 409', async () => {
    const f = await resetSystemDomains();
    const cancelled = f.domain('cancel');
    const finished = f.domain('finish');
    cf = fakeCloudflare({ zones: [{ name: cancelled }, { name: finished }] });
    const admin = await actor('cc-admin');
    const id = await insertTask({ domain: cancelled, createdBy: admin.id, state: 'finalizing', zoneId: cf.zoneByName(cancelled)!.id, zoneStatus: 'active' });
    let response: SystemDomainOnboarding | null = null;
    const racing = beforeStatement(runtime, FINALIZE_CAS, async () => {
      response = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${id}/cancel`, admin.jwt));
    });
    const before = await systemList();
    expect(await syncDueOnboarding(racing)).toBe(1);
    // 定时任务持有租约时，取消只置标记，由它在检查点处理
    expect(response!).toMatchObject({ state: 'finalizing', cancelRequested: true });
    expect(await task(id)).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(await systemList()).toEqual(before);

    const done = await data<SystemDomainOnboarding>(await onboardExisting(admin, cf.zoneByName(finished)!.id), 201);
    expect((await task(done.id)).state).toBe('completed');
    const late = await errorOf(await call('POST', `${BASE}/onboardings/${done.id}/cancel`, admin.jwt, { deleteCreatedZone: false }), 409);
    expect(late.message).toBe('接入已完成，如需停用请在系统域名列表中移除');
  });

  it('完成写入前租约被其他执行者接手：过期的处理器写不进列表，也不把任务置为完成', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const admin = await actor('cc-admin');
    const id = await insertTask({ domain, createdBy: admin.id, state: 'finalizing', zoneId: cf.zoneByName(domain)!.id, zoneStatus: 'active' });
    const racing = beforeStatement(runtime, FINALIZE_CAS, async () => {
      await env.db.prepare(`UPDATE system_domain_onboarding SET lease_token = 'taken-over', lease_until = ? WHERE id = ?`)
        .bind(Date.now() + 60_000, id).run();
    });
    const before = await systemList();
    await syncDueOnboarding(racing);
    expect(await systemList()).toEqual(before);
    expect(await task(id)).toMatchObject({ state: 'finalizing' });
    expect((await auditActions(domain)).map((entry) => entry.action)).toEqual([]);
  });
});

describe('租约', () => {
  it('定时任务处理中手动检测：直接返回当前视图，只有一套写入', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('cc-admin');
    const id = await insertTask({ domain, createdBy: admin.id, state: 'configuring', zoneId, zoneStatus: 'active' });
    let during: SystemDomainOnboarding | null = null;
    cf.onCall({ method: 'GET', path: /\/email\/routing\/rules\/catch_all$/ }, async () => {
      during = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${id}/check`, admin.jwt));
    });
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect(during!.state).toBe('configuring');
    expect((await task(id)).state).toBe('completed');
    expect(writeKinds(cf, zoneId)).toEqual([
      'PUT /zones/Z/email/routing/rules/catch_all', 'POST /zones/Z/email/routing/dns', 'POST /zones/Z/email/sending/subdomains',
    ]);
  });

  it('两次定时任务并发：租约保证只处理一次；租约未过期时跳过，过期后接手', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    const held = f.domain('held');
    cf = fakeCloudflare({ zones: [{ name: domain }, { name: held }] });
    const admin = await actor('cc-admin');
    const zoneId = cf.zoneByName(domain)!.id;
    const id = await insertTask({ domain, createdBy: admin.id, state: 'configuring', zoneId, zoneStatus: 'active' });
    const results = await Promise.all([syncDueOnboarding(runtime), syncDueOnboarding(runtime)]);
    expect(results[0]! + results[1]!).toBe(1);
    expect((await task(id)).state).toBe('completed');
    expect(writeKinds(cf, zoneId)).toHaveLength(3);

    const heldId = await insertTask({
      domain: held, createdBy: admin.id, state: 'configuring', zoneId: cf.zoneByName(held)!.id, zoneStatus: 'active',
      leaseToken: 'someone-else', leaseUntil: Date.now() + 60_000,
    });
    expect(await syncDueOnboarding(runtime)).toBe(0);
    expect((await task(heldId)).state).toBe('configuring');
    await env.db.prepare('UPDATE system_domain_onboarding SET lease_until = ? WHERE id = ?').bind(Date.now() - 1, heldId).run();
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect((await task(heldId)).state).toBe('completed');
  });

  it('两个标签页同时确认：只有一个生效，只有一套写入', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }] } }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('cc-admin');
    const id = await insertTask({ domain, createdBy: admin.id, state: 'needs_confirmation', zoneId, zoneStatus: 'active', nextCheckAt: null });
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${zoneId}`, admin.jwt));
    const body = { fingerprint: precheck.fingerprint, accept: precheck.requiredAcks };
    const responses = await Promise.all([1, 2].map(() => call('POST', `${BASE}/onboardings/${id}/confirm`, admin.jwt, body)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await task(id)).state).toBe('completed');
    expect(writeKinds(cf, zoneId).filter((c) => c.includes('catch_all'))).toHaveLength(1);
  });

  /**
   * 模拟后台处理被截断（waitUntil 超时、isolate 被回收）：第一次写 catch-all 的请求挂住，接口先返回；
   * 再把租约改成已过期（相当于过了 2 分钟），看定时任务能否接手。最后放开挂住的请求，旧处理器的租约已丢，不再写入。
   */
  async function truncatedBackground(path: string, body: unknown, check: (id: number) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cf!.onCall({ method: 'PUT', path: /\/catch_all$/ }, () => gate);
    const admin = await actor('cc-admin');
    const ctx = createExecutionContext();
    const response = await app.request(`/api${BASE}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, runtime, ctx);
    expect(response.status).toBeLessThan(300);
    const { id } = (await response.json() as { data: SystemDomainOnboarding }).data;
    expect((await task(id)).state).toBe('configuring');
    await env.db.prepare('UPDATE system_domain_onboarding SET lease_until = ?1 WHERE id = ?2').bind(Date.now() - 1, id).run();
    expect(await syncDueOnboarding(runtime)).toBe(1);
    await check(id);
    release();
    await waitOnExecutionContext(ctx);
    expect((await task(id)).state).toBe('completed');
  }

  it('A18 已激活 zone 一键接入的后台处理被截断：租约过期后定时任务接手并完成', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain('cut');
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const zoneId = cf.zoneByName(domain)!.id;
    await truncatedBackground('/onboardings', { mode: 'existing_zone', zoneId }, async (id) => {
      expect((await task(id)).state).toBe('completed');
      expect((await systemList()).domains.map((entry) => entry.domain)).toContain(domain);
    });
  });

  it('A18 确认后的后台处理被截断：租约过期后定时任务接手并完成', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain('cut2');
    cf = fakeCloudflare({ zones: [{ name: domain, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }] } }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const owner = await actor('cc-admin');
    const id = await insertTask({ domain, createdBy: owner.id, state: 'needs_confirmation', zoneId, zoneStatus: 'active', nextCheckAt: null });
    const precheck = await data<SystemDomainPrecheck>(await call('GET', `${BASE}/precheck?mode=existing_zone&zoneId=${zoneId}`, owner.jwt));
    await truncatedBackground(`/onboardings/${id}/confirm`, { fingerprint: precheck.fingerprint, accept: precheck.requiredAcks }, async () => {
      expect((await task(id)).state).toBe('completed');
    });
  });

  it('每轮最多处理 3 条；全局 429 退避期内跳过整轮', async () => {
    const f = await resetSystemDomains();
    const names = ['a', 'b', 'c', 'd'].map((name) => f.domain(name));
    cf = fakeCloudflare({ zones: names.map((name) => ({ name, status: 'pending' as const })) });
    const admin = await actor('cc-admin');
    for (const name of names) {
      await insertTask({ domain: name, createdBy: admin.id, state: 'awaiting_ns', zoneId: cf.zoneByName(name)!.id, zoneStatus: 'pending' });
    }
    await env.db.prepare(`INSERT INTO settings (key, value) VALUES ('cf_backoff', json_object('until', ?))`).bind(Date.now() + 60_000).run();
    expect(await syncDueOnboarding(runtime)).toBe(0);
    expect(cf.calls).toEqual([]);
    await env.db.prepare(`DELETE FROM settings WHERE key = 'cf_backoff'`).run();
    expect(await syncDueOnboarding(runtime)).toBe(3);
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect(await syncDueOnboarding(runtime)).toBe(0);
  });

  it('等待 NS 时手动检测与定时任务交错：手动检测拿不到租约，直接返回当前视图，不重复调用 Cloudflare', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('cc-admin');
    const created = await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain()), 201);
    await env.db.prepare('UPDATE system_domain_onboarding SET next_check_at = ?, checked_at = NULL WHERE id = ?').bind(Date.now() - 1, created.id).run();
    cf.onCall({ method: 'GET', path: new RegExp(`^/zones/${created.zoneId}$`) }, async () => {
      expect((await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings/${created.id}/check`, admin.jwt))).state).toBe('awaiting_ns');
    });
    expect(await syncDueOnboarding(runtime)).toBe(1);
    expect(cf.calls.filter((c) => c.endsWith('/activation_check'))).toEqual([]);
  });
});
