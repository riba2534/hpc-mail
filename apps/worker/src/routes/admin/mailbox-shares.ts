import { replaceMailboxSharesRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, ok, parseBody, parseId } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logAdminAction } from '../../services/audit.js';
import { listMailboxShares, replaceMailboxShares, revokeMailboxShare } from '../../services/mailbox-share.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** ?mailboxId= 只返回该邮箱（0 或 1 项）；缺省返回全站已认领邮箱 */
app.get('/', async (c) => {
  const acting = c.get('user')!;
  const raw = c.req.query('mailboxId');
  const mailboxId = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && !(/^[1-9]\d*$/.test(raw) && Number.isSafeInteger(mailboxId))) {
    throw new AppError('validation_failed', 'mailboxId 需为正整数');
  }
  return ok(c, await listMailboxShares(c.env, acting.id, true, mailboxId));
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
  const { address } = await revokeMailboxShare(c.env, acting.id, mailboxId, userId, true);
  // target 写地址（与 mailbox.share、过户一致），按地址就能查到这只邮箱的全部共享变更
  await logAdminAction(c.env, acting, 'mailbox.unshare', address, `移除共享 user#${userId}（mailbox#${mailboxId}）`, clientIp(c));
  return ok(c, { success: true });
});

export default app;
