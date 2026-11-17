import {
  batchMailboxRequestSchema, claimMailboxRequestSchema, claimPlanQuerySchema, listMailboxesQuerySchema, updateMailboxRequestSchema,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { execCtx, ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { pageRequestOf } from '../../lib/pagination.js';
import {
  apiKeyAuth, assertKeyCanUseDomain, assertKeyCanUseMailboxIds, assertKeyUnrestricted, filterWithinKey, keyRestriction, requireScope,
} from '../../middleware/api-key-auth.js';
import { planRandomDomains } from '../../services/claim-plan.js';
import {
  checkAvailability, checkAvailabilityBatch, claimMailbox, claimMailboxes, listMailboxes, releaseMailbox, updateMailbox,
} from '../../services/mailbox.js';
import { listSharedMailboxes } from '../../services/mailbox-share.js';
import { auditActorOf } from '../../services/audit.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

app.get('/shared', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  return ok(c, filterWithinKey(c, await listSharedMailboxes(c.env, key.userId), (box) => box.mailboxId));
});

app.get('/', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const all = parseBooleanFlag(c.req.query('all'));
  if (all && key.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const query = parseQuery(c, listMailboxesQuerySchema);
  const scope = all ? { all: true } : { userId: key.userId };
  // 限定了范围的 Key 只列范围内的邮箱（在查询里收窄，分页大小不受影响）
  const restrict = keyRestriction(c) ?? undefined;
  return ok(c, await listMailboxes(c.env, { ...scope, q: query.q, domain: query.domain, restrict }, pageRequestOf(query)));
});

app.get('/availability', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const req = parseQuery(c, claimMailboxRequestSchema);
  assertKeyCanUseDomain(c, req.domain);
  return ok(c, await checkAvailability(c.env, { userId: key.userId, role: key.role }, req.localPart, req.domain, req.strategy));
});

/** 批量可用性提示：同 /api 同名接口，结果保持请求顺序 */
app.post('/availability/batch', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, batchMailboxRequestSchema);
  for (const item of req.items) assertKeyCanUseDomain(c, item.domain);
  return ok(c, await checkAvailabilityBatch(c.env, { userId: key.userId, role: key.role }, req.items));
});

/** 随机后缀分配（不认领），同 /api 同名接口 */
app.get('/random-plan', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const req = parseQuery(c, claimPlanQuerySchema);
  // 随机分配会从全部可认领域名里挑，限定了范围的 Key 改用 availability 指定允许的域名
  assertKeyUnrestricted(c, '随机域名分配，请用 availability 检查允许的域名后认领');
  return ok(c, await planRandomDomains(c.env, { userId: key.userId, role: key.role }, req.count, req.strategy));
});

/** 批量认领：按顺序逐个认领，被占用的跳过，其他错误停止并保留已认领的（见 stoppedBy） */
app.post('/batch', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, batchMailboxRequestSchema);
  for (const item of req.items) assertKeyCanUseDomain(c, item.domain);
  return ok(c, await claimMailboxes(c.env, key.userId, key.role, req.items));
});

app.put('/:id', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, updateMailboxRequestSchema);
  await assertKeyCanUseMailboxIds(c, [id]);
  return ok(c, await updateMailbox(c.env, key.userId, id, req.displayName, key.role === 'admin', auditActorOf(c)));
});

app.delete('/:id', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  await assertKeyCanUseMailboxIds(c, [id]);
  const result = await releaseMailbox(c.env, key.userId, id, key.role === 'admin',
    parseBooleanFlag(c.req.query('deleteHistory')), execCtx(c), auditActorOf(c));
  return ok(c, { success: true, ...result });
});

app.post('/', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const req = await parseBody(c, claimMailboxRequestSchema);
  assertKeyCanUseDomain(c, req.domain);
  return ok(c, await claimMailbox(c.env, key.userId, key.role, req), 201);
});

export default app;
