import { z } from 'zod';
import {
  feishuSettingSchema,
  gmailForwardSettingSchema,
  notifyWebhookSettingSchema,
} from './admin-settings.js';

/** 个人飞书 / 通用 webhook / 邮箱转发 的配置形状（与旧全局设置同形，复用校验） */
export type FeishuConfig = z.infer<typeof feishuSettingSchema>;
export type WebhookConfig = z.infer<typeof notifyWebhookSettingSchema>;
export type ForwardConfig = z.infer<typeof gmailForwardSettingSchema>;

/**
 * 每用户的转发与通知偏好。语义：
 * - 作用于「该用户认领地址收到的邮件」。
 * - 管理员的这一份**还**作用于收信当时尚未认领的地址（catch-all）与系统级通知。
 * - forward（转发到外部邮箱）：已验证 destination 走原生 forward（原样转发）；
 *   未验证目标降级为 no-reply@收件域名 中转重发，任意邮箱均可送达。
 */
export const userNotifyPrefsSchema = z.object({
  feishu: feishuSettingSchema,
  webhook: notifyWebhookSettingSchema,
  forward: gmailForwardSettingSchema,
});
export type UserNotifyPrefs = z.infer<typeof userNotifyPrefsSchema>;

export const DEFAULT_USER_NOTIFY_PREFS: UserNotifyPrefs = {
  feishu: { enabled: false, webhookUrl: '', secret: '', contentLevel: 'summary' },
  webhook: { enabled: false, url: '', secret: '' },
  forward: { enabled: false, addresses: [] },
};

/** 更新请求：三块各自可选，至少一块 */
export const updateNotifyPrefsRequestSchema = z
  .object({
    feishu: feishuSettingSchema.optional(),
    webhook: notifyWebhookSettingSchema.optional(),
    forward: gmailForwardSettingSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '至少提供一个待更新项',
  });
export type UpdateNotifyPrefsRequest = z.infer<typeof updateNotifyPrefsRequestSchema>;
