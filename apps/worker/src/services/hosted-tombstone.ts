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

interface TombstoneRow { user_id: number; reason: string; transfer: string | null }

/**
 * 墓碑记录的最后所有者：删除与过期写入的是删除当时的所有者；迁移 0024 回填的只有最后一次添加的人，
 * 之后若有过户（审计 detail 形如「旧名 (#旧id) → 新名 (#新id)；…」）以最近一次过户的目标为准，解析不出时谁都不免检（0）
 */
function lastOwner(row: TombstoneRow): number {
  if (row.reason !== 'backfill' || !row.transfer) return Number(row.user_id);
  const target = /→ .*? \(#(\d+)\)/.exec(row.transfer);
  return target ? Number(target[1]) : 0;
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
      // 回填墓碑只知道最后一次添加的人：一并取这次添加之后最近的过户审计，按过户目标认定最后的所有者
      env.db.prepare(`SELECT t.user_id, t.reason,
          (SELECT a.detail FROM admin_audit_logs a WHERE a.action = 'hosted_domain.transfer' AND a.target = t.domain
            AND a.id > COALESCE((SELECT MAX(c.id) FROM admin_audit_logs c WHERE c.action = 'hosted_domain.create' AND c.target = t.domain), 0)
            ORDER BY a.id DESC LIMIT 1) AS transfer
        FROM hosted_domain_tombstones t WHERE t.domain = ? AND t.deleted_at >= ?`).bind(domain, Date.now() - RETENTION_MS),
      env.db.prepare(`SELECT lower(j.value) AS ns FROM hosted_domains h, json_each(h.name_servers) j
        UNION SELECT lower(j.value) FROM hosted_domain_tombstones t, json_each(t.name_servers) j`),
    ]),
    lookupDelegation(domain),
  ]);
  const previous = tombstone?.results?.[0] as TombstoneRow | undefined;
  if (previous && lastOwner(previous) === viewer.id) return null;
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
