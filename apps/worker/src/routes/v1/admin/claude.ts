import { claudeAddressesQuerySchema, claudeDomainsQuerySchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseQuery } from '../../../lib/http.js';
import { lookupClaudeAddresses, lookupClaudeDomains } from '../../../services/admin-lookup.js';
import type { AppContext } from '../../../types.js';

/** /v1/admin 的 Claude 事实与收据（鉴权由 admin/index.ts 统一完成）；只读，不写审计 */
const app = new Hono<AppContext>();

app.get('/domains', async (c) => {
  const { domains } = parseQuery(c, claudeDomainsQuerySchema);
  return ok(c, await lookupClaudeDomains(c.env, domains));
});

app.get('/addresses', async (c) => {
  const { addresses } = parseQuery(c, claudeAddressesQuerySchema);
  return ok(c, await lookupClaudeAddresses(c.env, addresses));
});

export default app;
