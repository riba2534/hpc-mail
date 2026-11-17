import { Hono } from 'hono';
import { ok } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getVisibleDomains } from '../services/domain.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 当前用户可认领的域名：管理员全部，普通用户按公共或专属规则。 */
app.get('/', async (c) => {
  const user = c.get('user')!;
  const domains = await getVisibleDomains(c.env, { userId: user.id, role: user.role });
  return ok(c, domains);
});

export default app;
