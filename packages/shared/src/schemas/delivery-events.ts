import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';

/**
 * 外发投递回执：Cloudflare Email Sending 按发信域名订阅事件，投递到 Queue，由 Worker 消费并回写。
 * 只消费终态事件；deferred（临时失败、仍在重试）不订阅。
 */
export const DELIVERY_EVENT_TYPES = ['delivered', 'bounced', 'failed', 'rejected', 'complained'] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/**
 * 投递事件 Queue 的建议名（不含账户信息）。投递回执显式启用：部署时把队列名设为 GitHub Variable
 * DELIVERY_EVENTS_QUEUE，CI 才创建 Queue 并注入 consumer；没设置时整个功能不生效。
 */
export const DELIVERY_EVENTS_QUEUE = 'hpc-mail-email-events';

/**
 * 抑制名单原因：hard_bounce 永久退信（地址或域名不存在等）、soft_bounce 临时退信且重试耗尽、
 * complaint 收件人把邮件标记为垃圾邮件
 */
export const SUPPRESSION_REASONS = ['hard_bounce', 'soft_bounce', 'complaint'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * 命中抑制名单的收件人（recipient_suppressed 错误的 details.suppressed）。
 * 范围与 Cloudflare 一致按发信域名：只拦这个域名发出的信，同一收件人从其他域名发信不受影响。
 */
export interface SuppressedRecipient {
  address: string;
  reason: SuppressionReason;
  sendingDomain: string;
  /** 进入名单的时间 */
  since: string;
  /** 自动解除时间；null 表示长期有效，需管理员解除 */
  expiresAt: string | null;
}

/** 管理员查看的抑制名单条目（GET /api/admin/suppressions） */
export interface EmailSuppression extends SuppressedRecipient {
  id: number;
  /** 收件服务器的退信说明或投诉类型 */
  detail: string;
  updatedAt: string;
}

export const adminSuppressionsQuerySchema = z.object({
  /** 按收件地址或发信域名包含匹配 */
  q: z.string().trim().max(254).optional(),
  cursor: z.string().trim().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type AdminSuppressionsQuery = z.infer<typeof adminSuppressionsQuerySchema>;

/** 某个发信域名的事件订阅状态（GET /api/admin/delivery-events） */
export interface DeliveryEventSubscriptionView {
  domain: string;
  /** system 系统域名；hosted 用户托管域名 */
  kind: 'system' | 'hosted';
  zoneId: string;
  subscriptionId: string | null;
  /** active 已订阅；error 建立失败（见 lastError，定时任务稍后重试） */
  status: 'active' | 'error';
  lastError: string;
  checkedAt: string | null;
}

export interface DeliveryEventsOverview {
  /** 设置 delivery_events.enabled */
  enabled: boolean;
  /** Worker 是否配置了 Cloudflare 凭据（cf_api_token / cf_account_id）；没有时不会自动建立订阅 */
  credentials: boolean;
  /** 部署注入的 Queue 名；null 表示部署未启用投递回执（没有设置 GitHub Variable DELIVERY_EVENTS_QUEUE），开关不生效 */
  queue: string | null;
  subscriptions: DeliveryEventSubscriptionView[];
}
