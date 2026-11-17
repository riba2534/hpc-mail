import { adminHostedDomainsQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, ok, parseId, parseQuery } from '../../lib/http.js';
import { pageRequestOf } from '../../lib/pagination.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  hostedDomainsHealth, listAllHostedDomains, resumeHostedDomain, suspendHostedDomain,
} from '../../services/hosted-domain.js';
import type { AppContext } from '../../types.js';

/** 全站托管域名；详情、成员、过户与删除复用 /api/hosted-domains，管理员在那里拥有全部权限 */
const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/', async (c) => {
  const query = parseQuery(c, adminHostedDomainsQuerySchema);
  return ok(c, await listAllHostedDomains(c.env, c.get('user')!, query, pageRequestOf(query)));
});

/** 凭据是否配置且有效、站长账户 zone 数量 */
app.get('/health', async (c) => ok(c, await hostedDomainsHealth(c.env)));

app.post('/:id/suspend', async (c) => ok(c, await suspendHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')), clientIp(c))));

app.post('/:id/resume', async (c) => ok(c, await resumeHostedDomain(c.env, c.get('user')!, parseId(c.req.param('id')), clientIp(c))));

export default app;
