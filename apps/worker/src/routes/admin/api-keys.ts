import { Hono } from 'hono';
import { clientIp, ok, parseId } from '../../lib/http.js';
import { pageLimit } from '../../lib/pagination.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { getApiKey, listApiKeyLogs, listApiKeys, revokeApiKey } from '../../services/api-key.js';
import { logAdminAction } from '../../services/audit.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 全站 key 列表（含 ownerUsername） */
app.get('/', async (c) => ok(c, await listApiKeys(c.env)));

app.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  return ok(c, await getApiKey(c.env, id));
});

/** 审计日志分页 */
app.get('/:id/logs', async (c) => {
  const id = parseId(c.req.param('id'));
  const cursor = c.req.query('cursor');
  return ok(c, await listApiKeyLogs(c.env, id, cursor, pageLimit(c.req.query('limit'))));
});

/** admin 吊销任意 key */
app.delete('/:id', async (c) => {
  const acting = c.get('user')!;
  const id = parseId(c.req.param('id'));
  await revokeApiKey(c.env, id);
  await logAdminAction(c.env, acting, 'apikey.revoke', `key#${id}`, '', clientIp(c));
  return ok(c, { success: true });
});

export default app;
