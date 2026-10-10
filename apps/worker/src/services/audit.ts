import { SETTING_SCHEMAS, type AdminAuditLogEntry, type Page, type SettingKey, type Settings } from '@hpc-mail/shared';
import { desc, lt } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { adminAuditLogs } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import type { AuthUser, Env } from '../types.js';

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
    if (changes.length) parts.push(`${domain} ${changes.join('，')}`);
  }
  // 只调整顺序也算一次写入，留痕但不展开
  if (!parts.length && before.list.map((e) => e.domain).join() !== after.list.map((e) => e.domain).join()) parts.push('调整域名顺序');
  return parts;
}

function describeValue(key: string, before: unknown, after: unknown): string[] {
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
