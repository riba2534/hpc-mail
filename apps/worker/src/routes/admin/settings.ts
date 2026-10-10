import {
  SECRET_MASK,
  aiModelTestRequestSchema,
  domainSchema,
  updateSettingsRequestSchema,
  type AiModelTestRequest,
  type AiModelTestResult,
} from '@hpc-mail/shared';
import { Hono } from 'hono';
import { AppError } from '../../lib/errors.js';
import { clientIp, ok, parseBody } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { describeSettingsChange, logAdminAction } from '../../services/audit.js';
import { checkDomainOnboarding } from '../../services/domain-check.js';
import { getSettingsFresh, maskSettings, updateSettings } from '../../services/setting.js';
import { AiProviderError, isAiModelConfigured } from '../../services/ai-provider.js';
import { translateSegments } from '../../services/translate.js';
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
  const before = await getSettingsFresh(c.env);
  await updateSettings(c.env, req);
  const settings = await getSettingsFresh(c.env);
  // 目标只记设置键（不含 expectedDomainsRevision），明细写变更摘要
  const { target, detail } = describeSettingsChange(before, settings, Object.keys(req));
  await logAdminAction(c.env, acting, 'settings.update', target, detail, clientIp(c));
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

const AI_MODEL_TEST_SAMPLE = 'Your verification code is 123456. It expires in 10 minutes.';

/** 测试 AI 模型：用翻译的同一调用格式译一句固定示例。未提交的字段与 SECRET_MASK 用已保存值；不计用户额度 */
app.post('/ai-model-test', async (c) => {
  const req: AiModelTestRequest = c.req.header('Content-Length') === '0' || c.req.raw.body === null
    ? {} : await parseBody(c, aiModelTestRequestSchema);
  const saved = (await getSettingsFresh(c.env)).ai_model;
  const config = {
    baseUrl: req.baseUrl || saved.baseUrl,
    apiKey: req.apiKey && req.apiKey !== SECRET_MASK ? req.apiKey : saved.apiKey,
    model: req.model || saved.model,
  };
  if (!isAiModelConfigured(config)) throw new AppError('validation_failed', '请先填写接口地址、API Key 和模型');
  const started = Date.now();
  try {
    const [sample] = await translateSegments(config, [AI_MODEL_TEST_SAMPLE]);
    const result: AiModelTestResult = { ok: true, latencyMs: Date.now() - started, sample: sample ?? '' };
    return ok(c, result);
  } catch (error) {
    if (error instanceof AiProviderError) throw new AppError('internal', `AI 模型测试失败：${error.message}`);
    throw error;
  }
});

export default app;
