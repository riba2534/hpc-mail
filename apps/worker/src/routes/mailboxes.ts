import { claimMailboxRequestSchema, updateMailboxRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import {
  checkAvailability,
  claimMailbox,
  listMailboxes,
  releaseMailbox,
  updateMailbox,
} from '../services/mailbox.js';
import { listSharedMailboxes } from '../services/mailbox-share.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** admin ?all=1 看全站；否则看自己认领的 */
app.get('/', async (c) => {
  const user = c.get('user')!;
  const all = parseBooleanFlag(c.req.query('all'));
  if (all && user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const list = await listMailboxes(c.env, all ? { all: true } : { userId: user.id });
  return ok(c, list);
});

/** 分享给我的管理员邮箱（只读，不能当发件身份） */
app.get('/shared', async (c) => {
  const user = c.get('user')!;
  return ok(c, await listSharedMailboxes(c.env, user.id));
});

app.get('/availability', async (c) => {
  const req = parseQuery(c, claimMailboxRequestSchema);
  const user = c.get('user')!;
  return ok(c, await checkAvailability(c.env, { userId: user.id, role: user.role }, req.localPart, req.domain));
});

app.post('/', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, claimMailboxRequestSchema);
  return ok(c, await claimMailbox(c.env, user.id, user.role, req), 201);
});

app.put('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, updateMailboxRequestSchema);
  return ok(c, await updateMailbox(c.env, user.id, id, req.displayName, user.role === 'admin'));
});

app.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const deleteHistory = parseBooleanFlag(c.req.query('deleteHistory'));
  const result = await releaseMailbox(c.env, user.id, id, user.role === 'admin', deleteHistory);
  return ok(c, { success: true, ...result });
});

export default app;
