import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostedDomain, Mailbox, SystemDomainOnboarding } from '@hpc-mail/shared';
import { mailboxes, messages } from '../src/db/schema.js';
import { syncDueHostedDomains } from '../src/services/hosted-domain.js';
import { handleInbound } from '../src/services/inbound.js';
import { syncDueOnboarding } from '../src/services/system-domain.js';
// @ts-expect-error Vite 的 ?raw 导入（只用于源码结构断言）
import systemDomainSource from '../src/services/system-domain.ts?raw';
// @ts-expect-error Vite 的 ?raw 导入（只用于源码结构断言）
import zoneCatalogSource from '../src/services/zone-catalog.ts?raw';
import { fakeCloudflare, type FakeCloudflare } from './support/fake-cloudflare.js';
import {
  actor, auditActions, call, data, db, errorOf, insertTask, makeDue, onboardExisting, onboardNewZone, resetSystemDomains, runtime,
  systemList, task,
} from './support/system-domains.js';

const BASE = '/admin/system-domains';
let cf: FakeCloudflare | null = null;
/** 本用例允许删除的 zone（取消本任务创建、从未激活的 zone） */
let allowedDeletes: string[] = [];

afterEach(() => {
  if (cf) expect(cf.zoneDeletes()).toEqual(allowedDeletes.map((id) => `DELETE /zones/${id}`));
  cf = null;
  allowedDeletes = [];
  vi.unstubAllGlobals();
});

const cancel = (token: string, id: number, body?: unknown) => call('POST', `${BASE}/onboardings/${id}/cancel`, token, body);

async function receive(address: string, label: string) {
  const raw = `From: sender@example.net\r\nTo: ${address}\r\nMessage-ID: <${label}@example.net>\r\nSubject: hi\r\nContent-Type: text/plain\r\n\r\nhello`;
  const ctx = createExecutionContext();
  const rejected: string[] = [];
  await handleInbound({ to: address, from: 'sender@example.net', raw: new Response(raw).body!, headers: new Headers(),
    forward: async () => {}, setReject: (reason: string) => { rejected.push(reason); },
  } as unknown as ForwardableEmailMessage, runtime, ctx);
  await waitOnExecutionContext(ctx);
  const stored = await db.select().from(messages).where(eq(messages.messageId, `<${label}@example.net>`)).get();
  return { rejected, stored };
}

describe('取消', () => {
  it('关联已有 zone 的任务：各阶段取消都不删 zone、不回滚配置；勾选删除 zone 返回 400；取消后同名可以重新接入', async () => {
    const f = await resetSystemDomains();
    const waiting = f.domain('waiting');
    const confirm = f.domain('confirm');
    cf = fakeCloudflare({ zones: [
      { name: waiting, status: 'pending' },
      { name: confirm, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['legacy-worker'] }] } },
    ] });
    const admin = await actor('lc-admin');
    const awaiting = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt,
      { mode: 'existing_zone', zoneId: cf.zoneByName(waiting)!.id }), 201);
    const pending = await insertTask({
      domain: confirm, createdBy: admin.id, state: 'needs_confirmation', zoneId: cf.zoneByName(confirm)!.id, zoneStatus: 'active', nextCheckAt: null,
    });

    const refused = await errorOf(await cancel(admin.jwt, awaiting.id, { deleteCreatedZone: true }), 400);
    expect(refused.message).toContain('只能删除本任务创建、从未激活的 zone');
    const calls = cf.calls.length;
    expect(await data<SystemDomainOnboarding>(await cancel(admin.jwt, awaiting.id))).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect(await data<SystemDomainOnboarding>(await cancel(admin.jwt, pending, {}))).toMatchObject({ state: 'cancelled' });
    // 不需要删 zone 的取消不访问 Cloudflare
    expect(cf.calls).toHaveLength(calls);
    expect(cf.zoneByName(waiting)).toBeDefined();
    expect((await auditActions(waiting)).map((entry) => entry.action)).toEqual(['system_domain.create', 'system_domain.cancel']);
    await errorOf(await cancel(admin.jwt, awaiting.id), 409);

    const again = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt,
      { mode: 'existing_zone', zoneId: cf.zoneByName(waiting)!.id }), 201);
    expect(again.id).not.toBe(awaiting.id);
  });

  it('配置途中取消：已写入的步骤保留并记在台账，后续步骤不再执行，不加入列表，之后定时任务也不再写入', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('lc-admin');
    const id = await insertTask({ domain, createdBy: admin.id, state: 'configuring', zoneId, zoneStatus: 'active' });
    cf.onCall({ method: 'PUT', path: /\/catch_all$/ }, async () => {
      expect((await data<SystemDomainOnboarding>(await cancel(admin.jwt, id))).cancelRequested).toBe(true);
    });
    const before = await systemList();
    expect(await syncDueOnboarding(runtime)).toBe(1);
    const cancelled = await task(id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.changes.map((c) => [c.kind, c.status])).toEqual([['catchAll.put', 'started'], ['catchAll.put', 'done']]);
    expect(cf.writes()).toEqual([`PUT /zones/${zoneId}/email/routing/rules/catch_all`]);
    expect(await systemList()).toEqual(before);
    await makeDue(id);
    expect(await syncDueOnboarding(runtime)).toBe(0);
    expect(cf.writes()).toHaveLength(1);
  });

  it('A17 删第三方 MX 到开启 Routing 之间取消：这一段做完才处理取消，域名不会没有 MX', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain('gap');
    cf = fakeCloudflare({ zones: [{ name: domain, records: [
      { type: 'MX', name: domain, content: 'mx1.other.example', priority: 10 },
      { type: 'MX', name: domain, content: 'mx2.other.example', priority: 20 },
    ] }] });
    const zone = cf.zoneByName(domain)!;
    const admin = await actor('lc-admin');
    // 第一条 MX 删除请求发出时管理员点了取消（执行者持有租约，取消只写标记）
    cf.onCall({ method: 'DELETE', path: /\/dns_records\// }, async () => {
      const row = await env.db.prepare('SELECT id FROM system_domain_onboarding WHERE domain = ?').bind(domain).first<{ id: number }>();
      expect((await data<SystemDomainOnboarding>(await cancel(admin.jwt, row!.id))).cancelRequested).toBe(true);
    });
    const created = await data<SystemDomainOnboarding>(await onboardExisting(admin, zone.id), 201);
    const done = await task(created.id);
    expect(done).toMatchObject({ state: 'cancelled', errorCode: '' });
    expect(zone.routingEnabled).toBe(true);
    expect(cf.recordsOf(zone, domain, 'MX').map((r) => r.content).sort())
      .toEqual(['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net']);
    // 这一段之后的步骤照常因取消停止
    expect(cf.writes().some((w) => w.includes('/email/sending/'))).toBe(false);
    expect(await systemList()).toMatchObject({ domains: [] });
  });

  it('A17 删了 MX、Routing 没开成就取消：照常取消但保留「MX 已删除」告警', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain('gap2');
    cf = fakeCloudflare({ zones: [{ name: domain, records: [{ type: 'MX', name: domain, content: 'mx1.other.example', priority: 10 }] }] });
    const zone = cf.zoneByName(domain)!;
    cf.fail({ method: 'POST', path: /\/email\/routing\/dns$/, status: 400, code: 9999, times: 5 });
    const admin = await actor('lc-admin');
    const created = await data<SystemDomainOnboarding>(await onboardExisting(admin, zone.id), 201);
    expect(await task(created.id)).toMatchObject({ state: 'blocked', errorCode: 'mx_removed_routing_pending' });
    const cancelled = await data<SystemDomainOnboarding>(await cancel(admin.jwt, created.id));
    expect(cancelled).toMatchObject({ state: 'cancelled', errorCode: 'mx_removed_routing_pending' });
    expect(cancelled.lastError).toContain('该域名现在收不到信');
    expect(zone.routingEnabled).toBe(false);
  });

  it('本任务新建、从未激活的 zone：勾选删除时取消删除 zone 并审计，不勾选保留；取消时已激活则保留', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('lc-admin');
    const drop = await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('drop')), 201);
    const keep = await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('keep')), 201);
    const live = await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('live')), 201);
    expect(drop.canDeleteZone).toBe(true);

    allowedDeletes = [drop.zoneId!];
    const dropped = await data<SystemDomainOnboarding>(await cancel(admin.jwt, drop.id, { deleteCreatedZone: true }));
    expect(dropped).toMatchObject({ state: 'cancelled', zoneStatus: 'missing', canDeleteZone: false });
    expect(dropped.changes.filter((c) => c.kind === 'zone.delete').map((c) => c.status)).toEqual(['started', 'done']);
    expect(cf.zoneByName(f.domain('drop'))).toBeUndefined();
    expect((await auditActions(f.domain('drop'))).map((entry) => [entry.action, entry.actorName])).toEqual([
      ['system_domain.create', admin.username], ['system_domain.cancel', admin.username], ['system_domain.zone_delete', 'system'],
    ]);

    expect((await data<SystemDomainOnboarding>(await cancel(admin.jwt, keep.id))).state).toBe('cancelled');
    expect(cf.zoneByName(f.domain('keep'))).toBeDefined();

    // 取消时 zone 已在 Cloudflare 激活（任务还没来得及核对）：按规则保留
    cf.zoneByName(f.domain('live'))!.status = 'active';
    const kept = await data<SystemDomainOnboarding>(await cancel(admin.jwt, live.id, { deleteCreatedZone: true }));
    expect(kept).toMatchObject({ state: 'cancelled', lastError: '取消时 zone 已激活，按规则保留' });
    expect(cf.zoneByName(f.domain('live'))).toBeDefined();

    // 激活过的 zone 不能勾选删除
    const activated = await insertTask({
      domain: f.domain('activated'), createdBy: admin.id, state: 'blocked', mode: 'new_zone', origin: 'created',
      zoneId: cf.addZone({ name: f.domain('activated') }).id, zoneStatus: 'active', activatedAt: Date.now() - 1000, nextCheckAt: null,
    });
    await errorOf(await cancel(admin.jwt, activated, { deleteCreatedZone: true }), 400);
  });

  it('建 zone 途中取消：建好后转入取消，zone 已标为本任务创建，可以再勾选删除', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare();
    const admin = await actor('lc-admin');
    let id = 0;
    cf.onCall({ method: 'POST', path: /^\/zones$/ }, async () => {
      id = (await env.db.prepare('SELECT id FROM system_domain_onboarding WHERE domain = ?').bind(domain).first<{ id: number }>())!.id;
      // 建 zone 期间来源未确认：不能勾选删除；只置标记
      await errorOf(await cancel(admin.jwt, id, { deleteCreatedZone: true }), 400);
      expect((await data<SystemDomainOnboarding>(await cancel(admin.jwt, id))).state).toBe('creating_zone');
    });
    const created = await data<SystemDomainOnboarding>(await onboardNewZone(admin, domain), 201);
    expect(created).toMatchObject({ state: 'cancelling', zoneOrigin: 'created', canDeleteZone: true, cancelRequested: true });

    allowedDeletes = [created.zoneId!];
    expect((await data<SystemDomainOnboarding>(await cancel(admin.jwt, id, { deleteCreatedZone: true }))).state).toBe('cancelled');
    expect(cf.zoneByName(domain)).toBeUndefined();
  });
});

describe('移除、重新接入与收件', () => {
  it('完成前的来信按未认领入库；完成后认领可见历史；移除系统域名不碰 Cloudflare、保留地址与邮件；重新接入没有写入且继承历史', async () => {
    const f = await resetSystemDomains();
    const domain = f.domain();
    cf = fakeCloudflare({ zones: [{ name: domain, status: 'pending' }] });
    const zoneId = cf.zoneByName(domain)!.id;
    const admin = await actor('lc-admin');

    const created = await data<SystemDomainOnboarding>(await call('POST', `${BASE}/onboardings`, admin.jwt, { mode: 'existing_zone', zoneId }), 201);
    const early = await receive(`early@${domain}`, `${f.prefix}-early`);
    expect(early.rejected).toEqual([]);
    expect(early.stored).toMatchObject({ address: `early@${domain}`, domain });
    // 完成前不能认领（不在系统域名列表）
    expect((await errorOf(await call('POST', '/mailboxes', admin.jwt, { localPart: 'early', domain }), 400)).message).toBe('域名不在系统域名列表内');

    cf.zoneByName(domain)!.status = 'active';
    await makeDue(created.id);
    await syncDueOnboarding(runtime);
    expect((await task(created.id)).state).toBe('completed');
    const box = await data<Mailbox>(await call('POST', '/mailboxes', admin.jwt, { localPart: 'early', domain }), 201);
    expect(box.messageCount).toBe(1);

    // 移除：只改列表，不调用 Cloudflare，地址与邮件保留
    const calls = cf.calls.length;
    const current = await systemList();
    await data(await call('PUT', '/admin/settings', admin.jwt, {
      domains: { list: current.domains.filter((entry) => entry.domain !== domain) }, expectedDomainsRevision: current.revision,
    }));
    expect(cf.calls).toHaveLength(calls);
    expect(await db.select().from(mailboxes).where(eq(mailboxes.domain, domain)).all()).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.domain, domain)).all()).toHaveLength(1);
    // 移除后定时任务不会把它加回来，也不改 Cloudflare
    await syncDueOnboarding(runtime);
    expect((await systemList()).domains.map((entry) => entry.domain)).not.toContain(domain);
    expect(cf.calls).toHaveLength(calls);
    // 移除后仍收信（Cloudflare 路由没有停）
    expect((await receive(`early@${domain}`, `${f.prefix}-after`)).rejected).toEqual([]);

    // 重新接入：远端已全部就绪，没有写入；认领过的地址继续可见历史
    const writes = cf.writes().length;
    const again = await data<SystemDomainOnboarding>(await onboardExisting(admin, zoneId), 201);
    expect((await task(again.id)).state).toBe('completed');
    expect(cf.writes()).toHaveLength(writes);
    expect((await systemList()).domains.at(-1)).toEqual({ domain, public: false, perUserLimit: 0, random: true });
    const boxes = await data<Mailbox[]>(await call('GET', '/mailboxes', admin.jwt));
    expect(boxes.find((item) => item.address === `early@${domain}`)!.messageCount).toBe(2);
  });

  it('与托管域名交叉：托管同步不碰系统接入的 zone，系统接入不碰托管 zone', async () => {
    const f = await resetSystemDomains();
    cf = fakeCloudflare();
    const admin = await actor('lc-admin');
    const owner = await actor('lc-owner', 'user');
    const hosted = await data<HostedDomain>(await call('POST', '/hosted-domains', owner.jwt, { domain: f.domain('hosted') }), 201);
    const system = await data<SystemDomainOnboarding>(await onboardNewZone(admin, f.domain('system')), 201);
    const hostedZone = cf.zoneByName(f.domain('hosted'))!.id;
    const systemZone = system.zoneId!;
    cf.zoneByName(f.domain('hosted'))!.status = 'active';
    cf.zoneByName(f.domain('system'))!.status = 'active';

    const systemWrites = cf.writesTo(systemZone).length;
    await env.db.prepare('UPDATE hosted_domains SET checked_at = 0 WHERE id = ?').bind(hosted.id).run();
    await syncDueHostedDomains(runtime);
    expect(cf.writesTo(systemZone)).toHaveLength(systemWrites);
    expect(cf.writesTo(hostedZone).length).toBeGreaterThan(0);

    const hostedWrites = cf.writesTo(hostedZone).length;
    await makeDue(system.id);
    await syncDueOnboarding(runtime);
    expect((await task(system.id)).state).toBe('completed');
    expect(cf.writesTo(hostedZone)).toHaveLength(hostedWrites);
  });
});

describe('源码结构', () => {
  it('系统接入只有一处 deleteZone 调用（取消时删除本任务创建、未激活的 zone），不删除发信子域、DNS 记录或邮件', () => {
    expect(systemDomainSource.match(/\bdeleteZone\(/g)).toHaveLength(1);
    for (const source of [systemDomainSource as string, zoneCatalogSource as string]) {
      expect(source).not.toMatch(/deleteSendingSubdomain|deleteDnsRecord|purgeMatchingMessages|DELETE FROM (messages|mailboxes)/);
    }
    expect(zoneCatalogSource).not.toMatch(/\bdeleteZone\b/);
  });
});
