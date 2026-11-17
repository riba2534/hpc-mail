import {
  cancelSystemDomainOnboardingRequestSchema, confirmSystemDomainOnboardingRequestSchema, createSystemDomainOnboardingRequestSchema,
  systemDomainOnboardingsQuerySchema, systemDomainPrecheckQuerySchema, systemDomainZonesQuerySchema,
  updateSystemDomainHiddenZonesRequestSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId, parseQuery, type SafeParser } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  cancelOnboarding, checkOnboarding, confirmOnboarding, createOnboarding, getOnboarding, listOnboardings, precheckSystemDomain,
  systemDomainZones,
} from '../../services/system-domain.js';
import { updateHiddenZones } from '../../services/zone-catalog.js';
import type { AppContext } from '../../types.js';

/** 请求体可省略：空体按 {} 校验 */
async function parseOptionalBody<T>(c: Context<AppContext>, schema: SafeParser<T>): Promise<T> {
  if (!(await c.req.text()).trim()) {
    const parsed = schema.safeParse({});
    if (parsed.success) return parsed.data;
  }
  return parseBody(c, schema);
}

/** 系统域名一键接入（只接受管理员 JWT，不扩展 /v1）：可接入的 zone、预检、接入任务与隐藏列表 */
const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.get('/zones', async (c) => ok(c, await systemDomainZones(c.env, parseQuery(c, systemDomainZonesQuerySchema))));

app.get('/precheck', async (c) => ok(c, await precheckSystemDomain(c.env, parseQuery(c, systemDomainPrecheckQuerySchema))));

app.post('/onboardings', async (c) => {
  const req = await parseBody(c, createSystemDomainOnboardingRequestSchema);
  const { view, created } = await createOnboarding(c.env, c.get('user')!, req, execCtx(c), clientIp(c));
  return ok(c, view, created ? 201 : 200);
});

app.get('/onboardings', async (c) => ok(c, await listOnboardings(c.env, parseQuery(c, systemDomainOnboardingsQuerySchema))));

app.get('/onboardings/:id', async (c) => ok(c, await getOnboarding(c.env, parseId(c.req.param('id')))));

app.post('/onboardings/:id/check', async (c) => ok(c, await checkOnboarding(c.env, parseId(c.req.param('id')))));

app.post('/onboardings/:id/confirm', async (c) => {
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, confirmSystemDomainOnboardingRequestSchema);
  return ok(c, await confirmOnboarding(c.env, c.get('user')!, id, req, execCtx(c), clientIp(c)));
});

app.post('/onboardings/:id/cancel', async (c) => {
  const id = parseId(c.req.param('id'));
  const req = await parseOptionalBody(c, cancelSystemDomainOnboardingRequestSchema);
  return ok(c, await cancelOnboarding(c.env, c.get('user')!, id, req, clientIp(c)));
});

app.put('/hidden-zones', async (c) => {
  const req = await parseBody(c, updateSystemDomainHiddenZonesRequestSchema);
  return ok(c, await updateHiddenZones(c.env, c.get('user')!, req, clientIp(c)));
});

export default app;
