import { Hono } from 'hono';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { listSendIdentities } from '../services/identities.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 发件身份（同 GET /v1/identities）：自己认领与共享给我的邮箱及能否发信（普通用户共享来的只读）、可用任意前缀的域名（管理员；托管域名所有者） */
app.get('/', async (c) => {
  const user = c.get('user')!;
  return ok(c, await listSendIdentities(c.env, { userId: user.id, role: user.role }));
});

export default app;
