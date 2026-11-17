import { adminBatchReplaceSharesRequestSchema, adminClaimAndShareRequestSchema, adminMailboxesQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseListQuery } from '../../../lib/http.js';
import { lookupAdminMailboxes } from '../../../services/admin-lookup.js';
import { auditActorOf } from '../../../services/audit.js';
import { adminClaimAndShare, adminReplaceShares } from '../../../services/mailbox-admin-batch.js';
import type { AppContext } from '../../../types.js';
import { adminMailboxBatchRoutes, batchTag } from '../../admin/mailboxes.js';

/**
 * /v1/admin/mailboxes（鉴权由 admin/index.ts 统一完成）：批量写操作与 /api/admin/mailboxes/batch/* 同一套服务、事务与审计，
 * 另有按地址或域名查询与整体替换共享名单。
 */
const app = new Hono<AppContext>();

app.get('/', async (c) => ok(c, await lookupAdminMailboxes(c.env, parseListQuery(c, adminMailboxesQuerySchema))));

app.post('/batch/claim', async (c) => {
  const req = await parseBody(c, adminClaimAndShareRequestSchema);
  return ok(c, await adminClaimAndShare(c.env, auditActorOf(c), req, batchTag(c)));
});
app.route('/batch', adminMailboxBatchRoutes());

app.put('/shares', async (c) => {
  const req = await parseBody(c, adminBatchReplaceSharesRequestSchema);
  return ok(c, await adminReplaceShares(c.env, auditActorOf(c), req, batchTag(c)));
});

export default app;
