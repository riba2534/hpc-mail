import { Hono } from 'hono';
import { ok } from '../../lib/http.js';
import { pageLimit } from '../../lib/pagination.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { listAdminAuditLogs } from '../../services/audit.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 管理操作审计日志（游标分页，倒序） */
app.get('/', async (c) => {
  const cursor = c.req.query('cursor');
  return ok(c, await listAdminAuditLogs(c.env, cursor, pageLimit(c.req.query('limit'))));
});

export default app;
