import {
  MAX_INLINE_ATTACHMENT_TOTAL_BYTES,
  batchSendRequestSchema,
  deleteMessagesRequestSchema,
  inlineAttachmentBytes,
  internalSendMailSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  MAX_WAIT_POLLS_PER_USER_PER_MINUTE,
  starMessagesRequestSchema,
  markAllReadRequestSchema,
  waitMessagesQuerySchema,
  type BatchSendItemResult,
  type BatchSendResult,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { buildSecureHeaders } from '../../lib/attachment-security.js';
import { auditUnclaimedPurge, auditUserScopeRead, messageViewer, mutationViewer } from '../../lib/message-viewer.js';
import { runLimited } from '../../lib/concurrency.js';
import { V1_ATTACHMENT_TTL_SECONDS } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { conditionalDetailResponse } from '../../lib/etag.js';
import { execCtx, ok, parseBody, parseId, parseQuery, parseValue } from '../../lib/http.js';
import {
  apiKeyAuth, assertKeyCanUseAddress, assertKeyCanUseDomain, keyRestriction, requireScope,
} from '../../middleware/api-key-auth.js';
import { errorObject } from '../../middleware/error.js';
import {
  countUnread,
  deleteMessages,
  getThread,
  getRawMessageObject,
  getRecentContacts,
  markAllRead,
  starMessages,
  restoreMessages,
  purgeMessages,
  findNextMessage,
  getMessageDetailConditional,
  listMessages,
  loadAttachmentForViewer,
  markMessages,
  type Viewer,
} from '../../services/message.js';
import { assertRequestSize, authorizeSendContent, handleCompose, handleSend, sendEnvironment, sendOne } from '../send-handler.js';
import { getObject } from '../../services/storage.js';
import type { AppContext } from '../../types.js';
import { bumpCounter, minuteWindow } from '../../services/rate-counter.js';

const app = new Hono<AppContext>();
const WAIT_POLL_INTERVAL_MS = 2000;
app.use('*', apiKeyAuth);

app.get('/', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const query = parseQuery(c, listMessagesQuerySchema);
  // 显式给出范围外的地址或域名直接 403，而不是静默返回空列表
  if (query.address) await assertKeyCanUseAddress(c, query.address);
  if (query.domain) assertKeyCanUseDomainOrMailboxes(c, query.domain);
  return ok(c, await listMessages(c.env, viewerFromKey(key, query, c), query));
});

app.post('/', (c) => {
  requireScope(c, 'mail.send');
  const key = c.get('apiKey')!;
  return handleSend(c, { type: 'api_key', id: key.id }, { userId: key.userId, role: key.role });
});

/** 批量发送并发上限：项与项之间互不等待，又不至于同时持有太多附件或占满出站连接 */
const BATCH_SEND_CONCURRENCY = 4;

/**
 * 批量发送：每项是一份独立的发信请求，与单发同一流程（校验、mail.read、幂等、URL 附件、配额、发送、回收）。
 * 外层不合法、请求体或 base64 附件合计超限才整体失败；单项失败（含配额用尽的 429）只体现在该项结果里。
 * 幂等键：项的 idempotencyKey 优先，否则由请求头 Idempotency-Key 派生 `<头>:<index>`，整批重试时逐项重放。
 */
app.post('/batch', async (c) => {
  requireScope(c, 'mail.send');
  assertRequestSize(c);
  const key = c.get('apiKey')!;
  const { items } = await parseBody(c, batchSendRequestSchema);
  const headerKey = c.req.header('Idempotency-Key')?.trim() || undefined;
  const parsed = items.map((raw, index) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError('validation_failed', '每一项都需要是发信请求对象');
      const { idempotencyKey, ...request } = raw as Record<string, unknown>;
      if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
        throw new AppError('validation_failed', 'idempotencyKey 需为字符串');
      }
      const itemKey = idempotencyKey?.trim() || (headerKey ? `${headerKey}:${index}` : undefined);
      return { index, itemKey, req: parseValue(internalSendMailSchema, request) };
    } catch (error) {
      return { index, error };
    }
  });
  // base64 附件在内存里要解码、组装 MIME，整批合计与单发同一上限，超了整体拒绝
  const inlineBytes = parsed.reduce((sum, item) => sum + ('req' in item && item.req ? inlineAttachmentBytes(item.req.attachments) : 0), 0);
  if (inlineBytes > MAX_INLINE_ATTACHMENT_TOTAL_BYTES) {
    throw new AppError('payload_too_large', `批量请求里的 base64 附件合计超过 ${MAX_INLINE_ATTACHMENT_TOTAL_BYTES / 1024 / 1024}MB 上限`);
  }
  const se = sendEnvironment(c);
  const sender = { userId: key.userId, role: key.role };
  const results: BatchSendItemResult[] = [];
  await runLimited(parsed, BATCH_SEND_CONCURRENCY, async (item) => {
    const itemKey = 'itemKey' in item ? item.itemKey : undefined;
    try {
      if ('error' in item) throw item.error;
      await authorizeSendContent(c, item.req);
      const message = await sendOne(se, { type: 'api_key', id: key.id }, sender, item.req, itemKey);
      results.push({ index: item.index, ok: true, httpStatus: 201, ...(itemKey ? { idempotencyKey: itemKey } : {}), message });
    } catch (error) {
      const { status, error: body } = errorObject(error, c);
      results.push({ index: item.index, ok: false, httpStatus: status, ...(itemKey ? { idempotencyKey: itemKey } : {}), error: body });
    }
  });
  results.sort((a, b) => a.index - b.index);
  const succeeded = results.filter((result) => result.ok).length;
  const body: BatchSendResult = { items: results, succeeded, failed: results.length - succeeded };
  return ok(c, body);
});

/**
 * 按域名收窄：域名在 allowedDomains 中，或只限定了邮箱时该域名下有允许的邮箱（列表照常只返回允许的邮箱），
 * 否则 403。只限定邮箱的 Key 按域名筛自己邮箱的邮件是合理用法，不应一律拒绝。
 */
function assertKeyCanUseDomainOrMailboxes(c: Context<AppContext>, domain: string): void {
  const restriction = keyRestriction(c);
  if (!restriction || restriction.domains.includes(domain) || restriction.mailboxIds.length) return;
  assertKeyCanUseDomain(c, domain);
}

/**
 * 回复与转发：服务端按原信算收件人、主题、引用与线程头，from 缺省用原信的收件地址。
 * 会读出原信内容，与 POST / 引用来源邮件一样同时需要 mail.send 与 mail.read。
 */
for (const op of ['reply', 'forward'] as const) {
  app.post(`/:id/${op}`, (c) => {
    requireScope(c, 'mail.send');
    requireScope(c, 'mail.read');
    const key = c.get('apiKey')!;
    return handleCompose(c, { type: 'api_key', id: key.id }, { userId: key.userId, role: key.role }, op, parseId(c.req.param('id')));
  });
}

/** 标记已读/未读——Agent 处理完邮件后维护状态用（需 mail.write） */
app.post('/read', async (c) => {
  requireScope(c, 'mail.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, markReadRequestSchema);
  const viewer = mutationViewer(c, key, req.scope);
  const changed = await markMessages(c.env, viewer, req.ids, req.isRead);
  return ok(c, { changed });
});

/** 删除邮件——Agent 清理已消费的验证码邮件用（需 mail.write） */
app.post('/delete', async (c) => {
  requireScope(c, 'mail.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const viewer = mutationViewer(c, key, req.scope);
  const deleted = await deleteMessages(c.env, viewer, req.ids);
  return ok(c, { deleted });
});

app.post('/read-all', async (c) => {
  requireScope(c, 'mail.write');
  const req = c.req.header('Content-Length') === '0' || c.req.raw.body === null
    ? {} : await parseBody(c, markAllReadRequestSchema);
  const { scope, ...filters } = req;
  return ok(c, { changed: await markAllRead(c.env, mutationViewer(c, c.get('apiKey')!, scope), filters) });
});

app.post('/star', async (c) => {
  requireScope(c, 'mail.write');
  const req = await parseBody(c, starMessagesRequestSchema);
  return ok(c, { changed: await starMessages(c.env, mutationViewer(c, c.get('apiKey')!, req.scope), req.ids, req.starred) });
});

app.post('/restore', async (c) => {
  requireScope(c, 'mail.write');
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const restored = await restoreMessages(c.env, mutationViewer(c, c.get('apiKey')!, req.scope), req.ids);
  return ok(c, { restored, changed: restored });
});

app.post('/purge', async (c) => {
  requireScope(c, 'mail.write');
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const viewer = mutationViewer(c, c.get('apiKey')!, req.scope);
  const purged = await purgeMessages(c.env, viewer, req.ids, execCtx(c));
  await auditUnclaimedPurge(c, viewer, req.ids, purged);
  return ok(c, { purged, changed: purged });
});

app.get('/contacts', async (c) => {
  requireScope(c, 'mail.read');
  return ok(c, { contacts: await getRecentContacts(c.env, messageViewer(c, c.get('apiKey')!)) });
});

/** 未读数只统计调用者认领的地址；scope 只接受 mine，其他值显式拒绝，不静默退回个人未读数 */
app.get('/unread-count', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const scope = c.req.query('scope');
  if (scope !== undefined && scope !== 'mine') {
    throw new AppError('validation_failed', '未读数只统计调用者认领的地址，scope 只能为 mine');
  }
  return ok(c, { unread: await countUnread(c.env, key.userId, key.role, undefined, keyRestriction(c) ?? undefined) });
});

/**
 * afterId=0 是空邮箱基线；校验参数、范围，客户端取消后不再进行额外 D1 轮询。
 * 轮询配额在请求开始时按本次最多轮询次数一次性预占（1 次写），结束时退还未用部分，
 * 不再每 2 秒写一次计数；预占超限即拒绝，并发长轮询仍受同一上限约束。
 * from/subjectContains/hasCode 跳过不匹配的新邮件；scannedThroughId 让调用方超时后也能推进游标。
 * address（最多 20 个）与 domain 收窄范围；include=body 命中时直接返回详情结构，省一次详情请求。
 */
app.get('/wait', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  // 重复的 address 参数（?address=a&address=b）先用逗号合并，与逗号分隔写法走同一校验
  const addresses = c.req.queries('address');
  const query = parseQuery(c, {
    safeParse: (raw) => waitMessagesQuerySchema.safeParse({ ...(raw as Record<string, string>), address: addresses?.join(',') }),
  });
  for (const address of query.address ?? []) await assertKeyCanUseAddress(c, address);
  if (query.domain) assertKeyCanUseDomainOrMailboxes(c, query.domain);
  const viewer = messageViewer(c, key);
  const deadline = Date.now() + query.timeout * 1000;
  const signal = c.req.raw.signal;
  let cursor = query.afterId;
  const empty = () => ok(c, { message: null, scannedThroughId: cursor });
  if (signal.aborted) return empty();
  const subject = String(key.userId);
  const window = minuteWindow(1);
  const planned = Math.ceil((query.timeout * 1000) / WAIT_POLL_INTERVAL_MS) + 1;
  const rate = await bumpCounter(c.env, 'api-wait', subject, window, planned);
  if (rate.count > MAX_WAIT_POLLS_PER_USER_PER_MINUTE) {
    // 被拒的这次与原先一样计 1 次，其余预占立即退还
    await bumpCounter(c.env, 'api-wait', subject, window, 1 - planned);
    throw new AppError('rate_limited', '长轮询查询频率超限，请稍后重试');
  }
  let polls = 0;
  try {
    for (;;) {
      if (signal.aborted) return empty();
      polls++;
      const found = await findNextMessage(c.env, viewer, {
        afterId: cursor, address: query.address, domain: query.domain, include: query.include,
        from: query.from, subjectContains: query.subjectContains, hasCode: query.hasCode,
      }, V1_ATTACHMENT_TTL_SECONDS);
      cursor = found.scannedThroughId;
      if (found.message) return ok(c, found);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || polls >= planned) return empty();
      await waitForPoll(signal, Math.min(WAIT_POLL_INTERVAL_MS, remaining));
    }
  } finally {
    const unused = planned - polls;
    if (unused > 0) {
      const refund = bumpCounter(c.env, 'api-wait', subject, window, -unused)
        .catch(error => console.error('长轮询配额退还失败:', error));
      const ctx = execCtx(c);
      if (ctx) ctx.waitUntil(refund);
      else await refund;
    }
  }
});

function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const complete = () => { clearTimeout(timer); signal.removeEventListener('abort', complete); resolve(); };
    const timer = setTimeout(complete, milliseconds);
    signal.addEventListener('abort', complete, { once: true });
    if (signal.aborted) complete();
  });
}

function viewerFromKey(
  key: { userId: number; role: Viewer['role'] },
  query: { scope?: Viewer['scope']; userId?: number },
  c: Context<AppContext>,
): Viewer {
  const restrict = keyRestriction(c) ?? undefined;
  const viewer: Viewer = { userId: key.userId, role: key.role, scope: query.scope, targetUserId: query.userId, ...(restrict ? { restrict } : {}) };
  auditUserScopeRead(c, viewer);
  return viewer;
}

app.get('/:id/thread', async (c) => {
  requireScope(c, 'mail.read');
  return ok(c, { items: await getThread(c.env, messageViewer(c, c.get('apiKey')!), parseId(c.req.param('id'))) });
});

app.get('/:id/raw', async (c) => {
  requireScope(c, 'mail.read');
  const id = parseId(c.req.param('id'));
  const obj = await getRawMessageObject(c.env, messageViewer(c, c.get('apiKey')!), id);
  if (!obj) throw new AppError('not_found', '该邮件无原始存档');
  return new Response(obj.body, { status: 200, headers: {
    'Content-Type': 'message/rfc822', 'Content-Disposition': `attachment; filename="message-${id}.eml"`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
  } });
});

app.get('/:id', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  const ifNoneMatch = c.req.header('If-None-Match');
  return conditionalDetailResponse(c, await getMessageDetailConditional(c.env, messageViewer(c, key), id, {
    attachmentTtlSeconds: V1_ATTACHMENT_TTL_SECONDS, ifNoneMatch,
  }));
});

app.get('/:id/attachments/:attId', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  const attId = parseId(c.req.param('attId'));
  const viewer: Viewer = messageViewer(c, key);
  const att = await loadAttachmentForViewer(c.env, viewer, attId);
  if (att.messageId !== id) throw new AppError('not_found', '附件不存在');
  const obj = await getObject(c.env, att.r2Key);
  if (!obj) throw new AppError('not_found', '附件内容不存在');
  return new Response(obj.body, { status: 200, headers: buildSecureHeaders(att.mimeType, att.filename) });
});

export default app;
