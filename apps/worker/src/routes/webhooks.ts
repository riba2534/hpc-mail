import {
  createWebhookEndpointRequestSchema,
  updateWebhookEndpointRequestSchema,
  type WebhookEndpoint,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { getEmailDomain } from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import { execCtx, ok, parseBody, parseId } from '../lib/http.js';
import { pageLimit } from '../lib/pagination.js';
import { apiKeyAuth, keyRestriction, requireScope, type KeyRestriction } from '../middleware/api-key-auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  retryWebhookDelivery,
  rotateWebhookSecret,
  testWebhookEndpoint,
  updateWebhookEndpoint,
} from '../services/webhooks.js';
import type { AppContext } from '../types.js';

/** 过滤条件里落在 Key 范围内的地址：域名命中不查库，其余一次查出认领行 id 再比对 */
async function addressesInKey(c: Context<AppContext>, restriction: KeyRestriction, addresses: readonly string[]): Promise<Set<string>> {
  const allowed = new Set(addresses.filter((address) => restriction.domains.includes(getEmailDomain(address))));
  const rest = addresses.filter((address) => !allowed.has(address));
  if (rest.length && restriction.mailboxIds.length) {
    const { results } = await c.env.db.prepare('SELECT id, address FROM mailboxes WHERE address IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(rest)).all<{ id: number; address: string }>();
    for (const row of results) if (restriction.mailboxIds.includes(Number(row.id))) allowed.add(row.address);
  }
  return allowed;
}

/**
 * 限定了邮箱或域名的 Key 只能管理「过滤条件非空、且全部落在范围内」的端点：不带过滤的端点会收到账户的全部事件，
 * 超出这把 Key 能看到的范围。范围外的端点对这把 Key 不可见（404）。
 */
async function filtersInKey(c: Context<AppContext>, endpoints: { addresses: string[]; domains: string[] }[]): Promise<boolean[]> {
  const restriction = keyRestriction(c);
  if (!restriction) return endpoints.map(() => true);
  const allowed = await addressesInKey(c, restriction, [...new Set(endpoints.flatMap((endpoint) => endpoint.addresses))]);
  return endpoints.map((endpoint) => (endpoint.addresses.length + endpoint.domains.length > 0)
    && endpoint.domains.every((domain) => restriction.domains.includes(domain))
    && endpoint.addresses.every((address) => allowed.has(address)));
}

function restrictedFilters(): AppError {
  return new AppError('forbidden', '这把 API Key 限定了可用的邮箱或域名，Webhook 端点的 addresses / domains 必须非空且都在范围内', {
    fix: '把 addresses 或 domains 设成这把 Key 允许的地址与域名（GET /v1/me 查看 key.allowedMailboxIds 与 key.allowedDomains）',
    docs: '/references/errors.md#key-restricted',
  });
}

/**
 * Webhook v2 端点管理，网页会话（/api/webhooks）与 API Key（/v1/webhooks，webhook.write）同形。
 */
export function webhookRoutes(mode: 'session' | 'key') {
  const app = new Hono<AppContext>();
  if (mode === 'session') {
    app.use('*', requireAuth);
  } else {
    app.use('*', apiKeyAuth);
    app.use('*', async (c, next) => {
      requireScope(c, 'webhook.write');
      await next();
    });
  }
  const owner = (c: Context<AppContext>) => (mode === 'session' ? c.get('user')!.id : c.get('apiKey')!.userId);
  const origin = (c: Context<AppContext>) => new URL(c.req.url).origin;

  /** 读端点并确认这把 Key 能管理它（会话请求不受限） */
  async function visible(c: Context<AppContext>, id: number): Promise<WebhookEndpoint> {
    const endpoint = await getWebhookEndpoint(c.env, owner(c), id);
    const [inKey] = await filtersInKey(c, [endpoint]);
    if (!inKey) throw new AppError('not_found', 'Webhook 端点不存在');
    return endpoint;
  }

  app.get('/', async (c) => {
    const endpoints = await listWebhookEndpoints(c.env, owner(c));
    const inKey = await filtersInKey(c, endpoints);
    return ok(c, endpoints.filter((_, index) => inKey[index]));
  });

  app.post('/', async (c) => {
    const req = await parseBody(c, createWebhookEndpointRequestSchema);
    if (!(await filtersInKey(c, [req]))[0]) throw restrictedFilters();
    return ok(c, await createWebhookEndpoint(c.env, owner(c), req, origin(c)), 201);
  });

  app.get('/:id', async (c) => ok(c, await visible(c, parseId(c.req.param('id')))));

  app.put('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const req = await parseBody(c, updateWebhookEndpointRequestSchema);
    const current = await visible(c, id);
    const next = { addresses: req.addresses ?? current.addresses, domains: req.domains ?? current.domains };
    if (!(await filtersInKey(c, [next]))[0]) throw restrictedFilters();
    return ok(c, await updateWebhookEndpoint(c.env, owner(c), id, req, origin(c)));
  });

  app.delete('/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    await visible(c, id);
    await deleteWebhookEndpoint(c.env, owner(c), id);
    return ok(c, { success: true });
  });

  app.post('/:id/rotate-secret', async (c) => {
    const id = parseId(c.req.param('id'));
    await visible(c, id);
    return ok(c, await rotateWebhookSecret(c.env, owner(c), id));
  });

  app.post('/:id/test', async (c) => {
    const id = parseId(c.req.param('id'));
    await visible(c, id);
    return ok(c, await testWebhookEndpoint(c.env, owner(c), id));
  });

  app.get('/:id/deliveries', async (c) => {
    const id = parseId(c.req.param('id'));
    await visible(c, id);
    return ok(c, await listWebhookDeliveries(c.env, owner(c), id, c.req.query('cursor'), pageLimit(c.req.query('limit'))));
  });

  app.post('/:id/deliveries/:deliveryId/retry', async (c) => {
    const id = parseId(c.req.param('id'));
    await visible(c, id);
    return ok(c, await retryWebhookDelivery(c.env, owner(c), id, parseId(c.req.param('deliveryId')), execCtx(c)));
  });

  return app;
}

export default webhookRoutes('session');
