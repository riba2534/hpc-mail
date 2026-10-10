import { z } from 'zod';
import { LOCAL_PART_REGEX } from '../constants.js';

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

export const claimMailboxRequestSchema = z.object({
  localPart: localPartSchema,
  domain: domainSchema,
});
export type ClaimMailboxRequest = z.infer<typeof claimMailboxRequestSchema>;

export const updateMailboxRequestSchema = z.object({
  displayName: z.string().trim().max(64),
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
}

/**
 * 不可认领原因：taken 已被占用；reserved 系统保留前缀；quota 达到个人认领上限；
 * domain_limit 达到该域名的每人上限；domain_unavailable 域名不存在或未对当前用户开放。
 */
export type MailboxUnavailableReason = 'taken' | 'reserved' | 'quota' | 'domain_limit' | 'domain_unavailable';

export interface MailboxAvailability {
  address: string;
  available: boolean;
  /** available=false 时说明原因 */
  reason?: MailboxUnavailableReason;
}

export interface MailboxTransferResult {
  mailbox: Mailbox;
  previousUserId: number;
  transferred: boolean;
  revokedShares: number;
}

/** 管理员替换某只自己认领的邮箱的共享名单。空数组表示全部撤销。 */
export const replaceMailboxSharesRequestSchema = z.object({
  mailboxId: z.number().int().positive(),
  userIds: z.array(z.number().int().positive()).max(100),
});
export type ReplaceMailboxSharesRequest = z.infer<typeof replaceMailboxSharesRequestSchema>;

export interface MailboxShareGrantee {
  userId: number;
  username: string;
  grantedAt: string;
}

/** 管理员视角：自己认领的一只邮箱及其共享名单 */
export interface MailboxShareGrant {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  grantees: MailboxShareGrantee[];
}

/** 被分享人视角：只读可见的管理员邮箱，不能当发件身份 */
export interface SharedMailboxView {
  mailboxId: number;
  address: string;
  domain: string;
  displayName: string;
  ownerUsername: string;
}
