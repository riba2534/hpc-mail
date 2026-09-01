import { z } from 'zod';
import { DEFAULT_RESERVED_LOCAL_PARTS, REGISTRATION_MODES } from '../constants.js';
import { emailAddressSchema } from './mail.js';
import { domainSchema } from './mailbox.js';

/** 掩码占位：设置回显时密文一律显示为该值；提交时值等于它则不更新 */
export const SECRET_MASK = '******';

export const registerModeSchema = z.enum(REGISTRATION_MODES);

export const gmailForwardSettingSchema = z.object({
  enabled: z.boolean(),
  /** 转发目标邮箱；已验证 destination 走原生 forward，其余走 no-reply 中转 */
  addresses: z.array(emailAddressSchema).max(5),
});

export const feishuSettingSchema = z.object({
  enabled: z.boolean(),
  webhookUrl: z
    .union([z.literal(''), z.url().startsWith('https://')])
    .default(''),
  secret: z.string().max(128).default(''),
  /** 推送内容分级：仅验证码 / 摘要 / 全文原文。default 使旧配置（无此字段）仍能解析 */
  contentLevel: z.enum(['code_only', 'summary', 'full']).default('summary'),
});

export const codeExtractSettingSchema = z.object({
  enabled: z.boolean(),
  aiEnabled: z.boolean(),
});

/** 通用 webhook：新邮件时 POST JSON 到自定义 https 端点（带 HMAC 签名），供 Bark/ntfy/自建服务 */
export const notifyWebhookSettingSchema = z.object({
  enabled: z.boolean(),
  url: z.union([z.literal(''), z.url().startsWith('https://')]).default(''),
  secret: z.string().max(128).default(''),
});

export const siteSettingSchema = z.object({
  title: z.string().trim().min(1).max(64),
});

export const apiSettingSchema = z.object({
  enabled: z.boolean(),
});

/** 安全策略 */
export const securitySettingSchema = z.object({
  /** 要求所有用户启用两步验证：未启用者登录后强制引导设置 */
  require2fa: z.boolean(),
});

/**
 * 单个系统域名条目。
 * - `public`：是否对普通用户开放（可见 + 可认领）。默认 false = 仅管理员可用。
 * - `perUserLimit`：普通用户在**该域名**下最多可认领的地址数（0=不限，仅受全局 mailbox_policy.perUserLimit 约束）；管理员豁免。
 * preprocess：兼容历史存储的纯字符串形态（`"example.com"` → `{ domain: "example.com" }`），
 * 老数据升级后自动落到 public=false（默认仅管理员），不影响存量已认领地址。
 */
export const domainEntrySchema = z.preprocess(
  (v) => (typeof v === 'string' ? { domain: v } : v),
  z.object({
    domain: domainSchema,
    public: z.boolean().default(false),
    perUserLimit: z.number().int().min(0).max(10000).default(0),
  }),
);
export type DomainEntry = z.infer<typeof domainEntrySchema>;

/** 系统域名列表：管理端维护，空数组表示未配置任何域名（认领/发件将被拒） */
export const domainsSettingSchema = z.object({
  list: z.array(domainEntrySchema).max(64),
});

/** 邮件保留策略：catch-all 全量落库，需定期清理防止无限膨胀撑爆 D1（0=不清理） */
export const retentionSettingSchema = z.object({
  /** 未被任何用户认领的地址收到的 inbound 邮件保留天数（这些是 catch-all 垃圾的主要来源） */
  unclaimedDays: z.number().int().min(0).max(3650),
  /** 全局所有邮件（含已认领）保留天数，作为总上限兜底；0=不限 */
  allMessagesDays: z.number().int().min(0).max(3650),
});

/** 外发配额：防被盗账号/恶意用户脚本化群发 spam 烧域名信誉（admin 豁免，0=不限） */
export const quotaSettingSchema = z.object({
  /** 普通用户每日外发邮件条数上限 */
  dailyOutbound: z.number().int().min(0).max(100000),
  /** 普通用户每日外发唯一收件人（站内 + 站外）总数上限 */
  dailyRecipients: z.number().int().min(0).max(1000000),
});

/** 邮箱认领策略：保留前缀防身份冒充 + 每用户认领上限防囤积（admin 豁免） */
export const mailboxPolicySettingSchema = z.object({
  /** 普通用户最多可认领地址数（0=不限） */
  perUserLimit: z.number().int().min(0).max(10000),
  /** 保留前缀：普通用户禁止认领（大小写不敏感），admin 不受限 */
  reservedLocalParts: z.array(z.string().trim().toLowerCase().max(64)).max(200),
});

// gmail_forward / feishu / notify_webhook 已从系统设置下放为「每用户的个人转发与通知偏好」
// （见 schemas/notify-prefs.ts）；下面三个 schema 定义保留、被个人偏好复用。
export const SETTING_SCHEMAS = {
  register_mode: registerModeSchema,
  code_extract: codeExtractSettingSchema,
  site: siteSettingSchema,
  api: apiSettingSchema,
  domains: domainsSettingSchema,
  retention: retentionSettingSchema,
  quota: quotaSettingSchema,
  mailbox_policy: mailboxPolicySettingSchema,
  security: securitySettingSchema,
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;

export type Settings = {
  [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]>;
};

export const DEFAULT_SETTINGS: Settings = {
  register_mode: 'closed',
  code_extract: { enabled: true, aiEnabled: true },
  site: { title: 'HPC Mail' },
  api: { enabled: true },
  domains: { list: [] },
  // 保留策略默认关闭（0），避免升级即意外删除历史邮件；管理员按需开启（建议未认领 90 天）
  retention: { unclaimedDays: 0, allMessagesDays: 0 },
  // 外发配额默认对普通用户生效（admin 豁免），防脚本群发
  quota: { dailyOutbound: 200, dailyRecipients: 500 },
  mailbox_policy: {
    perUserLimit: 50,
    reservedLocalParts: [...DEFAULT_RESERVED_LOCAL_PARTS],
  },
  security: { require2fa: false },
};

export const updateSettingsRequestSchema = z
  .object({
    register_mode: registerModeSchema.optional(),
    code_extract: codeExtractSettingSchema.optional(),
    site: siteSettingSchema.optional(),
    api: apiSettingSchema.optional(),
    domains: domainsSettingSchema.optional(),
    retention: retentionSettingSchema.optional(),
    quota: quotaSettingSchema.optional(),
    mailbox_policy: mailboxPolicySettingSchema.optional(),
    security: securitySettingSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '至少提供一个待更新配置',
  });
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

/** 公开配置（无鉴权 GET /api/config） */
export interface PublicConfig {
  siteTitle: string;
  registrationMode: z.infer<typeof registerModeSchema>;
  domains: string[];
  /** 是否强制两步验证（前端据此引导未启用用户设置） */
  require2fa: boolean;
}

/** 域名接入自检状态：DNS-over-HTTPS 探测 MX/SPF 是否已指向 Cloudflare Email Routing（无需 CF 凭据） */
export interface DomainOnboardingStatus {
  domain: string;
  /** 已加入系统域名列表 */
  inList: boolean;
  /** MX 已指向 Cloudflare Email Routing（*.mx.cloudflare.net）→ 视为该域已开启 Email Routing */
  mxReady: boolean;
  /** SPF TXT 已包含 Cloudflare Email Routing（_spf.mx.cloudflare.net） */
  spfReady: boolean;
  /** 实测到的 MX 目标主机（用于展示与排查） */
  mxRecords: string[];
  /** DNS 查询本身是否成功（false=探测失败，需重试；≠ 域名未接入） */
  resolved: boolean;
}
