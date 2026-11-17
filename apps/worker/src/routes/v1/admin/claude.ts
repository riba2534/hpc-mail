import { claudeAddressesQuerySchema, claudeDomainsQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseListQuery } from '../../../lib/http.js';
import { requireScope } from '../../../middleware/api-key-auth.js';
import { lookupClaudeAddresses, lookupClaudeDomains } from '../../../services/admin-lookup.js';
import type { AppContext } from '../../../types.js';

/** /v1/admin 的 Claude 事实与收据（鉴权由 admin/index.ts 统一完成）；只读，不写审计 */
const app = new Hono<AppContext>();
app.use('*', async (c, next) => { requireScope(c, 'mail.read'); await next(); });

app.get('/domains', async (c) => {
  const { domains } = parseListQuery(c, claudeDomainsQuerySchema);
  return ok(c, await lookupClaudeDomains(c.env, domains));
});

app.get('/addresses', async (c) => {
  const { addresses } = parseListQuery(c, claudeAddressesQuerySchema);
  return ok(c, await lookupClaudeAddresses(c.env, addresses));
});

export default app;
