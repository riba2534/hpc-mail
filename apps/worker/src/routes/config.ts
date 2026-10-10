import type { PublicConfig } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { execCtx, ok } from '../lib/http.js';
import { getPublicDomains } from '../services/domain.js';
import { getSettings } from '../services/setting.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();

/** 公开配置：站点名 / 注册模式 / 公开域名表（无鉴权，仅暴露对普通用户开放的域名） */
app.get('/', async (c) => {
  const settings = await getSettings(c.env, execCtx(c));
  const config: PublicConfig = {
    siteTitle: settings.site.title,
    registrationMode: settings.register_mode,
    domains: await getPublicDomains(c.env, settings),
    require2fa: settings.security.require2fa,
  };
  c.header('Cache-Control', 'no-store');
  c.header('X-HPC-Build', c.env.build_sha ?? 'local');
  return ok(c, config);
});

export default app;
