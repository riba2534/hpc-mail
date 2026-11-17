import { adminMailboxSharesQuerySchema, replaceMailboxSharesRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { pageRequestOf } from '../../lib/pagination.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logAdminAction } from '../../services/audit.js';
import { listMailboxShares, replaceMailboxShares, revokeMailboxShare } from '../../services/mailbox-share.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** ?mailboxId= 只返回该邮箱（0 或 1 项的数组）；否则为全站已认领邮箱，带 cursor 或 limit 时返回 Page */
app.get('/', async (c) => {
  const acting = c.get('user')!;
  const { mailboxId, q, ...rest } = parseQuery(c, adminMailboxSharesQuerySchema);
  const page = mailboxId === undefined ? pageRequestOf(rest) : null;
  return ok(c, await listMailboxShares(c.env, acting.id, true, { mailboxId, q }, page));
});

app.put('/', async (c) => {
  const acting = c.get('user')!;
  const req = await parseBody(c, replaceMailboxSharesRequestSchema);
  const updated = await replaceMailboxShares(c.env, acting.id, req.mailboxId, req.userIds, true, req.expectedOwnerId);
  await logAdminAction(
    c.env,
    acting,
    'mailbox.share',
    updated.address,
    updated.grantees.map((grantee) => grantee.username).join('、') || '清空共享',
    clientIp(c),
  );
  return ok(c, updated);
});

app.delete('/:mailboxId/grantees/:userId', async (c) => {
  const acting = c.get('user')!;
  const mailboxId = parseId(c.req.param('mailboxId'));
  const userId = parseId(c.req.param('userId'));
  await revokeMailboxShare(c.env, acting.id, mailboxId, userId, true);
  await logAdminAction(c.env, acting, 'mailbox.unshare', `mailbox#${mailboxId}`, `user#${userId}`, clientIp(c));
  return ok(c, { success: true });
});

export default app;
