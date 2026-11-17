import { z } from 'zod';
import { LOCAL_PART_REGEX, MAX_BATCH_CLAIM, MAX_BATCH_SHARE_MAILBOXES, MAX_DISPLAY_NAME_LENGTH, MAX_MAILBOX_GRANTEES } from '../constants.js';
import type { ErrorCode } from '../envelope.js';
import { emptyAsUndefined, pageQueryShape } from './query.js';

export const localPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(LOCAL_PART_REGEX, '前缀需为 1-64 位小写字母/数字，中间可含 . _ + -');

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, '域名格式非法')
  .refine((v) => v.split('.').every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)), '域名标签需为 1-63 位，不能以连字符开头或结尾');

/** 管理列表可选分页的每页条数 */
export const LIST_PAGE_DEFAULT_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 200;

/** 查询参数里出现 cursor 或 limit（值可为空）即分页模式 */
const markPaged = (raw: unknown) =>
  raw !== null && typeof raw === 'object' ? { ...raw, paged: 'cursor' in raw || 'limit' in raw } : raw;

/**
 * 可选分页的列表查询：分页模式（paged=true）响应 Page，cursor 为空即首页，limit 缺省 50；
 * 两个参数都没出现时 paged=false，响应保持旧版的完整数组，已有脚本不受影响。
 */
export function withOptionalPage<T extends z.ZodRawShape>(shape: T) {
  const limitMessage = `limit 需为 1-${LIST_PAGE_MAX_LIMIT} 的整数`;
  return z.preprocess(markPaged, z.object({
    ...shape,
    paged: z.boolean(),
    cursor: pageQueryShape.cursor,
    limit: emptyAsUndefined(z.coerce.number().int(limitMessage).min(1, limitMessage).max(LIST_PAGE_MAX_LIMIT, limitMessage))
      .default(LIST_PAGE_DEFAULT_LIMIT),
  }));
}

/** 地址或所有者用户名的子串，按字面匹配（不支持通配符） */
const listSearchSchema = z.string().trim().toLowerCase().max(254).optional();

/** GET /api/mailboxes 与 /v1/mailboxes（all=1 另由路由校验权限）；q、domain 在两种模式下都生效 */
export const listMailboxesQuerySchema = withOptionalPage({
  q: listSearchSchema,
  domain: emptyAsUndefined(domainSchema),
});
export type ListMailboxesQuery = z.infer<typeof listMailboxesQuerySchema>;

/** GET /api/admin/mailbox-shares：mailboxId 只取该邮箱（0 或 1 项的数组，忽略分页参数） */
export const adminMailboxSharesQuerySchema = withOptionalPage({
  mailboxId: z.string().regex(/^[1-9]\d*$/, 'mailboxId 需为正整数').transform(Number)
    .refine(Number.isSafeInteger, 'mailboxId 需为正整数').optional(),
  q: listSearchSchema,
});

export const CLAIM_PLAN_STRATEGIES = ['uniform', 'claude'] as const;
export type ClaimPlanStrategy = (typeof CLAIM_PLAN_STRATEGIES)[number];

export const claimMailboxRequestSchema = z.object({
  localPart: localPartSchema,
  domain: domainSchema,
  /** claude：仅可认领从未观测到 Claude 封号的域名；缺省或 uniform 为普通认领 */
  strategy: z.enum(CLAIM_PLAN_STRATEGIES).optional(),
});
export type ClaimMailboxRequest = z.infer<typeof claimMailboxRequestSchema>;

/** 批量认领 / 批量可用性检查：按给出的顺序逐个处理 */
export const batchMailboxRequestSchema = z.object({
  items: z.array(claimMailboxRequestSchema).min(1).max(MAX_BATCH_CLAIM),
});
export type BatchMailboxRequest = z.infer<typeof batchMailboxRequestSchema>;

/**
 * 随机后缀分配（GET /api/mailboxes/random-plan）：只返回为当前用户分好的后缀，不认领。
 * uniform：在参与随机的可认领域名里等概率选；claude：排除任何有 Claude 封号记录的后缀，按账号负载均衡分配，每个后缀每天新增有上限。
 */
export const claimPlanQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(MAX_BATCH_CLAIM),
  strategy: z.enum(CLAIM_PLAN_STRATEGIES),
});
export type ClaimPlanQuery = z.infer<typeof claimPlanQuerySchema>;

export interface ClaimPlanItem {
  domain: string;
  /** 该后缀上收到过 Claude 封号信的地址数（根据历史来信统计） */
  suspended: number;
}

export interface ClaimPlan {
  strategy: ClaimPlanStrategy;
  /** 按分配顺序排列，长度不超过 count */
  items: ClaimPlanItem[];
  /** 参与随机且当前用户可认领、符合本次策略的域名（单个地址重新随机时从中选） */
  pool: string[];
  /** 没能分配的个数 */
  shortfall: number;
  /**
   * shortfall 的原因：quota 用户总认领额度不足；domain_quota 候选后缀的每域额度用完；
   * daily_limit 零封号候选后缀近 24 小时新增都已达上限；no_candidates 没有可用的后缀
   */
  reason: 'quota' | 'domain_quota' | 'daily_limit' | 'no_candidates' | null;
}

export const updateMailboxRequestSchema = z.object({
  displayName: z.string().trim().max(MAX_DISPLAY_NAME_LENGTH),
});
export type UpdateMailboxRequest = z.infer<typeof updateMailboxRequestSchema>;

/** 管理员强制过户；expectedOwnerId 来自最新的全站邮箱列表。 */
export const transferMailboxRequestSchema = z.object({
  userId: z.number().int().positive(),
  expectedOwnerId: z.number().int().positive(),
});
export type TransferMailboxRequest = z.infer<typeof transferMailboxRequestSchema>;

export interface Mailbox {
  id: number;
  address: string;
  domain: string;
  userId: number;
  /** 仅 admin ?all=1 场景返回 */
  ownerUsername?: string;
  displayName: string;
  messageCount: number;
  createdAt: string;
  /**
   * 列表接口返回：该邮箱所在域名当前能否发信（托管域名需发信就绪；系统域名恒为 true）。
   * 只反映域名状态；用它发信还要求调用者是所有者（管理员不限）。
   */
  canSend?: boolean;
}

/**
 * 不能用作发件身份的原因：hosted_sending_not_ready 托管域名的发信尚未就绪；
 * hosted_domain_unavailable 托管域名已暂停、迁走或删除中；shared_readonly 别人共享给我的邮箱只能读不能发（普通用户）。
 */
export type SendIdentityBlockReason = 'hosted_sending_not_ready' | 'hosted_domain_unavailable' | 'shared_readonly';

/** 一个具体的发件地址：自己认领的（kind=owned）或共享给我的（kind=shared：普通用户恒不能发；管理员可用 mailboxId 发，按域名状态判定） */
export interface SendIdentity {
  kind: 'owned' | 'shared';
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  canSend: boolean;
  /** canSend=false 时的原因；可发时为 null */
  reason: SendIdentityBlockReason | null;
}

/**
 * 可用任意前缀发信的域名（from 写 localPart+domain 或 "Name <任意前缀@域名>"），与发信的实际放行规则一致：
 * 管理员得到 system 系统域名、hosted 发信已就绪的托管域名、legacy 已从系统列表移除但仍有存量邮箱的旧域名；
 * 普通用户只得到自己作为所有者、已生效且发信就绪的托管域名（hosted），发出时自动把该地址认领给所有者
 * （不占全站每人认领上限），成员与共享不适用。
 */
export interface SendIdentityDomain {
  domain: string;
  kind: 'system' | 'hosted' | 'legacy';
  anyLocalPart: true;
}

/** GET /v1/identities 与 GET /api/identities */
export interface SendIdentities {
  identities: SendIdentity[];
  domains: SendIdentityDomain[];
}

/**
 * 不可认领原因：taken 已被占用；reserved 系统保留前缀；quota 达到个人认领上限；
 * domain_limit 达到该域名的每人上限；domain_unavailable 域名不存在或未对当前用户开放；
 * claude_suspended Claude 模式下域名存在历史封号记录。
 */
export type MailboxUnavailableReason = 'taken' | 'reserved' | 'quota' | 'domain_limit' | 'domain_unavailable' | 'claude_suspended';

export interface MailboxAvailability {
  address: string;
  available: boolean;
  /** available=false 时说明原因 */
  reason?: MailboxUnavailableReason;
}

/**
 * 批量认领结果：按请求顺序逐个认领，与单个认领同一套规则。
 * 被占用的跳过并继续；其他错误立即停止，已认领的保留。
 */
export interface BatchClaimMailboxResult {
  claimed: Mailbox[];
  /** 因已被占用而跳过的地址，保持请求顺序 */
  taken: ClaimMailboxRequest[];
  /** 停止后没有尝试的地址（含触发停止的那一个），保持请求顺序；全部尝试过时为空 */
  notAttempted: ClaimMailboxRequest[];
  /** 停止原因；null 表示全部尝试过 */
  stoppedBy: { code: ErrorCode; message: string } | null;
}

export interface MailboxTransferResult {
  mailbox: Mailbox;
  previousUserId: number;
  transferred: boolean;
  revokedShares: number;
}

/** 所有者或管理员替换邮箱共享名单。空数组表示全部撤销。 */
export const replaceMailboxSharesRequestSchema = z.object({
  mailboxId: z.number().int().positive(),
  userIds: z.array(z.number().int().positive()).max(MAX_MAILBOX_GRANTEES),
  expectedOwnerId: z.number().int().positive().optional(),
});
export type ReplaceMailboxSharesRequest = z.infer<typeof replaceMailboxSharesRequestSchema>;

/** 所有者把自己的多只邮箱一次共享给同一批用户：追加到各自名单，不移除已有成员。 */
export const batchShareMailboxesRequestSchema = z.object({
  mailboxIds: z.array(z.number().int().positive()).min(1).max(MAX_BATCH_SHARE_MAILBOXES),
  userIds: z.array(z.number().int().positive()).min(1).max(MAX_MAILBOX_GRANTEES),
});
export type BatchShareMailboxesRequest = z.infer<typeof batchShareMailboxesRequestSchema>;

export interface MailboxShareGrantee {
  userId: number;
  username: string;
  grantedAt: string;
  status: 'active' | 'disabled';
}

/** 所有者或管理员视角：邮箱及其共享名单 */
export interface MailboxShareGrant {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUserId: number;
  ownerUsername: string;
  grantees: MailboxShareGrantee[];
}

/** 被分享人视角：只读可见的邮箱，不能当发件身份 */
export interface SharedMailboxView {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUsername: string;
}

/** 管理员批量邮箱接口（/api/admin/mailboxes/batch/*，仅管理员 JWT）单次最多处理的项数 */
export const MAX_ADMIN_MAILBOX_BATCH = 100;

/** 完整邮箱地址：前缀与域名规则同认领，按小写比较 */
export const mailboxAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(318)
  .refine((value) => {
    const at = value.lastIndexOf('@');
    return at > 0 && localPartSchema.safeParse(value.slice(0, at)).success && domainSchema.safeParse(value.slice(at + 1)).success;
  }, '邮箱地址格式非法');

const userIdSchema = z.number().int().positive();

/** 同一批里重复的地址会让逐项结果含糊（第二项看到的是第一项的结果），直接拒绝整批 */
function uniqueAddresses<T extends { address: string }>(items: T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.address)) ctx.addIssue({ code: 'custom', message: `地址 ${item.address} 在本批中重复`, path: [index, 'address'] });
    seen.add(item.address);
  });
}

/** 按地址指定已认领邮箱；expectedOwnerId 可选，给了就与当前所有者比对，不一致的项不处理 */
export const adminBatchMailboxRefSchema = z.object({
  address: mailboxAddressSchema,
  expectedOwnerId: userIdSchema.optional(),
});

export const adminBatchMailboxRefsSchema = z.array(adminBatchMailboxRefSchema).min(1).max(MAX_ADMIN_MAILBOX_BATCH).superRefine(uniqueAddresses);

/** 为指定用户批量认领：按该用户自己的认领规则逐个认领，响应同 POST /api/mailboxes/batch */
export const adminBatchClaimRequestSchema = z.object({
  userId: userIdSchema,
  items: z.array(claimMailboxRequestSchema).min(1).max(MAX_ADMIN_MAILBOX_BATCH),
});
export type AdminBatchClaimRequest = z.infer<typeof adminBatchClaimRequestSchema>;

/** 批量释放；deleteHistory=true 时同时永久删除这些地址的全部历史邮件 */
export const adminBatchReleaseRequestSchema = z.object({
  items: adminBatchMailboxRefsSchema,
  deleteHistory: z.boolean().default(false),
});
export type AdminBatchReleaseRequest = z.infer<typeof adminBatchReleaseRequestSchema>;

/** 批量过户给同一个用户；每项必须带 expectedOwnerId（同单个过户） */
export const adminBatchTransferRequestSchema = z.object({
  userId: userIdSchema,
  items: z.array(adminBatchMailboxRefSchema.extend({ expectedOwnerId: userIdSchema }))
    .min(1).max(MAX_ADMIN_MAILBOX_BATCH).superRefine(uniqueAddresses),
});
export type AdminBatchTransferRequest = z.infer<typeof adminBatchTransferRequestSchema>;

/** 批量共享（追加，不移除已有成员）与批量取消共享：同一批用户作用于每个邮箱 */
export const adminBatchShareRequestSchema = z.object({
  userIds: z.array(userIdSchema).min(1).max(MAX_MAILBOX_GRANTEES),
  items: adminBatchMailboxRefsSchema,
});
export type AdminBatchShareRequest = z.infer<typeof adminBatchShareRequestSchema>;

/**
 * 逐项结果。done 已执行；unchanged 已是目标状态（已归目标用户、成员都已在或都不在名单里）；
 * failed 未执行，原因见 error（not_found 邮箱不存在、conflict 所有者与 expectedOwnerId 不符、其余同单个接口）。
 */
export interface AdminMailboxBatchItemResult {
  address: string;
  status: 'done' | 'unchanged' | 'failed';
  mailboxId: number | null;
  /** 处理前的所有者；邮箱不存在时为 null */
  ownerId: number | null;
  error: { code: ErrorCode; message: string } | null;
  /** 释放：删除的历史邮件数（deleteHistory=false 时为 0） */
  deletedMessages?: number;
  /** 释放与过户：撤销的共享数；取消共享：移除的成员数 */
  revokedShares?: number;
  /** 共享：新增的成员数 */
  addedShares?: number;
}

export interface AdminMailboxBatchResult {
  /** 与请求 items 同序 */
  results: AdminMailboxBatchItemResult[];
  done: number;
  unchanged: number;
  failed: number;
}
