import type { PublicConfig } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok } from '../lib/http.js';
import { getPublicDomains } from '../services/domain.js';
import { hostedDomainsAvailable } from '../services/hosted-domain.js';
import { getSettings, isTranslationReady } from '../services/setting.js';
import type { AppContext } from '../types.js';
import { oidcConfigured } from '../services/oidc.js';

const app = new Hono<AppContext>();

/**
 * 公开配置：站点名 / 注册模式 / 公开域名表 / 翻译是否可用（无鉴权，仅暴露对普通用户开放的域名）。
 * 热 isolate 命中设置内存缓存，不访问 D1/KV；冷 isolate 只读一次 D1。
 */
app.get('/', async (c) => {
  const settings = await getSettings(c.env);
  const config: PublicConfig = {
    oidcEnabled: oidcConfigured(c.env),
    siteTitle: settings.site.title,
    registrationMode: settings.register_mode,
    domains: await getPublicDomains(c.env, settings),
    require2fa: settings.security.require2fa,
    translationEnabled: isTranslationReady(settings),
    hostedDomainsEnabled: hostedDomainsAvailable(c.env, settings),
  };
  c.header('Cache-Control', 'no-store');
  c.header('X-HPC-Build', c.env.build_sha ?? 'local');
  return ok(c, config);
});

export default app;
