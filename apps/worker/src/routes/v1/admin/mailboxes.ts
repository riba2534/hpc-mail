import {
  adminBatchReleaseRequestSchema, adminBatchReplaceSharesRequestSchema, adminBatchShareRequestSchema, adminBatchTransferRequestSchema,
  adminClaimAndShareRequestSchema, adminMailboxesQuerySchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { execCtx, ok, parseBody, parseValue } from '../../../lib/http.js';
import { joinRepeatedQuery, lookupAdminMailboxes } from '../../../services/admin-lookup.js';
import { auditActorOf } from '../../../services/audit.js';
import {
  adminClaimAndShare, adminReleaseMailboxes, adminReplaceShares, adminShareMailboxes, adminTransferMailboxes, adminUnshareMailboxes,
} from '../../../services/mailbox-admin-batch.js';
import type { AppContext } from '../../../types.js';

/**
 * /v1/admin/mailboxes（鉴权由 admin/index.ts 统一完成）：批量写操作与 /api/admin/mailboxes/batch/* 同一套服务、事务与审计，
 * 另有按地址或域名查询与整体替换共享名单。
 */
const app = new Hono<AppContext>();

/** 批量操作写进审计 detail 的标记：同一请求的多行审计可按请求 id 归组（同 /api/admin） */
const batchTag = (c: Context<AppContext>) => `批量请求 ${c.get('requestId')}`;

app.get('/', async (c) => {
  const query = parseValue(adminMailboxesQuerySchema, joinRepeatedQuery(c.req.queries()));
  return ok(c, await lookupAdminMailboxes(c.env, query));
});

app.post('/batch/claim', async (c) => {
  const req = await parseBody(c, adminClaimAndShareRequestSchema);
  return ok(c, await adminClaimAndShare(c.env, auditActorOf(c), req, batchTag(c)));
});

app.post('/batch/release', async (c) => {
  const req = await parseBody(c, adminBatchReleaseRequestSchema);
  return ok(c, await adminReleaseMailboxes(c.env, auditActorOf(c), req, batchTag(c), execCtx(c)));
});

app.post('/batch/transfer', async (c) => {
  const req = await parseBody(c, adminBatchTransferRequestSchema);
  return ok(c, await adminTransferMailboxes(c.env, auditActorOf(c), req, batchTag(c)));
});

app.post('/batch/share', async (c) => {
  const req = await parseBody(c, adminBatchShareRequestSchema);
  return ok(c, await adminShareMailboxes(c.env, auditActorOf(c), req, batchTag(c)));
});

app.post('/batch/unshare', async (c) => {
  const req = await parseBody(c, adminBatchShareRequestSchema);
  return ok(c, await adminUnshareMailboxes(c.env, auditActorOf(c), req, batchTag(c)));
});

app.put('/shares', async (c) => {
  const req = await parseBody(c, adminBatchReplaceSharesRequestSchema);
  return ok(c, await adminReplaceShares(c.env, auditActorOf(c), req, batchTag(c)));
});

export default app;
