import { batchCheckHostedDomainsRequestSchema, batchCreateHostedDomainsRequestSchema } from '@hpc-mail/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { clientIp, execCtx, ok, parseBody } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { checkHostedDomains, createHostedDomains } from '../services/hosted-domain-batch.js';
import type { AppContext } from '../types.js';

/**
 * 与 /api/hosted-domains 子应用同前缀挂载，那边用 use('*') 挂了 requireAuth：已鉴权就跳过，
 * 无论哪个先注册，一个请求只鉴权、限流计数一次。鉴权按路由挂，不作用到同前缀的其他路由。
 */
const authOnce: MiddlewareHandler<AppContext> = (c, next) => (c.get('user') ? next() : requireAuth(c, next));

/** 批量添加与批量立即检测（JWT）：逐项独立结果，单项规则与单个接口相同 */
const app = new Hono<AppContext>();

app.post('/batch', authOnce, async (c) => {
  const req = await parseBody(c, batchCreateHostedDomainsRequestSchema);
  return ok(c, await createHostedDomains(c.env, c.get('user')!, req.domains, execCtx(c), clientIp(c)));
});

app.post('/batch-check', authOnce, async (c) => {
  const req = await parseBody(c, batchCheckHostedDomainsRequestSchema);
  return ok(c, await checkHostedDomains(c.env, c.get('user')!, req.ids));
});

export default app;
