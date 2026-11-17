import {
  adminBatchClaimRequestSchema, adminBatchReleaseRequestSchema, adminBatchShareRequestSchema, adminBatchTransferRequestSchema,
  transferMailboxRequestSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { auditActorOf } from '../../services/audit.js';
import { getMailbox, transferMailbox } from '../../services/mailbox.js';
import {
  adminClaimMailboxes, adminReleaseMailboxes, adminShareMailboxes, adminTransferMailboxes, adminUnshareMailboxes,
} from '../../services/mailbox-admin-batch.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 批量操作写进审计 detail 的标记：同一请求的多行审计可按请求 id 归组 */
const batchTag = (c: Context<AppContext>) => `批量请求 ${c.get('requestId')}`;

// 批量接口必须注册在 /:id 之前：POST /batch/transfer 会先匹配到 /:id/transfer
app.post('/batch/claim', async (c) => {
  const req = await parseBody(c, adminBatchClaimRequestSchema);
  return ok(c, await adminClaimMailboxes(c.env, auditActorOf(c), req, batchTag(c)));
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

/** 单地址页按 id 读任意邮箱，不必为找一个邮箱拉全站列表 */
app.get('/:id', async (c) => ok(c, await getMailbox(c.env, parseId(c.req.param('id')))));

app.post('/:id/transfer', async (c) => {
  const req = await parseBody(c, transferMailboxRequestSchema);
  return ok(c, await transferMailbox(c.env, c.get('user')!, parseId(c.req.param('id')), req, clientIp(c)));
});

export default app;
