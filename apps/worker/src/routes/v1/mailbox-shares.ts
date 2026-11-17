import { batchShareMailboxesRequestSchema, replaceMailboxSharesRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { ok, parseBody, parseId } from '../../lib/http.js';
import {
  apiKeyAuth, assertKeyCanUseMailbox, keyRestriction, requireScope, restrictionAllowsMailbox,
} from '../../middleware/api-key-auth.js';
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

/** 修改前确认这些邮箱都在 Key 范围内；不存在的交给服务层按原口径报错 */
async function assertMailboxesInKey(c: Context<AppContext>, ids: readonly number[]): Promise<void> {
  if (!keyRestriction(c) || !ids.length) return;
  const { results } = await c.env.db.prepare('SELECT id, domain, address FROM mailboxes WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all<{ id: number; domain: string; address: string }>();
  for (const box of results) assertKeyCanUseMailbox(c, { id: Number(box.id), domain: box.domain, address: box.address });
}

app.get('/', async (c) => {
  const grants = await listMailboxShares(c.env, c.get('apiKey')!.userId);
  const restriction = keyRestriction(c);
  return ok(c, restriction ? grants.filter((grant) => restrictionAllowsMailbox(restriction, { id: grant.mailboxId, domain: grant.domain })) : grants);
});

app.put('/', async (c) => {
  const req = await parseBody(c, replaceMailboxSharesRequestSchema);
  await assertMailboxesInKey(c, [req.mailboxId]);
  return ok(c, await replaceMailboxShares(c.env, c.get('apiKey')!.userId, req.mailboxId, req.userIds, false, req.expectedOwnerId));
});

app.post('/batch', async (c) => {
  const req = await parseBody(c, batchShareMailboxesRequestSchema);
  await assertMailboxesInKey(c, req.mailboxIds);
  return ok(c, await shareMailboxes(c.env, c.get('apiKey')!.userId, req.mailboxIds, req.userIds));
});

app.delete('/:mailboxId/grantees/:userId', async (c) => {
  const mailboxId = parseId(c.req.param('mailboxId'));
  await assertMailboxesInKey(c, [mailboxId]);
  await revokeMailboxShare(c.env, c.get('apiKey')!.userId, mailboxId, parseId(c.req.param('userId')));
  return ok(c, { success: true });
});

export default app;
