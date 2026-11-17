import { z } from 'zod';
import { MAX_MAILBOX_GRANTEES, type Role, type UserStatus } from '../constants.js';
import { usernameSchema } from './auth.js';
import { adminBatchMailboxRefsSchema, domainSchema, mailboxAddressSchema } from './mailbox.js';
import type { UserMailboxPolicy } from './mailbox-policy.js';

/**
 * /v1/admin：管理员 Key（管理员账户 + admin scope）调用的运维接口。
 * 写操作复用 /api/admin/mailboxes/batch/* 的服务与语义；查询接口一次按一批地址、域名或用户名返回，
 * 运维脚本不再直连 D1 拼 SQL。
 */

/** 查询接口单次最多查询的条目数（地址、域名、用户名） */
export const MAX_ADMIN_LOOKUP = 200;

/** 逗号分隔的字符串拆成列表：去空白、去重、保持顺序；已是数组时原样交给后续校验 */
function splitLookupList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
}

/** 逗号分隔或重复参数合并后的列表，1–MAX_ADMIN_LOOKUP 项 */
export function adminLookupList<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(splitLookupList, z.array(item).min(1).max(MAX_ADMIN_LOOKUP));
}

// ---------- 目录：用户与托管域名 ----------

export const adminUsersQuerySchema = z.object({ usernames: adminLookupList(usernameSchema) });
export type AdminUsersQuery = z.infer<typeof adminUsersQuerySchema>;

/** 不存在的用户名不出现在结果里，调用方按 username 比对缺失项 */
export interface AdminUserView {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  /** 专属邮箱额度；null 表示使用全站公共配置 */
  mailboxPolicy: UserMailboxPolicy | null;
  mailboxPolicyRevision: number;
  createdAt: string;
}

/** 不带条件时返回全站托管域名（按 id 升序）；domains 与 owner 可同时给，取交集 */
export const adminHostedDomainsLookupSchema = z.object({
  domains: adminLookupList(domainSchema).optional(),
  owner: usernameSchema.optional(),
});
export type AdminHostedDomainsLookupQuery = z.infer<typeof adminHostedDomainsLookupSchema>;

export interface AdminHostedDomainView {
  id: number;
  domain: string;
  ownerId: number;
  ownerUsername: string;
  status: string;
  zoneStatus: string;
  routingStatus: string;
  sendingStatus: string;
  catchAllReady: boolean;
  /** 收发都已就绪：status 与 zoneStatus 为 active，routing 与 sending 为 ready，catch-all 已指向本站 */
  ready: boolean;
  createdAt: string;
}

// ---------- 邮箱 ----------

/** addresses 与 domain 二选一 */
export const adminMailboxesQuerySchema = z
  .object({
    addresses: adminLookupList(mailboxAddressSchema).optional(),
    domain: domainSchema.optional(),
  })
  .refine((value) => (value.addresses === undefined) !== (value.domain === undefined), {
    message: 'addresses 与 domain 必须且只能给一个',
    path: ['addresses'],
  });
export type AdminMailboxesQuery = z.infer<typeof adminMailboxesQuerySchema>;

/** 只返回已认领的邮箱；未认领的地址不出现在结果里 */
export interface AdminMailboxView {
  id: number;
  address: string;
  domain: string;
  ownerId: number;
  ownerUsername: string;
  grantees: { userId: number; username: string }[];
  createdAt: string;
}

/** 把每个邮箱的共享成员替换为 userIds（空数组表示清空）；不能包含邮箱所有者 */
export const adminBatchReplaceSharesRequestSchema = z.object({
  userIds: z.array(z.number().int().positive()).max(MAX_MAILBOX_GRANTEES),
  items: adminBatchMailboxRefsSchema,
});
export type AdminBatchReplaceSharesRequest = z.infer<typeof adminBatchReplaceSharesRequestSchema>;

// ---------- Claude 事实 ----------

export const CLAUDE_TIERS = ['5x', '20x'] as const;
export type ClaudeTier = (typeof CLAUDE_TIERS)[number];

/** 收据金额（美分）对应的 Max 档位：$100 为 5x，$200 为 20x，其余金额不推断 */
export function claudeTierFromAmount(amountCents: number | null): ClaudeTier | null {
  if (amountCents === 10_000) return '5x';
  if (amountCents === 20_000) return '20x';
  return null;
}

export const claudeDomainsQuerySchema = z.object({ domains: adminLookupList(domainSchema) });
export type ClaudeDomainsQuery = z.infer<typeof claudeDomainsQuerySchema>;

/** 每个后缀的 Claude 事实汇总；没有任何事实的域名也返回（计数为 0） */
export interface ClaudeDomainFacts {
  domain: string;
  /** 收到过 Anthropic 邮件的地址数 */
  addresses: number;
  paid: number;
  suspended: number;
  suspendedAddresses: { address: string; suspendedAt: string | null }[];
}

export const claudeAddressesQuerySchema = z.object({ addresses: adminLookupList(mailboxAddressSchema) });
export type ClaudeAddressesQuery = z.infer<typeof claudeAddressesQuerySchema>;

export interface ClaudeReceipt {
  /** 原邮件 id；邮件被永久删除后为 null，收据记录本身保留 */
  messageId: number | null;
  receivedAt: string;
  subject: string;
  amountCents: number | null;
  currency: string | null;
  tier: ClaudeTier | null;
  /** 扣款卡尾号（收据正文 `with - 1234`） */
  cardLast4: string | null;
}

/** 每个地址的 Claude 事实；没有任何 Anthropic 邮件的地址也返回（known=false） */
export interface ClaudeAddressFacts {
  address: string;
  domain: string;
  /** 是否收到过 Anthropic 的邮件（注册、登录链接、收据、封号通知等） */
  known: boolean;
  firstSeenAt: string | null;
  paid: boolean;
  suspended: boolean;
  suspendedAt: string | null;
  /**
   * 收到的 Anthropic / Claude 邮件数（发件域为 anthropic.com、claude.com 及其子域，含回收站，不含已永久删除的），
   * 以及最近一封的时间。cmu 运维说的「有登录记录」即 anthropicMails > 0
   */
  anthropicMails: number;
  lastAnthropicMailAt: string | null;
  /** 其中登录链接邮件（主题以 `Secure link to log in to Claude` 或 `Your secure link to Claude` 开头）的数量 */
  loginLinkMails: number;
  /** 按收到时间升序 */
  receipts: ClaudeReceipt[];
  /** 最近一张能识别金额的收据对应的档位 */
  tier: ClaudeTier | null;
}
