import { z } from 'zod';
import { MAX_PAGE_SIZE, MAX_WAIT_ADDRESSES, MESSAGE_DIRECTIONS } from '../constants.js';
import { emailAddressSchema, internalSendMailSchema, listMessagesQuerySchema, waitMessagesQuerySchema } from './mail.js';
import { claimMailboxRequestSchema } from './mailbox.js';

/**
 * 远程 MCP（同一 Worker 的 /mcp，Streamable HTTP，无状态）。工具参数用 JSON 原生类型（布尔、整数、数组），
 * 字段约束取自对应 REST 接口的 schema；工具调用转成对应的 /v1 请求，由 REST 接口再按原 schema 校验一次。
 */

/** 支持的协议版本，第一个是最新版本：initialize 请求的版本不在其中时按它协商 */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export const MCP_RESPONSE_FORMATS = ['concise', 'detailed'] as const;
export type McpResponseFormat = (typeof MCP_RESPONSE_FORMATS)[number];

const responseFormat = z.enum(MCP_RESPONSE_FORMATS).default('concise')
  .describe('concise（默认）只返回常用字段并截断正文；detailed 返回与对应 REST 接口相同的完整结构');

/** 与 REST 的 Idempotency-Key 头同一规则：1-128 位可见 ASCII */
const idempotencyKey = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/, 'idempotencyKey 必须是 1-128 位可见 ASCII 字符')
  .describe('同 REST 的 Idempotency-Key 头：一次逻辑发信用一个，网络错误或超时后用同一个 Key 和相同参数重试不会重复发送')
  .optional();

const messageId = z.number().int().positive();
const sendShape = internalSendMailSchema.shape;
const waitShape = waitMessagesQuerySchema.shape;
const listShape = listMessagesQuerySchema.shape;
const flag = (description: string) => z.boolean().optional().describe(description);

export const mcpToolInputSchemas = {
  get_me: z.object({}).strict(),
  list_identities: z.object({ response_format: responseFormat }),
  list_mailboxes: z.object({ response_format: responseFormat }),
  claim_mailbox: claimMailboxRequestSchema.extend({ response_format: responseFormat }),
  release_mailbox: z.object({
    mailboxId: z.number().int().positive().optional().describe('要释放的邮箱 id（claim_mailbox、list_mailboxes 返回）'),
    address: emailAddressSchema.optional().describe('也可以给完整地址，服务端先查 GET /v1/mailboxes 找到 id（另需 mailbox.read）'),
    deleteHistory: z.boolean().default(false).describe('true 时永久删除该地址的全部历史邮件；默认保留给下一个认领者'),
  }).refine((value) => (value.mailboxId === undefined) !== (value.address === undefined), {
    message: 'mailboxId 与 address 必须且只能给一个',
  }),
  send_email: z.object({ ...sendShape, idempotencyKey, response_format: responseFormat }),
  reply_email: z.object({
    messageId: messageId.describe('要回复的邮件 id'),
    from: sendShape.from.optional().describe('发件身份，写法同 send_email；默认用原邮件所在的地址'),
    text: sendShape.text,
    html: sendShape.html,
    replyAll: z.boolean().default(false).describe('true 时把原邮件的其他收件人（To、Cc，去掉自己）放进抄送'),
    cc: sendShape.cc.optional(),
    bcc: sendShape.bcc.optional(),
    attachments: sendShape.attachments.optional(),
    attachmentTokens: sendShape.attachmentTokens.optional(),
    headers: sendShape.headers,
    idempotencyKey,
    response_format: responseFormat,
  }),
  search_messages: z.object({
    q: listShape.q.describe('按主题、发件人、正文搜索'),
    direction: z.enum(MESSAGE_DIRECTIONS).optional(),
    address: listShape.address.describe('只看这个收件或发件地址'),
    domain: listShape.domain,
    unread: flag('true 只看未读（只统计自己认领的地址）'),
    starred: flag('true 只看星标'),
    afterId: z.number().int().nonnegative().optional().describe('只返回 id 大于它的邮件，用于增量同步'),
    cursor: z.string().max(128).optional().describe('上一页返回的 nextCursor，原样传回'),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    response_format: responseFormat,
  }),
  get_message: z.object({ messageId: messageId.describe('邮件 id'), response_format: responseFormat }),
  wait_for_message: z.object({
    address: z.union([emailAddressSchema, z.array(emailAddressSchema).min(1).max(MAX_WAIT_ADDRESSES)]).optional()
      .describe(`只等发到这些地址的邮件，一个地址或最多 ${MAX_WAIT_ADDRESSES} 个地址的数组`),
    domain: waitShape.domain.describe('只等发到这个域名的邮件'),
    from: waitShape.from.describe('只等这个发件人：完整地址，或 @域名'),
    subjectContains: waitShape.subjectContains.describe('只等主题包含该文本（不区分大小写）的邮件'),
    hasCode: flag('true 只等已识别出验证码的邮件'),
    afterId: z.number().int().nonnegative().default(0)
      .describe('只等 id 大于它的邮件：先用 search_messages 取最新一封的 id 作基线，超时后用返回的 scannedThroughId 继续'),
    timeout: z.number().int().min(1).max(50).default(25).describe('最长等待秒数'),
    response_format: responseFormat,
  }),
} as const;

export type McpToolName = keyof typeof mcpToolInputSchemas;
export const MCP_TOOL_NAMES = Object.keys(mcpToolInputSchemas) as McpToolName[];
export type McpToolArgs<T extends McpToolName> = z.output<(typeof mcpToolInputSchemas)[T]>;

/** search_messages 参数 → GET /v1/messages 查询串 */
export function mcpSearchQuery(args: McpToolArgs<'search_messages'>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of ['q', 'direction', 'address', 'domain', 'cursor'] as const) {
    if (args[key] !== undefined) query[key] = args[key];
  }
  for (const key of ['unread', 'starred'] as const) {
    if (args[key] !== undefined) query[key] = args[key] ? '1' : '0';
  }
  if (args.afterId !== undefined) query.afterId = String(args.afterId);
  if (args.limit !== undefined) query.limit = String(args.limit);
  return query;
}

/** wait_for_message 参数 → GET /v1/messages/wait 查询串；detailed 等同 include=body */
export function mcpWaitQuery(args: McpToolArgs<'wait_for_message'>): Record<string, string> {
  const query: Record<string, string> = { afterId: String(args.afterId), timeout: String(args.timeout) };
  if (args.address !== undefined) query.address = ([] as string[]).concat(args.address).join(',');
  for (const key of ['domain', 'from', 'subjectContains'] as const) {
    if (args[key] !== undefined) query[key] = args[key];
  }
  if (args.hasCode !== undefined) query.hasCode = args.hasCode ? '1' : '0';
  if (args.response_format === 'detailed') query.include = 'body';
  return query;
}
