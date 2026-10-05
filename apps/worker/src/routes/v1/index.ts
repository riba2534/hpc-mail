import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ok } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { getVisibleDomains } from '../../services/domain.js';
import type { AppContext } from '../../types.js';
import { createUploadRoutes } from '../uploads.js';
import v1Mailboxes from './mailboxes.js';
import v1Messages from './messages.js';
import { buildOpenApiSpec } from './openapi.js';

const app = new Hono<AppContext>();

// 仅对 /v1 开 CORS（允许 Authorization 头）
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Link', 'X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }),
);

app.get('/status', apiKeyAuth, (c) => {
  const key = c.get('apiKey')!;
  return ok(c, { status: 'operational', userId: key.userId, role: key.role, scopes: key.scopes });
});

// 按 key 的角色过滤：普通用户只该看到对其开放的域名。此前这里返回全部系统域名，
// 既泄露管理员私有域名，AI 拿去认领还会得 403「该域名未对普通用户开放」
app.get('/domains', apiKeyAuth, async (c) => {
  const key = c.get('apiKey')!;
  return ok(c, { domains: await getVisibleDomains(c.env, key.role === 'admin') });
});

/** OpenAPI 描述（公开，无需 key） */
app.get('/openapi.json', (c) => c.json(buildOpenApiSpec(new URL(c.req.url).origin)));

app.route('/mailboxes', v1Mailboxes);
app.route('/messages', v1Messages);
app.route('/uploads', createUploadRoutes(apiKeyAuth, async (c, next) => {
  requireScope(c, 'mail.send');
  await next();
}));

export default app;
