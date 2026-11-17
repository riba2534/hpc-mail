import { createUserRequestSchema, searchUsersQuerySchema, updateUserRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId, parseQuery } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logAdminAction } from '../../services/audit.js';
import { createUser, deleteUser, listUsers, searchUsers, updateUser } from '../../services/user.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/', async (c) => ok(c, await listUsers(c.env)));
app.get('/search', async (c) => ok(c, await searchUsers(c.env, parseQuery(c, searchUsersQuerySchema))));

app.post('/', async (c) => {
  const acting = c.get('user')!;
  const req = await parseBody(c, createUserRequestSchema);
  const created = await createUser(c.env, req);
  await logAdminAction(c.env, acting, 'user.create', created.username, `角色 ${created.role}`, clientIp(c));
  return ok(c, created, 201);
});

app.put('/:id', async (c) => {
  const acting = c.get('user')!;
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, updateUserRequestSchema);
  const { user: updated, revokedApiKeys } = await updateUser(c.env, acting.id, id, req);
  const changes: string[] = [];
  if (req.status) changes.push(req.status === 'disabled' ? '禁用' : '启用');
  if (req.role) changes.push(`角色→${req.role}`);
  if (req.password) changes.push('重置密码');
  if (req.mailboxPolicy !== undefined) {
    const policy = req.mailboxPolicy;
    const limit = (value: number) => value === 0 ? '不限' : String(value);
    changes.push(policy === null ? '邮箱权限→公共配置'
      : `邮箱权限→专属配置（总数 ${limit(policy.perUserLimit)}；${policy.domains.map((entry) => `${entry.domain}: ${limit(entry.perUserLimit)}`).join('、') || '无可认领域名'}）`);
  }
  await logAdminAction(c.env, acting, 'user.update', updated.username, changes.join('、'), clientIp(c));
  if (revokedApiKeys) {
    await logAdminAction(c.env, acting, 'apikey.revoke_all', updated.username, `重置密码时吊销 ${revokedApiKeys} 个 API Key`, clientIp(c));
  }
  return ok(c, updated);
});

app.delete('/:id', async (c) => {
  const acting = c.get('user')!;
  const id = parseId(c.req.param('id'));
  await deleteUser(c.env, acting.id, id, execCtx(c));
  await logAdminAction(c.env, acting, 'user.delete', `user#${id}`, '', clientIp(c));
  return ok(c, { success: true });
});

export default app;
