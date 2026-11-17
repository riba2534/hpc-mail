import { batchCheckHostedDomainsRequestSchema, batchCreateHostedDomainsRequestSchema, type ApiScope } from '@hpc-mail/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { clientIp, execCtx, ok, parseBody } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { checkHostedDomains, createHostedDomains } from '../../services/hosted-domain-batch.js';
import type { AppContext } from '../../types.js';

/**
 * 与 /v1/hosted-domains 的其他接口同前缀挂载：已鉴权就跳过，一个请求只计一次限流、写一条审计。
 * 鉴权按路由挂，不作用到同前缀的其他路由。
 */
/** domain.write 由并行的 PR3b 加进 API_SCOPES；两者合并后可去掉类型断言 */
const DOMAIN_WRITE = 'domain.write' as ApiScope;

const authOnce: MiddlewareHandler<AppContext> = (c, next) => (c.get('apiKey') ? next() : apiKeyAuth(c, next));

/** 批量添加与批量立即检测（API Key，domain.write）：与 /api 同名接口共用 service */
const app = new Hono<AppContext>();

app.post('/batch', authOnce, async (c) => {
  requireScope(c, DOMAIN_WRITE);
  const req = await parseBody(c, batchCreateHostedDomainsRequestSchema);
  const key = c.get('apiKey')!;
  // 管理审计记为「用户名（API Key #id）」，与网页操作区分
  const username = await c.env.db.prepare('SELECT username FROM users WHERE id = ?').bind(key.userId).first<string>('username');
  const actor = { id: key.userId, role: key.role, username: `${username ?? `user#${key.userId}`}（API Key #${key.id}）` };
  return ok(c, await createHostedDomains(c.env, actor, req.domains, execCtx(c), clientIp(c)));
});

app.post('/batch-check', authOnce, async (c) => {
  requireScope(c, DOMAIN_WRITE);
  const req = await parseBody(c, batchCheckHostedDomainsRequestSchema);
  const key = c.get('apiKey')!;
  return ok(c, await checkHostedDomains(c.env, { id: key.userId, role: key.role, username: `API Key #${key.id}` }, req.ids));
});

export default app;
