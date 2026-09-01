import {
  deleteMessagesRequestSchema,
  internalSendMailSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  starMessagesRequestSchema,
  type MessageSummary,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { ok, parseBody, parseId, parseQuery } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  countUnread,
  deleteMessages,
  getMessageDetail,
  getRawMessageObject,
  getRecentContacts,
  getThread,
  listMessages,
  markAllRead,
  markMessages,
  purgeMessages,
  restoreMessages,
  starMessages,
  type Viewer,
} from '../services/message.js';
import { AppError } from '../lib/errors.js';
import { decodeInlineAttachments, sendMail } from '../services/outbound.js';
import {
  beginIdempotentSend,
  completeIdempotentSend,
  failIdempotentSend,
} from '../services/idempotency.js';
import { consumeDraftAttachments, resolveDraftAttachments } from '../services/upload.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

function parseListScope(raw: string | undefined): Viewer['scope'] {
  return raw === 'mine' || raw === 'unclaimed' || raw === 'user' ? raw : undefined;
}

function viewerOf(c: Context<AppContext>): Viewer {
  const user = c.get('user')!;
  const scope = parseListScope(c.req.query('scope'));
  const userIdRaw = Number(c.req.query('userId'));
  return {
    userId: user.id,
    role: user.role,
    scope,
    targetUserId: Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : undefined,
  };
}

function viewerFromListQuery(
  user: { id: number; role: Viewer['role'] },
  query: { scope?: Viewer['scope']; userId?: number },
): Viewer {
  return { userId: user.id, role: user.role, scope: query.scope, targetUserId: query.userId };
}

app.get('/', async (c) => {
  const query = parseQuery(c, listMessagesQuerySchema);
  const user = c.get('user')!;
  return ok(c, await listMessages(c.env, viewerFromListQuery(user, query), query));
});

app.post('/send', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, internalSendMailSchema);
  const idem = await beginIdempotentSend(
    c.env,
    { type: 'user', id: user.id },
    c.req.header('Idempotency-Key'),
    req,
  );
  if (idem.kind === 'replay') return ok(c, idem.response, 201);
  let summary: MessageSummary;
  try {
    // 兼容两种附件来源：base64 内联（AI/脚本）+ 上传 token（前端），合并后送 sendMail
    const decoded = decodeInlineAttachments(req.attachments);
    const fromTokens = await resolveDraftAttachments(c.env, user.id, req.attachmentTokens);
    const attachments = [...decoded, ...fromTokens];
    const origin = new URL(c.req.url).origin;
    summary = await sendMail(
      c.env,
      c.executionCtx,
      { userId: user.id, role: user.role },
      req,
      attachments,
      origin,
    );
    await completeIdempotentSend(c.env, idem.handle, summary);
  } catch (error) {
    await failIdempotentSend(c.env, idem.handle, error);
    throw error;
  }
  // 发送成功后回收 token 引用的草稿附件（base64 内联的无草稿，跳过）。
  // 不能让回收失败翻转整个请求的结果：邮件此刻已经真发出去了，这里再抛 500 会让前端提示
  // 「发送失败，请重试」，用户一重发、token 又还在，收件人就收到两封。回收失败留给
  // 24h 的草稿清理任务兜底
  try {
    await consumeDraftAttachments(c.env, user.id, req.attachmentTokens);
  } catch (e) {
    console.error('草稿附件回收失败（邮件已发送，留给定时清理）:', e);
  }
  return ok(c, summary, 201);
});

app.post('/read', async (c) => {
  const req = await parseBody(c, markReadRequestSchema);
  const changed = await markMessages(c.env, viewerOf(c), req.ids, req.isRead);
  return ok(c, { changed });
});

/** 一键全读：可见范围内全部未读收件标为已读（admin 需显式 scope=unclaimed 才动未认领） */
app.post('/read-all', async (c) => {
  const changed = await markAllRead(c.env, viewerOf(c));
  return ok(c, { changed });
});

app.post('/delete', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const deleted = await deleteMessages(c.env, viewerOf(c), req.ids);
  return ok(c, { deleted });
});

/** 从回收站恢复 */
app.post('/restore', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const restored = await restoreMessages(c.env, viewerOf(c), req.ids);
  return ok(c, { restored });
});

/** 永久删除（回收站里彻底删） */
app.post('/purge', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const purged = await purgeMessages(c.env, viewerOf(c), req.ids);
  return ok(c, { purged });
});

app.post('/star', async (c) => {
  const req = await parseBody(c, starMessagesRequestSchema);
  const changed = await starMessages(c.env, viewerOf(c), req.ids, req.starred);
  return ok(c, { changed });
});

/** 侧栏收件箱未读角标：口径同 /inbox（scope=mine + inbound + 未读）。须在 /:id 之前注册 */
app.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  return ok(c, { unread: await countUnread(c.env, user.id, user.role) });
});

/** 写信收件人自动补全：近期联系人 */
app.get('/contacts', async (c) => {
  return ok(c, { contacts: await getRecentContacts(c.env, viewerOf(c)) });
});

/** 会话线程（须在 /:id 之前注册） */
app.get('/:id/thread', async (c) => {
  const id = parseId(c.req.param('id'));
  return ok(c, { items: await getThread(c.env, viewerOf(c), id) });
});

/** 下载原始 .eml（须在 /:id 之前注册） */
app.get('/:id/raw', async (c) => {
  const id = parseId(c.req.param('id'));
  const obj = await getRawMessageObject(c.env, viewerOf(c), id);
  if (!obj) throw new AppError('not_found', '该邮件无原始存档');
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'message/rfc822',
      'Content-Disposition': `attachment; filename="message-${id}.eml"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
});

app.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  return ok(c, await getMessageDetail(c.env, viewerOf(c), id));
});

export default app;
