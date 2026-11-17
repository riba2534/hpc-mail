import { Hono } from 'hono';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { listSendIdentities } from '../services/identities.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 发件身份（同 GET /v1/identities）：自己认领的邮箱及能否发信、共享给我的只读邮箱、可用任意前缀的系统域名（管理员）与托管域名（所有者） */
app.get('/', async (c) => {
  const user = c.get('user')!;
  return ok(c, await listSendIdentities(c.env, { userId: user.id, role: user.role }));
});

export default app;
