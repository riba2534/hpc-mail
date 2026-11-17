import { z } from 'zod';
import {
  DRAFT_STATUSES,
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MAX_REPLY_TO,
  type DraftStatus,
} from '../constants.js';
import type { MailAddress } from '../mail-address.js';
import {
  attachmentTokenRefSchema,
  customHeadersSchema,
  isoTimeSchema,
  mailAddressSchema,
  sendAttachmentItemSchema,
  sendFromSchema,
  validateSendParts,
  type AttachmentDisposition,
  type AttachmentTokenRef,
  type SendFrom,
  type SingleUploadResult,
} from './mail.js';
import { emptyAsUndefined, pageQueryShape } from './query.js';

/**
 * 创建（POST /drafts）与修改（PATCH /drafts/:id）服务端草稿共用的请求体。字段与发信请求相同，但都可暂缺：
 * 创建时缺省为空；修改时缺省表示保持原值，null 表示清空（from、replyToMessageId、forwardAttachmentsFrom、sendAt）。
 *
 * 附件：attachments（base64 或 {url}）在保存时就转存为上传附件（同 POST /uploads 的 token，计入同一份待发送附件配额），
 * 草稿里只保存 token。修改时只要给了 attachments 或 attachmentTokens 之一，附件集合就整体替换为
 * 「本次 attachments 转存出的 token + 本次 attachmentTokens」；要保留原有附件，把它们的 token 写进 attachmentTokens。
 *
 * sendAt：ISO 8601（带时区），最早 1 分钟后、最晚 30 天内（sendAtProblem）；给出即安排定时发送（status=scheduled），
 * 此时草稿必须已是完整、合法的发信请求。null 取消定时（回到 draft）。expectedVersion 只用于修改：与当前 version 不同返回 409。
 */
export const draftInputSchema = z
  .object({
    from: sendFromSchema.nullable().optional(),
    to: z.array(mailAddressSchema('收件人')).optional(),
    cc: z.array(mailAddressSchema('抄送')).optional(),
    bcc: z.array(mailAddressSchema('密送')).optional(),
    replyTo: z.array(mailAddressSchema('replyTo ')).max(MAX_REPLY_TO).optional(),
    subject: z.string().trim().max(998).optional(),
    text: z.string().max(MAX_BODY_BYTES).optional(),
    html: z.string().max(MAX_BODY_BYTES).optional(),
    replyToMessageId: z.number().int().positive().nullable().optional(),
    forwardAttachmentsFrom: z.number().int().positive().nullable().optional(),
    headers: customHeadersSchema.optional(),
    attachments: z.array(sendAttachmentItemSchema).max(MAX_ATTACHMENTS).optional(),
    attachmentTokens: z.array(attachmentTokenRefSchema).max(MAX_ATTACHMENTS).optional(),
    sendAt: isoTimeSchema.nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .superRefine((v, ctx) => validateSendParts({
    to: v.to ?? [], cc: v.cc ?? [], bcc: v.bcc ?? [], text: v.text, html: v.html,
    replyToMessageId: v.replyToMessageId, headers: v.headers,
    attachments: v.attachments ?? [], attachmentTokens: v.attachmentTokens,
  }, ctx, false));
export type DraftInput = z.infer<typeof draftInputSchema>;
/** 请求体的输入形状（构造请求时用） */
export type DraftRequestBody = z.input<typeof draftInputSchema>;

/**
 * 立即发送（POST /drafts/:id/send）的可选请求体。人审场景下带上审阅时看到的 version：
 * 草稿在审阅后被改过（如 Agent 又 PATCH 了收件人）时返回 409，不会发出没看过的内容。已发送的仍重放原结果。
 */
export const sendDraftRequestSchema = z.object({
  expectedVersion: z.number().int().positive().optional(),
});
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;

export const listDraftsQuerySchema = z.object({
  status: emptyAsUndefined(z.enum(DRAFT_STATUSES)),
  ...pageQueryShape,
});
export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>;

/** 草稿里的附件：已转存的上传附件（token 可直接写进 attachmentTokens 保留它） */
export interface DraftAttachment extends SingleUploadResult {
  contentId: string;
  disposition: AttachmentDisposition;
}

/** 列表项：不含正文 */
export interface DraftSummary {
  id: number;
  status: DraftStatus;
  /** 每次修改加 1；PATCH 带 expectedVersion 做并发保护 */
  version: number;
  from: SendFrom | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  /** 正文摘要（同邮件列表的 preview） */
  preview: string;
  attachmentCount: number;
  /** 定时发送时间（ISO）；未安排为 null */
  sendAt: string | null;
  /** 发送后对应的发件记录 id（GET /messages/:id 查看结果）；未发送为 null */
  messageId: number | null;
  /** 上一次发送失败或定时发送被取消的原因；没有为空串 */
  errorDetail: string;
  /** web：网页创建；api：API Key 创建（Agent 草稿，人审后再发） */
  createdVia: 'web' | 'api';
  /** API Key 创建时为该 Key 的名称（Key 已删除时为 null） */
  apiKeyName: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/** 草稿详情：列表项 + 完整内容 */
export interface Draft extends DraftSummary {
  replyTo: MailAddress[];
  text: string;
  html: string;
  headers: Record<string, string>;
  replyToMessageId: number | null;
  forwardAttachmentsFrom: number | null;
  attachments: DraftAttachment[];
}

/**
 * 草稿内容的存储形状（drafts.content 列的 JSON；正文另存 body_text / body_html 列）。
 * 字段是 draftInputSchema 解析后的值，可直接作为发信请求再交给 internalSendMailSchema 解析。
 */
export interface StoredDraftContent {
  from: SendFrom | null;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  headers: Record<string, string>;
  replyToMessageId: number | null;
  forwardAttachmentsFrom: number | null;
  attachmentTokens: AttachmentTokenRef[];
}

/** 由存储内容与正文拼出发信请求的输入（交给 internalSendMailSchema.safeParse 做完整校验） */
export function draftSendInput(content: StoredDraftContent, text: string, html: string): Record<string, unknown> {
  return {
    ...(content.from ? { from: content.from } : {}),
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    ...(content.replyTo.length ? { replyTo: content.replyTo } : {}),
    subject: content.subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(content.replyToMessageId ? { replyToMessageId: content.replyToMessageId } : {}),
    ...(content.forwardAttachmentsFrom ? { forwardAttachmentsFrom: content.forwardAttachmentsFrom } : {}),
    ...(Object.keys(content.headers).length ? { headers: content.headers } : {}),
    attachments: [],
    attachmentTokens: content.attachmentTokens,
  };
}
