import { messageViewQuerySchema, type MessageMutationScope } from '@hpc-mail/shared';
import type { Context } from 'hono';
import { keyRestriction } from '../middleware/api-key-auth.js';
import { auditActorOf, userMailReadAuditStatement, writeAudit } from '../services/audit.js';
import type { Viewer } from '../services/message.js';
import type { AppContext } from '../types.js';
import { AppError } from './errors.js';
import { execCtx, parseQuery } from './http.js';

/** JWT 与 API Key 路由必须使用同一范围解析，避免默默忽略作用范围；API Key 的限定范围随之带上。 */
export function messageViewer(
  c: Context<AppContext>,
  actor: { userId: number; role: Viewer['role'] },
  bodyScope?: MessageMutationScope,
  mutation = false,
): Viewer {
  const query = parseQuery(c, messageViewQuerySchema);
  if (mutation && query.scope === 'user') {
    throw new AppError('validation_failed', '修改邮件仅支持 mine 或 unclaimed 范围');
  }
  if (bodyScope !== undefined && query.scope !== undefined && bodyScope !== query.scope) {
    throw new AppError('validation_failed', 'query 与 body 的 scope 不能冲突');
  }
  const scope = bodyScope ?? query.scope;
  if (actor.role !== 'admin' && scope !== undefined && scope !== 'mine') {
    throw new AppError('forbidden', '无权使用该可见范围');
  }
  const viewer = scopedViewer(c, actor, scope, query.userId);
  if (!mutation) auditUserScopeRead(c, viewer);
  return viewer;
}

function scopedViewer(c: Context<AppContext>, actor: { userId: number; role: Viewer['role'] }, scope: Viewer['scope'], targetUserId?: number): Viewer {
  const restrict = keyRestriction(c) ?? undefined;
  return { ...actor, scope, targetUserId, ...(restrict ? { restrict } : {}) };
}

/**
 * 列表：scope/userId 已随列表查询一起解析校验（越权范围由 listMessages 的 resolveScope 拒绝），
 * 同样带上 API Key 的限定范围，管理员读他人邮件时记审计。
 */
export function listViewer(
  c: Context<AppContext>,
  actor: { userId: number; role: Viewer['role'] },
  query: { scope?: Viewer['scope']; userId?: number },
): Viewer {
  const viewer = scopedViewer(c, actor, query.scope, query.userId);
  auditUserScopeRead(c, viewer);
  return viewer;
}

export function mutationViewer(
  c: Context<AppContext>,
  actor: { userId: number; role: Viewer['role'] },
  bodyScope?: MessageMutationScope,
): Viewer {
  return messageViewer(c, actor, bodyScope, true);
}

/** 本 isolate 当天已记过的（管理员:目标用户）；只省掉重复语句，去重以数据库里那条语句为准 */
const auditedReads = new Set<string>();
let auditedDay = 0;
const AUDITED_READS_MAX = 1000;

/**
 * 管理员以 scope=user 读取他人邮件时记一条管理审计，每个（管理员、目标用户、UTC 日）一条。
 * 写入放进 waitUntil，不给读请求加串行往返；非管理员或其他范围在第一行就返回。
 * 没有 ExecutionContext（只有单测直接调用 app.request 不传 ctx）时不等待写入完成：调用方是同步函数。
 */
export function auditUserScopeRead(c: Context<AppContext>, viewer: Viewer): void {
  if (viewer.role !== 'admin' || viewer.scope !== 'user' || !viewer.targetUserId || viewer.targetUserId === viewer.userId) return;
  const now = Date.now();
  const day = Math.floor(now / 86_400_000);
  if (day !== auditedDay || auditedReads.size >= AUDITED_READS_MAX) {
    auditedReads.clear();
    auditedDay = day;
  }
  const key = `${viewer.userId}:${viewer.targetUserId}`;
  if (auditedReads.has(key)) return;
  const write = userMailReadAuditStatement(c.env, auditActorOf(c), viewer.targetUserId, `${c.req.method} ${c.req.path}`, now).run()
    .then(() => { auditedReads.add(key); })
    .catch((error) => console.error('读取他人邮件的审计写入失败:', error));
  execCtx(c)?.waitUntil(write);
}

const PURGE_AUDIT_IDS = 50;

/**
 * 管理员永久删除未认领地址的邮件（/purge 带 scope=unclaimed）后记审计。
 * 删除在 message 服务里自成事务，审计只能提交后补写；写失败只记日志，不把已完成的删除报成失败。
 */
export async function auditUnclaimedPurge(c: Context<AppContext>, viewer: Viewer, ids: readonly number[], purged: number): Promise<void> {
  if (viewer.role !== 'admin' || viewer.scope !== 'unclaimed' || purged === 0) return;
  const shown = ids.slice(0, PURGE_AUDIT_IDS).join('、') + (ids.length > PURGE_AUDIT_IDS ? ` 等共 ${ids.length} 个` : '');
  await writeAudit(c.env, auditActorOf(c), 'mail.purge_unclaimed', 'scope=unclaimed', `永久删除未认领地址的邮件 ${purged} 封；请求的 id：${shown}`);
}
