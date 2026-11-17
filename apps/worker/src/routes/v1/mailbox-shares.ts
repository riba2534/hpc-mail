import { batchShareMailboxesRequestSchema, replaceMailboxSharesRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { AppError } from '../../lib/errors.js';
import { ok, parseBody, parseId } from '../../lib/http.js';
import { apiKeyAuth, assertKeyCanUseMailboxIds, filterWithinKey, requireScope } from '../../middleware/api-key-auth.js';
import { listMailboxShares, replaceMailboxShares, revokeMailboxShare, shareMailboxes } from '../../services/mailbox-share.js';
import type { AppContext } from '../../types.js';

/**
 * /v1/mailboxes/shares：API Key（mailbox.share）管理自己邮箱的共享，与网页会话 /api/mailboxes/shares 同形。
 * 只接受 userId，不提供用户搜索；管理员 Key 也只能管理自己的邮箱（管理全站共享用管理员网页会话）。
 * 限定了范围的 Key 只能看到、修改范围内的邮箱。
 */
const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);
app.use('*', async (c, next) => {
  requireScope(c, 'mailbox.share');
  await next();
});

app.get('/', async (c) => {
  return ok(c, filterWithinKey(c, await listMailboxShares(c.env, c.get('apiKey')!.userId), (grant) => grant.mailboxId));
});

app.put('/', async (c) => {
  const req = await parseBody(c, replaceMailboxSharesRequestSchema);
  await assertKeyCanUseMailboxIds(c, [req.mailboxId]);
  return ok(c, await replaceMailboxShares(c.env, c.get('apiKey')!.userId, req.mailboxId, req.userIds, false, req.expectedOwnerId));
});

app.post('/batch', async (c) => {
  const req = await parseBody(c, batchShareMailboxesRequestSchema);
  await assertKeyCanUseMailboxIds(c, req.mailboxIds);
  return ok(c, await shareMailboxes(c.env, c.get('apiKey')!.userId, req.mailboxIds, req.userIds));
});

app.delete('/:mailboxId/grantees/:userId', async (c) => {
  const mailboxId = parseId(c.req.param('mailboxId'));
  await assertKeyCanUseMailboxIds(c, [mailboxId]);
  await revokeMailboxShare(c.env, c.get('apiKey')!.userId, mailboxId, parseId(c.req.param('userId')));
  return ok(c, { success: true });
});

// 未匹配的 /mailboxes/shares 路径到此为止：不再落进 /mailboxes 子应用（再鉴权一次、被当成 /mailboxes/:id）
app.all('*', () => {
  throw new AppError('not_found', '接口不存在');
});

export default app;
