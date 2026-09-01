import {
  API_KEY_PREFIX,
  MAX_API_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_API_USER_REQUESTS_PER_MINUTE,
  type ApiScope,
} from '@hpc-mail/shared';
import { eq, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { createDb } from '../db/client.js';
import { apiKeys, apiRateLimits, apiRequestLogs, users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { ipInAllowList } from '../lib/ip-allowlist.js';
import { getSettings } from '../services/setting.js';
import { bumpCounter, minuteWindow } from '../services/rate-counter.js';
import type { AppContext } from '../types.js';

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-f0-9]{64}$`);

function clientIp(c: Context<AppContext>): string {
  const value = c.req.header('CF-Connecting-IP') || '';
  return (value.split(',')[0] ?? '').trim().toLowerCase() || 'unknown';
}

/** /v1 鉴权：hash 查 key → 状态/过期/IP → 滑窗限流 → finally 审计 */
export const apiKeyAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const startedAt = Date.now();
  c.set('apiStartedAt', startedAt);

  const settings = await getSettings(c.env);
  if (!settings.api.enabled) throw new AppError('forbidden', 'API 已关闭');

  const header = c.req.header('Authorization') || '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  if (!KEY_PATTERN.test(token)) throw new AppError('unauthorized', '缺少或非法的 API Key');

  const keyHash = await sha256Hex(token);
  const db = createDb(c.env);
  const row = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      scopes: apiKeys.scopes,
      allowedIps: apiKeys.allowedIps,
      rateLimit: apiKeys.rateLimit,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      userStatus: users.status,
      role: users.role,
    })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, keyHash))
    .get();

  // key 未定位（无 Bearer / hash 不匹配）不记审计，避免垃圾请求刷日志
  if (!row) throw new AppError('unauthorized', 'API Key 无效');

  // key 已定位：从这里起所有拒绝（状态/过期/IP/限流）都进审计，安全监控最需要这些
  const ip = clientIp(c);
  let statusCode = 200;
  try {
    if (row.status !== 'active') throw new AppError('unauthorized', 'API Key 已禁用或吊销');
    if (row.userStatus !== 'active') throw new AppError('user_disabled', 'API Key 所属用户已被禁用');
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new AppError('unauthorized', 'API Key 已过期');
    }
    if (!ipInAllowList(ip, row.allowedIps)) throw new AppError('forbidden', '来源 IP 不在白名单内');

    c.set('apiClientIp', ip);
    c.set('apiKey', {
      id: row.id,
      userId: row.userId,
      role: row.role ?? 'user',
      scopes: row.scopes as ApiScope[],
    });

    const windowStart = Math.floor(Date.now() / 60000);
    const rate = await db
      .insert(apiRateLimits)
      .values({ apiKeyId: row.id, windowStart, requestCount: 1 })
      .onConflictDoUpdate({
        target: [apiRateLimits.apiKeyId, apiRateLimits.windowStart],
        set: { requestCount: sql`${apiRateLimits.requestCount} + 1` },
      })
      .returning({ requestCount: apiRateLimits.requestCount })
      .get();
    const requestCount = rate?.requestCount ?? 1;
    c.header('X-RateLimit-Limit', String(row.rateLimit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, row.rateLimit - requestCount)));
    c.header('X-RateLimit-Reset', String((windowStart + 1) * 60));
    if (requestCount > row.rateLimit) throw new AppError('rate_limited', 'API 调用频率超限');

    // Key 级限制之外再加用户级与实例级总桶，避免创建多个 Key 横向放大额度。
    const minute = minuteWindow(1);
    const [userRate, globalRate] = await Promise.all([
      bumpCounter(c.env, 'api-user', String(row.userId), minute),
      bumpCounter(c.env, 'api-global', 'instance', minute),
    ]);
    if (userRate.count > MAX_API_USER_REQUESTS_PER_MINUTE || globalRate.count > MAX_API_GLOBAL_REQUESTS_PER_MINUTE) {
      throw new AppError('rate_limited', 'API 总调用频率超限，请稍后重试');
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(), lastUsedIp: ip })
      .where(eq(apiKeys.id, row.id));

    await next();
    statusCode = c.res.status;
  } catch (err) {
    statusCode = err instanceof AppError ? err.status : 500;
    throw err;
  } finally {
    try {
      await db.insert(apiRequestLogs).values({
        apiKeyId: row.id,
        requestId: c.get('requestId') ?? '',
        method: c.req.method,
        path: c.req.path,
        statusCode,
        ip,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (e) {
      console.error('api audit log failed:', e);
    }
  }
};

/** 校验 scope（v1 路由内调用） */
export function requireScope(c: Context<AppContext>, scope: ApiScope): void {
  const apiKey = c.get('apiKey');
  if (!apiKey || !apiKey.scopes.includes(scope)) {
    throw new AppError('forbidden', `需要 API scope: ${scope}`);
  }
}
