import { z } from 'zod';
import {
  DRAFT_STATUSES,
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MAX_REPLY_TO,
  type DraftStatus,
} from '../constants.js';
import type { IssueErrorParams } from '../envelope.js';
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
/** 常见的写错字段 → 正确字段（未知字段报错时提示）；用 Map，toString 这类与原型同名的键查不到东西 */
const DRAFT_FIELD_ALIASES = new Map<string, string>(Object.entries({
  scheduledAt: 'sendAt', scheduleAt: 'sendAt', scheduled_at: 'sendAt', send_at: 'sendAt', sendTime: 'sendAt', sendDate: 'sendAt',
  deliverAt: 'sendAt', schedule: 'sendAt', body: 'text 或 html', content: 'text 或 html', bodyText: 'text', bodyHtml: 'html',
  attachmentToken: 'attachmentTokens', tokens: 'attachmentTokens', reply_to: 'replyTo', replyToId: 'replyToMessageId',
  inReplyTo: 'replyToMessageId', forwardFrom: 'forwardAttachmentsFrom', version: 'expectedVersion', recipients: 'to/cc/bcc',
}));

const draftInputShape = {
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
};
const DRAFT_FIELDS = Object.keys(draftInputShape);

/**
 * 未知字段报 400（与 /v1 回复、转发一致），不静默忽略：例如把 sendAt 写成 scheduledAt 时草稿会被当成普通草稿保存、
 * 永远不会发出；立即发送时带 sendAt 则会被提前发出。fix 里给出最可能的正确写法与全部可用字段。
 */
function rejectUnknownFields(allowed: readonly string[], label: string, hint: (key: string) => string | undefined, docs: string) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx): void => {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (!unknown.length) return;
    const hints = unknown.flatMap((key) => hint(key) ?? []);
    const params: IssueErrorParams = { fix: `${hints.length ? `${hints.join('；')}。` : ''}${label}可用的字段：${allowed.join(', ')}`, docs };
    ctx.addIssue({ code: 'custom', message: `${label}不接受字段：${unknown.join(', ')}`, path: [unknown[0]!], params });
  };
}

const draftFieldHint = (key: string) => {
  const field = DRAFT_FIELD_ALIASES.get(key);
  return field === undefined ? undefined : `${key} 应写成 ${field}`;
};

export const draftInputSchema = z
  .looseObject(draftInputShape)
  .superRefine(rejectUnknownFields(DRAFT_FIELDS, '草稿', draftFieldHint, '/references/drafts.md#保存草稿'))
  .transform((v) => v as { [K in keyof typeof draftInputShape]: z.infer<(typeof draftInputShape)[K]> })
  .superRefine((v, ctx) => validateSendParts({
    to: v.to ?? [], cc: v.cc ?? [], bcc: v.bcc ?? [], text: v.text, html: v.html,
    replyToMessageId: v.replyToMessageId, headers: v.headers,
    attachments: v.attachments ?? [], attachmentTokens: v.attachmentTokens,
  }, ctx, false));
export type DraftInput = z.infer<typeof draftInputSchema>;
/** 请求体的输入形状（构造请求时用）：按字段表推导，不带 looseObject 的索引签名，写错字段名编译期就报错 */
export type DraftRequestBody = z.input<z.ZodObject<typeof draftInputShape>>;

/**
 * 立即发送（POST /drafts/:id/send）的可选请求体。人审场景下带上审阅时看到的 version：
 * 草稿在审阅后被改过（如 Agent 又 PATCH 了收件人）时返回 409，不会发出没看过的内容。已发送的仍重放原结果。
 */
const sendDraftShape = {
  expectedVersion: z.number().int().positive().optional(),
};
const SEND_DRAFT_FIELDS = Object.keys(sendDraftShape);

/** 立即发送误带的字段：定时时间、草稿内容要先 PATCH 进草稿；version 是 expectedVersion */
function sendDraftFieldHint(key: string): string | undefined {
  const field = key === 'sendAt' ? 'sendAt' : DRAFT_FIELD_ALIASES.get(key);
  if (field === 'expectedVersion') return `${key} 应写成 expectedVersion`;
  if (field === 'sendAt') return `这个接口立即发出；要定时发送，用 PATCH /drafts/:id 写 sendAt`;
  if (field !== undefined || DRAFT_FIELDS.includes(key)) return `${key} 是草稿内容，先用 PATCH /drafts/:id 改好再发送`;
  return undefined;
}

export const sendDraftRequestSchema = z
  .looseObject(sendDraftShape)
  .superRefine(rejectUnknownFields(SEND_DRAFT_FIELDS, '立即发送', sendDraftFieldHint, '/references/drafts.md#发送'))
  .transform((v) => v as { expectedVersion?: number });
export type SendDraftRequest = z.input<z.ZodObject<typeof sendDraftShape>>;

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
