import { adminHostedDomainsLookupSchema, adminUsersQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseListQuery } from '../../../lib/http.js';
import { lookupAdminHostedDomains, lookupAdminUsers } from '../../../services/admin-lookup.js';
import type { AppContext } from '../../../types.js';

/** /v1/admin 的目录查询：按用户名查用户、查托管域名（鉴权由 admin/index.ts 统一完成） */
const app = new Hono<AppContext>();

app.get('/users', async (c) => ok(c, await lookupAdminUsers(c.env, parseListQuery(c, adminUsersQuerySchema))));

app.get('/hosted-domains', async (c) => ok(c, await lookupAdminHostedDomains(c.env, parseListQuery(c, adminHostedDomainsLookupSchema))));

export default app;
