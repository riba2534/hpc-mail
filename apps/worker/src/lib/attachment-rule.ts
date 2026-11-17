import { sql } from 'drizzle-orm';
import { attachments } from '../db/schema.js';

/**
 * hasAttachments 的口径：带 Content-ID 的 inline 部件是正文里的内嵌图（logo、签名图），不算附件，
 * 否则带内嵌 logo 的通知邮件在列表里也显示回形针。列表、详情、发信响应与幂等重放共用这一条规则。
 */
export const COUNTS_AS_ATTACHMENT = sql`NOT (${attachments.disposition} = 'inline' AND ${attachments.contentId} <> '')`;

export function countsAsAttachment(att: { disposition: string; contentId: string }): boolean {
  return !(att.disposition === 'inline' && att.contentId !== '');
}
