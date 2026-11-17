import { canaryRequestSchema, type CanaryRequest } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { bytesToHex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ok, parseBody } from '../lib/http.js';
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

/** 经 send_email 真实外发一封金丝雀：canary@A → canary@B，外发失败返回 502（不重试） */
app.post('/canary', async (c) => {
  // body 可选：空 body 等于收发域名都不指定（Hono 缓存了已读的正文，parseBody 可再次读取）
  const requested: CanaryRequest = (await c.req.text()).trim() ? await parseBody(c, canaryRequestSchema) : {};
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
