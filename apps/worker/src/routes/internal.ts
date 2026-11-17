import { Hono, type Context } from 'hono';
import { bytesToHex } from '../lib/crypto.js';
import { normalizeDomain } from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import { ok } from '../lib/http.js';
import { getDomains } from '../services/domain.js';
import {
  CANARY_RATE_LIMIT, CANARY_RATE_SCOPE, buildId, isCanaryNonce, pickCanaryDomains, readCanaryReceipt,
  readCronHeartbeat, sendCanaryMail, verifyCanaryToken,
} from '../services/ops-probe.js';
import { bumpCounter, minuteWindow } from '../services/rate-counter.js';
import { getSettingsFresh } from '../services/setting.js';
import type { AppContext } from '../types.js';

/**
 * 部署后运维端点（CI 调用，不进 OpenAPI / skill.md）：收件金丝雀与 cron 心跳。
 * X-Canary-Token 错误或缺失时与不存在的接口返回同样的 404，不暴露端点存在。
 */
const app = new Hono<AppContext>();

app.use('*', async (c, next) => {
  if (!(await verifyCanaryToken(c.env, c.req.header('X-Canary-Token')))) {
    throw new AppError('not_found', '接口不存在');
  }
  await next();
});

/** 可选 body `{fromDomain, toDomain}`；空 body 等于都不指定 */
async function readCanaryRequest(c: Context<AppContext>): Promise<{ fromDomain?: string; toDomain?: string }> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError('validation_failed', '请求体须为 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('validation_failed', '请求体须为 JSON 对象');
  const pick = (key: 'fromDomain' | 'toDomain') => {
    const value = (body as Record<string, unknown>)[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new AppError('validation_failed', `${key} 须为字符串`);
    return normalizeDomain(value);
  };
  return { fromDomain: pick('fromDomain'), toDomain: pick('toDomain') };
}

/** 经 send_email 真实外发一封金丝雀：canary@A → canary@B，外发失败返回 502（不重试） */
app.post('/canary', async (c) => {
  const requested = await readCanaryRequest(c);
  const { fromDomain, toDomain } = pickCanaryDomains(await getDomains(c.env, await getSettingsFresh(c.env)), requested);
  // 校验通过才计数：参数错误不占全站额度
  const usage = await bumpCounter(c.env, CANARY_RATE_SCOPE, 'site', minuteWindow(1));
  if (usage.count > CANARY_RATE_LIMIT) throw new AppError('rate_limited', `金丝雀每分钟最多 ${CANARY_RATE_LIMIT} 次`);
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const from = `canary@${fromDomain}`;
  const to = `canary@${toDomain}`;
  try {
    await sendCanaryMail(c.env, from, to, nonce);
  } catch (error) {
    throw new AppError('internal', `金丝雀外发失败: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  return ok(c, { nonce, from, to, build: buildId(c.env), sentAt: new Date().toISOString() });
});

app.get('/canary/:nonce', async (c) => {
  const nonce = c.req.param('nonce');
  if (!isCanaryNonce(nonce)) throw new AppError('validation_failed', 'nonce 格式不正确');
  return ok(c, await readCanaryReceipt(c.env, nonce));
});

app.get('/health', async (c) => ok(c, { build: buildId(c.env), cron: await readCronHeartbeat(c.env) }));

export default app;
