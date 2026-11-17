import { SETTING_SCHEMAS, type AdminAuditLogEntry, type Page, type SettingKey, type Settings } from '@hpc-mail/shared';
import { desc, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { createDb } from '../db/client.js';
import { adminAuditLogs } from '../db/schema.js';
import { clientIp } from '../lib/http.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { AppContext, AuthUser, Env } from '../types.js';

/** 记录一条管理操作（best-effort，写失败不阻断主流程） */
export async function logAdminAction(
  env: Env,
  actor: Pick<AuthUser, 'id' | 'username'>,
  action: string,
  target = '',
  detail = '',
  ip = '',
): Promise<void> {
  try {
    await createDb(env)
      .insert(adminAuditLogs)
      .values({ actorId: actor.id, actorName: actor.username, action, target, detail, ip });
  } catch (e) {
    console.error('管理审计日志写入失败:', e);
  }
}

/**
 * 审计里的操作者：/api 为登录用户，/v1 为 Key 所属用户。
 * Key 鉴权不读用户名，用户名统一在写入语句里按 id 查出（ACTOR_NAME_SQL），不为审计多一次往返。
 */
export interface AuditActor {
  id: number;
  ip: string;
  /** 经 API Key 调用时的 Key id，标注在 detail 末尾 */
  apiKeyId?: number;
}

export function auditActorOf(c: Context<AppContext>): AuditActor {
  const key = c.get('apiKey');
  if (key) return { id: key.userId, ip: c.get('apiClientIp') ?? clientIp(c), apiKeyId: key.id };
  return { id: c.get('user')!.id, ip: clientIp(c) };
}

/** detail 末尾的来源标注：/v1 写明 Key，便于从审计追到具体 Key */
export function auditSuffix(actor: AuditActor): string {
  return actor.apiKeyId === undefined ? '' : `（API Key #${actor.apiKeyId}）`;
}

/** 操作者用户名（?1 = 操作者 id） */
export const ACTOR_NAME_SQL = `COALESCE((SELECT username FROM users WHERE id = ?1), '')`;

/** 一条审计 INSERT，可并入调用方的 batch，与业务写入同一事务提交 */
export function auditStatement(env: Env, actor: AuditActor, action: string, target: string, detail: string): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
    SELECT ?1, ${ACTOR_NAME_SQL}, ?2, ?3, ?4, ?5`).bind(actor.id, action, target, `${detail}${auditSuffix(actor)}`, actor.ip);
}

/** 业务写入已提交、审计无法同事务时用：失败只记日志，不把已成功的操作变成报错 */
export async function writeAudit(env: Env, actor: AuditActor, action: string, target: string, detail: string): Promise<void> {
  try {
    await auditStatement(env, actor, action, target, detail).run();
  } catch (e) {
    console.error('管理审计日志写入失败:', e);
  }
}

/** 管理员以 scope=user 读取他人邮件（列表、同步、详情、线程、原始邮件、附件等） */
export const MAIL_READ_USER_ACTION = 'mail.read_user';

const DAY_MS = 86_400_000;

/**
 * 读取他人邮件的审计按（管理员、目标用户、UTC 日）只留一条：去重与写入是同一条语句，并发请求也只写一条。
 * NOT EXISTS 用 created_at 索引只扫当天的审计行；D1 没有 STAT4，用 INDEXED BY 固定计划。
 */
export function userMailReadAuditStatement(env: Env, actor: AuditActor, targetUserId: number, via: string, now = Date.now()): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
    SELECT ?1, ${ACTOR_NAME_SQL}, '${MAIL_READ_USER_ACTION}', ?2,
      '查看 ' || COALESCE((SELECT username FROM users WHERE id = ?3), '已删除的用户') || ' 的邮件，当日首次：' || ?4, ?5
    WHERE NOT EXISTS (SELECT 1 FROM admin_audit_logs INDEXED BY idx_admin_audit_created
      WHERE created_at >= ?6 AND actor_id = ?1 AND action = '${MAIL_READ_USER_ACTION}' AND target = ?2)`)
    .bind(actor.id, `user#${targetUserId}`, targetUserId, `${via}${auditSuffix(actor)}`, actor.ip, now - (now % DAY_MS));
}

const AUDIT_DETAIL_MAX = 1000;

function shortValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** 数组差集摘要：+新增 −移除 */
function arrayDiff(before: unknown[], after: unknown[]): string {
  const key = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const old = new Set(before.map(key));
  const now = new Set(after.map(key));
  const added = [...now].filter((v) => !old.has(v));
  const removed = [...old].filter((v) => !now.has(v));
  return [added.length ? `+${added.join('、')}` : '', removed.length ? `−${removed.join('、')}` : ''].filter(Boolean).join(' ');
}

function describeDomains(before: Settings['domains'], after: Settings['domains']): string[] {
  const old = new Map(before.list.map((e) => [e.domain, e]));
  const now = new Map(after.list.map((e) => [e.domain, e]));
  const added = [...now.keys()].filter((d) => !old.has(d));
  const removed = [...old.keys()].filter((d) => !now.has(d));
  const parts: string[] = [];
  if (added.length) parts.push(`新增域名 ${added.join('、')}`);
  if (removed.length) parts.push(`移除域名 ${removed.join('、')}`);
  for (const [domain, entry] of now) {
    const prev = old.get(domain);
    if (!prev) continue;
    const changes: string[] = [];
    if (prev.public !== entry.public) changes.push(entry.public ? '改为公开' : '改为仅管理员');
    if (prev.perUserLimit !== entry.perUserLimit) changes.push(`每人上限 ${prev.perUserLimit}→${entry.perUserLimit}`);
    if ((prev.random !== false) !== (entry.random !== false)) changes.push(entry.random !== false ? '参与随机' : '不参与随机');
    if (changes.length) parts.push(`${domain} ${changes.join('，')}`);
  }
  // 只调整顺序也算一次写入，留痕但不展开
  if (!parts.length && before.list.map((e) => e.domain).join() !== after.list.map((e) => e.domain).join()) parts.push('调整域名顺序');
  return parts;
}

/** 密文字段只记录是否变化，绝不写入值 */
const SECRET_SETTING_FIELDS = new Set(['ai_model.apiKey']);

function describeValue(key: string, before: unknown, after: unknown): string[] {
  if (SECRET_SETTING_FIELDS.has(key)) return before === after ? [] : [`${key} ${after ? '已更新' : '已清除'}`];
  if (Array.isArray(before) && Array.isArray(after)) {
    const diff = arrayDiff(before, after);
    return diff ? [`${key} ${diff}`] : [];
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...fields].flatMap((field) => describeValue(`${key}.${field}`,
      (before as Record<string, unknown>)[field], (after as Record<string, unknown>)[field]));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [`${key}: ${shortValue(before)}→${shortValue(after)}`];
}

/**
 * 系统设置变更的审计摘要：target 只列真正变化的设置键（不含 expectedDomainsRevision 这类请求内部字段），
 * detail 写变更内容；域名列表写新增/移除/公开性与上限调整。
 */
export function describeSettingsChange(
  before: Settings,
  after: Settings,
  requestedKeys: string[],
): { target: string; detail: string } {
  const keys = requestedKeys.filter((key): key is SettingKey => key in SETTING_SCHEMAS);
  const changed: string[] = [];
  const details: string[] = [];
  for (const key of keys) {
    const parts = key === 'domains'
      ? describeDomains(before.domains, after.domains)
      : describeValue(key, before[key], after[key]);
    if (!parts.length) continue;
    changed.push(key);
    details.push(...parts);
  }
  const detail = details.length ? details.join('；') : '无实际变更';
  return {
    target: (changed.length ? changed : keys).join('、'),
    detail: detail.length > AUDIT_DETAIL_MAX ? `${detail.slice(0, AUDIT_DETAIL_MAX - 1)}…` : detail,
  };
}

export async function listAdminAuditLogs(
  env: Env,
  cursor: string | undefined,
  limit: number,
): Promise<Page<AdminAuditLogEntry>> {
  const db = createDb(env);
  const cursorId = decodeCursor(cursor);
  const rows = await db
    .select()
    .from(adminAuditLogs)
    .where(cursorId ? lt(adminAuditLogs.id, cursorId) : undefined)
    .orderBy(desc(adminAuditLogs.id))
    .limit(limit + 1)
    .all();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => ({
      id: r.id,
      actorName: r.actorName,
      action: r.action,
      target: r.target,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}
