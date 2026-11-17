import { z } from 'zod';
import { emailAddressSchema } from './mail.js';
import { domainSchema } from './mailbox.js';

/**
 * Webhook v2 事件类型。
 * - mail.received：归属人（收信当时的通知归属：认领人；未认领地址归启用中的管理员）收到新邮件
 * - mail.sent / mail.failed：发信结果（至少一个收件人成功为 sent，全部失败为 failed）
 * - hosted_domain.activated：托管域名可以收信（NS 生效且收件路由、catch-all 就绪）
 * - hosted_domain.sending_ready：托管域名发信就绪
 * - hosted_domain.moved：托管域名的 NS 不再指向本站（或 zone 已不存在）
 */
export const WEBHOOK_EVENT_TYPES = [
  'mail.received',
  'mail.sent',
  'mail.failed',
  'hosted_domain.activated',
  'hosted_domain.sending_ready',
  'hosted_domain.moved',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
/** 测试发送使用的事件类型，不能订阅 */
export const WEBHOOK_TEST_EVENT_TYPE = 'webhook.test';

export const MAX_WEBHOOK_ENDPOINTS_PER_USER = 10;
export const MAX_WEBHOOK_FILTER_ADDRESSES = 50;
export const MAX_WEBHOOK_FILTER_DOMAINS = 20;
/** 每次投递最多尝试次数（首次 + 7 次退避重试） */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** includeBody 时正文（text、html 各自）截断上限，字符 */
export const WEBHOOK_BODY_MAX_CHARS = 64 * 1024;

const webhookUrlSchema = z.url().trim().startsWith('https://', 'Webhook 地址必须是 https').max(2048);
const eventsSchema = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length)
  .transform((events) => [...new Set(events)]);
const addressesSchema = z.array(emailAddressSchema).max(MAX_WEBHOOK_FILTER_ADDRESSES)
  .transform((list) => [...new Set(list)]);
const domainsSchema = z.array(domainSchema).max(MAX_WEBHOOK_FILTER_DOMAINS)
  .transform((list) => [...new Set(list)]);

/**
 * 创建端点。addresses / domains 是「或」关系的过滤：事件涉及的地址命中其一、或地址的域名命中其一就投递；
 * 两者都为空表示不按地址过滤（托管域名事件按 domains 过滤，addresses 对它们不生效）。
 */
export const createWebhookEndpointRequestSchema = z.object({
  url: webhookUrlSchema,
  description: z.string().trim().max(200).default(''),
  events: eventsSchema,
  addresses: addressesSchema.default([]),
  domains: domainsSchema.default([]),
  /** mail.received 是否附带正文 text/html（各自截断到 WEBHOOK_BODY_MAX_CHARS） */
  includeBody: z.boolean().default(false),
});
export type CreateWebhookEndpointRequest = z.infer<typeof createWebhookEndpointRequestSchema>;
export type CreateWebhookEndpointInput = z.input<typeof createWebhookEndpointRequestSchema>;

export const updateWebhookEndpointRequestSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    description: z.string().trim().max(200).optional(),
    events: eventsSchema.optional(),
    addresses: addressesSchema.optional(),
    domains: domainsSchema.optional(),
    includeBody: z.boolean().optional(),
    /** true 重新启用（清零连续失败并清空停用原因），false 手动停用 */
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: '至少提供一个待更新字段' });
export type UpdateWebhookEndpointRequest = z.infer<typeof updateWebhookEndpointRequestSchema>;

export type WebhookEndpointStatus = 'active' | 'disabled';

export interface WebhookEndpoint {
  id: number;
  url: string;
  description: string;
  events: WebhookEventType[];
  addresses: string[];
  domains: string[];
  includeBody: boolean;
  status: WebhookEndpointStatus;
  /** 停用原因：手动停用为空串；连续失败自动停用时说明原因 */
  disabledReason: string;
  /** 自上次成功以来连续失败的投递尝试次数 */
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** 签名密钥的前几位（whsec_ 加 4 个字符），用于核对接收端配置；完整密钥只在创建与轮换时返回一次 */
  secretPrefix: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建与轮换密钥的响应：带一次性返回的完整签名密钥 */
export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  /** whsec_ 加 base64 的 32 字节随机数（Svix 格式），只返回这一次 */
  secret: string;
}

export type WebhookDeliveryStatus = 'pending' | 'processing' | 'succeeded' | 'failed';

export interface WebhookDelivery {
  id: number;
  endpointId: number;
  /** 即请求头 webhook-id，同一事件的重试保持不变 */
  eventId: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastError: string;
  lastHttpStatus: number | null;
  createdAt: string;
}

/** POST /webhooks/:id/test 的结果：同步发送一次 webhook.test 事件 */
export interface WebhookTestResult {
  ok: boolean;
  httpStatus: number | null;
  error: string;
  durationMs: number;
}
