import {
  API_KEY_PREFIX,
  type ApiScope,
  type Role,
  type Settings,
  type UserStatus,
} from '@hpc-mail/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { execCtx, routeLabel } from '../lib/http.js';
import { ipInAllowList } from '../lib/ip-allowlist.js';
import { writeApiRequestLog } from '../services/api-request-log.js';
import { getSettings, settingsQuery } from '../services/setting.js';
import { limitApiKeyRequest } from '../services/rate-limit.js';
import type { AppContext, Env } from '../types.js';

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-f0-9]{64}$`);
const LAST_USED_THROTTLE_MS = 60_000;
const AUDIT_PATH_MAX = 256;

function clientIp(c: Context<AppContext>): string {
  const value = c.req.header('CF-Connecting-IP') || '';
  return (value.split(',')[0] ?? '').trim().toLowerCase() || 'unknown';
}

/** api_keys LEFT JOIN users 读出的鉴权所需列 */
interface ApiKeyRecord {
  id: number;
  user_id: number;
  scopes: string;
  allowed_ips: string;
  rate_limit: number;
  status: 'active' | 'disabled' | 'revoked';
  expires_at: number | null;
  last_used_at: number | null;
  user_status: UserStatus | null;
  role: Role | null;
}

/**
 * 读设置并按 hash 查 key。设置命中 isolate 缓存时只查 key；未命中时两条读语句合进一个 batch，
 * 冷 isolate 与热 isolate 都只有一次读往返。Token 格式非法时不查 key，只读设置判断 API 是否关闭。
 * 已吊销的 Key 不可恢复，查询阶段就当作不存在：不进审计，吊销后的请求刷不了日志。
 */
async function loadSettingsAndKey(env: Env, keyHash: string | null): Promise<{ settings: Settings; record: ApiKeyRecord | null }> {
  if (!keyHash) return { settings: await getSettings(env), record: null };
  const keyStatement = env.db.prepare(`SELECT k.id, k.user_id, k.scopes, k.allowed_ips, k.rate_limit, k.status, k.expires_at,
      k.last_used_at, u.status AS user_status, u.role
    FROM api_keys k LEFT JOIN users u ON u.id = k.user_id WHERE k.key_hash = ? AND k.status <> 'revoked'`).bind(keyHash);
  const query = settingsQuery(env);
  if ('cached' in query) return { settings: query.cached, record: await keyStatement.first<ApiKeyRecord>() };
  const [settingsResult, keyResult] = await env.db.batch([query.statement, keyStatement]);
  return {
    settings: query.resolve(settingsResult!),
    record: (keyResult?.results?.[0] as ApiKeyRecord | undefined) ?? null,
  };
}

/**
 * /v1 鉴权：设置 + hash 查 key（唯一一次 D1 往返）→ 状态/过期/IP → 限流（Rate Limiting binding）→ finally 审计。
 * 中间件自身拒绝的请求（Key 禁用/过期、IP 白名单、用户停用、限流）每 Key 每分钟只写 1 行明细，
 * 其余只在 rate_counters 累加，拒绝请求再多也只是一行计数，写不满审计表。
 */
export const apiKeyAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const startedAt = Date.now();
  c.set('apiStartedAt', startedAt);

  const header = c.req.header('Authorization') || '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  const keyHash = KEY_PATTERN.test(token) ? await sha256Hex(token) : null;
  const { settings, record } = await loadSettingsAndKey(c.env, keyHash);
  // API 关闭优先于 Key 校验
  if (!settings.api.enabled) throw new AppError('forbidden', 'API 已关闭');
  if (!keyHash) throw new AppError('unauthorized', '缺少或非法的 API Key');

  // key 未定位（无 Bearer / hash 不匹配 / 已吊销）不记审计，避免垃圾请求刷日志
  if (!record) throw new AppError('unauthorized', 'API Key 无效');
  const row = {
    id: record.id,
    userId: record.user_id,
    scopes: JSON.parse(record.scopes) as ApiScope[],
    allowedIps: JSON.parse(record.allowed_ips) as string[],
    rateLimit: Number(record.rate_limit),
    status: record.status,
    expiresAt: record.expires_at === null ? null : new Date(Number(record.expires_at)),
    userStatus: record.user_status,
    role: record.role,
  };

  // key 已定位：从这里起的拒绝（状态/过期/IP/限流）都进审计，安全监控最需要这些
  const ip = clientIp(c);
  let statusCode = 200;
  let admitted = false;
  try {
    if (row.status !== 'active') throw new AppError('unauthorized', 'API Key 已禁用');
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
      scopes: row.scopes,
    });

    // 限流不写 D1：Key 档位 → 用户总桶 → 全站总桶依次短路（services/rate-limit.ts）。
    // Key 级超限不占用户额度，用户级超限不计入全站，避免创建多个 Key 横向放大额度，也让单个用户打不满全站。
    // 三种超限分开提示，调用方能区分是这把 Key、自己账户还是全站繁忙
    const now = Date.now();
    const rate = await limitApiKeyRequest(c.env, { id: row.id, userId: row.userId, rateLimit: row.rateLimit }, now);
    c.header('X-RateLimit-Limit', String(row.rateLimit));
    c.header('X-RateLimit-Remaining', String(rate.remaining));
    c.header('X-RateLimit-Reset', String(rate.reset));
    if (rate.rejectedBy === 'key') throw new AppError('rate_limited', 'API 调用频率超限');
    if (rate.rejectedBy === 'user') throw new AppError('rate_limited', 'API 调用频率超限（账户级），请稍后重试');
    if (rate.rejectedBy === 'global') throw new AppError('rate_limited', 'API 总调用频率超限，请稍后重试');
    await touchLastUsed(c, record, ip, now);

    admitted = true;
    await next();
    statusCode = c.res.status;
  } catch (err) {
    statusCode = err instanceof AppError ? err.status : 500;
    throw err;
  } finally {
    // 审计日志不阻塞响应；无 ExecutionContext（单测直调）时同步写入
    const audit = writeApiRequestLog(c.env, admitted, {
      apiKeyId: row.id,
      requestId: c.get('requestId') ?? '',
      method: c.req.method,
      // 数字 id 段归一并截断，任意长的 URL 不会原样落库
      path: routeLabel(c.req.path).slice(0, AUDIT_PATH_MAX),
      statusCode,
      ip,
      durationMs: Math.max(0, Date.now() - startedAt),
    }).catch((e: unknown) => console.error('api audit log failed:', e));
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(audit);
    else await audit;
  }
};

/**
 * last_used 每把 Key 最多 60 秒写一次：查 key 时已读出旧值，未到期不发语句；写入走 waitUntil，不阻塞响应。
 * 条件更新防止多个 isolate 同时写；无 ExecutionContext（单测直调）时同步写入。
 */
async function touchLastUsed(c: Context<AppContext>, record: ApiKeyRecord, ip: string, now: number): Promise<void> {
  if (record.last_used_at !== null && Number(record.last_used_at) >= now - LAST_USED_THROTTLE_MS) return;
  const write = c.env.db.prepare(`UPDATE api_keys SET last_used_at = ?, last_used_ip = ?
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
    .bind(now, ip, record.id, now - LAST_USED_THROTTLE_MS).run()
    .then(() => undefined, (e: unknown) => console.error('api key last_used update failed:', e));
  const ctx = execCtx(c);
  if (ctx) ctx.waitUntil(write);
  else await write;
}

/** 校验 scope（v1 路由内调用） */
export function requireScope(c: Context<AppContext>, scope: ApiScope): void {
  const apiKey = c.get('apiKey');
  if (!apiKey || !apiKey.scopes.includes(scope)) {
    throw new AppError('forbidden', `需要 API scope: ${scope}`, {
      fix: `这把 Key 缺少 scope ${scope}：在网页「API Key」页面给它加上，或换用带该 scope 的 Key（GET /v1/me 可查看当前 scopes）`,
      docs: '/references/errors.md#forbidden-scope',
    });
  }
}
