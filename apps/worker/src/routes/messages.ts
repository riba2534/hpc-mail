import {
  deleteMessagesRequestSchema,
  listMessagesQuerySchema,
  markReadRequestSchema,
  markAllReadRequestSchema,
  starMessagesRequestSchema,
  translateMessageRequestSchema,
  type MessageListPage,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { execCtx, ok, parseBody, parseId, parseQuery } from '../lib/http.js';
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
  syncMessages,
  UNREAD_COUNT_CAP,
  type Viewer,
} from '../services/message.js';
import { auditUnclaimedPurge, auditUserScopeRead, messageViewer, mutationViewer } from '../lib/message-viewer.js';
import { AppError } from '../lib/errors.js';
import { pageHead } from '../lib/pagination.js';
import { translateMessage } from '../services/translate.js';
import { handleSend } from './send-handler.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

function viewerOf(c: Context<AppContext>, bodyScope?: 'mine' | 'unclaimed'): Viewer {
  const user = c.get('user')!;
  return messageViewer(c, { userId: user.id, role: user.role }, bodyScope);
}

function mutationViewerOf(c: Context<AppContext>, bodyScope?: 'mine' | 'unclaimed'): Viewer {
  const user = c.get('user')!;
  return mutationViewer(c, { userId: user.id, role: user.role }, bodyScope);
}

function viewerFromListQuery(
  user: { id: number; role: Viewer['role'] },
  query: { scope?: Viewer['scope']; userId?: number },
  c: Context<AppContext>,
): Viewer {
  const viewer: Viewer = { userId: user.id, role: user.role, scope: query.scope, targetUserId: query.userId };
  auditUserScopeRead(c, viewer);
  return viewer;
}

/**
 * 首页（不带 cursor）附带 head，与 /sync 同一算法；带 afterId 的增量页不是 sync 所描述的首页，同样不带。
 * /v1 列表不返回 head。
 */
app.get('/', async (c) => {
  const query = parseQuery(c, listMessagesQuerySchema);
  const user = c.get('user')!;
  const page = await listMessages(c.env, viewerFromListQuery(user, query, c), query);
  if (query.cursor !== undefined || query.afterId !== undefined) return ok(c, page);
  const body: MessageListPage = { ...page, head: await pageHead(page) };
  return ok(c, body);
});

app.post('/send', (c) => {
  const user = c.get('user')!;
  return handleSend(c, { type: 'user', id: user.id }, { userId: user.id, role: user.role });
});

app.post('/read', async (c) => {
  const req = await parseBody(c, markReadRequestSchema);
  const changed = await markMessages(c.env, mutationViewerOf(c, req.scope), req.ids, req.isRead);
  return ok(c, { changed });
});

/**
 * 一键全读：范围内全部未读收件标为已读，可按 domain/address/q 收窄；只动自己认领的地址，
 * 共享邮件的已读状态属于所有者（admin 需显式 scope=unclaimed 才动未认领）
 */
app.post('/read-all', async (c) => {
  const req = c.req.header('Content-Length') === '0' || c.req.raw.body === null
    ? {} : await parseBody(c, markAllReadRequestSchema);
  const { scope, ...filters } = req;
  const changed = await markAllRead(c.env, mutationViewerOf(c, scope), filters);
  return ok(c, { changed });
});

app.post('/delete', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const deleted = await deleteMessages(c.env, mutationViewerOf(c, req.scope), req.ids);
  return ok(c, { deleted });
});

/** 从回收站恢复 */
app.post('/restore', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const restored = await restoreMessages(c.env, mutationViewerOf(c, req.scope), req.ids);
  return ok(c, { restored, changed: restored });
});

/** 永久删除（回收站里彻底删） */
app.post('/purge', async (c) => {
  const req = await parseBody(c, deleteMessagesRequestSchema);
  const viewer = mutationViewerOf(c, req.scope);
  const purged = await purgeMessages(c.env, viewer, req.ids, execCtx(c));
  await auditUnclaimedPurge(c, viewer, req.ids, purged);
  return ok(c, { purged, changed: purged });
});

app.post('/star', async (c) => {
  const req = await parseBody(c, starMessagesRequestSchema);
  const changed = await starMessages(c.env, mutationViewerOf(c, req.scope), req.ids, req.starred);
  return ok(c, { changed });
});

/** 侧栏收件箱未读角标：口径同 /inbox（scope=mine + inbound + 未读），封顶 UNREAD_COUNT_CAP。须在 /:id 之前注册 */
app.get('/unread-count', async (c) => {
  const user = c.get('user')!;
  return ok(c, { unread: await countUnread(c.env, user.id, user.role, UNREAD_COUNT_CAP) });
});

/**
 * 列表轻量轮询：参数与列表相同（同一 schema 与范围校验，cursor/afterId 忽略），
 * 返回调用者未读数与该筛选首页的 head；head 与已加载首页不同才需要重拉列表
 */
app.get('/sync', async (c) => {
  const query = parseQuery(c, listMessagesQuerySchema);
  const user = c.get('user')!;
  return ok(c, await syncMessages(c.env, viewerFromListQuery(user, query, c), query));
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

/** AI 翻译为简体中文（仅 JWT，不开放到 /v1）：scope/userId 与详情同一校验，只译出自该邮件的片段 */
app.post('/:id/translate', async (c) => {
  const id = parseId(c.req.param('id'));
  const viewer = viewerOf(c);
  const req = await parseBody(c, translateMessageRequestSchema);
  return ok(c, await translateMessage(c.env, execCtx(c), viewer, id, req.segments));
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
