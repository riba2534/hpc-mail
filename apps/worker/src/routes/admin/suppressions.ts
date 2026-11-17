import { adminSuppressionsQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, ok, parseId, parseQuery } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logAdminAction } from '../../services/audit.js';
import { deleteSuppression, listSuppressions } from '../../services/suppression.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 有效的外发抑制条目（退信、投诉），按 id 倒序游标分页；?q= 按收件地址或发信域名筛选 */
app.get('/', async (c) => ok(c, await listSuppressions(c.env, parseQuery(c, adminSuppressionsQuerySchema))));

/** 解除一条抑制：只删本站名单，Cloudflare 侧的抑制需在 Cloudflare 控制台另行解除 */
app.delete('/:id', async (c) => {
  const removed = await deleteSuppression(c.env, parseId(c.req.param('id')));
  await logAdminAction(c.env, c.get('user')!, 'suppression.delete', removed.address, `发信域名 ${removed.sendingDomain}`, clientIp(c));
  return ok(c, { success: true });
});

export default app;
