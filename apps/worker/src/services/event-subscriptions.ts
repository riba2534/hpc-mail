import {
  DELIVERY_EVENT_TYPES,
  type DeliveryEventsOverview,
  type DeliveryEventSubscriptionView,
} from '@hpc-mail/shared';
import type { Env } from '../types.js';
import {
  CloudflareApiError,
  cloudflareCredentials,
  createEventSubscription,
  findQueue,
  findZone,
  listQueueSubscriptions,
  type CfEventSubscription,
  type CloudflareCredentials,
} from './cloudflare.js';
import { deliveryEventsQueue } from './delivery-refs.js';
import { getSettings, getSettingsFresh } from './setting.js';

/** 订阅的事件名（Queues 订阅接口使用不带 cf.email.sending 前缀的短名） */
export const SUBSCRIBED_EVENTS = DELIVERY_EVENT_TYPES.map((type) => `message.${type}`);
/** 建立失败的域名隔多久再试：权限或发信未开通这类错误不会很快自愈，避免每轮都调用 Cloudflare */
const ERROR_RETRY_MS = 6 * 3600_000;
/** 每轮最多处理的域名数（每个新域名约 1–4 次 Cloudflare 调用） */
const DEFAULT_LIMIT = 5;

type Kind = DeliveryEventSubscriptionView['kind'];
interface Target { domain: string; kind: Kind; zoneId: string | null }
interface Row {
  domain: string; kind: Kind; zone_id: string; subscription_id: string | null;
  status: 'active' | 'error'; last_error: string; checked_at: number | null;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // 403 多半是 Token 缺权限：建订阅需要 Queues:Edit，系统域名还需要能读到所在 zone
  const hint = error instanceof CloudflareApiError && (error.status === 403 || error.has(10000, 9109))
    ? '（Cloudflare Token 需要 Account → Queues:Edit，并能访问该域名所在 zone）' : '';
  return `${text}${hint}`.slice(0, 500);
}

/** 系统域名可能是 zone 的子域（已验证的发信子域）：从完整域名逐级向上找账户里的 zone */
async function resolveZoneId(creds: CloudflareCredentials, domain: string): Promise<string> {
  const labels = domain.split('.');
  for (let start = 0; start <= labels.length - 2; start++) {
    const zone = await findZone(creds, labels.slice(start).join('.'));
    if (zone) return zone.id;
  }
  throw new Error('找不到该域名所在的 Cloudflare zone');
}

async function saveRow(env: Env, target: Target, fields: { zoneId: string; subscriptionId: string | null; status: Row['status']; lastError: string }): Promise<void> {
  await env.db.prepare(`INSERT INTO email_event_subscriptions (domain, kind, zone_id, subscription_id, status, last_error, checked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (domain) DO UPDATE SET kind = excluded.kind, zone_id = excluded.zone_id,
      subscription_id = COALESCE(excluded.subscription_id, email_event_subscriptions.subscription_id),
      status = excluded.status, last_error = excluded.last_error, checked_at = excluded.checked_at`)
    .bind(target.domain, target.kind, fields.zoneId, fields.subscriptionId, fields.status, fields.lastError, Date.now()).run();
}

/** 取 Queue 与它已有的 email.sending 订阅（按发信域名索引）；Queue 不存在时抛出带提示的错误 */
async function loadQueueState(creds: CloudflareCredentials, name: string): Promise<{ queueId: string; byDomain: Map<string, CfEventSubscription> }> {
  const queue = await findQueue(creds, name);
  if (!queue) throw new Error(`Queue ${name} 不存在：部署流程会自动创建，或手动运行 wrangler queues create ${name}`);
  const subscriptions = await listQueueSubscriptions(creds, queue.queue_id);
  const byDomain = new Map<string, CfEventSubscription>();
  for (const item of subscriptions) {
    if (item.source?.type === 'email.sending' && item.source.domain) byDomain.set(item.source.domain.toLowerCase(), item);
  }
  return { queueId: queue.queue_id, byDomain };
}

/** 为一个域名建立订阅：已有同域名订阅（包括手动建的）直接沿用；失败写 error 行，不抛出 */
async function ensureOne(env: Env, creds: CloudflareCredentials, target: Target,
  state: { queueId: string; byDomain: Map<string, CfEventSubscription> }): Promise<boolean> {
  let zoneId = target.zoneId ?? '';
  try {
    const existing = state.byDomain.get(target.domain);
    if (existing) {
      await saveRow(env, target, { zoneId: existing.source.zone_id ?? zoneId, subscriptionId: existing.id, status: 'active', lastError: '' });
      return true;
    }
    zoneId ||= await resolveZoneId(creds, target.domain);
    const created = await createEventSubscription(creds, {
      name: `hpc-mail-${target.domain}`, source: { type: 'email.sending', zone_id: zoneId, domain: target.domain },
      queueId: state.queueId, events: SUBSCRIBED_EVENTS,
    });
    state.byDomain.set(target.domain, created);
    await saveRow(env, target, { zoneId, subscriptionId: created.id, status: 'active', lastError: '' });
    return true;
  } catch (error) {
    console.error(`投递事件订阅 ${target.domain} 建立失败:`, error);
    try { await saveRow(env, target, { zoneId, subscriptionId: null, status: 'error', lastError: errorText(error) }); }
    catch (saveError) { console.error('投递事件订阅状态保存失败:', saveError); }
    return false;
  }
}

/** 需要订阅的发信域名：全部系统域名，以及已开通发信的托管域名 */
async function loadTargets(env: Env, domains: string[]): Promise<{ targets: Target[]; rows: Map<string, Row> }> {
  const [hosted, rows] = await env.db.batch([
    env.db.prepare(`SELECT domain, zone_id FROM hosted_domains
      WHERE status = 'active' AND sending_status = 'ready' AND zone_id IS NOT NULL`),
    env.db.prepare('SELECT domain, kind, zone_id, subscription_id, status, last_error, checked_at FROM email_event_subscriptions'),
  ]);
  const targets: Target[] = [
    ...domains.map((domain) => ({ domain, kind: 'system' as const, zoneId: null })),
    ...(hosted!.results as { domain: string; zone_id: string }[]).map((row) => ({ domain: row.domain, kind: 'hosted' as const, zoneId: row.zone_id })),
  ];
  return { targets, rows: new Map((rows!.results as Row[]).map((row) => [row.domain, row])) };
}

/**
 * 定时维护（幂等）：每 5 分钟为还没有订阅、或失败超过 6 小时的域名建立订阅，每轮最多 limit 个；
 * verify=true（每日）时再核对一次 Cloudflare 上的订阅，被删掉的重建，不再需要的域名删掉本地记录。
 * 只在部署启用了投递回执（注入了 Queue）、Worker 有 Cloudflare 凭据且设置 delivery_events.enabled 开启时执行；
 * 未启用时不读库也不调用 Cloudflare，没有待办时也不调用 Cloudflare。
 */
export async function syncDeliveryEventSubscriptions(env: Env, options: { verify?: boolean; limit?: number } = {}): Promise<number> {
  const queue = deliveryEventsQueue(env);
  const creds = cloudflareCredentials(env);
  if (!queue || !creds) return 0;
  const settings = await getSettings(env);
  if (!settings.delivery_events.enabled) return 0;
  const { targets, rows } = await loadTargets(env, settings.domains.list.map((item) => item.domain));
  const now = Date.now();
  const due = targets.filter((target) => {
    const row = rows.get(target.domain);
    if (!row) return true;
    if (row.status === 'error') return !row.checked_at || now - Number(row.checked_at) > ERROR_RETRY_MS;
    return options.verify === true;
  }).slice(0, options.verify ? targets.length : options.limit ?? DEFAULT_LIMIT);
  const wanted = new Set(targets.map((target) => target.domain));
  const stale = [...rows.keys()].filter((domain) => !wanted.has(domain));
  if (options.verify && stale.length) {
    // 域名已移除或托管域名已删除：只删本地记录，Cloudflare 上的订阅保留（之后重新加回时直接沿用）
    await env.db.batch(stale.map((domain) => env.db.prepare('DELETE FROM email_event_subscriptions WHERE domain = ?').bind(domain)));
  }
  if (!due.length) return 0;
  let state: Awaited<ReturnType<typeof loadQueueState>>;
  try {
    state = await loadQueueState(creds, queue);
  } catch (error) {
    // Queue 不可用时整轮失败：只给还没有记录的域名写 error，已生效的订阅保持原状态
    const message = errorText(error);
    console.error('投递事件 Queue 不可用:', message);
    for (const target of due.filter((item) => rows.get(item.domain)?.status !== 'active')) {
      await saveRow(env, target, { zoneId: target.zoneId ?? '', subscriptionId: null, status: 'error', lastError: message })
        .catch(() => undefined);
    }
    return 0;
  }
  let changed = 0;
  for (const target of due) {
    const row = rows.get(target.domain);
    // 每日核对：Cloudflare 上仍在的订阅不重复写库
    if (row?.status === 'active' && row.subscription_id && state.byDomain.get(target.domain)?.id === row.subscription_id) continue;
    if (await ensureOne(env, creds, target, state)) changed++;
  }
  return changed;
}

/**
 * 托管域名开通发信后立即订阅（开通流程里调用，失败只记录，不影响开通）；已订阅时只读一次本地记录。
 */
export async function subscribeHostedDomainEvents(env: Env, creds: CloudflareCredentials, domain: string, zoneId: string): Promise<void> {
  const queue = deliveryEventsQueue(env);
  if (!queue) return;
  try {
    const settings = await getSettings(env);
    if (!settings.delivery_events.enabled) return;
    const row = await env.db.prepare('SELECT status, checked_at FROM email_event_subscriptions WHERE domain = ?').bind(domain)
      .first<{ status: string; checked_at: number | null }>();
    // 已订阅，或失败不久（开通中的域名每 5 分钟核对一次，不必每次都重试）
    if (row?.status === 'active' || (row?.checked_at && Date.now() - Number(row.checked_at) < ERROR_RETRY_MS)) return;
    const target: Target = { domain, kind: 'hosted', zoneId };
    let state: Awaited<ReturnType<typeof loadQueueState>>;
    try {
      state = await loadQueueState(creds, queue);
    } catch (error) {
      await saveRow(env, target, { zoneId, subscriptionId: null, status: 'error', lastError: errorText(error) });
      return;
    }
    await ensureOne(env, creds, target, state);
  } catch (error) {
    console.error(`托管域名 ${domain} 投递事件订阅失败:`, error);
  }
}

/** 管理员查看订阅状态 */
export async function deliveryEventsOverview(env: Env): Promise<DeliveryEventsOverview> {
  const [settings, { results }] = await Promise.all([
    getSettingsFresh(env),
    env.db.prepare('SELECT domain, kind, zone_id, subscription_id, status, last_error, checked_at FROM email_event_subscriptions ORDER BY domain')
      .all<Row>(),
  ]);
  return {
    enabled: settings.delivery_events.enabled,
    credentials: cloudflareCredentials(env) !== null,
    queue: deliveryEventsQueue(env),
    subscriptions: results.map((row) => ({
      domain: row.domain, kind: row.kind, zoneId: row.zone_id, subscriptionId: row.subscription_id,
      status: row.status, lastError: row.last_error,
      checkedAt: row.checked_at === null ? null : new Date(Number(row.checked_at)).toISOString(),
    })),
  };
}
