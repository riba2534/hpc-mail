import { Hono } from 'hono';
import { AppError } from './lib/errors.js';
import { onError, requestId } from './middleware/error.js';
import adminApiKeys from './routes/admin/api-keys.js';
import adminHostedDomains from './routes/admin/hosted-domains.js';
import adminAudit from './routes/admin/audit.js';
import adminDeliveryEvents from './routes/admin/delivery-events.js';
import adminInvites from './routes/admin/invites.js';
import adminMailboxShares from './routes/admin/mailbox-shares.js';
import adminMailboxes from './routes/admin/mailboxes.js';
import adminSettings from './routes/admin/settings.js';
import adminSuppressions from './routes/admin/suppressions.js';
import adminSystemDomains from './routes/admin/system-domains.js';
import adminUsers from './routes/admin/users.js';
import apiKeys from './routes/api-keys.js';
import attachments from './routes/attachments.js';
import auth from './routes/auth.js';
import uploads from './routes/uploads.js';
import avatar from './routes/avatar.js';
import config from './routes/config.js';
import domains from './routes/domains.js';
import forwardConfirmations from './routes/forward-confirmations.js';
import hostedDomains from './routes/hosted-domains.js';
import identities from './routes/identities.js';
import internal from './routes/internal.js';
import mailboxes from './routes/mailboxes.js';
import messages from './routes/messages.js';
import notifyPrefs from './routes/notify-prefs.js';
import v1 from './routes/v1/index.js';
import webhooks from './routes/webhooks.js';
import { buildSessionOpenApiSpec } from './routes/api-openapi.js';
import { createMcpRoutes } from './routes/mcp/index.js';
import type { AppContext } from './types.js';

/** 只认 `/api`、`/v1` 本身或其子路径与 `/mcp`；`/api-keys` 之类前端路由仍交给 SPA */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/v1' || pathname.startsWith('/v1/') || pathname === '/mcp';
}

export function createApp() {
  const app = new Hono<AppContext>();
  app.use('*', requestId);
  app.onError(onError);
  app.notFound((c) => onError(new AppError('not_found', '接口不存在'), c));

  const api = new Hono<AppContext>();
  api.get('/openapi.json', (c) => c.json(buildSessionOpenApiSpec(new URL(c.req.url).origin)));
  api.route('/auth', auth);
  api.route('/avatar', avatar);
  api.route('/config', config);
  api.route('/domains', domains);
  // 批量接口按路由挂「已鉴权即跳过」的鉴权，与同前缀子应用谁先挂都只鉴权一次
  api.route('/hosted-domains', hostedDomains);
  api.route('/identities', identities);
  api.route('/mailboxes', mailboxes);
  api.route('/messages', messages);
  api.route('/me/notify-prefs', notifyPrefs);
  api.route('/webhooks', webhooks);
  api.route('/forward-confirmations', forwardConfirmations);
  api.route('/attachments', attachments);
  api.route('/uploads', uploads);
  api.route('/api-keys', apiKeys);
  api.route('/admin/users', adminUsers);
  api.route('/admin/mailbox-shares', adminMailboxShares);
  api.route('/admin/mailboxes', adminMailboxes);
  api.route('/admin/settings', adminSettings);
  api.route('/admin/hosted-domains', adminHostedDomains);
  api.route('/admin/system-domains', adminSystemDomains);
  api.route('/admin/invites', adminInvites);
  api.route('/admin/api-keys', adminApiKeys);
  api.route('/admin/audit-logs', adminAudit);
  api.route('/admin/suppressions', adminSuppressions);
  api.route('/admin/delivery-events', adminDeliveryEvents);
  api.route('/internal', internal);

  app.route('/api', api);
  app.route('/v1', v1);
  // MCP 工具转成对 /v1 的内部请求，进入这个 app 本身
  app.route('/mcp', createMcpRoutes((request, env, ctx) => app.fetch(request, env, ctx)));

  return app;
}

export type App = ReturnType<typeof createApp>;
