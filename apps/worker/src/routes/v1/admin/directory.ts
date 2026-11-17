import { adminHostedDomainsLookupSchema, adminUsersQuerySchema } from '@hpc-mail/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { ok, parseListQuery } from '../../../lib/http.js';
import { requireScope } from '../../../middleware/api-key-auth.js';
import { lookupAdminHostedDomains, lookupAdminUsers } from '../../../services/admin-lookup.js';
import type { AppContext } from '../../../types.js';

/** /v1/admin 的目录查询：按用户名查用户、查托管域名（鉴权由 admin/index.ts 统一完成） */
const app = new Hono<AppContext>();

/** 按路由挂：本子应用挂在 /v1/admin 根上，use('*') 会落到未匹配的其他路径 */
const readScope: MiddlewareHandler<AppContext> = async (c, next) => {
  requireScope(c, 'mailbox.read');
  await next();
};

app.get('/users', readScope, async (c) => ok(c, await lookupAdminUsers(c.env, parseListQuery(c, adminUsersQuerySchema))));

app.get('/hosted-domains', readScope, async (c) => ok(c, await lookupAdminHostedDomains(c.env, parseListQuery(c, adminHostedDomainsLookupSchema))));

export default app;
