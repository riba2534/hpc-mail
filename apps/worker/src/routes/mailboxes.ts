import {
  batchMailboxRequestSchema, batchShareMailboxesRequestSchema, claimMailboxRequestSchema, claimPlanQuerySchema, listMailboxesQuerySchema,
  replaceMailboxSharesRequestSchema, searchUsersQuerySchema, updateMailboxRequestSchema,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { execCtx, ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { pageRequestOf } from '../lib/pagination.js';
import { requireAuth } from '../middleware/auth.js';
import {
  checkAvailability,
  checkAvailabilityBatch,
  claimMailbox,
  claimMailboxes,
  listMailboxes,
  releaseMailbox,
  updateMailbox,
} from '../services/mailbox.js';
import { planRandomDomains } from '../services/claim-plan.js';
import {
  listMailboxShares, listSharedMailboxes, replaceMailboxShares, revokeMailboxShare, shareMailboxes,
} from '../services/mailbox-share.js';
import { searchUsers } from '../services/user.js';
import { auditActorOf } from '../services/audit.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** admin ?all=1 看全站；否则看自己认领的。带 cursor 或 limit 时返回 Page，否则返回完整数组 */
app.get('/', async (c) => {
  const user = c.get('user')!;
  const all = parseBooleanFlag(c.req.query('all'));
  if (all && user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const query = parseQuery(c, listMailboxesQuerySchema);
  const scope = all ? { all: true } : { userId: user.id };
  return ok(c, await listMailboxes(c.env, { ...scope, q: query.q, domain: query.domain }, pageRequestOf(query)));
});

/** 分享给我的邮箱（只读，不能当发件身份） */
app.get('/shared', async (c) => {
  const user = c.get('user')!;
  return ok(c, await listSharedMailboxes(c.env, user.id));
});

/** 普通会话只能管理自己名下邮箱；全站管理使用管理员接口。 */
app.get('/shares', async (c) => ok(c, await listMailboxShares(c.env, c.get('user')!.id)));

app.get('/share-users', async (c) => {
  const req = parseQuery(c, searchUsersQuerySchema);
  return ok(c, await searchUsers(c.env, req));
});

app.put('/shares', async (c) => {
  const req = await parseBody(c, replaceMailboxSharesRequestSchema);
  return ok(c, await replaceMailboxShares(c.env, c.get('user')!.id, req.mailboxId, req.userIds, false, req.expectedOwnerId));
});

/** 所有者把自己的多只邮箱一次追加共享给同一批用户；管理员也只能共享自己的邮箱 */
app.post('/shares/batch', async (c) => {
  const req = await parseBody(c, batchShareMailboxesRequestSchema);
  return ok(c, await shareMailboxes(c.env, c.get('user')!.id, req.mailboxIds, req.userIds));
});

app.delete('/shares/:mailboxId/grantees/:userId', async (c) => {
  await revokeMailboxShare(c.env, c.get('user')!.id, parseId(c.req.param('mailboxId')), parseId(c.req.param('userId')));
  return ok(c, { success: true });
});

/** 批量可用性提示：规则同 GET /availability，结果保持请求顺序 */
app.post('/availability/batch', async (c) => {
  const req = await parseBody(c, batchMailboxRequestSchema);
  const user = c.get('user')!;
  return ok(c, await checkAvailabilityBatch(c.env, { userId: user.id, role: user.role }, req.items));
});

/** 随机后缀分配（不认领）：uniform 等概率；claude 只在零封号域名中按账号负载均衡 */
app.get('/random-plan', async (c) => {
  const req = parseQuery(c, claimPlanQuerySchema);
  const user = c.get('user')!;
  return ok(c, await planRandomDomains(c.env, { userId: user.id, role: user.role }, req.count, req.strategy));
});

app.get('/availability', async (c) => {
  const req = parseQuery(c, claimMailboxRequestSchema);
  const user = c.get('user')!;
  return ok(c, await checkAvailability(c.env, { userId: user.id, role: user.role }, req.localPart, req.domain, req.strategy));
});

app.post('/', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, claimMailboxRequestSchema);
  return ok(c, await claimMailbox(c.env, user.id, user.role, req), 201);
});

/** 批量认领：按顺序逐个认领，被占用的跳过，其他错误停止并保留已认领的（见 stoppedBy） */
app.post('/batch', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, batchMailboxRequestSchema);
  return ok(c, await claimMailboxes(c.env, user.id, user.role, req.items));
});

app.put('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, updateMailboxRequestSchema);
  return ok(c, await updateMailbox(c.env, user.id, id, req.displayName, user.role === 'admin', auditActorOf(c)));
});

app.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const deleteHistory = parseBooleanFlag(c.req.query('deleteHistory'));
  const result = await releaseMailbox(c.env, user.id, id, user.role === 'admin', deleteHistory, execCtx(c), auditActorOf(c));
  return ok(c, { success: true, ...result });
});

export default app;
