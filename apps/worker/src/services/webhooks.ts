import type { WebhookEventType } from '@hpc-mail/shared';
import type { Env, ExecCtx } from '../types.js';

/** 发给某个用户的 Webhook v2 事件 */
export interface UserEvent {
  type: WebhookEventType;
  /** 去重键：同一用户同一事件只投递一次，如 `mail.sent:123`、`hosted_domain.activated:7:<activatedAt>` */
  key: string;
  /** 事件 data（请求体为 { id, type, timestamp, data }） */
  data: Record<string, unknown>;
  /** 事件涉及的本站地址与域名，用于端点的 addresses / domains 过滤 */
  address?: string;
  domain?: string;
}

/**
 * 把事件写入该用户订阅了此类型、且过滤命中的启用端点的投递队列，并尽快投递。
 * 有 ctx 时写入与投递都放进 waitUntil，不增加请求延迟；ctx 为 null（定时任务、单测直调）时只等写入完成，
 * 投递由定时任务的 webhook 步骤接着处理。任何失败只记日志，不抛给调用方。
 * TODO(PR4a-webhooks)：实现
 */
export async function emitUserEvent(env: Env, userId: number, event: UserEvent, ctx?: ExecCtx | null): Promise<void> {
  void env; void userId; void event; void ctx;
}
