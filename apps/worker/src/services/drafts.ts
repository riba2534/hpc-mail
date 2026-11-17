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
  type StoredDraftContent,
} from '@hpc-mail/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { apiKeys, draftAttachments, drafts, idempotencyRecords, messages } from '../db/schema.js';
import { runLimited } from '../lib/concurrency.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, toPage } from '../lib/pagination.js';
import { mailText } from '../lib/text.js';
import type { Env, ExecCtx } from '../types.js';
import { normalizeIdempotencyKey, type IdempotencyActor } from './idempotency.js';
import { readMailBody, storeMailBody } from './mail-body.js';
import { loadMessageSummary } from './message.js';
import { attachmentDisposition, decodeInlineAttachments, type BytesAttachment, type Sender } from './outbound.js';
import { deliverSend, inItemOrder, planOf, settledResult, type SendEnvironment } from './send-flow.js';
import { draftKey, newDraftToken, releaseDraftStatements, releaseDrafts, reserveDraftAttachment } from './upload.js';
import { fetchUrlAttachments, releaseUrlAttachments } from './url-attachment.js';
import { newUrlBufferBudget, reserveUrlFetches } from './url-fetch-budget.js';

type DraftRow = typeof drafts.$inferSelect;

/**
 * 能看到哪些草稿：始终限于 userId 的草稿；keyId 非空时（限定了范围的 API Key）只限这把 Key 自己创建的草稿，
 * 不能借草稿读写范围外地址的内容。
 */
export interface DraftOwner {
  userId: number;
  keyId?: number | null;
}

function ownedBy(owner: DraftOwner) {
  return and(eq(drafts.userId, owner.userId), owner.keyId ? eq(drafts.apiKeyId, owner.keyId) : undefined);
}

/** 操作草稿的调用方：网页会话或 API Key；草稿始终属于 userId */
export interface DraftActor {
  userId: number;
  /** 限定了范围的 API Key：只能操作它自己创建的草稿 */
  restrictedKeyId: number | null;
  via: 'web' | 'api';
  /** API Key 调用时为 Key id */
  apiKeyId: number | null;
  /** 创建草稿的 Idempotency-Key 按调用方隔离（同发信） */
  idempotencyActor: IdempotencyActor;
}

/** 保存草稿时的请求环境：附件下载链接的 origin，URL 附件不能指向的本站主机 */
export type DraftRequestEnv = Pick<SendEnvironment, 'origin' | 'selfHosts' | 'urlBuffer'>;

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

export async function listDrafts(env: Env, owner: DraftOwner, query: ListDraftsQuery): Promise<Page<DraftSummary>> {
  const cursorId = decodeCursor(query.cursor);
  const rows = await createDb(env).select({ draft: drafts, apiKeyName: keyName }).from(drafts)
    .where(and(ownedBy(owner), query.status ? eq(drafts.status, query.status) : undefined,
      cursorId ? lt(drafts.id, cursorId) : undefined))
    .orderBy(desc(drafts.id)).limit(query.limit + 1).all();
  const page = toPage(rows, query.limit, (row) => row.draft.id);
  return { items: page.items.map((row) => toSummary(row.draft, row.apiKeyName)), nextCursor: page.nextCursor };
}

/** 草稿行与它引用的附件合成一次往返 */
async function loadDraft(env: Env, owner: DraftOwner, id: number) {
  const db = createDb(env);
  const [rows, files] = await db.batch([
    db.select({ draft: drafts, apiKeyName: keyName }).from(drafts).where(and(eq(drafts.id, id), ownedBy(owner))),
    db.select().from(draftAttachments).where(and(eq(draftAttachments.draftId, id), eq(draftAttachments.userId, owner.userId))),
  ]);
  const row = rows[0];
  if (!row) throw notFound();
  return { row: row.draft, apiKeyName: row.apiKeyName, files };
}

export async function getDraft(env: Env, owner: DraftOwner, id: number): Promise<Draft> {
  const { row, apiKeyName, files } = await loadDraft(env, owner, id);
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

/**
 * 引用已有上传附件前核对：属于本人、已上传完成、没有被其他草稿引用。返回它们的合计大小（新附件的预算从剩余额度里扣）。
 */
async function usableTokenBytes(env: Env, userId: number, refs: AttachmentTokenRef[], draftId: number | null): Promise<number> {
  const tokens = [...new Set(refs.map((ref) => ref.token))];
  if (!tokens.length) return 0;
  const rows = await createDb(env).select({
    token: draftAttachments.token, status: draftAttachments.status, draftId: draftAttachments.draftId, size: draftAttachments.size,
  }).from(draftAttachments).where(and(eq(draftAttachments.userId, userId), inArray(draftAttachments.token, tokens))).all();
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
  return rows.reduce((sum, row) => sum + row.size, 0);
}

/** base64 附件转存为一份上传附件（同 POST /uploads，计入每人待发送附件配额） */
async function storeBase64(env: Env, userId: number, { filename, mimeType, bytes }: BytesAttachment): Promise<string> {
  const token = newDraftToken();
  const r2Key = draftKey(userId, token);
  const rowId = await reserveDraftAttachment(env, { userId, token, filename, mimeType, size: bytes.byteLength, r2Key });
  try {
    await env.r2.put(r2Key, bytes, { httpMetadata: { contentType: mimeType } });
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
  draftId: number | null,
  items: NonNullable<DraftInput['attachments']>,
  usedBytes: number,
  request: DraftRequestEnv,
): Promise<AttachmentTokenRef[]> {
  if (!items.length) return [];
  const urls = items.filter(isUrlAttachment);
  if (urls.length) {
    // 拉取之前先占每分钟拉取额度；新建时同一次往返读出未发送草稿数，已到上限就不去拉（不然每次被拒前都先拉一遍）
    const [unsent] = await reserveUrlFetches(env, userId, urls.length, draftId === null
      ? [env.db.prepare(`SELECT COUNT(*) AS n FROM drafts WHERE user_id = ? AND status <> 'sent'`).bind(userId)] : []);
    if (draftId === null && Number((unsent?.results[0] as { n?: number } | undefined)?.n ?? 0) >= MAX_DRAFTS_PER_USER) {
      throw new AppError('draft_limit_reached', `未发送的草稿最多 ${MAX_DRAFTS_PER_USER} 份`);
    }
  }
  const created: { token: string }[] = [];
  try {
    // base64 与发信同一解码；合计超限时一个都不转存
    const decoded = decodeInlineAttachments(items.filter((item) => !isUrlAttachment(item)));
    const total = decoded.reduce((sum, att) => sum + att.bytes.byteLength, usedBytes);
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new AppError('payload_too_large', '附件合计超过大小上限');
    for (const att of decoded) created.push({ token: await storeBase64(env, userId, att) });
    const stored = [...created];
    const fetched = await fetchUrlAttachments(env, userId, urls, {
      selfHosts: request.selfHosts, budgetBytes: MAX_ATTACHMENT_TOTAL_BYTES - total, memory: request.urlBuffer,
    });
    created.push(...fetched);
    const tokens = inItemOrder<{ token: string }>(items, stored, fetched);
    return items.map((item, index) => ({
      token: tokens[index]!.token,
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
    ...releaseDrafts(env, stale, [userId, draftId, ...unique]),
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
  /** 正文有改动时为新写入的正文列与摘要 */
  body: (Awaited<ReturnType<typeof storeMailBody>> & { preview: string }) | null;
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
    created = await materialize(env, userId, draftId, input.attachments ?? [], await usableTokenBytes(env, userId, kept, draftId), request);
  }
  let body: Prepared['body'] = null;
  if (input.text !== undefined || input.html !== undefined) {
    // 摘要与 D1 搜索文本共用一次 HTML → 纯文本转换
    const view = mailText(text, html);
    try { body = { ...await storeMailBody(env, text, html, undefined, view), preview: view.preview() }; }
    catch (error) { await releaseUrlAttachments(env, userId, created); throw error; }
  }
  // 新转存的排在前面，与发信时 attachments 在 attachmentTokens 之前的顺序一致
  const attachmentTokens = replacesAttachments ? [...created, ...kept] : content.attachmentTokens;
  return { content: { ...content, attachmentTokens }, body, created, replacesAttachments };
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

/** 同键已有草稿：同一请求体返回它（当前状态），不同请求体 409 */
async function replayCreate(env: Env, userId: number, storedKey: string, requestHash: string): Promise<Draft | null> {
  const existing = await createDb(env).select({ id: drafts.id, requestHash: drafts.requestHash }).from(drafts)
    .where(eq(drafts.idempotencyKey, storedKey)).get();
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new AppError('idempotency_mismatch', '相同 Idempotency-Key 不能用于不同的草稿内容，请使用新的 Key');
  }
  return getDraft(env, { userId }, existing.id);
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
  const body = prepared.body ?? { bodyText: '', bodyHtml: '', bodyR2Key: null, preview: '' };
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
      body.preview, sendAt ? sendAt.getTime() : null, actor.via, actor.apiKeyId,
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
  return { draft: await getDraft(env, { userId: actor.userId }, id), replayed: false };
}

export async function updateDraft(
  env: Env,
  actor: DraftActor,
  id: number,
  input: DraftInput,
  request: DraftRequestEnv,
  authorize?: (content: StoredDraftContent) => void | Promise<void>,
): Promise<Draft> {
  const owner = { userId: actor.userId, keyId: actor.restrictedKeyId };
  const { row } = await loadDraft(env, owner, id);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) throw stateConflict(row, conflictMessage(row, '修改'));
  if (!EDITABLE.includes(row.status)) throw stateConflict(row, conflictMessage(row, '修改'));
  await authorize?.(mergeContent(row.content, input));
  const sendAt = sendAtOf(input);
  const status: DraftStatus = sendAt ? 'scheduled' : sendAt === null ? 'draft' : row.status;
  // 原正文要读全文（D1 里可能只是搜索用的截断文本）：只改了 text、html 之一时另一段沿用原文重新落库；
  // 只改部分字段又要保持（或进入）定时状态时，原正文要一起做完整性校验
  const keepsPart = input.text === undefined || input.html === undefined;
  const changesPart = input.text !== undefined || input.html !== undefined;
  const current = keepsPart && (changesPart || status === 'scheduled') ? await readMailBody(env, row) : row;
  const prepared = await prepare(env, actor.userId, id, { content: row.content, text: current.bodyText, html: current.bodyHtml },
    input, status === 'scheduled', request);
  const db = createDb(env);
  const update = db.update(drafts).set({
    status,
    content: prepared.content,
    ...prepared.body,
    version: sql`${drafts.version} + 1`,
    updatedAt: new Date(),
    origin: request.origin,
    ...(sendAt !== undefined ? { sendAt, errorDetail: '' } : {}),
    // 安排者记的是最后一个让它保持定时的写入者（安排或改写内容都算）与当时的账户安全版本：到点按它复核，
    // 别的 Key 改写已安排的草稿后，到点复核的就是改写者，不会沿用原安排者的权限
    ...(status === 'scheduled' ? {
      scheduledByKeyId: actor.apiKeyId,
      scheduledAuthVersion: sql`(select auth_version from users where id = ${actor.userId})`,
    } : status === 'draft' ? { scheduledByKeyId: null, scheduledAuthVersion: null } : {}),
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
  return getDraft(env, owner, id);
}

export async function deleteDraft(env: Env, owner: DraftOwner, id: number): Promise<void> {
  const db = createDb(env);
  const userId = owner.userId;
  const row = await db.select({ status: drafts.status, version: drafts.version, bodyR2Key: drafts.bodyR2Key }).from(drafts)
    .where(and(eq(drafts.id, id), ownedBy(owner))).get();
  if (!row) throw notFound();
  if (row.status === 'sending') throw stateConflict(row, conflictMessage(row, '删除'));
  // 删除与释放附件、正文同一事务；附件只在草稿确实被删掉后才释放（并发进入 sending 时都不动）
  const released = `user_id = ? AND draft_id = ? AND NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?)`;
  const [deleted] = await env.db.batch([
    env.db.prepare(`DELETE FROM drafts WHERE id = ? AND user_id = ? AND status <> 'sending' RETURNING id`).bind(id, userId),
    ...releaseDrafts(env, released, [userId, id, id]),
    ...bodyCleanupStatement(env, row.bodyR2Key),
  ]);
  if (!deleted?.results.length) {
    const latest = await db.select({ status: drafts.status, version: drafts.version }).from(drafts).where(eq(drafts.id, id)).get();
    if (latest) throw stateConflict(latest, conflictMessage(latest, '删除'));
  }
}

// ---------- 发送 ----------

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
  se: SendEnvironment,
  row: DraftRow,
  sender: Sender,
  mode: SendMode,
  previous: DraftStatus,
): Promise<MessageSummary | null> {
  const { env } = se;
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
    // 附件在保存时已转存为上传附件（draftSendInput 的 attachments 恒为空），发送时没有 URL 要拉取
    summary = await deliverSend(se, { type: 'draft', id: row.id }, sender, String(row.attempt),
      sendRequestFingerprint(req), async () => ({ ...planOf(req), draftId: row.id }));
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
  if (mode === 'now') return settledResult(summary);
  return failed ? null : summary;
}

/**
 * 立即发送（POST /drafts/:id/send）：草稿、定时、失败三种状态都可以；已发送的重放原结果，发送中 409。
 * authorize 在认领前按草稿内容做 scope 检查（Key 引用来源邮件需 mail.read）；expectedVersion 是审阅时的版本，不一致 409。
 */
export async function sendDraftNow(
  se: SendEnvironment,
  sender: Sender,
  id: number,
  authorize?: (content: StoredDraftContent) => void | Promise<void>,
  expectedVersion?: number,
  restrictedKeyId?: number | null,
): Promise<MessageSummary> {
  const { env } = se;
  const db = createDb(env);
  const row = await db.select().from(drafts).where(and(eq(drafts.id, id), ownedBy({ userId: sender.userId, keyId: restrictedKeyId }))).get();
  if (!row) throw notFound();
  const settled = async (current: Pick<DraftRow, 'status' | 'version' | 'messageId'>): Promise<MessageSummary> => {
    if (current.status === 'sending') {
      throw new AppError('send_in_progress', '草稿正在发送，请稍后用 GET /drafts/:id 查看结果，不要重复发送', {
        fix: '稍后 GET /drafts/:id：status 变为 sent 后看 messageId 对应的发件记录',
      });
    }
    if (current.status === 'sent' && current.messageId) {
      const summary = await loadMessageSummary(env, current.messageId);
      if (summary) return summary;
    }
    throw stateConflict(current, current.status === 'sent' ? '草稿已发送，发件记录已不存在' : '草稿状态已变化，请重新读取');
  };
  if (!EDITABLE.includes(row.status)) return settled(row);
  // 人审：审阅之后又被改过就不发，免得发出审阅者没看过的内容（认领条件同样带版本，读与认领之间的修改也拦得住）
  if (expectedVersion !== undefined && expectedVersion !== row.version) {
    throw stateConflict(row, `草稿在你审阅之后被修改过（当前版本 ${row.version}），请重新审阅后再发送`);
  }
  await authorize?.(row.content);
  const claimed = await db.update(drafts).set({
    status: 'sending', attempt: sql`${drafts.attempt} + 1`, claimedAt: new Date(), version: sql`${drafts.version} + 1`, updatedAt: new Date(),
  }).where(and(eq(drafts.id, id), eq(drafts.version, row.version), eq(drafts.status, row.status))).returning().get();
  if (!claimed) {
    const current = await db.select().from(drafts).where(eq(drafts.id, id)).get();
    if (!current) throw notFound();
    return settled(current);
  }
  return (await performSend(se, claimed, sender, 'now', row.status))!;
}

// ---------- 定时派发与恢复 ----------

/** 到点复核：所有者仍启用、账户安全版本未变、安排它的 Key 仍有效；不满足时返回取消原因 */
interface SchedulerKey {
  status: string;
  expiresAt: Date | null;
  scopes: string[];
  mailboxIds: number[];
  domains: string[];
}

/** 发件地址对应的认领行（按 mailboxId 或地址查到的），用于复核限定了范围的 Key */
type SenderBox = { id: number; domain: string } | undefined;

function scheduleRevoked(
  row: DraftRow,
  owner: { status: string; authVersion: number } | undefined,
  key: SchedulerKey | undefined,
  sender: { box: SenderBox; domain: string | null },
  now: number,
): string | null {
  if (!owner || owner.status !== 'active') return '草稿所有者已被禁用，定时发送已取消';
  if (row.scheduledAuthVersion !== null && owner.authVersion !== row.scheduledAuthVersion) {
    return '账户安全状态已变化（改密、重置或禁用），定时发送已取消，请确认后重新安排';
  }
  if (row.scheduledByKeyId !== null && (!key || key.status !== 'active' || (key.expiresAt && key.expiresAt.getTime() <= now))) {
    return '安排定时发送的 API Key 已失效，定时发送已取消，请确认后重新安排';
  }
  // 与直接发信同一套 scope：发信要 mail.send，引用原信（回复、转发附件）另需 mail.read
  if (key && !key.scopes.includes('mail.send')) return '安排定时发送的 API Key 已没有 mail.send，定时发送已取消，请确认后重新安排';
  const referencesSource = Boolean(row.content.replyToMessageId || row.content.forwardAttachmentsFrom);
  if (key && referencesSource && !key.scopes.includes('mail.read')) {
    return '安排定时发送的 API Key 已没有 mail.read（草稿引用了原邮件），定时发送已取消，请确认后重新安排';
  }
  // Key 之后被收窄了范围：发件地址不在范围内就不发（与安排时的检查同一口径：域名在范围内或认领行在范围内）
  if (key && (key.mailboxIds.length || key.domains.length)) {
    const domain = sender.box?.domain ?? sender.domain;
    const allowed = (domain !== null && key.domains.includes(domain)) || (sender.box !== undefined && key.mailboxIds.includes(sender.box.id));
    if (!allowed) return '安排定时发送的 API Key 已不再覆盖这个发件地址，定时发送已取消，请确认后重新安排';
  }
  return null;
}

/** 定时发送的发信角色：网页会话安排的就是账户角色；Key 安排的按 apiKeyAuth 的规则，不会高于账户角色 */
function schedulerRole(ownerRole: Role, key: SchedulerKey | undefined): Role {
  if (!key) return ownerRole;
  return ownerRole === 'admin' && key.scopes.includes('admin') ? 'admin' : 'user';
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
  // 发件邮箱：限定范围的 Key 复核要用到认领行；草稿最多 DISPATCH_BATCH 封，绑定参数不会超
  const boxIds = [...new Set(due.flatMap((row) => (row.content.from?.mailboxId ? [row.content.from.mailboxId] : [])))];
  const addresses = [...new Set(due.flatMap((row) => (row.content.from?.localPart && row.content.from.domain
    ? [`${row.content.from.localPart}@${row.content.from.domain}`] : [])))];
  const list = (values: unknown[]) => values.map(() => '?').join(', ');
  const [owners, keys, boxes] = await env.db.batch<Record<string, unknown>>([
    env.db.prepare(`SELECT id, role, status, auth_version FROM users WHERE id IN (${list(ownerIds)})`).bind(...ownerIds),
    keyIds.length
      ? env.db.prepare(`SELECT id, status, expires_at, scopes, allowed_mailbox_ids, allowed_domains FROM api_keys WHERE id IN (${list(keyIds)})`).bind(...keyIds)
      : env.db.prepare('SELECT NULL AS id WHERE 0'),
    boxIds.length || addresses.length
      ? env.db.prepare(`SELECT id, domain, address FROM mailboxes WHERE id IN (${list(boxIds) || 'NULL'}) OR address IN (${list(addresses) || 'NULL'})`)
        .bind(...boxIds, ...addresses)
      : env.db.prepare('SELECT NULL AS id WHERE 0'),
  ]);
  const boxById = new Map(boxes!.results.map((box) => [Number(box.id), { id: Number(box.id), domain: String(box.domain) }]));
  const boxByAddress = new Map(boxes!.results.map((box) => [String(box.address), { id: Number(box.id), domain: String(box.domain) }]));
  const senderOf = (row: DraftRow) => {
    const from = row.content.from;
    if (from?.mailboxId) return { box: boxById.get(from.mailboxId), domain: null };
    if (from?.localPart && from.domain) return { box: boxByAddress.get(`${from.localPart}@${from.domain}`), domain: from.domain };
    return { box: undefined, domain: null };
  };
  const json = (value: unknown) => { try { return JSON.parse(String(value ?? '[]')) as unknown[]; } catch { return []; } };
  const ownerById = new Map(owners!.results.map((owner) => [Number(owner.id), {
    role: owner.role as Role, status: String(owner.status), authVersion: Number(owner.auth_version),
  }]));
  const keyById = new Map(keys!.results.map((key): [number, SchedulerKey] => [Number(key.id), {
    status: String(key.status), expiresAt: key.expires_at === null ? null : new Date(Number(key.expires_at)),
    scopes: json(key.scopes).map(String),
    mailboxIds: json(key.allowed_mailbox_ids).map(Number), domains: json(key.allowed_domains).map(String),
  }]));
  await runLimited(due, DISPATCH_CONCURRENCY, async (row) => {
    try {
      const owner = ownerById.get(row.userId);
      const key = row.scheduledByKeyId !== null ? keyById.get(row.scheduledByKeyId) : undefined;
      const revoked = scheduleRevoked(row, owner, key, senderOf(row), now);
      if (revoked) {
        await settle(env, row, { status: 'failed', messageId: null, errorDetail: revoked });
        report.failed++;
        return;
      }
      // 发信角色取账户角色与安排者有效角色中较低的一个：Key 安排的按 apiKeyAuth 的同一规则（管理员 Key 要带 admin scope
      // 才是管理员），否则管理员名下的普通 Key 可以借定时发送冒用任意邮箱、绕过外发配额
      const sender = { userId: row.userId, role: schedulerRole(owner!.role, key) };
      const summary = await performSend({ env, ctx, origin: env.site_origin ?? row.origin, selfHosts: [], urlBuffer: newUrlBufferBudget() },
        row, sender, 'scheduled', 'scheduled');
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
