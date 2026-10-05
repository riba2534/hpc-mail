import { messageViewQuerySchema, type MessageMutationScope } from '@hpc-mail/shared';
import type { Context } from 'hono';
import type { Viewer } from '../services/message.js';
import type { AppContext } from '../types.js';
import { AppError } from './errors.js';
import { parseQuery } from './http.js';

/** JWT 与 API Key 路由必须使用同一范围解析，避免默默忽略作用范围。 */
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
  return { ...actor, scope, targetUserId: query.userId };
}

export function mutationViewer(
  c: Context<AppContext>,
  actor: { userId: number; role: Viewer['role'] },
  bodyScope?: MessageMutationScope,
): Viewer {
  return messageViewer(c, actor, bodyScope, true);
}
