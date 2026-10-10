import { claimMailboxRequestSchema, updateMailboxRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { checkAvailability, claimMailbox, listMailboxes, releaseMailbox, updateMailbox } from '../../services/mailbox.js';
import { listSharedMailboxes } from '../../services/mailbox-share.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

app.get('/shared', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  return ok(c, await listSharedMailboxes(c.env, key.userId));
});

app.get('/', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const all = parseBooleanFlag(c.req.query('all'));
  if (all && key.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const list = await listMailboxes(c.env, all ? { all: true } : { userId: key.userId });
  return ok(c, list);
});

app.get('/availability', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const req = parseQuery(c, claimMailboxRequestSchema);
  return ok(c, await checkAvailability(c.env, { userId: key.userId, role: key.role }, req.localPart, req.domain));
});

app.put('/:id', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, updateMailboxRequestSchema);
  return ok(c, await updateMailbox(c.env, key.userId, parseId(c.req.param('id')), req.displayName, key.role === 'admin'));
});

app.delete('/:id', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const result = await releaseMailbox(c.env, key.userId, parseId(c.req.param('id')), key.role === 'admin', parseBooleanFlag(c.req.query('deleteHistory')));
  return ok(c, { success: true, ...result });
});

app.post('/', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, claimMailboxRequestSchema);
  return ok(c, await claimMailbox(c.env, key.userId, key.role, req), 201);
});

export default app;
