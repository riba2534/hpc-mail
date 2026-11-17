import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ok } from '../../lib/http.js';
import {
  apiKeyAuth, filterWithinKey, keyRestriction, requireAnyScope, requireScope, restrictionAllowsDomain,
} from '../../middleware/api-key-auth.js';
import { getApiKeySelf } from '../../services/api-key.js';
import { getVisibleDomains } from '../../services/domain.js';
import { listSendIdentities } from '../../services/identities.js';
import type { AppContext } from '../../types.js';
import { createUploadRoutes } from '../uploads.js';
import v1Admin from './admin/index.js';
import v1HostedDomains from './hosted-domains.js';
import v1MailboxShares from './mailbox-shares.js';
import v1Mailboxes from './mailboxes.js';
import v1Messages from './messages.js';
import { v1Drafts } from '../drafts.js';
import v1NotifyPrefs from './notify-prefs.js';
import v1Webhooks from './webhooks.js';
import { serveOpenApi } from '../openapi-serve.js';

const app = new Hono<AppContext>();

// 仅对 /v1 开 CORS（允许 Authorization 头）
app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'If-None-Match'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Link', 'X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'ETag'],
  }),
);

app.get('/status', apiKeyAuth, (c) => {
  const key = c.get('apiKey')!;
  return ok(c, { status: 'operational', userId: key.userId, role: key.role, scopes: key.scopes });
});

/** 当前 Key、所属用户、速率上限与今日外发用量；任何有效 Key 都能自查，不要求 scope */
app.get('/me', apiKeyAuth, async (c) => {
  const key = c.get('apiKey')!;
  return ok(c, await getApiKeySelf(c.env, key.id, key.userId));
});

/** 能用哪些地址发信：发信前选身份（mail.send）或盘点邮箱（mailbox.read）都需要，两者有其一即可 */
app.get('/identities', apiKeyAuth, async (c) => {
  requireAnyScope(c, ['mail.send', 'mailbox.read']);
  const key = c.get('apiKey')!;
  const result = await listSendIdentities(c.env, { userId: key.userId, role: key.role });
  const restriction = keyRestriction(c);
  if (!restriction) return ok(c, result);
  // 限定了范围的 Key 只列范围内的身份；任意前缀的系统域名只保留 allowedDomains 里的
  return ok(c, {
    identities: filterWithinKey(c, result.identities, (item) => item.mailboxId),
    domains: result.domains.filter((item) => restrictionAllowsDomain(restriction, item.domain)),
  });
});

// 与网页及认领校验共用用户的公共/专属规则。
app.get('/domains', apiKeyAuth, async (c) => {
  const key = c.get('apiKey')!;
  const domains = await getVisibleDomains(c.env, { userId: key.userId, role: key.role });
  const restriction = keyRestriction(c);
  // 只能在 allowedDomains 里认领；只限定了邮箱的 Key 没有可认领的域名
  return ok(c, { domains: restriction ? domains.filter((domain) => restrictionAllowsDomain(restriction, domain)) : domains });
});

/** OpenAPI 描述（公开，无需 key） */
app.get('/openapi.json', (c) => serveOpenApi(c, 'v1'));

app.route('/admin', v1Admin);
app.route('/hosted-domains', v1HostedDomains);
// 共享管理先于 /mailboxes 挂载：/mailboxes/shares 不能落进 /mailboxes/:id
app.route('/mailboxes/shares', v1MailboxShares);
app.route('/mailboxes', v1Mailboxes);
app.route('/messages', v1Messages);
app.route('/drafts', v1Drafts);
app.route('/notify-prefs', v1NotifyPrefs);
app.route('/webhooks', v1Webhooks);
app.route('/uploads', createUploadRoutes(apiKeyAuth, async (c, next) => {
  requireScope(c, 'mail.send');
  await next();
}));

export default app;
