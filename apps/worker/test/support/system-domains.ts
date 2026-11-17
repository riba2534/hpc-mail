/**
 * 系统域名接入测试共用的夹具：清空接入相关的表与计数、造用户、调用管理员接口、在指定 SQL 前插入并发写入。
 * 同一测试文件内的用例共享 D1：每个用例开头调用 resetSystemDomains，域名用前缀错开。
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import type { SystemDomainOnboarding, SystemDomainPrecheck } from '@hpc-mail/shared';
import { createApp } from '../../src/app.js';
import { createDb } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { signToken } from '../../src/lib/jwt.js';
import { createSession } from '../../src/services/session.js';
import { getSettingsFresh, updateSettings } from '../../src/services/setting.js';
import { getOnboarding } from '../../src/services/system-domain.js';
import { clearZoneCatalogCache } from '../../src/services/zone-catalog.js';
import type { Env } from '../../src/types.js';
import { cfRuntime } from './fake-cloudflare.js';

export const app = createApp();
export const db = createDb(env);
/** 带假凭据的运行时 env */
export const runtime: Env = cfRuntime(env);

let sequence = 0;

/** 清空接入任务、托管域名、相关计数与退避标记，重置系统域名列表；返回本用例的域名前缀 */
export async function resetSystemDomains(opts: {
  system?: string[];
  maxPendingTotal?: number;
} = {}): Promise<{ prefix: string; domain: (name?: string) => string }> {
  const prefix = `sd${++sequence}`;
  await env.db.batch([
    env.db.prepare('DELETE FROM system_domain_onboarding'),
    env.db.prepare('DELETE FROM hosted_domain_members'),
    env.db.prepare('DELETE FROM hosted_domains'),
    env.db.prepare(`DELETE FROM rate_counters WHERE scope IN ('system_domain_cf', 'hosted_dns_site', 'hosted_create', 'hosted_check')`),
    env.db.prepare(`DELETE FROM settings WHERE key IN ('cf_backoff', 'system_domains')`),
  ]);
  await updateSettings(env, {
    domains: { list: (opts.system ?? []).map((domain) => ({ domain, public: true, perUserLimit: 0 })) },
    mailbox_policy: { perUserLimit: 5, reservedLocalParts: [] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    hosted_domains: {
      enabled: true, maxPerUser: 3, maxPendingPerUser: 3, maxPendingTotal: opts.maxPendingTotal ?? 10, pendingDays: 7, autoClaimLimit: 0,
    },
  });
  clearZoneCatalogCache();
  return { prefix, domain: (name = 'mail') => `${prefix}-${name}.test` };
}

export interface TestActor {
  id: number;
  username: string;
  jwt: string;
}

export async function actor(name: string, role: 'admin' | 'user' = 'admin'): Promise<TestActor> {
  const user = (await db.insert(users).values({
    username: `${name}-${++sequence}`, role, passwordHash: 'test', authVersionMigrated: true,
  }).returning().get())!;
  const sid = await createSession(env, user.id);
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  return { id: user.id, username: user.username, jwt };
}

/** 调用 /api 接口；waitUntil 中的后台处理在返回前跑完 */
export async function call(method: string, path: string, token: string | null, body?: unknown, runtimeEnv: Env = runtime): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await app.request(`/api${path}`, {
    method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }, runtimeEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: { precheck?: SystemDomainPrecheck };
}

export async function errorOf(response: Response, status: number): Promise<ErrorBody> {
  const body = await response.json() as { error: ErrorBody };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

/** 直接写入一条接入任务（跳过接口），用来构造指定状态；默认已到期 */
export async function insertTask(fields: {
  domain: string;
  createdBy: number;
  state: string;
  mode?: 'existing_zone' | 'new_zone';
  zoneId?: string | null;
  origin?: 'created' | 'linked' | 'unknown';
  zoneStatus?: string;
  nextCheckAt?: number | null;
  leaseToken?: string | null;
  leaseUntil?: number | null;
  activatedAt?: number | null;
}): Promise<number> {
  const row = await env.db.prepare(`INSERT INTO system_domain_onboarding (domain, mode, state, account_id, zone_id, zone_origin,
      zone_status, created_by, next_check_at, lease_token, lease_until, activated_at)
    VALUES (?1, ?2, ?3, 'acct-test', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`)
    .bind(fields.domain, fields.mode ?? 'existing_zone', fields.state, fields.zoneId ?? null, fields.origin ?? 'linked',
      fields.zoneStatus ?? '', fields.createdBy, fields.nextCheckAt === undefined ? Date.now() - 1 : fields.nextCheckAt,
      fields.leaseToken ?? null, fields.leaseUntil ?? null, fields.activatedAt ?? null)
    .first<{ id: number }>();
  return row!.id;
}

/** 一键接入已有 zone（按预检结果确认全部需确认项） */
export async function onboardExisting(admin: TestActor, zoneId: string, runtimeEnv: Env = runtime): Promise<Response> {
  const precheck = await data<SystemDomainPrecheck>(await call('GET', `/admin/system-domains/precheck?mode=existing_zone&zoneId=${zoneId}`, admin.jwt, undefined, runtimeEnv));
  return call('POST', '/admin/system-domains/onboardings', admin.jwt,
    { mode: 'existing_zone', zoneId, fingerprint: precheck.fingerprint, accept: precheck.requiredAcks }, runtimeEnv);
}

/** 新建 zone 接入（确认改 NS） */
export async function onboardNewZone(admin: TestActor, domain: string, runtimeEnv: Env = runtime): Promise<Response> {
  const precheck = await data<SystemDomainPrecheck>(await call('GET', `/admin/system-domains/precheck?mode=new_zone&domain=${domain}`, admin.jwt, undefined, runtimeEnv));
  return call('POST', '/admin/system-domains/onboardings', admin.jwt,
    { mode: 'new_zone', domain, fingerprint: precheck.fingerprint, accept: precheck.requiredAcks }, runtimeEnv);
}

export function task(id: number): Promise<SystemDomainOnboarding> {
  return getOnboarding(env, id);
}

/** 让任务立即到期（cron 会处理）；可同时把创建时间往前挪 */
export async function makeDue(id: number, opts: { createdAgoMs?: number } = {}): Promise<void> {
  const now = Date.now();
  await env.db.prepare(`UPDATE system_domain_onboarding SET next_check_at = ?1, checked_at = NULL,
      created_at = CASE WHEN ?2 > 0 THEN ?1 - ?2 ELSE created_at END WHERE id = ?3`)
    .bind(now - 1, opts.createdAgoMs ?? 0, id).run();
}

export async function systemList(): Promise<{ domains: { domain: string; public: boolean; perUserLimit: number; random?: boolean }[]; revision: number }> {
  const settings = await getSettingsFresh(env);
  return { domains: settings.domains.list, revision: settings.domains.revision ?? 0 };
}

export async function auditActions(target: string): Promise<{ action: string; actorName: string; detail: string }[]> {
  const rows = await env.db.prepare('SELECT action, actor_name AS actorName, detail FROM admin_audit_logs WHERE target = ? ORDER BY id')
    .bind(target).all<{ action: string; actorName: string; detail: string }>();
  return rows.results;
}

/**
 * 在匹配 pattern 的 SQL 执行前（在 batch 里时为整个 batch 执行前）插入并发写入，用来确定性地复现交错。
 * times 为触发次数（默认 1）。
 */
export function beforeStatement(base: Env, pattern: RegExp, hook: () => Promise<void>, times = 1): Env {
  let left = times;
  const fire = async () => {
    if (left <= 0) return;
    left -= 1;
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
