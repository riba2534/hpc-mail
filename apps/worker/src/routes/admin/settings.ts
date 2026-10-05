import { domainSchema, updateSettingsRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, ok, parseBody } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { logAdminAction } from '../../services/audit.js';
import { checkDomainOnboarding } from '../../services/domain-check.js';
import { getSettingsFresh, maskSettings, updateSettings } from '../../services/setting.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 回显脱敏（feishu / webhook secret 掩码） */
app.get('/', async (c) => {
  const settings = await getSettingsFresh(c.env);
  return ok(c, maskSettings(settings));
});

app.put('/', async (c) => {
  const acting = c.get('user')!;
  const req = await parseBody(c, updateSettingsRequestSchema);
  if (req.domains && req.expectedDomainsRevision === undefined) throw new AppError('validation_failed', '更新域名需提供 expectedDomainsRevision');
  await updateSettings(c.env, req);
  await logAdminAction(c.env, acting, 'settings.update', Object.keys(req).join('、'), '', clientIp(c));
  const settings = await getSettingsFresh(c.env);
  return ok(c, maskSettings(settings));
});

/** 域名接入自检：DoH 探测该域 MX 是否已指向 Cloudflare Email Routing（无需 CF 凭据） */
app.get('/domain-status', async (c) => {
  const parsed = domainSchema.safeParse((c.req.query('domain') ?? '').trim().toLowerCase());
  if (!parsed.success) throw new AppError('validation_failed', '域名格式非法');
  const settings = await getSettingsFresh(c.env);
  const inList = settings.domains.list.some((e) => e.domain === parsed.data);
  const status = await checkDomainOnboarding(parsed.data, inList);
  return ok(c, status);
});

export default app;
