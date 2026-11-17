import { createApiKeyRequestSchema, updateApiKeyRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseId } from '../lib/http.js';
import { pageLimit } from '../lib/pagination.js';
import { requireAuth } from '../middleware/auth.js';
import { verifyReauthPassword } from '../services/reauth.js';
import {
  createApiKey,
  getApiKey,
  listApiKeyLogs,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from '../services/api-key.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 自助管理：只看/操作自己的 key */
app.get('/', async (c) => {
  const user = c.get('user')!;
  return ok(c, await listApiKeys(c.env, user.id));
});

app.post('/', async (c) => {
  const user = c.get('user')!;
  const { password, ...req } = await parseBody(c, createApiKeyRequestSchema);
  // 先重新验证密码：拿到会话令牌的人不能静默创建一把改密前就存在、之后也收不回的 Key
  await verifyReauthPassword(c.env, { userId: user.id, sessionId: c.get('sessionId')! }, password);
  // 带上令牌的鉴权版本：改密后仍在途的旧令牌请求不能再插入新 Key
  return ok(c, await createApiKey(c.env, user.id, req, c.get('authEpoch'), user.role), 201);
});

app.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  return ok(c, await getApiKey(c.env, id, user.id));
});

/** 自助审计日志：先按 userId 校验归属（非本人 key 抛 not_found），再返回日志 */
app.get('/:id/logs', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  await getApiKey(c.env, id, user.id);
  const cursor = c.req.query('cursor');
  return ok(c, await listApiKeyLogs(c.env, id, cursor, pageLimit(c.req.query('limit'))));
});

app.put('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, updateApiKeyRequestSchema);
  return ok(c, await updateApiKey(c.env, id, req, user.id, user.role));
});

app.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = parseId(c.req.param('id'));
  await revokeApiKey(c.env, id, user.id);
  return ok(c, { success: true });
});

export default app;
