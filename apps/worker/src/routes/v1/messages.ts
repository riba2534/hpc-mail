import {
  deleteMessagesRequestSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  MAX_WAIT_POLLS_PER_USER_PER_MINUTE,
  sendMailRequestSchema,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { buildSecureHeaders } from '../../lib/attachment-security.js';
import { AppError } from '../../lib/errors.js';
import { ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import {
  deleteMessages,
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
import { getObject } from '../../services/storage.js';
import type { AppContext } from '../../types.js';
import { bumpCounter, minuteWindow } from '../../services/rate-counter.js';

const app = new Hono<AppContext>();
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
  const req = await parseBody(c, sendMailRequestSchema);
  const idem = await beginIdempotentSend(
    c.env,
    { type: 'api_key', id: key.id },
    c.req.header('Idempotency-Key'),
    req,
  );
  if (idem.kind === 'replay') return ok(c, idem.response, 201);
  try {
    const attachments = decodeInlineAttachments(req.attachments);
    const origin = new URL(c.req.url).origin;
    const summary = await sendMail(
      c.env,
      c.executionCtx,
      { userId: key.userId, role: key.role },
      req,
      attachments,
      origin,
    );
    await completeIdempotentSend(c.env, idem.handle, summary);
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
  const viewer: Viewer = { userId: key.userId, role: key.role, scope: req.scope };
  const changed = await markMessages(c.env, viewer, req.ids, req.isRead);
  return ok(c, { changed });
});

/** 删除邮件——Agent 清理已消费的验证码邮件用（需 mail.write） */
app.post('/delete', async (c) => {
  requireScope(c, 'mail.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const viewer: Viewer = { userId: key.userId, role: key.role, scope: req.scope };
  const deleted = await deleteMessages(c.env, viewer, req.ids);
  return ok(c, { deleted });
});

/**
 * 长轮询等新邮件：hold 到出现 id>afterId 的 inbound 邮件即返回，最长 timeout 秒。
 * 严格返回 afterId 之后最早的一封，避免突发邮件把游标推进到较新 id 后永久漏信。
 * 须在 /:id 之前注册，否则 "wait" 会被当作 :id。
 */
app.get('/wait', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const address = (c.req.query('address') || '').trim().toLowerCase() || undefined;
  const afterId = Math.max(0, Math.floor(Number(c.req.query('afterId') || '0')) || 0);
  const timeoutSec = Math.min(Math.max(Math.floor(Number(c.req.query('timeout') || '25')) || 25, 1), 50);
  const viewer: Viewer = { userId: key.userId, role: key.role };
  const deadline = Date.now() + timeoutSec * 1000;

  const poll = async () => {
    const rate = await bumpCounter(c.env, 'api-wait', String(key.userId), minuteWindow(1));
    if (rate.count > MAX_WAIT_POLLS_PER_USER_PER_MINUTE) {
      throw new AppError('rate_limited', '长轮询查询频率超限，请稍后重试');
    }
    return findNextMessage(c.env, viewer, { afterId, address });
  };

  for (;;) {
    const found = await poll();
    if (found) return ok(c, { message: found });
    if (Date.now() >= deadline) return ok(c, { message: null });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
});

function viewerFromKey(
  key: { userId: number; role: Viewer['role'] },
  query: { scope?: Viewer['scope']; userId?: number },
): Viewer {
  return { userId: key.userId, role: key.role, scope: query.scope, targetUserId: query.userId };
}

function viewerFromQueryString(c: { req: { query: (k: string) => string | undefined } }, key: { userId: number; role: Viewer['role'] }): Viewer {
  const q = c.req.query('scope');
  const scope = q === 'mine' || q === 'unclaimed' || q === 'user' ? q : undefined;
  const userIdRaw = Number(c.req.query('userId'));
  return {
    userId: key.userId,
    role: key.role,
    scope,
    targetUserId: Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : undefined,
  };
}

app.get('/:id', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  return ok(c, await getMessageDetail(c.env, viewerFromQueryString(c, key), id));
});

app.get('/:id/attachments/:attId', async (c) => {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  const attId = parseId(c.req.param('attId'));
  const viewer: Viewer = viewerFromQueryString(c, key);
  const att = await loadAttachmentForViewer(c.env, viewer, attId);
  if (att.messageId !== id) throw new AppError('not_found', '附件不存在');
  const obj = await getObject(c.env, att.r2Key);
  if (!obj) throw new AppError('not_found', '附件内容不存在');
  return new Response(obj.body, { status: 200, headers: buildSecureHeaders(att.mimeType, att.filename) });
});

export default app;
