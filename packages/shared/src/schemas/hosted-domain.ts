import { z } from 'zod';
import { MAX_HOSTED_DOMAIN_BATCH, MAX_HOSTED_DOMAIN_MEMBERS } from '../constants.js';
import type { ErrorCode } from '../envelope.js';
import { domainSchema, withOptionalPage } from './mailbox.js';

/**
 * 托管域名：用户把自己的域名 NS 指向站长 Cloudflare 账户分配的名称服务器，系统自动开通收发。
 * - pending：zone 已创建，等待用户在注册商处把 NS 改为分配值
 * - provisioning：NS 已生效，正在开通收件路由（Email Routing + catch-all）与发信（Email Sending）
 * - active：收发均已就绪
 * - error：NS 已生效但开通或巡检未通过，系统定时重试
 * - moved：NS 已不再指向本站（改回原服务商或域名过期），收发停止
 * - suspended：管理员暂停，拒收、禁止发信与新认领
 * - deleting：删除中，正在清理地址、邮件与 Cloudflare 配置
 */
export const HOSTED_DOMAIN_STATUSES = ['pending', 'provisioning', 'active', 'error', 'moved', 'suspended', 'deleting'] as const;
export type HostedDomainStatus = (typeof HOSTED_DOMAIN_STATUSES)[number];

/** NS 生效后的状态：可以认领地址、收信（未认领地址自动归域名所有者） */
export const HOSTED_DOMAIN_USABLE_STATUSES = ['provisioning', 'active', 'error'] as const satisfies readonly HostedDomainStatus[];

/** 当前用户与域名的关系：所有者、被共享的成员，或以管理员身份查看他人的域名 */
export type HostedDomainRole = 'owner' | 'member' | 'admin';

/** 单个开通环节：waiting 尚未完成（含等待 NS），ready 已生效，error 失败待重试 */
export type HostedDomainStepState = 'waiting' | 'ready' | 'error';

export interface HostedDomainSteps {
  /** 域名 NS 已指向分配的名称服务器（Cloudflare zone 已激活） */
  nameServers: HostedDomainStepState;
  /** 收件路由（Email Routing 的 MX / SPF / DKIM） */
  routing: HostedDomainStepState;
  /** 全部地址（catch-all）投递到本站 */
  catchAll: HostedDomainStepState;
  /** 发信（Email Sending 的退信域与 DKIM / DMARC） */
  sending: HostedDomainStepState;
}

export interface HostedDomain {
  id: number;
  domain: string;
  status: HostedDomainStatus;
  /** 当前查看者的身份 */
  role: HostedDomainRole;
  ownerUserId: number;
  ownerUsername: string;
  /** 需要在注册商处填写的名称服务器 */
  nameServers: string[];
  /** 创建时 Cloudflare 识别到的原名称服务器与注册商（删除托管前可据此改回） */
  originalNameServers: string[];
  originalRegistrar: string;
  steps: HostedDomainSteps;
  /** 需要用户处理的提示，例如 DNSSEC 未关闭 */
  warnings: string[];
  /** 最近一次开通或巡检的错误；空串表示无 */
  lastError: string;
  /** 每位成员在该域名下最多认领的地址数（0=不限） */
  memberLimit: number;
  memberCount: number;
  /** 该域名下已认领的地址数（含所有成员） */
  mailboxCount: number;
  createdAt: string;
  activatedAt: string | null;
  /** 最近一次与 Cloudflare 核对状态的时间 */
  checkedAt: string | null;
  /** pending 状态下到期仍未生效会自动删除；其他状态为 null */
  expiresAt: string | null;
}

export interface HostedDomainMember {
  userId: number;
  username: string;
  status: 'active' | 'disabled';
  grantedAt: string;
  /** 该成员在此域名下已认领的地址数 */
  mailboxCount: number;
}

export const createHostedDomainRequestSchema = z.object({
  domain: domainSchema,
});
export type CreateHostedDomainRequest = z.infer<typeof createHostedDomainRequestSchema>;

/** 列表里规范化后重复的项报在第二次出现的位置 */
function rejectDuplicates<T>(items: T[], ctx: z.RefinementCtx, field: string, label: string): void {
  const seen = new Set<T>();
  items.forEach((item, index) => {
    if (seen.has(item)) ctx.addIssue({ code: 'custom', message: `${field} 中有重复的${label}：${String(item)}`, path: [field, index] });
    seen.add(item);
  });
}

/** 批量添加托管域名：按顺序逐个添加，每项独立结果 */
export const batchCreateHostedDomainsRequestSchema = z.object({
  domains: z.array(domainSchema).min(1).max(MAX_HOSTED_DOMAIN_BATCH),
}).superRefine((value, ctx) => rejectDuplicates(value.domains, ctx, 'domains', '域名'));
export type BatchCreateHostedDomainsRequest = z.infer<typeof batchCreateHostedDomainsRequestSchema>;

/** 批量立即检测：按顺序逐个检测，每项独立结果 */
export const batchCheckHostedDomainsRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(MAX_HOSTED_DOMAIN_BATCH),
}).superRefine((value, ctx) => rejectDuplicates(value.ids, ctx, 'ids', '域名 id'));
export type BatchCheckHostedDomainsRequest = z.infer<typeof batchCheckHostedDomainsRequestSchema>;

/** 批量操作中单项的失败原因，取值与错误信封的 error 相同（不含 details） */
export interface HostedDomainBatchError {
  code: ErrorCode;
  message: string;
  fix?: string;
  docs?: string;
}

/** 单项结果：成功时带该域名的最新视图，失败时带原因；因额度或前序错误未处理的项也是失败 */
export type HostedDomainBatchOutcome =
  | { ok: true; hostedDomain: HostedDomain }
  | { ok: false; error: HostedDomainBatchError };

export type HostedDomainBatchCreateItem = { domain: string } & HostedDomainBatchOutcome;
export type HostedDomainBatchCheckItem = { id: number } & HostedDomainBatchOutcome;

/** 批量结果：items 与请求顺序一一对应 */
export interface HostedDomainBatchResult<T extends HostedDomainBatchOutcome> {
  items: T[];
  succeeded: number;
  failed: number;
}

export const updateHostedDomainRequestSchema = z.object({
  memberLimit: z.number().int().min(0).max(10000),
});
export type UpdateHostedDomainRequest = z.infer<typeof updateHostedDomainRequestSchema>;

/** 替换成员名单（空数组表示全部移除）；被移除成员已认领的地址保留给他 */
export const replaceHostedDomainMembersRequestSchema = z.object({
  userIds: z.array(z.number().int().positive()).max(MAX_HOSTED_DOMAIN_MEMBERS),
  expectedOwnerId: z.number().int().positive(),
});
export type ReplaceHostedDomainMembersRequest = z.infer<typeof replaceHostedDomainMembersRequestSchema>;

/** 过户：includeMailboxes=true 时原所有者在该域名下的地址连同历史邮件一起过户 */
export const transferHostedDomainRequestSchema = z.object({
  userId: z.number().int().positive(),
  expectedOwnerId: z.number().int().positive(),
  includeMailboxes: z.boolean(),
});
export type TransferHostedDomainRequest = z.infer<typeof transferHostedDomainRequestSchema>;

export interface HostedDomainTransferResult {
  /** 调用者过户后不再有权限（原所有者且不是管理员或成员）时为 null */
  domain: HostedDomain | null;
  previousUserId: number;
  transferred: boolean;
  /** 随域名一起过户的地址数 */
  movedMailboxes: number;
}

/** 管理员全站托管域名：数组模式最多 1000 条；分页模式按 id 倒序（见 withOptionalPage） */
export const adminHostedDomainsQuerySchema = withOptionalPage({
  status: z.enum(HOSTED_DOMAIN_STATUSES).optional(),
  q: z.string().trim().toLowerCase().max(253).optional(),
});
export type AdminHostedDomainsQuery = z.infer<typeof adminHostedDomainsQuerySchema>;

/** 管理员查看托管功能的运行条件：Worker 是否配置了 Cloudflare 凭据、凭据是否有效 */
export interface HostedDomainsHealth {
  /** 设置里的总开关 */
  enabled: boolean;
  /** Worker 已配置 cf_api_token 与 cf_account_id */
  configured: boolean;
  /** 凭据校验结果；未配置时为 null */
  tokenValid: boolean | null;
  /** 校验失败原因 */
  error: string;
  /** 站长账户当前 zone 总数与其中 pending 的数量（Cloudflare 在超过 50 个且 pending 多于 active 时禁止新增） */
  accountZones: number | null;
  accountPendingZones: number | null;
}
