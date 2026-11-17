import { z } from 'zod';
import {
  type Role,
  API_SCOPES,
  DEFAULT_API_RATE_LIMIT,
  MAX_ADMIN_KEY_TTL_DAYS,
  MAX_API_RATE_LIMIT,
  MAX_KEY_ALLOWED_DOMAINS,
  MAX_KEY_ALLOWED_MAILBOXES,
  type ApiKeyStatus,
  type ApiScope,
} from '../constants.js';
import { currentPasswordSchema } from './auth.js';
import { domainSchema } from './mailbox.js';

const ipOrCidrSchema = z
  .string()
  .trim()
  .regex(
    /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/,
    'IP 或 CIDR 格式非法',
  );

/** Key 限定的邮箱：认领行 id（GET /api/mailboxes 的 id）；释放后重新认领会得到新 id，旧 Key 不再覆盖它 */
const allowedMailboxIdsSchema = z.array(z.number().int().positive()).max(MAX_KEY_ALLOWED_MAILBOXES)
  .transform((ids) => [...new Set(ids)]);
/** Key 限定的域名：该域名下的全部地址（含之后新认领的）都在范围内 */
const allowedDomainsSchema = z.array(domainSchema).max(MAX_KEY_ALLOWED_DOMAINS)
  .transform((domains) => [...new Set(domains)]);

/** admin scope 的硬性要求：IP 白名单非空，且有效期不超过 MAX_ADMIN_KEY_TTL_DAYS 天 */
export const ADMIN_KEY_TTL_MS = MAX_ADMIN_KEY_TTL_DAYS * 86_400_000;
export function adminKeyIssues(
  key: { scopes?: readonly string[]; allowedIps?: readonly string[]; expiresAt?: string | null },
  now = Date.now(),
): { path: 'allowedIps' | 'expiresAt'; message: string }[] {
  if (!key.scopes?.includes('admin')) return [];
  const issues: { path: 'allowedIps' | 'expiresAt'; message: string }[] = [];
  if (!key.allowedIps?.length) issues.push({ path: 'allowedIps', message: '带 admin scope 的 Key 必须设置 IP 白名单' });
  const expires = key.expiresAt ? Date.parse(key.expiresAt) : NaN;
  if (!Number.isFinite(expires)) {
    issues.push({ path: 'expiresAt', message: `带 admin scope 的 Key 必须设置有效期（不超过 ${MAX_ADMIN_KEY_TTL_DAYS} 天）` });
  } else if (expires > now + ADMIN_KEY_TTL_MS) {
    issues.push({ path: 'expiresAt', message: `带 admin scope 的 Key 有效期不能超过 ${MAX_ADMIN_KEY_TTL_DAYS} 天` });
  }
  return issues;
}

export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  rateLimit: z.number().int().min(1).max(MAX_API_RATE_LIMIT).default(DEFAULT_API_RATE_LIMIT),
  allowedIps: z.array(ipOrCidrSchema).max(32).default([]),
  /** ISO 时间；不传则永不过期（带 admin scope 时必填且不超过 90 天） */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  /** 只允许访问这些邮箱（认领行 id）；与 allowedDomains 都为空表示不限 */
  allowedMailboxIds: allowedMailboxIdsSchema.default([]),
  /** 只允许访问这些域名下的地址；与 allowedMailboxIds 都为空表示不限 */
  allowedDomains: allowedDomainsSchema.default([]),
  /** 当前登录密码：创建 Key 前重新验证（缺失 403 reauth_required，错误 403 reauth_failed） */
  password: currentPasswordSchema,
}).superRefine((value, ctx) => {
  for (const issue of adminKeyIssues(value)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateApiKeyInput = z.input<typeof createApiKeyRequestSchema>;

export const updateApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    scopes: z.array(z.enum(API_SCOPES)).min(1).optional(),
    rateLimit: z.number().int().min(1).max(MAX_API_RATE_LIMIT).optional(),
    allowedIps: z.array(ipOrCidrSchema).max(32).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    /** 续期：ISO 时间；显式传 null 表示改为永不过期（带 admin scope 时不允许） */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /** 整体替换；[] 表示取消该维度的限定 */
    allowedMailboxIds: allowedMailboxIdsSchema.optional(),
    allowedDomains: allowedDomainsSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '至少提供一个待更新字段',
  });
export type UpdateApiKeyRequest = z.infer<typeof updateApiKeyRequestSchema>;

export interface ApiKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  scopes: ApiScope[];
  rateLimit: number;
  allowedIps: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** 限定的邮箱（认领行 id）与域名；两者都为空表示不限 */
  allowedMailboxIds: number[];
  allowedDomains: string[];
  /** admin 全站视图返回 */
  ownerUsername?: string;
}

/**
 * GET /v1/me：当前 Key 与所属用户的自查信息。只读，任何有效 Key 都能调用（不要求 scope）。
 */
export interface ApiKeySelf {
  key: {
    id: number;
    name: string;
    keyPrefix: string;
    keySuffix: string;
    scopes: ApiScope[];
    /** 本 Key 每分钟请求上限 */
    rateLimit: number;
    allowedIps: string[];
    expiresAt: string | null;
    createdAt: string;
    /** 限定的邮箱（认领行 id）与域名；两者都为空表示不限 */
    allowedMailboxIds: number[];
    allowedDomains: string[];
    /** 这把 Key 实际按什么角色执行：所属用户是管理员且 Key 带 admin scope 时为 admin，否则 user */
    effectiveRole: Role;
  };
  /** 所属用户与其账户角色（不等于 Key 的执行角色，见 key.effectiveRole） */
  user: { id: number; username: string; role: Role };
  limits: {
    /** 同一用户全部 Key 合计的每分钟请求上限 */
    userRequestsPerMinute: number;
    /** /v1/messages/wait 每用户每分钟轮询次数上限 */
    waitPollsPerMinute: number;
  };
  /** 今日（UTC 自然日）外发用量。上限为 0 表示不限；按 Key 的执行角色判断，effectiveRole=admin 时不受外发配额约束（exempt=true，上限按 0 返回） */
  outbound: {
    sent: number;
    recipients: number;
    dailyLimit: number;
    dailyRecipientLimit: number;
    exempt: boolean;
    /** 下一个 UTC 零点（ISO） */
    resetsAt: string;
  };
}

export interface CreatedApiKey extends ApiKeySummary {
  /** 完整明文 key，仅创建时返回一次 */
  key: string;
}

export interface ApiRequestLogEntry {
  id: number;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  ip: string;
  /** 聚合行为同分钟内各请求耗时之和；平均耗时 = durationMs / count */
  durationMs: number;
  /**
   * 本行代表的请求数。成功的 GET（2xx 与 304）按 Key、路由、状态码、分钟聚合成一行，
   * requestId/ip/createdAt 取该分钟第一次请求；写操作与失败请求逐条记录，恒为 1。
   */
  count: number;
  createdAt: string;
}
