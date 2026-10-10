import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_BODY_BYTES,
  MAX_PAGE_SIZE,
  MAX_RECIPIENTS,
  MAX_TRANSLATE_BATCH_CHARS,
  MAX_TRANSLATE_SEGMENT_CHARS,
  MAX_TRANSLATE_SEGMENTS,
  MESSAGE_DIRECTIONS,
  type MessageDirection,
} from '../constants.js';
import { domainSchema, localPartSchema } from './mailbox.js';

export const emailAddressSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, '邮箱地址格式非法');

/**
 * 查询参数里的空串按「没传」处理。skill.md 教的就是 `?cursor=&limit=` 这种形状，
 * 而 z.coerce.number() 会把 '' 转成 0 再被 min(1) 拒掉——外部调用方照文档拼串直接 400。
 * 前端不受影响（api/client.ts 本来就跳过空串），纯粹是外部调用方的陷阱。
 */
function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** 布尔开关参数：接受 1/true/0/false，空串等同未传 */
function boolFlag() {
  return z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
      .transform((v) => v === '1' || v === 'true')
      .optional(),
  );
}

export const listMessagesQuerySchema = z.object({
  direction: z.enum(MESSAGE_DIRECTIONS).optional(),
  domain: domainSchema.optional(),
  address: emailAddressSchema.optional(),
  unread: boolFlag(),
  starred: boolFlag(),
  /** 回收站视图：只看软删除的邮件 */
  trash: boolFlag(),
  /** 搜索主题 / 发件人 / 正文 */
  q: z.string().trim().max(256).optional(),
  /**
   * 可见范围。普通用户仅支持 mine（自己认领及共享收件），其他范围拒绝。
   * admin：缺省/'mine' = 自己认领；'unclaimed' = 未认领地址；'user' = 指定用户（需 userId）。
   */
  scope: z.enum(['mine', 'unclaimed', 'user']).optional(),
  /** admin + scope=user 时指定目标用户 */
  userId: emptyAsUndefined(z.coerce.number().int().positive()),
  /** 增量拉取：只返回 id 大于该值的邮件（配合轮询/长轮询等码，避免漏检） */
  afterId: emptyAsUndefined(z.coerce.number().int().nonnegative()),
  cursor: emptyAsUndefined(z.string().max(128)),
  limit: emptyAsUndefined(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)).default(
    DEFAULT_PAGE_SIZE,
  ),
})
  .superRefine((q, ctx) => {
    if (q.scope === 'user' && q.userId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'scope=user 需要 userId', path: ['userId'] });
    }
  });
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type MessageListScope = NonNullable<ListMessagesQuery['scope']>;
export type MessageMutationScope = 'mine' | 'unclaimed';

/** 详情/线程/附件与批量操作复用同一范围参数，非法范围不能降级成默认范围。 */
export const messageViewQuerySchema = z.object({
  scope: z.enum(['mine', 'unclaimed', 'user']).optional(),
  userId: emptyAsUndefined(z.coerce.number().int().positive()),
}).superRefine((query, ctx) => {
  if (query.scope === 'user' && query.userId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'scope=user 需要 userId', path: ['userId'] });
  }
});

/** 发件人过滤：完整地址，或 `@域名` 匹配该域全部发件人 */
const senderFilterSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((v) => /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(v) || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), '发件人需为完整地址或 @域名');

export const waitMessagesQuerySchema = z.object({
  address: emptyAsUndefined(emailAddressSchema),
  afterId: emptyAsUndefined(z.coerce.number().int().nonnegative()).default(0),
  timeout: emptyAsUndefined(z.coerce.number().int().min(1).max(50)).default(25),
  /** 只等指定发件人（完整地址或 @域名）；不匹配的新邮件被跳过 */
  from: emptyAsUndefined(senderFilterSchema),
  /** 只等主题包含该文本（不区分大小写）的邮件 */
  subjectContains: emptyAsUndefined(z.string().trim().min(1).max(200)),
  /** 只等已提取出验证码的邮件 */
  hasCode: boolFlag(),
  scope: z.enum(['mine', 'unclaimed', 'user']).optional(),
  userId: emptyAsUndefined(z.coerce.number().int().positive()),
}).superRefine((query, ctx) => {
  if (query.scope === 'user' && query.userId === undefined) {
    ctx.addIssue({ code: 'custom', message: 'scope=user 需要 userId', path: ['userId'] });
  }
});
export type WaitMessagesQuery = z.infer<typeof waitMessagesQuerySchema>;

/** 附件文件名：禁路径分隔符与 .. 遍历 */
export const attachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((v) => !/[/\\]/.test(v) && !v.includes('..'), '文件名非法');

export const sendAttachmentSchema = z.object({
  filename: attachmentFilenameSchema,
  contentType: z.string().trim().min(3).max(128),
  /**
   * base64 编码内容。允许含空白：`base64 file.pdf`、Python `base64.encodebytes()`、
   * `openssl base64` 产出的都是 76 字符折行的多行 base64，直接拒掉等于逼调用方
   * 必须知道要加 `-w0`。这里统一去掉空白后再校验，解码前也会去一次。
   */
  content: z
    .string()
    .min(1)
    .transform((v) => v.replace(/\s+/g, ''))
    .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 !== 1 &&
      (!v.endsWith('=') || v.length % 4 === 0), '附件需为合法 base64'),
});

/** 发件人身份：mailboxId 或 localPart+domain 二选一 */
const fromSchema = z
  .object({
    mailboxId: z.number().int().positive().optional(),
    localPart: localPartSchema.optional(),
    domain: domainSchema.optional(),
    displayName: z.string().trim().max(64).optional(),
  })
  .refine(
    (f) =>
      (f.mailboxId !== undefined && f.localPart === undefined && f.domain === undefined) ||
      (f.mailboxId === undefined && f.localPart !== undefined && f.domain !== undefined),
    'from 需为 mailboxId 或 localPart+domain 二选一',
  );

/** 发送邮件共用字段（附件载体由各 schema 各自定义：base64 内联 或 token 引用） */
const sendMailBaseShape = {
  from: fromSchema,
  to: z.array(emailAddressSchema),
  cc: z.array(emailAddressSchema).default([]),
  bcc: z.array(emailAddressSchema).default([]),
  subject: z.string().trim().min(1).max(998),
  text: z.string().max(MAX_BODY_BYTES).optional(),
  html: z.string().max(MAX_BODY_BYTES).optional(),
  /** 回复的站内邮件 id：后端据此注入 In-Reply-To / References 头 */
  replyToMessageId: z.number().int().positive().optional(),
  /** 转发来源邮件 id：后端据此把原邮件附件带入本次发送（发件人需对该邮件可见） */
  forwardAttachmentsFrom: z.number().int().positive().optional(),
};

/** 收件人上限 + 正文非空（base64 与 token 两种发送共用） */
function validateSendCommon(
  v: { to: unknown[]; cc: unknown[]; bcc: unknown[]; text?: string; html?: string },
  ctx: z.RefinementCtx,
): void {
  if (v.to.length + v.cc.length + v.bcc.length === 0) ctx.addIssue({ code: 'custom', message: '至少需要一个收件人', path: ['to'] });
  if (v.to.length + v.cc.length + v.bcc.length > MAX_RECIPIENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `收件人合计不能超过 ${MAX_RECIPIENTS} 个`,
      path: ['to'],
    });
  }
  const utf8Length = (value: string) => { let bytes = 0; for (const char of value) { const cp = char.codePointAt(0)!; bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4; } return bytes; };
  const bytes = utf8Length(v.text ?? '') + utf8Length(v.html ?? '');
  if (bytes > MAX_BODY_BYTES) ctx.addIssue({ code: 'custom', message: '正文 UTF-8 字节合计超过上限', path: ['body'] });
  if ((v.text ?? '').length === 0 && (v.html ?? '').length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '正文不能为空', path: ['body'] });
  }
}

/**
 * 基础发送契约：附件以 base64 内联（AI/脚本一步发送，一般不带大附件）。
 * 保留原契约不破坏；附件合计按 base64 解码后字节数估 ≤ MAX_ATTACHMENT_TOTAL_BYTES。
 */
export const sendMailRequestSchema = z
  .object({
    ...sendMailBaseShape,
    attachments: z.array(sendAttachmentSchema).max(MAX_ATTACHMENTS).default([]),
  })
  .superRefine((v, ctx) => {
    validateSendCommon(v, ctx);
    const total = v.attachments.reduce((sum, a) => sum + Math.ceil((a.content.length * 3) / 4), 0);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
        path: ['attachments'],
      });
    }
  });
export type SendMailRequest = z.infer<typeof sendMailRequestSchema>;

/**
 * /api 与 /v1：附件两种来源均可（向后兼容）——
 *  · attachmentTokens：前端先分片上传到 R2 再引用（治本：请求体极小、不卡 UI、不超时）
 *  · attachments(base64)：AI / 脚本 / 旧调用方直接内联（与 /v1 一致，skill.md 教的就是这种）
 * 两者可混用，合并后送 sendMail。
 */
export const internalSendMailSchema = z
  .object({
    ...sendMailBaseShape,
    attachments: z.array(sendAttachmentSchema).max(MAX_ATTACHMENTS).default([]),
    attachmentTokens: z.array(z.string().min(1)).max(MAX_ATTACHMENTS).default([]),
  })
  .superRefine((v, ctx) => {
    validateSendCommon(v, ctx);
    // 两路附件合并计数：各自 .max(MAX_ATTACHMENTS) 只管自己，混用会放行到 2 倍
    if (v.attachments.length + v.attachmentTokens.length > MAX_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件最多 ${MAX_ATTACHMENTS} 个`,
        path: ['attachments'],
      });
    }
    // 这里只能校验 base64 那路的体积；token 那路的真实大小要查库，由 sendMail 统一兜底
    const total = v.attachments.reduce((sum, a) => sum + Math.ceil((a.content.length * 3) / 4), 0);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
        path: ['attachments'],
      });
    }
  });
export type InternalSendMailRequest = z.infer<typeof internalSendMailSchema>;

/**
 * 附件独立上传（先落 R2 草稿区，发送时引用 token）
 */
/** 大文件分片上传：初始化（创建 R2 multipart upload） */
export const initMultipartUploadSchema = z.object({
  filename: attachmentFilenameSchema,
  mimeType: z.string().trim().min(3).max(128),
  size: z.number().int().positive().max(MAX_ATTACHMENT_FILE_BYTES, '单文件超过上限'),
});
export type InitMultipartUploadRequest = z.infer<typeof initMultipartUploadSchema>;

/** R2 multipart 单个分片（uploadPart 返回、complete 时按 partNumber 升序回传） */
export const uploadedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10000),
  etag: z.string().min(1),
});
export type UploadedPart = z.infer<typeof uploadedPartSchema>;

/** 大文件分片上传：完成（提交所有 parts 触发 R2 complete） */
export const completeMultipartUploadSchema = z.object({
  parts: z.array(uploadedPartSchema).min(1),
});
export type CompleteMultipartUploadRequest = z.infer<typeof completeMultipartUploadSchema>;

/** 单片直传响应（{data} 信封内） */
export interface SingleUploadResult {
  token: string;
  filename: string;
  size: number;
  mimeType: string;
}
/** 分片初始化响应：前端据此切片 */
export interface MultipartInitResult {
  token: string;
  uploadId: string;
  /** 每片大小（字节） */
  partBytes: number;
  /** 预计分片总数 */
  partCount: number;
}
export interface MultipartPartResult {
  partNumber: number;
  etag: string;
}
export interface MultipartCompleteResult {
  token: string;
  size: number;
}
export interface DraftAttachmentMeta {
  token: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * 变更类操作的作用范围。admin 必须显式传 'unclaimed' 才动未认领地址下的邮件
 * （防漏传参数误改他人已认领邮件）。不能改其他用户已认领地址。
 * /api 与 /v1 均接受 query 或 body，同一次请求不能传冲突的范围。
 */
const mutationScopeSchema = z.enum(['mine', 'unclaimed']).optional();

/**
 * 全部已读：按与列表相同的筛选收窄范围（domain/address/q），只处理自己认领的地址
 * （admin scope=unclaimed 处理未认领地址）。共享邮件的已读状态属于所有者，任何情况下都不改。
 */
export const markAllReadRequestSchema = z.object({
  scope: mutationScopeSchema,
  domain: domainSchema.optional(),
  address: emailAddressSchema.optional(),
  q: z.string().trim().max(256).optional(),
});
export type MarkAllReadRequest = z.infer<typeof markAllReadRequestSchema>;

export const markReadRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  isRead: z.boolean().default(true),
  scope: mutationScopeSchema,
});
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const deleteMessagesRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  scope: mutationScopeSchema,
});
export type DeleteMessagesRequest = z.infer<typeof deleteMessagesRequestSchema>;

/** 回收站：恢复 / 永久删除（复用 ids 形态） */
export const messageIdsRequestSchema = deleteMessagesRequestSchema;
export type MessageIdsRequest = DeleteMessagesRequest;

export const starMessagesRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
  starred: z.boolean().default(true),
  scope: mutationScopeSchema,
});
export type StarMessagesRequest = z.infer<typeof starMessagesRequestSchema>;

export interface RecipientOutcome {
  address: string;
  status: 'delivered' | 'sent' | 'failed';
  error?: string;
}

export interface MessageSummary {
  recipientOutcomes?: RecipientOutcome[];
  id: number;
  direction: MessageDirection;
  address: string;
  domain: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  preview: string;
  verificationCode: string;
  /** 入站邮件中识别出的验证/登录链接（http/https）；没有则为空串 */
  verificationLink?: string;
  status: string;
  /** 发送失败/部分失败原因（inbound 与成功发送为空串）；让调用方能识别「假成功」 */
  errorDetail: string;
  /** 收件人 To 列表；仅 outbound 填充，供已发送列表展示「发给了谁」 */
  recipientsTo?: string[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  size: number;
  createdAt: string;
  /** 仅回收站列表返回：进入回收站的时间，用于计算剩余保留天数 */
  deletedAt?: string;
}

export interface AttachmentMeta {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string;
  disposition: string;
  /** 短期签名下载 URL（详情接口下发） */
  url: string;
}

export interface MessageRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface MessageDetail extends MessageSummary {
  replyTo?: string[];
  recipients: MessageRecipients;
  bodyText: string;
  bodyHtml: string;
  attachments: AttachmentMeta[];
  /** 是否存有原始 .eml，可经 /api/messages/:id/raw 下载 */
  hasRaw: boolean;
}

/**
 * 邮件翻译（POST /api/messages/:id/translate，scope 等查询参数同详情）：
 * segments 是前端从该邮件主题与正文中按文字节点/段落切出的片段，按顺序翻译成简体中文。
 * 服务端只翻译能在该邮件内容中找到的片段，找不到的原样返回并计入 skipped。
 */
export const translateMessageRequestSchema = z.object({
  segments: z
    .array(z.string().max(MAX_TRANSLATE_SEGMENT_CHARS))
    .min(1)
    .max(MAX_TRANSLATE_SEGMENTS)
    .refine((items) => items.reduce((sum, item) => sum + item.length, 0) <= MAX_TRANSLATE_BATCH_CHARS, `单次翻译总字符数不能超过 ${MAX_TRANSLATE_BATCH_CHARS}`),
});
export type TranslateMessageRequest = z.infer<typeof translateMessageRequestSchema>;

export interface MessageTranslation {
  /** 与请求 segments 一一对应的简体中文译文 */
  translations: string[];
  /** 是否命中服务端缓存（命中不消耗额度） */
  cached: boolean;
  /** 未在邮件内容中找到、因此原样返回的片段数 */
  skipped: number;
}
