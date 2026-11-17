import type { UrlAttachment } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import type { StoredAttachment } from './outbound.js';

/** 拉取并转存后的 URL 附件：token 是转存出的上传附件（draft_attachments 行），发送成功后与 attachmentTokens 一起回收 */
export interface FetchedUrlAttachment extends StoredAttachment {
  token: string;
}

export interface UrlFetchOptions {
  /** 本站自身的主机名（请求的 Host、env.site_origin 的主机），不允许拉取 */
  selfHosts: string[];
  /** 本次请求还能容纳的附件字节数（MAX_ATTACHMENT_TOTAL_BYTES 减去其他附件） */
  budgetBytes: number;
  /** 转存出的附件直接被这个服务端草稿引用（draft_attachments.draft_id） */
  draftId?: number;
}

/**
 * 拉取 URL 附件并转存为上传附件（status=ready，计入每人待发送附件配额），按 items 顺序返回。
 * 只允许 https；DNS/IP 两层防 SSRF；限制大小、超时与重定向次数。失败时清理本次已转存的部分并抛
 * attachment_url_forbidden / attachment_url_fetch_failed / payload_too_large / rate_limited。
 */
export async function fetchUrlAttachments(
  _env: Env,
  _userId: number,
  items: UrlAttachment[],
  _options: UrlFetchOptions,
): Promise<FetchedUrlAttachment[]> {
  if (!items.length) return [];
  throw new AppError('attachment_url_fetch_failed', 'URL 附件尚未实现');
}
