import {
  deleteMessagesRequestSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  MAX_WAIT_POLLS_PER_USER_PER_MINUTE,
  internalSendMailSchema,
  starMessagesRequestSchema,
  markAllReadRequestSchema,
  waitMessagesQuerySchema,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { buildSecureHeaders } from '../../lib/attachment-security.js';
import { messageViewer, mutationViewer } from '../../lib/message-viewer.js';
import { AppError } from '../../lib/errors.js';
import { execCtx, ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
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
  getMessageDetail,
  listMessages,
  loadAttachmentForViewer,
  markMessages,
  type Viewer,
} from '../../services/message.js';
import { decodeInlineAttachments, sendMail } from '../../services/outbound.js';
import {
  beginIdempotentSend,
  completeIdempotentSend,
  failIdempotentSend,
} from '../../services/idempotency.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../../services/upload.js';
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
  return ok(c, await listMessages(c.env, viewerFromKey(key, query), query));
});

app.post('/', async (c) => {
  requireScope(c, 'mail.send');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, internalSendMailSchema);
  const idem = await beginIdempotentSend(
    c.env,
    { type: 'api_key', id: key.id },
    c.req.header('Idempotency-Key'),
    req,
  );
  if (idem.kind === 'replay') return ok(c, idem.response, 201);
  try {
    const attachments = [...decodeInlineAttachments(req.attachments),
      ...await resolveDraftAttachments(c.env, key.userId, req.attachmentTokens)];
    const origin = new URL(c.req.url).origin;
    const summary = await sendMail(
      c.env,
      c.executionCtx,
      { userId: key.userId, role: key.role },
      req,
      attachments,
      origin,
      idem.handle,
    );
    try { await completeIdempotentSend(c.env, idem.handle, summary); }
    catch (error) { console.error('已投递邮件的幂等结果回填失败，保持原键以便查询:', error); }
    try { await consumeDraftAttachments(c.env, key.userId, req.attachmentTokens); }
    catch (error) { console.error('已发送邮件的草稿回收延迟:', error); }
    return ok(c, summary, 201);
  } catch (error) {
    await failIdempotentSend(c.env, idem.handle, error);
    throw error;
  }
});

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
  const purged = await purgeMessages(c.env, mutationViewer(c, c.get('apiKey')!, req.scope), req.ids);
  return ok(c, { purged, changed: purged });
});

app.get('/contacts', async (c) => {
  requireScope(c, 'mail.read');
  return ok(c, { contacts: await getRecentContacts(c.env, messageViewer(c, c.get('apiKey')!)) });
});

app.get('/unread-count', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  return ok(c, { unread: await countUnread(c.env, key.userId, key.role) });
});

/**
 * afterId=0 是空邮箱基线；校验参数、范围，客户端取消后不再进行额外 D1 轮询。
 * 轮询配额在请求开始时按本次最多轮询次数一次性预占（1 次写），结束时退还未用部分，
 * 不再每 2 秒写一次计数；预占超限即拒绝，并发长轮询仍受同一上限约束。
 * from/subjectContains/hasCode 跳过不匹配的新邮件；scannedThroughId 让调用方超时后也能推进游标。
 */
app.get('/wait', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const query = parseQuery(c, waitMessagesQuerySchema);
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
        afterId: cursor, address: query.address,
        from: query.from, subjectContains: query.subjectContains, hasCode: query.hasCode,
      });
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
): Viewer {
  return { userId: key.userId, role: key.role, scope: query.scope, targetUserId: query.userId };
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
  return ok(c, await getMessageDetail(c.env, messageViewer(c, key), id));
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
