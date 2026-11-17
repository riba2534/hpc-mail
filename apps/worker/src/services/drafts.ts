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
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { base64ToBytes } from '../lib/mime.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { makePreview } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { beginIdempotentSend, failIdempotentSend, type IdempotencyActor } from './idempotency.js';
import { readMailBody, storeMailBody } from './mail-body.js';
import { summarize } from './message.js';
import { attachmentDisposition, deliveryFailedError, releaseDeliveryLeases, sendMail, type Sender } from './outbound.js';
import {
  consumeDraftAttachments, draftKey, newDraftToken, releaseDraftStatements, reserveDraftAttachment, resolveDraftAttachments,
} from './upload.js';
import { fetchUrlAttachments, releaseUrlAttachments } from './url-attachment.js';

type DraftRow = typeof drafts.$inferSelect;

/** 操作草稿的调用方：网页会话或 API Key；草稿始终属于 userId */
export interface DraftActor {
  userId: number;
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
/** 每分钟一次的派发最多认领几封、同时发几封；剩下的下一分钟继续 */
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

/** 状态不允许修改或删除时的说明 */
function conflictMessage(row: Pick<DraftRow, 'status' | 'version'>, action: '修改' | '删除'): string {
  if (row.status === 'sending') return `草稿正在发送，不能${action}`;
  if (row.status === 'sent') return `草稿已发送，不能${action}`;
  return `草稿已被修改（当前版本 ${row.version}），请读取最新内容后再改`;
}

/** 合并后内容是否引用来源邮件（Key 需另有 mail.read） */
export function referencesSource(content: Pick<StoredDraftContent, 'replyToMessageId' | 'forwardAttachmentsFrom'>): boolean {
  return Boolean(content.replyToMessageId || content.forwardAttachmentsFrom);
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

const keyName = sql<string | null>`(select ${apiKeys.name} from ${apiKeys} where ${apiKeys.id} = ${drafts.apiKeyId})`;

export async function listDrafts(env: Env, userId: number, query: ListDraftsQuery): Promise<Page<DraftSummary>> {
  const cursorId = decodeCursor(query.cursor);
  const rows = await createDb(env).select({ draft: drafts, apiKeyName: keyName }).from(drafts)
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
  const body = await readMailBody(env, row);
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
    replyTo: row.content.replyTo, text: body.bodyText, html: body.bodyHtml, headers: row.content.headers,
    replyToMessageId: row.content.replyToMessageId, forwardAttachmentsFrom: row.content.forwardAttachmentsFrom,
    attachments,
  };
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

/**
 * 安排定时发送时草稿必须已是完整发信请求。新附件（base64、URL）此时还没转存，按原样放进 attachments 一起校验，
 * 个数、contentId 与内联体积的规则与发信完全一致。
 */
function assertSendable(content: StoredDraftContent, text: string, html: string, pending: DraftInput['attachments'] = []): void {
  const parsed = internalSendMailSchema.safeParse({ ...draftSendInput(content, text, html), attachments: pending });
  if (!parsed.success) {
    throw new AppError('validation_failed', `草稿还不能发送：${parsed.error.issues[0]?.message ?? '内容不完整'}`, {
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

/** 已引用附件的合计大小（新附件的预算从剩余额度里扣） */
async function referencedBytes(env: Env, userId: number, refs: AttachmentTokenRef[]): Promise<number> {
  if (!refs.length) return 0;
  const rows = await createDb(env).select({ size: draftAttachments.size }).from(draftAttachments)
    .where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, [...new Set(refs.map((ref) => ref.token))]))).all();
  return rows.reduce((sum, row) => sum + row.size, 0);
}

/** base64 附件转存为一份上传附件（同 POST /uploads，计入每人待发送附件配额） */
async function storeBase64(env: Env, userId: number, item: SendAttachment, bytes: Uint8Array): Promise<string> {
  const token = newDraftToken();
  const r2Key = draftKey(userId, token);
  const rowId = await reserveDraftAttachment(env, { userId, token, filename: item.filename, mimeType: item.contentType, size: bytes.byteLength, r2Key });
  try {
    await env.r2.put(r2Key, bytes, { httpMetadata: { contentType: item.contentType } });
    await env.db.prepare(`UPDATE draft_attachments SET status = 'ready' WHERE id = ?`).bind(rowId).run();
  } catch (error) {
    await env.db.batch(releaseDraftStatements(env, [rowId])).catch((cause) => console.error('草稿附件转存失败后的清理登记失败:', cause));
    throw error;
  }
  return token;
}

/**
 * 把请求里的 base64 与 URL 附件转存为上传附件（按原顺序），返回引用。失败时释放本次已转存的部分。
 * 新转存的附件此时还没有 draft_id，草稿写入后再统一写上。
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
    const stored = new Map<SendAttachment, string>();
    let total = usedBytes;
    for (const item of items) {
      if (isUrlAttachment(item)) continue;
      let bytes: Uint8Array;
      try { bytes = base64ToBytes(item.content); } catch { throw new AppError('validation_failed', '附件需为合法 base64'); }
      total += bytes.byteLength;
      if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AppError('payload_too_large', '附件合计超过大小上限');
      const token = await storeBase64(env, userId, item, bytes);
      created.push({ token });
      stored.set(item, token);
    }
    const fetched = await fetchUrlAttachments(env, userId, items.filter(isUrlAttachment), {
      selfHosts: request.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - total,
    });
    created.push(...fetched);
    let remote = 0;
    return items.map((item) => ({
      token: isUrlAttachment(item) ? fetched[remote++]!.token : stored.get(item)!,
      ...(item.contentId ? { contentId: item.contentId } : {}),
      ...(item.disposition ? { disposition: item.disposition } : {}),
    }));
  } catch (error) {
    await releaseUrlAttachments(env, userId, created);
    throw error;
  }
}

/**
 * 写上附件引用、释放被替换掉的旧附件（同一个 batch）。被释放的行登记对象清理后删除，
 * 对象若已被发出的邮件引用，清理任务会按引用保留。
 */
function attachmentRefStatements(env: Env, userId: number, draftId: number, tokens: string[]): D1PreparedStatement[] {
  const unique = [...new Set(tokens)];
  const keep = unique.length ? `AND token NOT IN (${unique.map(() => '?').join(', ')})` : '';
  const stale = `user_id = ? AND draft_id = ? ${keep}`;
  return [
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE ${stale}`).bind(userId, draftId, ...unique),
    env.db.prepare(`DELETE FROM draft_attachments WHERE ${stale}`).bind(userId, draftId, ...unique),
    ...(unique.length ? [env.db.prepare(`UPDATE draft_attachments SET draft_id = ? WHERE user_id = ? AND (draft_id IS NULL OR draft_id = ?)
      AND token IN (${unique.map(() => '?').join(', ')})`).bind(draftId, userId, draftId, ...unique)] : []),
  ];
}

/** 正文对象不再被草稿引用时登记清理（与改动同一个 batch，放在改动之后） */
function bodyCleanupStatement(env: Env, key: string | null): D1PreparedStatement[] {
  if (!key) return [];
  return [env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT ? WHERE NOT EXISTS
    (SELECT 1 FROM drafts WHERE body_r2_key = ?)`).bind(key, key)];
}

interface Prepared {
  content: StoredDraftContent;
  text: string;
  html: string;
  /** 正文有改动时为新写入的正文列 */
  body: Awaited<ReturnType<typeof storeMailBody>> | null;
  /** 本次新转存的附件（保存失败时要释放） */
  created: AttachmentTokenRef[];
  replacesAttachments: boolean;
}

/** 合并内容、核对并转存附件、写正文；sendable 时（安排定时）先按完整发信请求校验，校验通过才有副作用 */
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
  let created: AttachmentTokenRef[] = [];
  if (replacesAttachments) {
    await assertUsableTokens(env, userId, kept, draftId);
    created = await materialize(env, userId, input.attachments ?? [], await referencedBytes(env, userId, kept), request);
  }
  let body: Prepared['body'] = null;
  if (input.text !== undefined || input.html !== undefined) {
    try { body = await storeMailBody(env, text, html); }
    catch (error) { await releaseUrlAttachments(env, userId, created); throw error; }
  }
  // 新转存的排在前面，与发信时 attachments 在 attachmentTokens 之前的顺序一致
  const attachmentTokens = replacesAttachments ? [...created, ...kept] : content.attachmentTokens;
  return { content: { ...content, attachmentTokens }, text, html, body, created, replacesAttachments };
}

/** 保存失败：释放本次转存的附件与写入的正文对象 */
async function discardPrepared(env: Env, userId: number, prepared: Prepared): Promise<void> {
  await Promise.all([
    releaseUrlAttachments(env, userId, prepared.created),
    prepared.body?.bodyR2Key
      ? env.db.batch(bodyCleanupStatement(env, prepared.body.bodyR2Key)).catch((error) => console.error('草稿正文清理登记失败:', error))
      : undefined,
  ]);
}

function sendAtOf(input: DraftInput): Date | null | undefined {
  if (input.sendAt === undefined || input.sendAt === null) return input.sendAt;
  const problem = sendAtProblem(input.sendAt);
  if (problem) {
    throw new AppError('validation_failed', problem, {
      fix: '用带时区的 ISO 8601 时间，例如 2026-11-18T09:00:00+08:00；最早 1 分钟后、最晚 30 天内',
      docs: '/references/drafts.md#安排定时发送',
    });
  }
  return new Date(input.sendAt);
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
  const key = normalizeIdempotencyKey(rawIdempotencyKey);
  // 幂等键按调用方隔离（同发信）；命中时在转存附件之前返回，重试不会重复拉取
  const storedKey = key ? `${actor.idempotencyActor.type}:${actor.idempotencyActor.id}:${key}` : null;
  const requestHash = storedKey ? await sha256Hex(JSON.stringify(input)) : null;
  if (storedKey) {
    const replay = await replayCreate(env, actor.userId, storedKey, requestHash!);
    if (replay) return { draft: replay, replayed: true };
  }
  const sendAt = sendAtOf(input);
  const prepared = await prepare(env, actor.userId, null, { content: EMPTY_CONTENT, text: '', html: '' }, input, Boolean(sendAt), request);
  const body = prepared.body ?? { bodyText: '', bodyHtml: '', bodyR2Key: null };
  const now = Date.now();
  let id: number;
  try {
    // 草稿数上限与插入同一条语句判断，并发创建也不会超；安排定时时同时记下所有者当前的 auth_version
    const inserted = await env.db.prepare(`INSERT INTO drafts (user_id, status, content, body_text, body_html, body_r2_key, preview,
        send_at, created_via, api_key_id, scheduled_by_key_id, scheduled_auth_version, origin, idempotency_key, request_hash,
        created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN (SELECT auth_version FROM users WHERE id = ?) END, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM drafts WHERE user_id = ? AND status <> 'sent') < ?
      RETURNING id`).bind(
      actor.userId, sendAt ? 'scheduled' : 'draft', JSON.stringify(prepared.content), body.bodyText, body.bodyHtml, body.bodyR2Key,
      makePreview(prepared.text, prepared.html), sendAt ? sendAt.getTime() : null, actor.via, actor.apiKeyId,
      sendAt ? actor.apiKeyId : null, sendAt ? 1 : 0, actor.userId, request.origin, storedKey, requestHash, now, now,
      actor.userId, MAX_DRAFTS_PER_USER,
    ).first<{ id: number }>();
    if (!inserted) {
      throw new AppError('draft_limit_reached', `未发送的草稿最多 ${MAX_DRAFTS_PER_USER} 份`);
    }
    id = inserted.id;
  } catch (error) {
    await discardPrepared(env, actor.userId, prepared);
    // 并发的同键创建先插入了：按幂等规则返回它
    if (storedKey && !(error instanceof AppError) && /UNIQUE/i.test(String(error))) {
      const replay = await replayCreate(env, actor.userId, storedKey, requestHash!);
      if (replay) return { draft: replay, replayed: true };
    }
    throw error;
  }
  if (prepared.content.attachmentTokens.length) {
    await env.db.batch(attachmentRefStatements(env, actor.userId, id, prepared.content.attachmentTokens.map((ref) => ref.token)));
  }
  return { draft: await getDraft(env, actor.userId, id), replayed: false };
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
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) throw stateConflict(row, conflictMessage(row, '修改'));
  if (!EDITABLE.includes(row.status)) throw stateConflict(row, conflictMessage(row, '修改'));
  authorize?.(mergeContent(row.content, input));
  const sendAt = sendAtOf(input);
  const status: DraftStatus = sendAt ? 'scheduled' : sendAt === null ? 'draft' : row.status;
  // 只改部分字段又要保持（或进入）定时状态时，需要原正文一起做完整性校验
  const needsBody = status === 'scheduled' && (input.text === undefined || input.html === undefined);
  const current = needsBody ? await readMailBody(env, row) : { bodyText: row.bodyText, bodyHtml: row.bodyHtml };
  const prepared = await prepare(env, actor.userId, id, { content: row.content, text: current.bodyText, html: current.bodyHtml },
    input, status === 'scheduled', request);
  const db = createDb(env);
  const scheduling = sendAt !== undefined;
  const update = db.update(drafts).set({
    status,
    content: prepared.content,
    ...(prepared.body ? { ...prepared.body, preview: makePreview(prepared.text, prepared.html) } : {}),
    version: sql`${drafts.version} + 1`,
    updatedAt: new Date(),
    origin: request.origin,
    ...(scheduling ? {
      sendAt: sendAt ?? null,
      // 安排者与当时的账户安全版本：到点复核，Key 失效或改密后不再发出
      scheduledByKeyId: sendAt ? actor.apiKeyId : null,
      scheduledAuthVersion: sendAt ? sql`(select auth_version from users where id = ${actor.userId})` : null,
      errorDetail: '',
    } : {}),
  }).where(and(eq(drafts.id, id), eq(drafts.userId, actor.userId), eq(drafts.version, row.version), inArray(drafts.status, EDITABLE)))
    .returning({ id: drafts.id });
  let updated: { id: number }[];
  try {
    [updated] = await db.batch([update]);
  } catch (error) {
    await discardPrepared(env, actor.userId, prepared);
    throw error;
  }
  if (!updated.length) {
    await discardPrepared(env, actor.userId, prepared);
    const latest = await db.select({ status: drafts.status, version: drafts.version }).from(drafts).where(eq(drafts.id, id)).get();
    if (!latest) throw notFound();
    throw stateConflict(latest, conflictMessage(latest, '修改'));
  }
  const followUps = [
    ...(prepared.replacesAttachments ? attachmentRefStatements(env, actor.userId, id, prepared.content.attachmentTokens.map((ref) => ref.token)) : []),
    ...(prepared.body ? bodyCleanupStatement(env, row.bodyR2Key) : []),
  ];
  if (followUps.length) await env.db.batch(followUps);
  return getDraft(env, actor.userId, id);
}

export async function deleteDraft(env: Env, userId: number, id: number): Promise<void> {
  const db = createDb(env);
  const row = await db.select({ status: drafts.status, version: drafts.version, bodyR2Key: drafts.bodyR2Key }).from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.userId, userId))).get();
  if (!row) throw notFound();
  if (row.status === 'sending') throw stateConflict(row, conflictMessage(row, '删除'));
  // 删除与释放附件、正文同一事务；附件只在草稿确实被删掉后才释放（并发进入 sending 时都不动）
  const released = `user_id = ? AND draft_id = ? AND NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?)`;
  const [deleted] = await env.db.batch([
    env.db.prepare(`DELETE FROM drafts WHERE id = ? AND user_id = ? AND status <> 'sending' RETURNING id`).bind(id, userId),
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT r2_key FROM draft_attachments WHERE ${released}`).bind(userId, id, id),
    env.db.prepare(`DELETE FROM draft_attachments WHERE ${released}`).bind(userId, id, id),
    ...bodyCleanupStatement(env, row.bodyR2Key),
  ]);
  if (!deleted?.results.length) {
    const latest = await db.select({ status: drafts.status, version: drafts.version }).from(drafts).where(eq(drafts.id, id)).get();
    if (latest) throw stateConflict(latest, conflictMessage(latest, '删除'));
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
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 发送中途出错后的草稿去向：以这一轮的幂等记录是否已绑定发件行为准，已绑定的绝不重发 */
async function failureOutcome(env: Env, row: DraftRow, error: unknown, mode: SendMode, previous: DraftStatus): Promise<SendOutcome> {
  const detail = errorText(error).slice(0, 2000);
  const db = createDb(env);
  const record = await db.select({ messageId: idempotencyRecords.messageId }).from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.actorType, 'draft'), eq(idempotencyRecords.actorId, row.id), eq(idempotencyRecords.key, String(row.attempt))))
    .get();
  const messageId = record?.messageId ?? null;
  if (messageId !== null) {
    const message = await db.select({ status: messages.status }).from(messages).where(eq(messages.id, messageId)).get();
    if (!message || message.status === 'failed') return { status: 'failed', messageId, errorDetail: detail };
    return { status: 'sent', messageId, errorDetail: `发送结果待确认，以发件记录为准：${detail}` };
  }
  const clientError = error instanceof AppError && error.status < 500;
  if (mode === 'now') return { status: previous, messageId: null, errorDetail: detail };
  // 没安排过定时的立即发送中断后（租约恢复走 scheduled 规则）不自动重发，交给用户决定
  if (!clientError && row.sendAt && row.attempt < MAX_SCHEDULED_ATTEMPTS) return { status: 'scheduled', messageId: null, errorDetail: detail };
  return { status: 'failed', messageId: null, errorDetail: detail };
}

/** 发送结束（成功或失败）写回草稿；只改本次认领的那一轮（status=sending 且 attempt 相同） */
async function settle(env: Env, row: Pick<DraftRow, 'id' | 'attempt'>, outcome: SendOutcome): Promise<void> {
  const now = new Date();
  await createDb(env).update(drafts).set({
    status: outcome.status, messageId: outcome.messageId, errorDetail: outcome.errorDetail, claimedAt: null,
    version: sql`${drafts.version} + 1`, updatedAt: now, ...(outcome.status === 'sent' ? { sentAt: now } : {}),
  }).where(and(eq(drafts.id, row.id), eq(drafts.status, 'sending'), eq(drafts.attempt, row.attempt)));
}

/**
 * 发送一份已认领（status=sending）的草稿，与 POST /messages 同一流程：幂等记录按 (draft, id, attempt) 占用，
 * sendMail 在外发前把发件行绑定上去、投递结束时回填结果并释放附件租约；进程中断后据此判断是否已外发。
 * 全部收件人失败时草稿标 failed（附件仍归草稿，修改后可重发）；其余结果标 sent。
 * 立即发送把错误原样抛给调用方（与 POST /messages 一致）；定时发送只记到草稿上。
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
  let summary: MessageSummary;
  try {
    const body = await readMailBody(env, row);
    const parsed = internalSendMailSchema.safeParse(draftSendInput(row.content, body.bodyText, body.bodyHtml));
    if (!parsed.success) {
      throw new AppError('validation_failed', `草稿还不能发送：${parsed.error.issues[0]?.message ?? '内容不完整'}`, {
        fix: '用 PATCH /drafts/:id 补全 from、收件人、主题与正文后再发送',
        docs: '/references/drafts.md#发送',
      });
    }
    const req: InternalSendMailRequest = parsed.data;
    const idem = await beginIdempotentSend(env, { type: 'draft', id: row.id }, String(row.attempt), sendRequestFingerprint(req));
    if (idem.kind === 'replay') {
      summary = idem.response;
    } else {
      const leaseToken = crypto.randomUUID();
      try {
        const files = await resolveDraftAttachments(env, row.userId, req.attachmentTokens, leaseToken, { draftId: row.id });
        summary = await sendMail(env, ctx, sender, req, files, origin, idem.handle, leaseToken);
      } catch (error) {
        // 投递开始后 sendMail 不再抛错；这里是投递前的异常，幂等记录按错误类型删除或标 failed，租约随之释放
        await Promise.all([failIdempotentSend(env, idem.handle, error), releaseDeliveryLeases(env, leaseToken)]);
        throw error;
      }
      if (summary.status !== 'failed') {
        await consumeDraftAttachments(env, row.userId, req.attachmentTokens.map((ref) => ref.token))
          .catch((error) => console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', error));
      }
    }
  } catch (error) {
    const outcome = await failureOutcome(env, row, error, mode, previous);
    await settle(env, row, outcome).catch((cause) => console.error('草稿发送结果写回失败:', cause));
    if (mode === 'now') throw error;
    console.error(JSON.stringify({ event: 'draft_send_failed', draftId: row.id, attempt: row.attempt, message: errorText(error) }));
    return null;
  }
  const failed = summary.status === 'failed';
  await settle(env, row, { status: failed ? 'failed' : 'sent', messageId: summary.id, errorDetail: summary.errorDetail })
    .catch((error) => console.error('草稿发送结果写回失败（邮件已处理，租约到期后按发件记录恢复）:', error));
  if (failed && mode === 'now') {
    throw deliveryFailedError(summary.id, summary.recipientOutcomes ?? [], summary.errorDetail || '全部收件人投递失败');
  }
  return failed ? null : summary;
}

/**
 * 立即发送（POST /drafts/:id/send）：草稿、定时、失败三种状态都可以；已发送的重放原结果，发送中 409。
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
      throw new AppError('send_in_progress', '草稿正在发送，请稍后用 GET /drafts/:id 查看结果，不要重复发送', {
        fix: '稍后 GET /drafts/:id：status 变为 sent 后看 messageId 对应的发件记录',
      });
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
 * 再按记录判定：已绑定发件行看发件行状态，未绑定就是没外发，安排过定时的重排（最多 3 次），否则标失败。
 */
async function recoverStale(env: Env, row: DraftRow): Promise<void> {
  await createDb(env).update(idempotencyRecords).set({ status: 'failed', errorDetail: '草稿发送中断，未外发', updatedAt: new Date() })
    .where(and(eq(idempotencyRecords.actorType, 'draft'), eq(idempotencyRecords.actorId, row.id), eq(idempotencyRecords.key, String(row.attempt)),
      eq(idempotencyRecords.status, 'pending'), isNull(idempotencyRecords.messageId)));
  const outcome = await failureOutcome(env, row, new AppError('internal', '发送中断（超过 15 分钟未完成）'), 'scheduled', 'scheduled');
  await settle(env, row, outcome);
}

/** 到期认领：走 idx_drafts_due（status='scheduled' 的部分索引，按 send_at），空闲时读 0 行（导出供 EXPLAIN 回归） */
export const DUE_DRAFTS_CLAIM_SQL = `UPDATE drafts SET status = 'sending', attempt = attempt + 1, claimed_at = ?, version = version + 1,
  updated_at = ? WHERE id IN (SELECT id FROM drafts WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT ?) RETURNING id`;
/** 租约到期：走 idx_drafts_sending（status='sending' 的部分索引，按 claimed_at） */
export const STALE_DRAFTS_SQL = `SELECT id FROM drafts WHERE status = 'sending' AND claimed_at < ? LIMIT ?`;

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
  const [claimed, stale] = await env.db.batch<{ id: number }>([
    env.db.prepare(DUE_DRAFTS_CLAIM_SQL).bind(now, now, now, DISPATCH_BATCH),
    env.db.prepare(STALE_DRAFTS_SQL).bind(now - DRAFT_SENDING_LEASE_MS, DISPATCH_BATCH),
  ]);
  const claimedIds = claimed!.results.map((item) => item.id);
  const staleIds = stale!.results.map((item) => item.id).filter((id) => !claimedIds.includes(id));
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
  const [owners, keys] = await env.db.batch<Record<string, unknown>>([
    env.db.prepare(`SELECT id, role, status, auth_version FROM users WHERE id IN (${ownerIds.map(() => '?').join(', ')})`).bind(...ownerIds),
    keyIds.length
      ? env.db.prepare(`SELECT id, status, expires_at FROM api_keys WHERE id IN (${keyIds.map(() => '?').join(', ')})`).bind(...keyIds)
      : env.db.prepare('SELECT NULL AS id WHERE 0'),
  ]);
  const ownerById = new Map(owners!.results.map((owner) => [Number(owner.id), {
    role: owner.role as Role, status: String(owner.status), authVersion: Number(owner.auth_version),
  }]));
  const keyById = new Map(keys!.results.map((key) => [Number(key.id), {
    status: String(key.status), expiresAt: key.expires_at === null ? null : new Date(Number(key.expires_at)),
  }]));
  await runPool(due, DISPATCH_CONCURRENCY, async (row) => {
    try {
      const owner = ownerById.get(row.userId);
      const revoked = scheduleRevoked(row, owner, row.scheduledByKeyId !== null ? keyById.get(row.scheduledByKeyId) : undefined, now);
      if (revoked) {
        await settle(env, row, { status: 'failed', messageId: null, errorDetail: revoked });
        report.failed++;
        return;
      }
      const sender = { userId: row.userId, role: owner!.role };
      const summary = await performSend(env, ctx, row, sender, env.site_origin ?? row.origin, 'scheduled', 'scheduled');
      if (summary) report.sent++;
      else report.failed++;
    } catch (error) {
      // 单封草稿的意外异常不影响其他草稿；它停在 sending，租约到期后恢复
      console.error('定时草稿发送异常:', error);
      report.failed++;
    }
  });
  return report;
}

/** 每日维护：删除超过保留期的已发送草稿与它们的正文对象（附件已在发送时回收；发件记录不受影响） */
export async function purgeSentDrafts(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - SENT_DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired = `SELECT id FROM drafts WHERE status = 'sent' AND sent_at < ? LIMIT 1000`;
  const [, deleted] = await env.db.batch([
    env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) SELECT body_r2_key FROM drafts
      WHERE id IN (${expired}) AND body_r2_key IS NOT NULL`).bind(cutoff),
    env.db.prepare(`DELETE FROM drafts WHERE id IN (${expired})`).bind(cutoff),
  ]);
  return deleted!.meta.changes ?? 0;
}
