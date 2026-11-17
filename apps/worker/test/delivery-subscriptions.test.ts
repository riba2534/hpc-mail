import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { emailEventSubscriptions, hostedDomains, users } from '../src/db/schema.js';
import { syncDeliveryEventSubscriptions, subscribeHostedDomainEvents, SUBSCRIBED_EVENTS } from '../src/services/event-subscriptions.js';
import { syncHostedDomain } from '../src/services/hosted-domain.js';
import { runScheduled } from '../src/services/scheduled.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const ACCOUNT = 'acct-events';
const QUEUE = 'hpc-mail-email-events';
const db = createDb(env);
const runtime: Env = { ...env, cf_api_token: 'events-token', cf_account_id: ACCOUNT, worker_name: 'hpc-cloud-mail' };

interface FakeSubscription { id: string; name: string; source: { type: string; zone_id: string; domain: string }; events: string[]; destination: { type: string; queue_id: string } }

/** 假 Cloudflare：Queues 与事件订阅接口，按名称查 zone，以及托管域名核对用到的少数只读接口 */
function fakeCloudflare(opts: { queue?: boolean; zones?: Record<string, string>; createStatus?: number; subscriptions?: FakeSubscription[] } = {}) {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const subscriptions = [...(opts.subscriptions ?? [])];
  let sequence = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], result, ...extra });
  const fail = (status: number, code: number, message: string) => json({ success: false, errors: [{ code, message }], result: null }, status);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer events-token');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/client/v4', '');
    calls.push(`${method} ${path}`);
    if (path === `/accounts/${ACCOUNT}/queues`) {
      return ok(opts.queue === false || url.searchParams.get('name') !== QUEUE ? [] : [{ queue_id: 'queue-1', queue_name: QUEUE }]);
    }
    if (path === `/accounts/${ACCOUNT}/event_subscriptions/subscriptions` && method === 'GET') {
      expect(url.searchParams.get('queue_id')).toBe('queue-1');
      return ok(subscriptions, { result_info: { page: 1, total_pages: 1 } });
    }
    if (path === `/accounts/${ACCOUNT}/event_subscriptions/subscriptions` && method === 'POST') {
      if (opts.createStatus) return fail(opts.createStatus, 10000, 'Authentication error');
      const body = JSON.parse(String(init!.body)) as FakeSubscription & Record<string, unknown>;
      created.push(body);
      const subscription = { ...body, id: `sub-${++sequence}` };
      subscriptions.push(subscription);
      return ok(subscription);
    }
    if (path === '/zones' && method === 'GET') {
      const name = url.searchParams.get('name')!;
      const id = opts.zones?.[name];
      return ok(id ? [{ id, name, status: 'active' }] : [], { result_info: { total_count: id ? 1 : 0 } });
    }
    // 托管域名核对：zone 已激活、收件路由与 catch-all 就绪、发信 DNS 就绪
    if (path === '/zones/zone-hosted') return ok({ id: 'zone-hosted', name: 'hosted-events.test', status: 'active', name_servers: [] });
    if (path === '/zones/zone-hosted/email/routing') return ok({ enabled: true, status: 'ready' });
    if (path === '/zones/zone-hosted/email/routing/rules/catch_all') return ok({ enabled: true, actions: [{ type: 'worker', value: ['hpc-cloud-mail'] }] });
    if (path === '/zones/zone-hosted/email/sending/subdomains/tag-hosted/dns/status') return ok({ status: 'ready', errors: [] });
    return fail(400, 9999, `unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, created, subscriptions, fetchMock };
}

async function reset(domains: string[], enabled = true) {
  await db.delete(emailEventSubscriptions);
  await db.delete(hostedDomains);
  await updateSettings(env, {
    domains: { list: domains.map((domain) => ({ domain, public: true, perUserLimit: 0 })) },
    delivery_events: { enabled },
  });
}
const rows = () => db.select().from(emailEventSubscriptions).all();

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('投递回执订阅维护', () => {
  it('没有凭据或开关关闭时不调用 Cloudflare', async () => {
    await reset(['plain.test']);
    const cf = fakeCloudflare({ zones: { 'plain.test': 'zone-plain' } });
    expect(await syncDeliveryEventSubscriptions(env)).toBe(0);
    await reset(['plain.test'], false);
    expect(await syncDeliveryEventSubscriptions(runtime, { verify: true })).toBe(0);
    expect(cf.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('系统域名逐级找到所在 zone 后建立订阅；已订阅后常规轮次不再调用 Cloudflare', async () => {
    await reset(['send.events-zone.test']);
    const cf = fakeCloudflare({ zones: { 'events-zone.test': 'zone-1' } });
    expect(await syncDeliveryEventSubscriptions(runtime)).toBe(1);
    expect(cf.created).toEqual([{
      name: 'hpc-mail-send.events-zone.test', enabled: true,
      source: { type: 'email.sending', zone_id: 'zone-1', domain: 'send.events-zone.test' },
      destination: { type: 'queues.queue', queue_id: 'queue-1' },
      events: ['message.delivered', 'message.bounced', 'message.failed', 'message.rejected', 'message.complained'],
    }]);
    expect(SUBSCRIBED_EVENTS).not.toContain('message.deferred');
    expect(await rows()).toMatchObject([{ domain: 'send.events-zone.test', kind: 'system', zoneId: 'zone-1', subscriptionId: 'sub-1', status: 'active', lastError: '' }]);
    cf.calls.length = 0;
    expect(await syncDeliveryEventSubscriptions(runtime)).toBe(0);
    expect(cf.calls).toEqual([]);
  });

  it('已有同域名订阅（包括手动建立的）直接沿用，不重复创建', async () => {
    await reset(['manual.test']);
    const cf = fakeCloudflare({ subscriptions: [{ id: 'manual-1', name: 'by hand', events: [], destination: { type: 'queues.queue', queue_id: 'queue-1' },
      source: { type: 'email.sending', zone_id: 'zone-manual', domain: 'manual.test' } }] });
    expect(await syncDeliveryEventSubscriptions(runtime)).toBe(1);
    expect(cf.created).toEqual([]);
    expect(await rows()).toMatchObject([{ domain: 'manual.test', zoneId: 'zone-manual', subscriptionId: 'manual-1', status: 'active' }]);
  });

  it('缺权限时记录失败与权限提示，6 小时内不重试，之后再试', async () => {
    await reset(['denied.test']);
    const cf = fakeCloudflare({ zones: { 'denied.test': 'zone-d' }, createStatus: 403 });
    expect(await syncDeliveryEventSubscriptions(runtime)).toBe(0);
    const [row] = await rows();
    expect(row).toMatchObject({ domain: 'denied.test', status: 'error', subscriptionId: null });
    expect(row!.lastError).toContain('Queues:Edit');
    cf.calls.length = 0;
    await syncDeliveryEventSubscriptions(runtime);
    expect(cf.calls).toEqual([]);
    await env.db.prepare('UPDATE email_event_subscriptions SET checked_at = ?').bind(Date.now() - 7 * 3600_000).run();
    await syncDeliveryEventSubscriptions(runtime);
    expect(cf.calls).toContain(`POST /accounts/${ACCOUNT}/event_subscriptions/subscriptions`);
  });

  it('Queue 不存在时给出创建方法，不影响已生效的记录', async () => {
    await reset(['noqueue.test']);
    fakeCloudflare({ queue: false });
    await syncDeliveryEventSubscriptions(runtime);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'error' });
    expect(row!.lastError).toContain('wrangler queues create hpc-mail-email-events');
  });

  it('每日核对：Cloudflare 上被删除的订阅重建，已移除的域名删掉本地记录', async () => {
    await reset(['keep.test', 'gone.test']);
    const cf = fakeCloudflare({ zones: { 'keep.test': 'zone-k', 'gone.test': 'zone-g' } });
    await syncDeliveryEventSubscriptions(runtime);
    expect((await rows()).map((row) => row.domain).sort()).toEqual(['gone.test', 'keep.test']);
    await updateSettings(env, { domains: { list: [{ domain: 'keep.test', public: true, perUserLimit: 0 }] } });
    cf.subscriptions.splice(0, cf.subscriptions.length);
    cf.created.length = 0;
    await syncDeliveryEventSubscriptions(runtime, { verify: true });
    expect(cf.created.map((item) => (item.source as { domain: string }).domain)).toEqual(['keep.test']);
    expect(await rows()).toMatchObject([{ domain: 'keep.test', status: 'active', subscriptionId: 'sub-3' }]);
  });

  it('托管域名用记录的 zone 建立订阅；开通流程在发信就绪后立即订阅', async () => {
    await reset([]);
    const owner = (await db.insert(users).values({ username: 'events-hosted-owner', passwordHash: 'x' }).returning().get())!;
    const hosted = (await db.insert(hostedDomains).values({ domain: 'hosted-events.test', userId: owner.id, status: 'provisioning',
      zoneId: 'zone-hosted', zoneStatus: 'active', routingStatus: 'ready', catchAllReady: true, sendingStatus: 'ready',
      sendingTag: 'tag-hosted', activatedAt: new Date() }).returning().get())!;
    const cf = fakeCloudflare();
    await syncHostedDomain(runtime, hosted.id);
    expect(cf.created).toMatchObject([{ source: { type: 'email.sending', zone_id: 'zone-hosted', domain: 'hosted-events.test' } }]);
    expect(await rows()).toMatchObject([{ domain: 'hosted-events.test', kind: 'hosted', status: 'active' }]);
    expect(cf.calls.some((call) => call.startsWith('GET /zones?'))).toBe(false);
    // 已订阅：再次开通核对只读本地记录
    cf.calls.length = 0;
    await subscribeHostedDomainEvents(runtime, { token: 'events-token', accountId: ACCOUNT, workerName: 'hpc-cloud-mail' }, 'hosted-events.test', 'zone-hosted');
    expect(cf.calls).toEqual([]);
  });

  it('开通流程里订阅失败后 6 小时内不重复调用 Cloudflare', async () => {
    await reset([]);
    const creds = { token: 'events-token', accountId: ACCOUNT, workerName: 'hpc-cloud-mail' };
    const cf = fakeCloudflare({ createStatus: 403 });
    await subscribeHostedDomainEvents(runtime, creds, 'hosted-denied.test', 'zone-hd');
    expect(await rows()).toMatchObject([{ domain: 'hosted-denied.test', kind: 'hosted', status: 'error' }]);
    cf.calls.length = 0;
    await subscribeHostedDomainEvents(runtime, creds, 'hosted-denied.test', 'zone-hd');
    expect(cf.calls).toEqual([]);
    await env.db.prepare('UPDATE email_event_subscriptions SET checked_at = ?').bind(Date.now() - 7 * 3600_000).run();
    await subscribeHostedDomainEvents(runtime, creds, 'hosted-denied.test', 'zone-hd');
    expect(cf.calls).toContain(`POST /accounts/${ACCOUNT}/event_subscriptions/subscriptions`);
  });

  it('定时任务接入：常规轮次建立订阅，每日维护清理过期的对应关系与抑制条目', async () => {
    await reset(['cron-events.test']);
    const cf = fakeCloudflare({ zones: { 'cron-events.test': 'zone-c' } });
    await runScheduled(runtime, false);
    expect(cf.created).toHaveLength(1);
    const old = Date.now() - 31 * 86_400_000;
    await env.db.prepare(`INSERT INTO email_delivery_refs (kind, message_id, sender, recipient, created_at)
      VALUES ('message', 1, 'cron@x.test', 'old@y.test', ?)`).bind(old).run();
    await env.db.prepare(`INSERT INTO email_suppressions (address, sending_domain, reason, expires_at, updated_at)
      VALUES ('cron-expired@y.test', 'x.test', 'soft_bounce', ?, ?)`).bind(Date.now() - 2 * 86_400_000, old).run();
    await runScheduled(runtime, true);
    expect(await env.db.prepare("SELECT COUNT(*) AS n FROM email_delivery_refs WHERE recipient = 'old@y.test'").first()).toEqual({ n: 0 });
    expect(await env.db.prepare("SELECT COUNT(*) AS n FROM email_suppressions WHERE address = 'cron-expired@y.test'").first()).toEqual({ n: 0 });
  });
});
