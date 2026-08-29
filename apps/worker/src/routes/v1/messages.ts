import {
  deleteMessagesRequestSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  sendMailRequestSchema,
  type ListMessagesQuery,
  type MessageSummary,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { buildSecureHeaders } from '../../lib/attachment-security.js';
import { AppError } from '../../lib/errors.js';
import { ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import {
  deleteMessages,
  getMessageDetail,
  listMessages,
  loadAttachmentForViewer,
  markMessages,
  type Viewer,
} from '../../services/message.js';
import { decodeInlineAttachments, sendMail } from '../../services/outbound.js';
import { getObject } from '../../services/storage.js';
import type { AppContext } from '../../types.js';

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
  // 幂等：带 Idempotency-Key 时按 (key, idemKey) 缓存结果 24h，超时重试不会重复发信
  const idemKey = c.req.header('Idempotency-Key')?.trim();
  const cacheKey = idemKey ? `idem:${key.id}:${idemKey}` : null;
  if (cacheKey) {
    const cached = await c.env.kv.get(cacheKey, { type: 'json' });
    if (cached) return ok(c, cached as MessageSummary, 201);
  }
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
  if (cacheKey) {
    try {
      await c.env.kv.put(cacheKey, JSON.stringify(summary), { expirationTtl: 24 * 3600 });
    } catch {
      // 缓存写失败不影响发送结果
    }
  }
  return ok(c, summary, 201);
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
 * 优先返回带验证码的那封；专为 AI Agent 等验证码设计，省去客户端轮询循环。
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
    const query: ListMessagesQuery = { direction: 'inbound', limit: 20 };
    if (address) query.address = address;
    if (afterId) query.afterId = afterId;
    const page = await listMessages(c.env, viewer, query);
    if (page.items.length === 0) return null;
    // items 按 id 降序；优先取带验证码的（从旧到新找第一封），否则取最旧的那封新邮件
    const reversed = [...page.items].reverse();
    return reversed.find((m) => m.verificationCode) ?? reversed[0]!;
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
