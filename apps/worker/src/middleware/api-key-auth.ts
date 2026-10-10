import {
  API_KEY_PREFIX,
  MAX_API_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_API_USER_REQUESTS_PER_MINUTE,
  type ApiScope,
} from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { createDb } from '../db/client.js';
import { apiKeys, apiRequestLogs, users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { execCtx } from '../lib/http.js';
import { ipInAllowList } from '../lib/ip-allowlist.js';
import { getSettings } from '../services/setting.js';
import { bumpCounter, counterResult, counterStatement, minuteWindow } from '../services/rate-counter.js';
import type { AppContext } from '../types.js';

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-f0-9]{64}$`);
const LAST_USED_THROTTLE_MS = 60_000;

function clientIp(c: Context<AppContext>): string {
  const value = c.req.header('CF-Connecting-IP') || '';
  return (value.split(',')[0] ?? '').trim().toLowerCase() || 'unknown';
}

/** /v1 鉴权：hash 查 key → 状态/过期/IP → 滑窗限流 → finally 审计 */
export const apiKeyAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const startedAt = Date.now();
  c.set('apiStartedAt', startedAt);

  const settings = await getSettings(c.env, execCtx(c));
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

    // 查到 key 之后的四次写合进一个 batch：Key 级窗口计数、用户级与实例级总桶、last_used。
    // 后三条带守卫，保持原先的短路语义：Key 级超限时不计入总桶、任一超限时不刷新 last_used。
    const now = Date.now();
    const windowStart = Math.floor(now / 60000);
    const minute = minuteWindow(1, now);
    const keyWithinLimit = {
      sql: `(SELECT request_count FROM api_rate_limits WHERE api_key_id = ? AND window_start = ?) <= ?`,
      params: [row.id, windowStart, row.rateLimit],
    };
    const counterWithin = 'COALESCE((SELECT count FROM rate_counters WHERE scope = ? AND subject = ? AND "window" = ?), 0) <= ?';
    const userSubject = String(row.userId);
    const results = await c.env.db.batch([
      c.env.db.prepare(`INSERT INTO api_rate_limits (api_key_id, window_start, request_count) VALUES (?, ?, 1)
        ON CONFLICT(api_key_id, window_start) DO UPDATE SET request_count = request_count + 1
        RETURNING request_count`).bind(row.id, windowStart),
      counterStatement(c.env, 'api-user', userSubject, minute, 1, 0, keyWithinLimit),
      counterStatement(c.env, 'api-global', 'instance', minute, 1, 0, keyWithinLimit),
      // last_used 最多 60 秒写一次，避免每个请求都写同一行
      c.env.db.prepare(`UPDATE api_keys SET last_used_at = ?, last_used_ip = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)
          AND ${keyWithinLimit.sql} AND ${counterWithin} AND ${counterWithin}`)
        .bind(now, ip, row.id, now - LAST_USED_THROTTLE_MS, ...keyWithinLimit.params,
          'api-user', userSubject, minute, MAX_API_USER_REQUESTS_PER_MINUTE,
          'api-global', 'instance', minute, MAX_API_GLOBAL_REQUESTS_PER_MINUTE),
    ]);
    const requestCount = Number((results[0]?.results?.[0] as { request_count?: number } | undefined)?.request_count ?? 1);
    c.header('X-RateLimit-Limit', String(row.rateLimit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, row.rateLimit - requestCount)));
    c.header('X-RateLimit-Reset', String((windowStart + 1) * 60));
    if (requestCount > row.rateLimit) throw new AppError('rate_limited', 'API 调用频率超限');

    // Key 级限制之外再加用户级与实例级总桶，避免创建多个 Key 横向放大额度。
    const userRate = counterResult(results[1]) ?? await bumpCounter(c.env, 'api-user', userSubject, minute);
    const globalRate = counterResult(results[2]) ?? await bumpCounter(c.env, 'api-global', 'instance', minute);
    if (userRate.count > MAX_API_USER_REQUESTS_PER_MINUTE || globalRate.count > MAX_API_GLOBAL_REQUESTS_PER_MINUTE) {
      throw new AppError('rate_limited', 'API 总调用频率超限，请稍后重试');
    }

    await next();
    statusCode = c.res.status;
  } catch (err) {
    statusCode = err instanceof AppError ? err.status : 500;
    throw err;
  } finally {
    // 审计日志不阻塞响应；无 ExecutionContext（单测直调）时同步写入
    const audit = db.insert(apiRequestLogs).values({
      apiKeyId: row.id,
      requestId: c.get('requestId') ?? '',
      method: c.req.method,
      path: c.req.path,
      statusCode,
      ip,
      durationMs: Math.max(0, Date.now() - startedAt),
    }).run().catch((e: unknown) => console.error('api audit log failed:', e));
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(audit);
    else await audit;
  }
};

/** 校验 scope（v1 路由内调用） */
export function requireScope(c: Context<AppContext>, scope: ApiScope): void {
  const apiKey = c.get('apiKey');
  if (!apiKey || !apiKey.scopes.includes(scope)) {
    throw new AppError('forbidden', `需要 API scope: ${scope}`);
  }
}
