import { batchMailboxRequestSchema, claimMailboxRequestSchema, claimPlanQuerySchema, updateMailboxRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { execCtx, ok, parseBody, parseBooleanFlag, parseId, parseQuery } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import {
  apiKeyAuth, assertKeyCanUseDomain, assertKeyCanUseMailbox, assertKeyUnrestricted, keyRestriction, requireScope,
  restrictionAllowsMailbox,
} from '../../middleware/api-key-auth.js';
import { planRandomDomains } from '../../services/claim-plan.js';
import {
  checkAvailability, checkAvailabilityBatch, claimMailbox, claimMailboxes, listMailboxes, releaseMailbox, updateMailbox,
} from '../../services/mailbox.js';
import { listSharedMailboxes } from '../../services/mailbox-share.js';
import type { Context } from 'hono';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

/** 限定了范围的 Key 只看得到范围内的邮箱 */
function withinKey<T extends { domain: string }>(c: Context<AppContext>, list: T[], idOf: (item: T) => number): T[] {
  const restriction = keyRestriction(c);
  return restriction ? list.filter((item) => restrictionAllowsMailbox(restriction, { id: idOf(item), domain: item.domain })) : list;
}

/** 改名、释放前确认邮箱在 Key 范围内；邮箱不存在交给服务层按原口径报 404 */
async function assertMailboxInKey(c: Context<AppContext>, id: number): Promise<void> {
  if (!keyRestriction(c)) return;
  const box = await c.env.db.prepare('SELECT id, domain, address FROM mailboxes WHERE id = ?')
    .bind(id).first<{ id: number; domain: string; address: string }>();
  if (box) assertKeyCanUseMailbox(c, { id: Number(box.id), domain: box.domain, address: box.address });
}

app.get('/shared', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  return ok(c, withinKey(c, await listSharedMailboxes(c.env, key.userId), (box) => box.mailboxId));
});

app.get('/', async (c) => {
  requireScope(c, 'mailbox.read');
  const key = c.get('apiKey')!;
  const all = parseBooleanFlag(c.req.query('all'));
  if (all && key.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  const list = await listMailboxes(c.env, all ? { all: true } : { userId: key.userId });
  return ok(c, withinKey(c, list, (box) => box.id));
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
  await assertMailboxInKey(c, id);
  return ok(c, await updateMailbox(c.env, key.userId, id, req.displayName, key.role === 'admin'));
});

app.delete('/:id', async (c) => {
  requireScope(c, 'mailbox.write');
  const key = c.get('apiKey')!;
  const id = parseId(c.req.param('id'));
  await assertMailboxInKey(c, id);
  const result = await releaseMailbox(c.env, key.userId, id, key.role === 'admin', parseBooleanFlag(c.req.query('deleteHistory')), execCtx(c));
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
