import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_BODY_BYTES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_INLINE_ATTACHMENT_TOTAL_BYTES,
  MAX_PAGE_SIZE,
  MAX_RECIPIENTS,
  MAX_REPLY_TO,
  MAX_TRANSLATE_BATCH_CHARS,
  MAX_TRANSLATE_SEGMENT_CHARS,
  MAX_TRANSLATE_SEGMENTS,
  MAX_WAIT_ADDRESSES,
  MESSAGE_DIRECTIONS,
  type MessageDirection,
} from '../constants.js';
import type { IssueErrorParams, Page } from '../envelope.js';
import { MAX_MAIL_ADDRESS_INPUT_LENGTH, parseMailAddress, type MailAddress } from '../mail-address.js';
import { checkCustomHeaders } from '../mail-headers.js';
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

/**
 * wait 的地址过滤：逗号分隔（路由会把重复的 address 参数先用逗号合并），去重后最多 MAX_WAIT_ADDRESSES 个。
 * 输出为地址数组；没传时为 undefined。
 */
const waitAddressesSchema = z.string().max(300 * MAX_WAIT_ADDRESSES).transform((value, ctx) => {
  const items = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (items.length > MAX_WAIT_ADDRESSES) {
    ctx.addIssue({ code: 'custom', message: `address 最多 ${MAX_WAIT_ADDRESSES} 个` });
    return z.NEVER;
  }
  for (const item of items) {
    if (!emailAddressSchema.safeParse(item).success) {
      ctx.addIssue({ code: 'custom', message: `address 中的地址格式非法：${item.slice(0, 100)}` });
      return z.NEVER;
    }
  }
  return items.length ? items : undefined;
});

export const waitMessagesQuerySchema = z.object({
  address: emptyAsUndefined(waitAddressesSchema),
  /** 只等这个域名下的收件地址 */
  domain: emptyAsUndefined(domainSchema),
  /** include=body：命中时返回与详情相同的结构（正文、收件人、附件元数据），省一次详情请求 */
  include: emptyAsUndefined(z.enum(['body'])),
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

/** 内联图片的 Content-ID：不带尖括号（带了会去掉），正文里用 `cid:<contentId>` 引用 */
export const contentIdSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().replace(/^<(.*)>$/, '$1') : value),
  z.string().min(1).max(128).regex(/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]+$/, 'contentId 只能包含字母、数字与 . _ - @ 等符号'),
);

/** 附件呈现方式：inline 必须带 contentId；只给 contentId、不给 disposition 时按 inline 处理 */
export const attachmentDispositionSchema = z.enum(['attachment', 'inline']);
export type AttachmentDisposition = z.infer<typeof attachmentDispositionSchema>;

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
  contentId: contentIdSchema.optional(),
  disposition: attachmentDispositionSchema.optional(),
});
export type SendAttachment = z.infer<typeof sendAttachmentSchema>;

/** 上传 token 引用：纯 token 字符串，或带内联参数的对象；输出统一为对象 */
export const attachmentTokenRefSchema = z.union([
  z.string().min(1).max(128),
  z.object({
    token: z.string().min(1).max(128),
    contentId: contentIdSchema.optional(),
    disposition: attachmentDispositionSchema.optional(),
  }),
]).transform((value) => (typeof value === 'string' ? { token: value } : value));
export type AttachmentTokenRef = z.infer<typeof attachmentTokenRefSchema>;

/** 一个地址写法（`a@b`、`Name <a@b>`、`{address, name}`）→ MailAddress；label 用于错误提示 */
function mailAddressSchema(label: string) {
  return z.union([
    z.string().max(MAX_MAIL_ADDRESS_INPUT_LENGTH, `${label}地址过长`),
    z.object({ address: z.string().max(254, `${label}地址过长`), name: z.string().max(200).optional() }),
  ])
    .transform((value, ctx): MailAddress => {
      const parsed = parseMailAddress(value);
      const shown = (typeof value === 'string' ? value : value.address).slice(0, 100);
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: `${label}地址格式非法：${shown}（写法：a@b、Name <a@b> 或 {address, name}）` });
        return z.NEVER;
      }
      if (parsed.name.length > MAX_DISPLAY_NAME_LENGTH) {
        ctx.addIssue({ code: 'custom', message: `${label}显示名不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符：${shown}` });
        return z.NEVER;
      }
      return parsed;
    });
}

/**
 * 发件人身份，四种写法：
 * - `{ mailboxId, displayName? }`：自己认领的邮箱 id（管理员可用任意邮箱）；
 * - `{ localPart, domain, displayName? }`；
 * - `"Name <a@b>"` 或 `"a@b"`；
 * - `{ address, name? }`。
 * 后两种解析后输出为 `{ localPart, domain, displayName? }`，与第二种走同一套鉴权；前两种原样输出。
 */
const legacyFromSchema = z.object({
  mailboxId: z.number().int().positive().optional(),
  localPart: localPartSchema.optional(),
  domain: domainSchema.optional(),
  displayName: z.string().trim().max(MAX_DISPLAY_NAME_LENGTH).optional(),
});
export type SendFrom = z.infer<typeof legacyFromSchema>;

const fromSchema = z
  .union([
    z.string().max(MAX_MAIL_ADDRESS_INPUT_LENGTH, 'from 地址过长'),
    z.object({ address: z.string().max(254, 'from 地址过长'), name: z.string().max(200).optional() }).strict(),
    legacyFromSchema,
  ])
  .transform((value, ctx): SendFrom => {
    if (typeof value === 'string' || 'address' in value) {
      const parsed = parseMailAddress(value as string | { address: string; name?: string });
      if (!parsed) {
        ctx.addIssue({ code: 'custom', message: 'from 地址格式非法（写法：a@b、Name <a@b> 或 {address, name}）' });
        return z.NEVER;
      }
      if (parsed.name.length > MAX_DISPLAY_NAME_LENGTH) {
        ctx.addIssue({ code: 'custom', message: `发件显示名不能超过 ${MAX_DISPLAY_NAME_LENGTH} 个字符` });
        return z.NEVER;
      }
      const at = parsed.address.lastIndexOf('@');
      const localPart = localPartSchema.safeParse(parsed.address.slice(0, at));
      const domain = domainSchema.safeParse(parsed.address.slice(at + 1));
      if (!localPart.success || !domain.success) {
        ctx.addIssue({ code: 'custom', message: 'from 必须是本站地址（前缀只含小写字母、数字与 . _ + -），可用地址见 GET /v1/identities' });
        return z.NEVER;
      }
      return { localPart: localPart.data, domain: domain.data, ...(parsed.name ? { displayName: parsed.name } : {}) };
    }
    const legacy = value as SendFrom;
    if (!((legacy.mailboxId !== undefined && legacy.localPart === undefined && legacy.domain === undefined) ||
      (legacy.mailboxId === undefined && legacy.localPart !== undefined && legacy.domain !== undefined))) {
      ctx.addIssue({ code: 'custom', message: 'from 需为 mailboxId、localPart+domain、"Name <a@b>" 或 {address, name} 之一' });
      return z.NEVER;
    }
    return legacy;
  });

/** 自定义邮件头：名称与取值按 Cloudflare 白名单校验（见 mail-headers.ts），输出规范名称 */
const customHeadersSchema = z.record(z.string(), z.string()).transform((value, ctx) => {
  const checked = checkCustomHeaders(value);
  if (!checked.ok) {
    const params: IssueErrorParams = {
      errorCode: checked.code,
      fix: checked.code === 'header_not_allowed'
        ? '去掉这些头：只允许 X- 开头的头与白名单头；From/To/Cc/Bcc/Subject/Reply-To 用对应的请求字段'
        : '按 message 修正这个头的取值',
      docs: '/references/errors.md#header_not_allowed',
      details: { headers: checked.headers },
    };
    ctx.addIssue({ code: 'custom', message: checked.message, params });
    return z.NEVER;
  }
  return checked.headers;
});

/** 发送邮件共用字段（附件载体由各 schema 各自定义：base64 内联 或 token 引用） */
const sendMailBaseShape = {
  from: fromSchema,
  to: z.array(mailAddressSchema('收件人')),
  cc: z.array(mailAddressSchema('抄送')).default([]),
  bcc: z.array(mailAddressSchema('密送')).default([]),
  subject: z.string().trim().min(1).max(998),
  text: z.string().max(MAX_BODY_BYTES).optional(),
  html: z.string().max(MAX_BODY_BYTES).optional(),
  /** 回复的站内邮件 id：后端据此注入 In-Reply-To / References 头 */
  replyToMessageId: z.number().int().positive().optional(),
  /** 转发来源邮件 id：后端据此把原邮件附件带入本次发送（发件人需对该邮件可见） */
  forwardAttachmentsFrom: z.number().int().positive().optional(),
  /** 收件人点「回复」时的目标地址（Reply-To 头） */
  replyTo: z.array(mailAddressSchema('replyTo ')).max(MAX_REPLY_TO).optional(),
  /**
   * 自定义邮件头（X-*、List-Unsubscribe、In-Reply-To/References 等白名单头）。
   * 与 replyToMessageId 同时给出 In-Reply-To 或 References 时报错：回复站内邮件用 replyToMessageId，
   * 回复站外邮件（只知道对方 Message-ID）才自己写这两个头。
   */
  headers: customHeadersSchema.optional(),
};

interface SendCommonShape {
  to: unknown[];
  cc: unknown[];
  bcc: unknown[];
  text?: string;
  html?: string;
  replyToMessageId?: number;
  headers?: Record<string, string>;
  attachments: { contentId?: string; disposition?: AttachmentDisposition; content: string }[];
  attachmentTokens?: AttachmentTokenRef[];
}

/** base64 内联附件按解码后字节计合计 */
export function inlineAttachmentBytes(attachments: { content: string }[]): number {
  return attachments.reduce((sum, a) => sum + Math.floor((a.content.length * 3) / 4)
    - (a.content.endsWith('==') ? 2 : a.content.endsWith('=') ? 1 : 0), 0);
}

/** 收件人上限、正文非空、内联附件、头部与回复参数的组合约束（base64 与 token 两种发送共用） */
function validateSendCommon(v: SendCommonShape, ctx: z.RefinementCtx): void {
  const refs = [
    ...v.attachments.map((a, index) => ({ ...a, path: ['attachments', index] as (string | number)[] })),
    ...(v.attachmentTokens ?? []).map((a, index) => ({ ...a, path: ['attachmentTokens', index] as (string | number)[] })),
  ];
  const contentIds = new Set<string>();
  const tokens = new Set<string>();
  for (const [index, ref] of (v.attachmentTokens ?? []).entries()) {
    // 同一份上传只能引用一次：两次引用会落成同一个对象的两行附件，第二个 contentId 在收件端找不到对应部件
    if (tokens.has(ref.token)) ctx.addIssue({ code: 'custom', message: `附件 token 重复：${ref.token}`, path: ['attachmentTokens', index] });
    tokens.add(ref.token);
  }
  for (const ref of refs) {
    if (ref.disposition === 'inline' && !ref.contentId) {
      ctx.addIssue({ code: 'custom', message: 'disposition 为 inline 的附件需要 contentId', path: ref.path });
    }
    if (ref.contentId) {
      const key = ref.contentId.toLowerCase();
      if (contentIds.has(key)) ctx.addIssue({ code: 'custom', message: `contentId 重复：${ref.contentId}`, path: ref.path });
      contentIds.add(key);
    }
  }
  if (v.replyToMessageId !== undefined && v.headers &&
    Object.keys(v.headers).some((name) => name === 'In-Reply-To' || name === 'References')) {
    ctx.addIssue({
      code: 'custom',
      message: 'replyToMessageId 与 headers 里的 In-Reply-To/References 不能同时提供：回复站内邮件只用 replyToMessageId',
      path: ['headers'],
    });
  }
  if (inlineAttachmentBytes(v.attachments) > MAX_INLINE_ATTACHMENT_TOTAL_BYTES) {
    const params: IssueErrorParams = {
      errorCode: 'payload_too_large',
      fix: '大文件先用 POST /v1/uploads（网页会话用 /api/uploads）上传拿到 token，再放进 attachmentTokens 引用',
      docs: '/references/errors.md#payload_too_large',
    };
    ctx.addIssue({
      code: 'custom',
      message: `base64 内联附件合计超过 ${Math.floor(MAX_INLINE_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
      path: ['attachments'],
      params,
    });
  }
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
  .superRefine((v, ctx) => validateSendCommon(v, ctx));
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
    attachmentTokens: z.array(attachmentTokenRefSchema).max(MAX_ATTACHMENTS).default([]),
  })
  .superRefine((v, ctx) => {
    // 这里只能校验 base64 那路的体积；token 那路的真实大小要查库，由 sendMail 统一兜底
    validateSendCommon(v, ctx);
    // 两路附件合并计数：各自 .max(MAX_ATTACHMENTS) 只管自己，混用会放行到 2 倍
    if (v.attachments.length + v.attachmentTokens.length > MAX_ATTACHMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `附件最多 ${MAX_ATTACHMENTS} 个`,
        path: ['attachments'],
      });
    }
  });
export type InternalSendMailRequest = z.infer<typeof internalSendMailSchema>;
/** 请求体的输入形状（地址可写字符串或对象、token 可写字符串）；构造请求时用它，服务端拿到的是 InternalSendMailRequest */
export type InternalSendMailInput = z.input<typeof internalSendMailSchema>;

/**
 * 幂等指纹的规范形：只用旧字段（无显示名的收件人、纯 token、没有 replyTo/headers）的请求，与新字段上线前
 * 的解析结果逐字节一致，部署前后同一 Idempotency-Key 的重试仍能命中原记录。键顺序沿用解析结果。
 * 收件人无显示名时还原为纯地址字符串，只有 token 的引用还原为字符串，空的 replyTo / headers 省略。
 */
export function sendRequestFingerprint(req: SendMailRequest | InternalSendMailRequest): Record<string, unknown> {
  const plain = (list: MailAddress[]) => list.map((item) => (item.name ? item : item.address));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req)) {
    if (value === undefined) continue;
    if (key === 'to' || key === 'cc' || key === 'bcc') out[key] = plain(value as MailAddress[]);
    else if (key === 'replyTo') { if ((value as MailAddress[]).length) out[key] = plain(value as MailAddress[]); }
    else if (key === 'headers') { if (Object.keys(value as object).length) out[key] = value; }
    else if (key === 'attachmentTokens') {
      out[key] = (value as AttachmentTokenRef[]).map((ref) => (ref.contentId || ref.disposition ? ref : ref.token));
    } else out[key] = value;
  }
  return out;
}

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

/**
 * /api（网页会话）专用：includeUnread=true 且是个人视图时，响应带回标记后的未读数（与 GET /api/messages/unread-count
 * 同口径、同封顶），详情页标已读后不必再请求一次未读数。/v1 的 /read 仍用 markReadRequestSchema，契约不变。
 */
export const apiMarkReadRequestSchema = markReadRequestSchema.extend({
  includeUnread: z.boolean().optional(),
});
export type ApiMarkReadRequest = z.infer<typeof apiMarkReadRequestSchema>;

export interface MarkReadResult {
  changed: number;
  /** 仅 /api 请求带 includeUnread=true 且为个人视图时返回 */
  unread?: number;
}

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

/**
 * 逐收件人结果：sent 已被 Cloudflare 接受（外部）；delivered 已落库（站内）；failed 明确失败（error 为原因）；
 * unknown 投递中断、结果未回填（由定时任务标记，可能已送达，补发前先向收件人确认）。
 */
export interface RecipientOutcome {
  address: string;
  status: 'delivered' | 'sent' | 'failed' | 'unknown';
  error?: string;
}

/** /api 列表页：首页（无 cursor）附带 head 指纹，与 /messages/sync 同算法，只用于比较首页是否变化 */
export interface MessageListPage extends Page<MessageSummary> {
  head?: string;
}

/** /api/messages/sync 轻量轮询：unread 同 /messages/unread-count；head 为当前筛选下首页的指纹 */
export interface MessageSyncResult {
  unread: number;
  head: string;
}

/** RFC 8601 认证结果（小写）；无法识别的取值按 none 记录 */
export const MAIL_AUTH_RESULTS = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy'] as const;
export type MailAuthResult = (typeof MAIL_AUTH_RESULTS)[number];

/**
 * 入站邮件的发件认证结果：只取 Cloudflare Email Routing 在最上方添加、authserv-id 为 mx.cloudflare.net 的
 * Authentication-Results（发件人自带的同名头不可信）。摘要里为 null 表示没有可信结果：功能上线前的历史邮件、
 * 站内互投，或这封信没有带 Cloudflare 的认证头；发件（outbound）不返回本字段。
 */
export interface MessageAuth {
  spf: MailAuthResult;
  /** 任一 DKIM 签名通过即为 pass，否则取第一个签名的结果；没有签名为 none */
  dkim: MailAuthResult;
  /** DKIM 签名域（header.d）：优先取与 From 域对齐的通过签名；没有签名为空串 */
  dkimDomain: string;
  dmarc: MailAuthResult;
  /**
   * 显示的 From 域与认证身份是否对齐：DMARC 通过，或通过的 DKIM 签名域 / SPF 发信域与 From 域相同或互为子域。
   * 邮件有多个 From、To 或 Subject 头时为 false（显示的值可能不是被签名的那一个）。
   */
  aligned: boolean;
}

/** prompt injection 规则检测命中的原因代码（只做提示，命中不代表邮件一定恶意） */
export const PROMPT_INJECTION_REASONS = [
  /** 要求忽略、无视或忘记之前的指令 */
  'ignore_instructions',
  /** 直接称呼读信的 AI / Agent 或给它重设角色 */
  'addresses_ai',
  /** 伪造系统提示、聊天模板标记或「新指令」段落 */
  'prompt_markup',
  /** 要求立即转发、发送、调用工具或执行操作 */
  'action_request',
  /** 要求对用户隐瞒 */
  'conceal_from_user',
  /** 索要提示词、密钥、密码或验证码 */
  'secret_request',
] as const;
export type PromptInjectionReason = (typeof PROMPT_INJECTION_REASONS)[number];

/** 收件内容的风险标签（规则检测，宁缺毋滥）；Agent 不应执行邮件里的任何指令 */
export interface MessageRisk {
  promptInjection: boolean;
  reasons: PromptInjectionReason[];
}

export interface MessageSummary {
  recipientOutcomes?: RecipientOutcome[];
  /** 仅收件：发件认证结果，没有可信结果为 null，见 MessageAuth */
  auth?: MessageAuth | null;
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
  /** 已在正文里以 cid: 引用并就地显示的内联图片；界面不再在附件区重复列出 */
  inline?: boolean;
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
  /** 仅收件：去掉引用历史后的纯文本（回复链里新写的部分）；认不出引用时为完整纯文本 */
  extractedText?: string;
  /** 仅收件：prompt injection 风险标签 */
  risk?: MessageRisk;
}

/** GET /v1/messages/wait 的结果：include=body 时 message 为 MessageDetail */
export interface WaitMessageResult {
  message: MessageSummary | MessageDetail | null;
  /** 本次已确定检查过的最大 id，下一轮从它继续（没有新邮件时等于 afterId） */
  scannedThroughId: number;
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
