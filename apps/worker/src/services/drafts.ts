import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_DRAFTS_PER_USER,
  SENT_DRAFT_RETENTION_DAYS,
  draftSendInput,
  internalSendMailSchema,
  isUrlAttachment,
  sendAtProblem,
  sendRequestFingerprint,
  type AttachmentTokenRef,
  type Draft,
  type DraftAttachment,
  type DraftInput,
  type DraftStatus,
  type DraftSummary,
  type InternalSendMailRequest,
  type ListDraftsQuery,
  type MessageSummary,
  type Page,
  type Role,
  type SendAttachment,
  type StoredDraftContent,
} from '@hpc-mail/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { apiKeys, attachments as attachmentsTable, draftAttachments, drafts, idempotencyRecords, messages } from '../db/schema.js';
import { base64ToBytes } from '../lib/mime.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import {
  beginIdempotentSend, completeIdempotentSend, failIdempotentSend, type IdempotencyActor,
} from './idempotency.js';
import { summarize } from './message.js';
import { attachmentDisposition, deliveryFailedError, sendMail, type Sender } from './outbound.js';
import {
  consumeDraftAttachments, draftKey, newDraftToken, releaseDraftStatements, reserveDraftAttachment, resolveDraftAttachments,
} from './upload.js';
import { fetchUrlAttachments, releaseUrlAttachments } from './url-attachment.js';

type DraftRow = typeof drafts.$inferSelect;

/** 操作草稿的调用方：网页会话或 API Key；草稿始终属于 userId */
export interface DraftActor {
  userId: number;
  role: Role;
  via: 'web' | 'api';
  /** API Key 调用时为 Key id */
  apiKeyId: number | null;
  /** 创建草稿的 Idempotency-Key 按调用方隔离（同发信） */
  idempotencyActor: IdempotencyActor;
}

/** 保存草稿时的请求环境：附件下载链接的 origin，URL 附件不能指向的本站主机 */
export interface DraftRequestEnv {
  origin: string;
  selfHosts: string[];
}

/** 定时发送因 5xx 且确认未外发时最多尝试几次，之后标 failed */
const MAX_SCHEDULED_ATTEMPTS = 3;
/** sending 超过这么久仍未结束视为中断，由定时任务按幂等记录判定结果 */
export const DRAFT_SENDING_LEASE_MS = 15 * 60 * 1000;
/** 每分钟一次的派发最多认领几封、同时发几封 */
const DISPATCH_BATCH = 20;
const DISPATCH_CONCURRENCY = 4;
const EDITABLE: DraftStatus[] = ['draft', 'scheduled', 'failed'];

const EMPTY_CONTENT: StoredDraftContent = {
  from: null, to: [], cc: [], bcc: [], replyTo: [], subject: '', headers: {},
  replyToMessageId: null, forwardAttachmentsFrom: null, attachmentTokens: [],
};

function stateConflict(row: Pick<DraftRow, 'status' | 'version'>, message: string): AppError {
  return new AppError('draft_state_conflict', message, { details: { draftStatus: row.status, draftVersion: row.version } });
}

function notFound(): AppError {
  return new AppError('not_found', '草稿不存在');
}

// ---------- 读取 ----------

function toSummary(row: DraftRow, apiKeyName: string | null): DraftSummary {
  return {
    id: row.id, status: row.status, version: row.version,
    from: row.content.from, to: row.content.to, cc: row.content.cc, bcc: row.content.bcc,
    subject: row.content.subject, preview: row.preview,
    attachmentCount: row.content.attachmentTokens.length,
    sendAt: row.sendAt ? row.sendAt.toISOString() : null,
    messageId: row.messageId ?? null, errorDetail: row.errorDetail,
    createdVia: row.createdVia, apiKeyName,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}

function toDraft(row: DraftRow, apiKeyName: string | null, files: (typeof draftAttachments.$inferSelect)[]): Draft {
  const byToken = new Map(files.map((file) => [file.token, file]));
  const attachments: DraftAttachment[] = row.content.attachmentTokens.flatMap((ref) => {
    const file = byToken.get(ref.token);
    return file ? [{
      token: ref.token, filename: file.filename, mimeType: file.mimeType, size: file.size,
      contentId: ref.contentId ?? '', disposition: attachmentDisposition(ref) as DraftAttachment['disposition'],
    }] : [];
  });
  return {
    ...toSummary(row, apiKeyName),
    replyTo: row.content.replyTo, text: row.bodyText, html: row.bodyHtml, headers: row.content.headers,
    replyToMessageId: row.content.replyToMessageId, forwardAttachmentsFrom: row.content.forwardAttachmentsFrom,
    attachments,
  };
}

const keyName = sql<string | null>`(select ${apiKeys.name} from ${apiKeys} where ${apiKeys.id} = ${drafts.apiKeyId})`;

export async function listDrafts(env: Env, userId: number, query: ListDraftsQuery): Promise<Page<DraftSummary>> {
  const db = createDb(env);
  const cursorId = decodeCursor(query.cursor);
  const rows = await db.select({ draft: drafts, apiKeyName: keyName }).from(drafts)
    .where(and(eq(drafts.userId, userId), query.status ? eq(drafts.status, query.status) : undefined,
      cursorId ? lt(drafts.id, cursorId) : undefined))
    .orderBy(desc(drafts.id)).limit(query.limit + 1).all();
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return {
    items: page.map((row) => toSummary(row.draft, row.apiKeyName)),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.draft.id) : null,
  };
}

/** 草稿行与它引用的附件合成一次往返 */
async function loadDraft(env: Env, userId: number, id: number) {
  const db = createDb(env);
  const [rows, files] = await db.batch([
    db.select({ draft: drafts, apiKeyName: keyName }).from(drafts).where(and(eq(drafts.id, id), eq(drafts.userId, userId))),
    db.select().from(draftAttachments).where(and(eq(draftAttachments.draftId, id), eq(draftAttachments.userId, userId))),
  ]);
  const row = rows[0];
  if (!row) throw notFound();
  return { row: row.draft, apiKeyName: row.apiKeyName, files };
}

export async function getDraft(env: Env, userId: number, id: number): Promise<Draft> {
  const { row, apiKeyName, files } = await loadDraft(env, userId, id);
  return toDraft(row, apiKeyName, files);
}

// ---------- 保存（创建与修改共用） ----------

/** 请求字段合并进已有内容：缺省保持，null 清空；附件另行处理 */
function mergeContent(base: StoredDraftContent, input: DraftInput): StoredDraftContent {
  return {
    from: input.from === undefined ? base.from : input.from,
    to: input.to ?? base.to,
    cc: input.cc ?? base.cc,
    bcc: input.bcc ?? base.bcc,
    replyTo: input.replyTo ?? base.replyTo,
    subject: input.subject ?? base.subject,
    headers: input.headers ?? base.headers,
    replyToMessageId: input.replyToMessageId === undefined ? base.replyToMessageId : input.replyToMessageId,
    forwardAttachmentsFrom: input.forwardAttachmentsFrom === undefined ? base.forwardAttachmentsFrom : input.forwardAttachmentsFrom,
    attachmentTokens: base.attachmentTokens,
  };
}

/** 合并后内容是否引用来源邮件（Key 需另有 mail.read） */
export function referencesSource(content: Pick<StoredDraftContent, 'replyToMessageId' | 'forwardAttachmentsFrom'>): boolean {
  return Boolean(content.replyToMessageId || content.forwardAttachmentsFrom);
}

/**
 * 安排定时发送时草稿必须已是完整发信请求。新附件（base64、URL）此时还没转存，按原样放进 attachments 一起校验，
 * 个数、contentId 与内联体积的规则与发信完全一致。
 */
function assertSendable(content: StoredDraftContent, text: string, html: string, pending: DraftInput['attachments'] = []): void {
  const input = { ...draftSendInput(content, text, html), attachments: pending };
  const parsed = internalSendMailSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('validation_failed', `草稿还不能发送：${issue?.message ?? '内容不完整'}`, {
      fix: '补全 from、收件人、主题与正文后再安排定时发送；只想保存时不要带 sendAt',
      docs: '/references/drafts.md#安排定时发送',
    });
  }
}

/** 引用已有上传附件前核对：属于本人、已上传完成、没有被其他草稿引用 */
async function assertUsableTokens(env: Env, userId: number, refs: AttachmentTokenRef[], draftId: number | null): Promise<void> {
  const tokens = [...new Set(refs.map((ref) => ref.token))];
  if (!tokens.length) return;
  const rows = await createDb(env).select({ token: draftAttachments.token, status: draftAttachments.status, draftId: draftAttachments.draftId })
    .from(draftAttachments).where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, tokens))).all();
  const byToken = new Map(rows.map((row) => [row.token, row]));
  for (const token of tokens) {
    const row = byToken.get(token);
    if (!row) throw new AppError('validation_failed', `附件不存在或无权使用：${token}`);
    if (row.status !== 'ready') throw new AppError('validation_failed', `附件尚未上传完成：${token}`);
    if (row.draftId !== null && row.draftId !== draftId) {
      throw new AppError('validation_failed', `附件已被草稿 #${row.draftId} 使用：${token}`, {
        fix: '一个上传附件只能放进一份草稿；另传一份，或先从那份草稿里移除它',
      });
    }
  }
}

/**
 * 把请求里的 base64 与 URL 附件转存为上传附件（按原顺序），返回引用。失败时释放本次已转存的部分。
 * 新转存的附件此时还没有 draft_id，保存草稿后再统一写上。
 */
async function materialize(
  env: Env,
  userId: number,
  items: NonNullable<DraftInput['attachments']>,
  usedBytes: number,
  request: DraftRequestEnv,
): Promise<AttachmentTokenRef[]> {
  if (!items.length) return [];
  const created: { token: string }[] = [];
  try {
    const refs: AttachmentTokenRef[] = [];
    const base64 = items.filter((item): item is SendAttachment => !isUrlAttachment(item));
    let total = usedBytes;
    const stored = new Map<SendAttachment, string>();
    for (const item of base64) {
      let bytes: Uint8Array;
      try { bytes = base64ToBytes(item.content); } catch { throw new AppError('validation_failed', '附件需为合法 base64'); }
      total += bytes.byteLength;
      if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AppError('payload_too_large', '附件合计超过大小上限');
      const token = newDraftToken();
      const r2Key = draftKey(userId, token);
      const rowId = await reserveDraftAttachment(env, { userId, token, filename: item.filename, mimeType: item.contentType, size: bytes.byteLength, r2Key });
      created.push({ token });
      try {
        await env.r2.put(r2Key, bytes, { httpMetadata: { contentType: item.contentType } });
        await env.db.prepare(`UPDATE draft_attachments SET status = 'ready' WHERE id = ?`).bind(rowId).run();
      } catch (error) {
        await env.db.batch(releaseDraftStatements(env, [rowId])).catch(() => undefined);
        created.pop();
        throw error;
      }
      stored.set(item, token);
    }
    const fetched = await fetchUrlAttachments(env, userId, items.filter(isUrlAttachment), {
      selfHosts: request.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - total,
    });
    created.push(...fetched);
    let remote = 0;
    for (const item of items) {
      const token = isUrlAttachment(item) ? fetched[remote++]!.token : stored.get(item)!;
      refs.push({ token, ...(item.contentId ? { contentId: item.contentId } : {}), ...(item.disposition ? { disposition: item.disposition } : {}) });
    }
    return refs;
  } catch (error) {
    await releaseUrlAttachments(env, userId, created);
    throw error;
  }
}

/** 已引用附件的合计大小（新附件的预算从剩余额度里扣） */
async function referencedBytes(env: Env, userId: number, refs: AttachmentTokenRef[]): Promise<number> {
  if (!refs.length) return 0;
  const rows = await createDb(env).select({ size: draftAttachments.size }).from(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, [...new Set(refs.map((ref) => ref.token))]))).all();
  return rows.reduce((sum, row) => sum + row.size, 0);
}

/**
 * 写上附件引用、释放被替换掉的旧附件（同一个 batch）。被释放的行登记对象清理后删除，
 * 对象若已被发出的邮件引用，清理任务会按引用保留。
 */
async function syncAttachmentRefs(env: Env, userId: number, draftId: number, tokens: string[]): Promise<void> {
  const unique = [...new Set(tokens)];
  const keep = unique.length ? `AND token NOT IN (${unique.map(() => '?').join(', ')})` : '';
  const stale = `user_id = ? AND draft_id = ? ${keep}`;
  const statements: D1PreparedStatement[] = [
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE ${stale}`).bind(userId, draftId, ...unique),
    env.db.prepare(`DELETE FROM draft_attachments WHERE ${stale}`).bind(userId, draftId, ...unique),
  ];
  if (unique.length) {
    statements.push(env.db.prepare(`UPDATE draft_attachments SET draft_id = ? WHERE user_id = ? AND (draft_id IS NULL OR draft_id = ?)
      AND token IN (${unique.map(() => '?').join(', ')})`).bind(draftId, userId, draftId, ...unique));
  }
  await env.db.batch(statements);
}

interface Prepared {
  content: StoredDraftContent;
  text: string;
  html: string;
  /** 本次新转存的附件（失败时要释放） */
  created: AttachmentTokenRef[];
  replacesAttachments: boolean;
}

/** 合并内容、核对并转存附件；sendable 时（安排定时）先按完整发信请求校验，再转存 */
async function prepare(
  env: Env,
  userId: number,
  draftId: number | null,
  base: { content: StoredDraftContent; text: string; html: string },
  input: DraftInput,
  sendable: boolean,
  request: DraftRequestEnv,
): Promise<Prepared> {
  const content = mergeContent(base.content, input);
  const text = input.text ?? base.text;
  const html = input.html ?? base.html;
  const replacesAttachments = input.attachments !== undefined || input.attachmentTokens !== undefined;
  const kept = replacesAttachments ? input.attachmentTokens ?? [] : content.attachmentTokens;
  if (sendable) assertSendable({ ...content, attachmentTokens: kept }, text, html, replacesAttachments ? input.attachments : []);
  if (!replacesAttachments) return { content, text, html, created: [], replacesAttachments };
  await assertUsableTokens(env, userId, kept, draftId);
  const created = await materialize(env, userId, input.attachments ?? [], await referencedBytes(env, userId, kept), request);
  // 新转存的排在前面，与发信时 attachments 在 attachmentTokens 之前的顺序一致
  return { content: { ...content, attachmentTokens: [...created, ...kept] }, text, html, created, replacesAttachments };
}

function sendAtOf(input: DraftInput): Date | null | undefined {
  if (input.sendAt === undefined || input.sendAt === null) return input.sendAt;
  const problem = sendAtProblem(input.sendAt);
  if (problem) {
    throw new AppError('validation_failed', problem, { fix: '用带时区的 ISO 8601 时间，例如 2026-11-18T09:00:00+08:00；最早 1 分钟后、最晚 30 天内' });
  }
  return new Date(input.sendAt);
}

/** 创建请求的幂等键在库里的形式：按调用方隔离 */
function storedIdempotencyKey(actor: DraftActor, key: string): string {
  return `${actor.idempotencyActor.type}:${actor.idempotencyActor.id}:${key}`;
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) throw new AppError('validation_failed', 'Idempotency-Key 必须是 1-128 位可见 ASCII 字符');
  return key;
}

/** 同键已有草稿：同一请求体返回它（当前状态），不同请求体 409 */
async function replayCreate(env: Env, userId: number, storedKey: string, requestHash: string): Promise<Draft | null> {
  const existing = await createDb(env).select({ id: drafts.id, requestHash: drafts.requestHash }).from(drafts)
    .where(eq(drafts.idempotencyKey, storedKey)).get();
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new AppError('idempotency_mismatch', '相同 Idempotency-Key 不能用于不同的草稿内容，请使用新的 Key');
  }
  return getDraft(env, userId, existing.id);
}

export interface CreateDraftResult {
  draft: Draft;
  /** 幂等重放：返回的是已有草稿 */
  replayed: boolean;
}

export async function createDraft(
  env: Env,
  actor: DraftActor,
  input: DraftInput,
  request: DraftRequestEnv,
  rawIdempotencyKey?: string,
): Promise<CreateDraftResult> {
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  const storedKey = idempotencyKey ? storedIdempotencyKey(actor, idempotencyKey) : null;
  const requestHash = storedKey ? await sha256Hex(JSON.stringify(input)) : null;
  if (storedKey) {
    const replay = await replayCreate(env, actor.userId, storedKey, requestHash!);
    if (replay) return { draft: replay, replayed: true };
  }
  const sendAt = sendAtOf(input);
  const prepared = await prepare(env, actor.userId, null, { content: EMPTY_CONTENT, text: '', html: '' }, input, Boolean(sendAt), request);
  const now = Date.now();
  let row: DraftRow | null = null;
  try {
    // 草稿数上限与插入同一条语句判断，并发创建也不会超
    const inserted = await env.db.prepare(`INSERT INTO drafts (user_id, status, content, body_text, body_html, preview, send_at,
        created_via, api_key_id, scheduled_by_key_id, scheduled_auth_version, origin, idempotency_key, request_hash, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT auth_version FROM users WHERE id = ? AND ? = 1), ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM drafts WHERE user_id = ? AND status <> 'sent') < ?
      RETURNING id`).bind(
      actor.userId, sendAt ? 'scheduled' : 'draft', JSON.stringify(prepared.content), prepared.text, prepared.html,
      makePreview(prepared.text, prepared.html), sendAt ? sendAt.getTime() : null,
      actor.via, actor.apiKeyId, sendAt ? actor.apiKeyId : null, actor.userId, sendAt ? 1 : 0, request.origin,
      storedKey, requestHash, now, now, actor.userId, MAX_DRAFTS_PER_USER,
    ).first<{ id: number }>();
    if (!inserted) {
      throw new AppError('draft_limit_reached', `未发送的草稿最多 ${MAX_DRAFTS_PER_USER} 份`);
    }
    if (prepared.content.attachmentTokens.length) {
      await syncAttachmentRefs(env, actor.userId, inserted.id, prepared.content.attachmentTokens.map((ref) => ref.token));
    }
    row = { id: inserted.id } as DraftRow;
  } catch (error) {
    await releaseUrlAttachments(env, actor.userId, prepared.created);
    // 并发的同键创建先插入了：按幂等规则返回它
    if (storedKey && !(error instanceof AppError) && /UNIQUE/i.test(String(error))) {
      const replay = await replayCreate(env, actor.userId, storedKey, requestHash!);
      if (replay) return { draft: replay, replayed: true };
    }
    throw error;
  }
  return { draft: await getDraft(env, actor.userId, row.id), replayed: false };
}

export async function updateDraft(
  env: Env,
  actor: DraftActor,
  id: number,
  input: DraftInput,
  request: DraftRequestEnv,
  authorize?: (content: StoredDraftContent) => void,
): Promise<Draft> {
  const { row } = await loadDraft(env, actor.userId, id);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    throw stateConflict(row, `草稿已被修改（当前版本 ${row.version}），请读取最新内容后再改`);
  }
  if (row.status === 'sending') throw stateConflict(row, '草稿正在发送，不能修改');
  if (row.status === 'sent') throw stateConflict(row, '草稿已发送，不能修改');
  authorize?.(mergeContent(row.content, input));
  const sendAt = sendAtOf(input);
  const status: DraftStatus = sendAt ? 'scheduled' : sendAt === null ? 'draft' : row.status;
  const prepared = await prepare(env, actor.userId, id, { content: row.content, text: row.bodyText, html: row.bodyHtml }, input,
    status === 'scheduled', request);
  const now = new Date();
  const scheduling = sendAt !== undefined;
  const db = createDb(env);
  let updated: DraftRow | undefined;
  try {
    updated = await db.update(drafts).set({
      status,
      content: prepared.content,
      bodyText: prepared.text,
      bodyHtml: prepared.html,
      preview: makePreview(prepared.text, prepared.html),
      version: sql`${drafts.version} + 1`,
      updatedAt: now,
      origin: request.origin,
      ...(scheduling ? {
        sendAt: sendAt ?? null,
        // 安排者与当时的账户安全版本：到点复核，Key 失效或改密后不再发出
        scheduledByKeyId: sendAt ? actor.apiKeyId : null,
        scheduledAuthVersion: sendAt ? sql`(select auth_version from users where id = ${actor.userId})` : null,
        errorDetail: '',
      } : {}),
    }).where(and(eq(drafts.id, id), eq(drafts.userId, actor.userId), eq(drafts.version, row.version), inArray(drafts.status, EDITABLE)))
      .returning().get();
    if (!updated) {
      const current = await db.select({ status: drafts.status, version: drafts.version }).from(drafts).where(eq(drafts.id, id)).get();
      if (!current) throw notFound();
      throw stateConflict(current, current.status === 'sending' ? '草稿正在发送，不能修改' : current.status === 'sent'
        ? '草稿已发送，不能修改' : `草稿已被修改（当前版本 ${current.version}），请读取最新内容后再改`);
    }
    if (prepared.replacesAttachments) {
      await syncAttachmentRefs(env, actor.userId, id, prepared.content.attachmentTokens.map((ref) => ref.token));
    }
  } catch (error) {
    if (!updated) await releaseUrlAttachments(env, actor.userId, prepared.created);
    throw error;
  }
  return getDraft(env, actor.userId, id);
}

export async function deleteDraft(env: Env, userId: number, id: number): Promise<void> {
  const db = createDb(env);
  const row = await db.select({ status: drafts.status, version: drafts.version }).from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId))).get();
  if (!row) throw notFound();
  if (row.status === 'sending') throw stateConflict(row, '草稿正在发送，不能删除');
  // 删除与释放附件同一事务；附件只在草稿确实被删掉后才释放（并发进入 sending 时都不动）
  const released = `user_id = ? AND draft_id = ? AND NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?)`;
  const [deleted] = await env.db.batch([
    env.db.prepare(`DELETE FROM drafts WHERE id = ? AND user_id = ? AND status <> 'sending' RETURNING id`).bind(id, userId),
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE ${released}`).bind(userId, id, id),
    env.db.prepare(`DELETE FROM draft_attachments WHERE ${released}`).bind(userId, id, id),
  ]);
  if (!deleted?.results.length) {
    const current = await db.select({ status: drafts.status, version: drafts.version }).from(drafts).where(eq(drafts.id, id)).get();
    if (current) throw stateConflict(current, '草稿正在发送，不能删除');
  }
}

// ---------- 发送 ----------

async function messageSummaryOf(env: Env, messageId: number): Promise<MessageSummary | null> {
  const db = createDb(env);
  const [rows, files] = await db.batch([
    db.select().from(messages).where(eq(messages.id, messageId)),
    db.select({ id: attachmentsTable.id }).from(attachmentsTable).where(and(eq(attachmentsTable.messageId, messageId),
      sql`NOT (${attachmentsTable.disposition} = 'inline' AND ${attachmentsTable.contentId} <> '')`)).limit(1),
  ]);
  return rows[0] ? summarize(rows[0], files.length > 0, false) : null;
}

type SendMode = 'now' | 'scheduled';

interface SendOutcome {
  status: DraftStatus;
  messageId: number | null;
  errorDetail: string;
  sendAt?: Date | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 发送失败后的草稿去向：以幂等记录是否已绑定发件行为准，已绑定的绝不重发 */
async function failureOutcome(env: Env, row: DraftRow, error: unknown, mode: SendMode, previous: DraftStatus): Promise<SendOutcome> {
  const detail = errorText(error).slice(0, 2000);
  let messageId = error instanceof AppError && error.code === 'delivery_failed' ? error.hints.details?.messageId ?? null : null;
  if (messageId === null) {
    const record = await createDb(env).select({ messageId: idempotencyRecords.messageId }).from(idempotencyRecords)
      .where(and(eq(idempotencyRecords.actorType, 'draft'), eq(idempotencyRecords.actorId, row.id), eq(idempotencyRecords.key, String(row.attempt))))
      .get();
    messageId = record?.messageId ?? null;
  }
  if (messageId !== null) {
    const message = await createDb(env).select({ status: messages.status }).from(messages).where(eq(messages.id, messageId)).get();
    if (!message || message.status === 'failed') return { status: 'failed', messageId, errorDetail: detail };
    return { status: 'sent', messageId, errorDetail: `发送结果待确认，以发件记录为准：${detail}` };
  }
  const clientError = error instanceof AppError && error.status < 500;
  if (mode === 'now') return { status: previous, messageId: null, errorDetail: detail };
  if (!clientError && row.attempt < MAX_SCHEDULED_ATTEMPTS) return { status: 'scheduled', messageId: null, errorDetail: detail };
  return { status: 'failed', messageId: null, errorDetail: detail };
}

/** 发送结束（成功或失败）写回草稿；只改本次认领的那一轮（status=sending 且 attempt 相同） */
async function settle(env: Env, row: DraftRow, outcome: SendOutcome): Promise<void> {
  const now = new Date();
  await createDb(env).update(drafts).set({
    status: outcome.status, messageId: outcome.messageId, errorDetail: outcome.errorDetail, claimedAt: null,
    version: sql`${drafts.version} + 1`, updatedAt: now, ...(outcome.status === 'sent' ? { sentAt: now } : {}),
    ...(outcome.sendAt !== undefined ? { sendAt: outcome.sendAt } : {}),
  }).where(and(eq(drafts.id, row.id), eq(drafts.status, 'sending'), eq(drafts.attempt, row.attempt)));
}

/**
 * 发送一份已认领（status=sending）的草稿。幂等记录按 (draft, id, attempt) 占用：sendMail 在外发前把发件行绑定上去，
 * 进程中断后据此判断是否已外发。立即发送时把错误原样抛给调用方（与 POST /messages 一致）；定时发送只记到草稿上。
 */
async function performSend(
  env: Env,
  ctx: ExecCtx,
  row: DraftRow,
  sender: Sender,
  origin: string,
  mode: SendMode,
  previous: DraftStatus,
): Promise<MessageSummary | null> {
  let req: InternalSendMailRequest | undefined;
  try {
    const parsed = internalSendMailSchema.safeParse(draftSendInput(row.content, row.bodyText, row.bodyHtml));
    if (!parsed.success) {
      throw new AppError('validation_failed', `草稿还不能发送：${parsed.error.issues[0]?.message ?? '内容不完整'}`, {
        fix: '用 PATCH /drafts/:id 补全 from、收件人、主题与正文后再发送',
        docs: '/references/drafts.md#发送',
      });
    }
    req = parsed.data;
    const idem = await beginIdempotentSend(env, { type: 'draft', id: row.id }, String(row.attempt), sendRequestFingerprint(req));
    if (idem.kind === 'replay') {
      // 同一轮的结果已经在了（重复调度）：按记录收尾
      const replay = idem.response;
      await settle(env, row, { status: replay.status === 'failed' ? 'failed' : 'sent', messageId: replay.id, errorDetail: replay.errorDetail });
      if (replay.status === 'failed') throw deliveryFailedError(replay.id, replay.recipientOutcomes ?? [], replay.errorDetail);
      return replay;
    }
    let summary: MessageSummary;
    try {
      const files = await resolveDraftAttachments(env, row.userId, req.attachmentTokens, { draftId: row.id });
      summary = await sendMail(env, ctx, sender, req, files, origin, idem.handle);
    } catch (error) {
      await failIdempotentSend(env, idem.handle, error).catch((cause) => console.error('草稿发送的幂等记录收尾失败:', cause));
      throw error;
    }
    await Promise.all([
      completeIdempotentSend(env, idem.handle, summary).catch((error) => console.error('草稿发送的幂等结果回填失败:', error)),
      consumeDraftAttachments(env, row.userId, req.attachmentTokens.map((ref) => ref.token))
        .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error)),
    ]);
    await settle(env, row, { status: 'sent', messageId: summary.id, errorDetail: summary.errorDetail });
    return summary;
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'delivery_failed' && req === undefined)) {
      const outcome = await failureOutcome(env, row, error, mode, previous);
      await settle(env, row, outcome).catch((cause) => console.error('草稿发送结果写回失败:', cause));
    }
    if (mode === 'now') throw error;
    console.error(JSON.stringify({ event: 'draft_send_failed', draftId: row.id, attempt: row.attempt, message: errorText(error) }));
    return null;
  }
}

/**
 * 立即发送（POST /drafts/:id/send）：草稿、定时、失败三种状态都可以；已发送的重放原结果（201），发送中 409。
 * authorize 在认领前按草稿内容做 scope 检查（Key 引用来源邮件需 mail.read）。
 */
export async function sendDraftNow(
  env: Env,
  ctx: ExecCtx,
  sender: Sender,
  id: number,
  origin: string,
  authorize?: (content: StoredDraftContent) => void,
): Promise<MessageSummary> {
  const db = createDb(env);
  const row = await db.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.userId, sender.userId))).get();
  if (!row) throw notFound();
  const settled = async (current: Pick<DraftRow, 'status' | 'version' | 'messageId'>): Promise<MessageSummary> => {
    if (current.status === 'sending') {
      throw new AppError('send_in_progress', '草稿正在发送，请稍后用 GET /drafts/:id 查看结果，不要重复发送');
    }
    if (current.status === 'sent' && current.messageId) {
      const summary = await messageSummaryOf(env, current.messageId);
      if (summary) return summary;
    }
    throw stateConflict(current, current.status === 'sent' ? '草稿已发送，发件记录已不存在' : '草稿状态已变化，请重新读取');
  };
  if (!EDITABLE.includes(row.status)) return settled(row);
  authorize?.(row.content);
  const claimed = await db.update(drafts).set({
    status: 'sending', attempt: sql`${drafts.attempt} + 1`, claimedAt: new Date(), version: sql`${drafts.version} + 1`, updatedAt: new Date(),
  }).where(and(eq(drafts.id, id), eq(drafts.version, row.version), eq(drafts.status, row.status))).returning().get();
  if (!claimed) {
    const current = await db.select().from(drafts).where(eq(drafts.id, id)).get();
    if (!current) throw notFound();
    return settled(current);
  }
  return (await performSend(env, ctx, claimed, sender, origin, 'now', row.status))!;
}

// ---------- 定时派发与恢复 ----------

/** 到点复核：所有者仍启用、账户安全版本未变、安排它的 Key 仍有效；不满足时返回取消原因 */
function scheduleRevoked(
  row: DraftRow,
  owner: { status: string; authVersion: number } | undefined,
  key: { status: string; expiresAt: Date | null } | undefined,
  now: number,
): string | null {
  if (!owner || owner.status !== 'active') return '草稿所有者已被禁用，定时发送已取消';
  if (row.scheduledAuthVersion !== null && owner.authVersion !== row.scheduledAuthVersion) {
    return '账户安全状态已变化（改密、重置或禁用），定时发送已取消，请确认后重新安排';
  }
  if (row.scheduledByKeyId !== null && (!key || key.status !== 'active' || (key.expiresAt && key.expiresAt.getTime() <= now))) {
    return '安排定时发送的 API Key 已失效，定时发送已取消，请确认后重新安排';
  }
  return null;
}

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) await task(items[i]!);
  }));
}

/**
 * sending 租约到期：先把这一轮的幂等记录在「pending 且未绑定」时原子标为 failed，迟到的绑定会失败、不再外发；
 * 再按记录判定：已绑定发件行看发件行状态，未绑定就是没外发，按定时发送的 5xx 规则重排或标失败。
 */
async function recoverStale(env: Env, row: DraftRow): Promise<void> {
  const db = createDb(env);
  const recordKey = and(eq(idempotencyRecords.actorType, 'draft'), eq(idempotencyRecords.actorId, row.id), eq(idempotencyRecords.key, String(row.attempt)));
  await db.update(idempotencyRecords).set({ status: 'failed', errorDetail: '草稿发送中断，未外发', updatedAt: new Date() })
    .where(and(recordKey, eq(idempotencyRecords.status, 'pending'), isNull(idempotencyRecords.messageId)));
  const interrupted = new AppError('internal', '发送中断（超过 15 分钟未完成）');
  const outcome = await failureOutcome(env, row, interrupted, 'scheduled', row.status);
  // 从没安排过定时的立即发送中断后不自动重发，交给用户决定
  if (outcome.status === 'scheduled' && !row.sendAt) outcome.status = 'failed';
  await settle(env, row, outcome);
}

export interface DispatchReport {
  sent: number;
  failed: number;
  recovered: number;
}

/**
 * 每分钟一次：到期认领与租约到期查询合成一个 batch（空闲时只有这一次 D1 往返）。
 * 认领最多 DISPATCH_BATCH 封，同时最多发 DISPATCH_CONCURRENCY 封；剩下的下一分钟继续。
 */
export async function dispatchDueDrafts(env: Env, ctx: ExecCtx, now = Date.now()): Promise<DispatchReport> {
  const db = createDb(env);
  const report: DispatchReport = { sent: 0, failed: 0, recovered: 0 };
  const [claimed, stale] = await env.db.batch<DraftRow>([
    env.db.prepare(`UPDATE drafts SET status = 'sending', attempt = attempt + 1, claimed_at = ?, version = version + 1, updated_at = ?
      WHERE id IN (SELECT id FROM drafts WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT ?) RETURNING id`)
      .bind(now, now, now, DISPATCH_BATCH),
    env.db.prepare(`SELECT id FROM drafts WHERE status = 'sending' AND claimed_at < ? LIMIT ?`).bind(now - DRAFT_SENDING_LEASE_MS, DISPATCH_BATCH),
  ]) as unknown as [D1Result<{ id: number }>, D1Result<{ id: number }>];
  const claimedIds = claimed.results.map((item) => item.id);
  const staleIds = stale.results.map((item) => item.id).filter((id) => !claimedIds.includes(id));
  if (!claimedIds.length && !staleIds.length) return report;
  const rows = await db.select().from(drafts).where(inArray(drafts.id, [...claimedIds, ...staleIds])).all();
  for (const row of rows.filter((item) => staleIds.includes(item.id) && item.status === 'sending')) {
    try { await recoverStale(env, row); report.recovered++; }
    catch (error) { console.error('草稿发送租约恢复失败:', error); }
  }
  const due = rows.filter((item) => claimedIds.includes(item.id));
  if (!due.length) return report;
  const ownerIds = [...new Set(due.map((row) => row.userId))];
  const keyIds = [...new Set(due.flatMap((row) => (row.scheduledByKeyId !== null ? [row.scheduledByKeyId] : [])))];
  const [owners, keys] = await db.batch([
    db.select({ id: sql<number>`id`, role: sql<Role>`role`, status: sql<string>`status`, authVersion: sql<number>`auth_version` })
      .from(sql`users`).where(sql`id in ${ownerIds}`),
    db.select({ id: apiKeys.id, status: apiKeys.status, expiresAt: apiKeys.expiresAt }).from(apiKeys)
      .where(keyIds.length ? inArray(apiKeys.id, keyIds) : sql`0`),
  ]);
  const ownerById = new Map(owners.map((owner) => [Number(owner.id), owner]));
  const keyById = new Map(keys.map((key) => [key.id, key]));
  await runPool(due, DISPATCH_CONCURRENCY, async (row) => {
    const owner = ownerById.get(row.userId);
    const revoked = scheduleRevoked(row, owner, row.scheduledByKeyId !== null ? keyById.get(row.scheduledByKeyId) : undefined, now);
    if (revoked) {
      await settle(env, row, { status: 'failed', messageId: null, errorDetail: revoked });
      report.failed++;
      return;
    }
    const summary = await performSend(env, ctx, row, { userId: row.userId, role: owner!.role }, env.site_origin ?? row.origin, 'scheduled', 'scheduled');
    if (summary) report.sent++;
    else report.failed++;
  });
  return report;
}

/** 每日维护：删除超过保留期的已发送草稿（附件已在发送时回收；发件记录不受影响） */
export async function purgeSentDrafts(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - SENT_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = await env.db.prepare(`DELETE FROM drafts WHERE id IN
    (SELECT id FROM drafts WHERE status = 'sent' AND sent_at < ? LIMIT 1000)`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
