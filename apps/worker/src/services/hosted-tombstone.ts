import type { Role } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { lookupDelegation } from './domain-check.js';

/** 删除或过期的托管域名保留前所有者与 NS 的天数；期内他人重新添加要先核对公开委派 */
export const HOSTED_TOMBSTONE_RETENTION_DAYS = 90;
const RETENTION_MS = HOSTED_TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * 墓碑 upsert：where/params 与随后删除 hosted_domains 行的 DELETE 守卫相同，放进同一个 batch，
 * 记录没删到时墓碑也不写。新记录没有 NS（zone 从未建好）时保留旧墓碑的 NS。
 */
export function tombstoneStatement(env: Env, reason: 'expire' | 'delete', where: string, params: unknown[]): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO hosted_domain_tombstones (domain, user_id, name_servers, reason, deleted_at)
    SELECT domain, user_id, name_servers, ?, ? FROM hosted_domains WHERE ${where}
    ON CONFLICT(domain) DO UPDATE SET user_id = excluded.user_id, reason = excluded.reason, deleted_at = excluded.deleted_at,
      name_servers = CASE WHEN excluded.name_servers = '[]' THEN hosted_domain_tombstones.name_servers ELSE excluded.name_servers END`)
    .bind(reason, Date.now(), ...params);
}

/**
 * 他人重新添加前的公开委派预检（R14）：同一 Cloudflare 账户重建 zone 会拿到相同的 NS，前所有者删除后没把 NS 改回时，
 * 别人加回来几分钟就能激活并收走全部来信。前所有者（90 天内墓碑）与管理员不受限；委派指向本账户分配过的 NS 一律拒绝；
 * 查不到委派、而该域名近期由别人托管过时也拒绝。返回拒绝原因，没有问题时为 null。
 */
export async function delegationBlock(env: Env, viewer: { id: number; role: Role }, domain: string): Promise<AppError | null> {
  if (viewer.role === 'admin') return null;
  const [[tombstone, known], delegation] = await Promise.all([
    env.db.batch([
      env.db.prepare('SELECT user_id FROM hosted_domain_tombstones WHERE domain = ? AND deleted_at >= ?').bind(domain, Date.now() - RETENTION_MS),
      env.db.prepare(`SELECT lower(j.value) AS ns FROM hosted_domains h, json_each(h.name_servers) j
        UNION SELECT lower(j.value) FROM hosted_domain_tombstones t, json_each(t.name_servers) j`),
    ]),
    lookupDelegation(domain),
  ]);
  const previous = tombstone?.results?.[0] as { user_id: number } | undefined;
  if (previous && Number(previous.user_id) === viewer.id) return null;
  if (delegation) {
    const ours = new Set(((known?.results ?? []) as { ns: string }[]).map((row) => row.ns.replace(/\.$/, '')));
    if (!delegation.some((ns) => ours.has(ns))) return null;
    return new AppError('conflict', '该域名的名称服务器仍指向本站分配的地址（可能是前所有者删除后没有改回），为防止他人接管来信，暂不能添加。'
      + '请先在注册商把 NS 改到其他服务商后再试，或联系管理员');
  }
  return previous ? new AppError('conflict', '暂时无法确认该域名的公开 NS 委派，请稍后再试或联系管理员') : null;
}

/** 每日维护：清除保留期已过的墓碑 */
export async function purgeHostedTombstones(env: Env): Promise<number> {
  const result = await env.db.prepare('DELETE FROM hosted_domain_tombstones WHERE deleted_at < ?').bind(Date.now() - RETENTION_MS).run();
  return result.meta.changes ?? 0;
}
