import {
  API_KEY_PREFIX,
  type ApiScope,
  type Role,
  type Settings,
  type UserStatus,
} from '@hpc-mail/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { sha256Hex } from '../lib/crypto.js';
import { AppError, missingScopeHints } from '../lib/errors.js';
import { bearerToken, clientIp, execCtx, routeLabel, runDetached } from '../lib/http.js';
import { getEmailDomain, normalizeEmail } from '../lib/email-address.js';
import { ipInAllowList } from '../lib/ip-allowlist.js';
import { writeApiRequestLog } from '../services/api-request-log.js';
import { getSettings, settingsQuery } from '../services/setting.js';
import { limitApiKeyRequest } from '../services/rate-limit.js';
import type { AppContext, Env } from '../types.js';

const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[a-f0-9]{64}$`);
const LAST_USED_THROTTLE_MS = 60_000;
const AUDIT_PATH_MAX = 256;

/** api_keys LEFT JOIN users 读出的鉴权所需列 */
interface ApiKeyRecord {
  id: number;
  user_id: number;
  scopes: string;
  allowed_ips: string;
  allowed_mailbox_ids: string;
  allowed_domains: string;
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
  const keyStatement = env.db.prepare(`SELECT k.id, k.user_id, k.scopes, k.allowed_ips, k.allowed_mailbox_ids, k.allowed_domains,
      k.rate_limit, k.status, k.expires_at, k.last_used_at, u.status AS user_status, u.role
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

  const token = bearerToken(c);
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
    allowedMailboxIds: JSON.parse(record.allowed_mailbox_ids) as number[],
    allowedDomains: JSON.parse(record.allowed_domains) as string[],
    rateLimit: Number(record.rate_limit),
    status: record.status,
    expiresAt: record.expires_at === null ? null : new Date(Number(record.expires_at)),
    userStatus: record.user_status,
    role: record.role,
  };

  // key 已定位：从这里起的拒绝（状态/过期/IP/限流）都进审计，安全监控最需要这些
  const ip = clientIp(c).toLowerCase();
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
      // 管理员能力要 Key 显式带 admin scope；没有它的管理员 Key 按普通用户执行
      role: row.role === 'admin' && row.scopes.includes('admin') ? 'admin' : 'user',
      scopes: row.scopes,
      allowedMailboxIds: row.allowedMailboxIds,
      allowedDomains: row.allowedDomains,
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
    await runDetached(execCtx(c), 'API 审计日志写入', () => writeApiRequestLog(c.env, admitted, {
      apiKeyId: row.id,
      requestId: c.get('requestId') ?? '',
      method: c.req.method,
      // 数字 id 段归一并截断，任意长的 URL 不会原样落库
      path: routeLabel(c.req.path).slice(0, AUDIT_PATH_MAX),
      statusCode,
      ip,
      durationMs: Math.max(0, Date.now() - startedAt),
    }));
  }
};

/**
 * last_used 每把 Key 最多 60 秒写一次：查 key 时已读出旧值，未到期不发语句；写入走 waitUntil，不阻塞响应。
 * 条件更新防止多个 isolate 同时写；无 ExecutionContext（单测直调）时同步写入。
 */
async function touchLastUsed(c: Context<AppContext>, record: ApiKeyRecord, ip: string, now: number): Promise<void> {
  if (record.last_used_at !== null && Number(record.last_used_at) >= now - LAST_USED_THROTTLE_MS) return;
  await runDetached(execCtx(c), 'API Key last_used 更新', () => c.env.db.prepare(`UPDATE api_keys SET last_used_at = ?, last_used_ip = ?
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`)
    .bind(now, ip, record.id, now - LAST_USED_THROTTLE_MS).run());
}

/** 校验 scope（v1 路由内调用） */
export function requireScope(c: Context<AppContext>, scope: ApiScope): void {
  requireAnyScope(c, [scope]);
}

/** Key 带其中任一 scope 即可（如 /identities：mail.send 或 mailbox.read）；没有 Key 时同样拒绝 */
export function requireAnyScope(c: Context<AppContext>, scopes: readonly ApiScope[]): void {
  const apiKey = c.get('apiKey');
  if (apiKey && scopes.some((scope) => apiKey.scopes.includes(scope))) return;
  const { message, ...hints } = missingScopeHints(scopes);
  throw new AppError('forbidden', message, hints);
}

/** Key 限定范围；null 表示不限（含不经过 API Key 的请求） */
export interface KeyRestriction {
  mailboxIds: number[];
  domains: string[];
}

/**
 * 当前请求的 Key 限定范围。地址可用的判定（全站统一）：地址的域名在 domains 中，
 * 或该地址当前的认领行 id 在 mailboxIds 中；未认领地址只看域名。
 */
export function keyRestriction(c: Context<AppContext>): KeyRestriction | null {
  const key = c.get('apiKey');
  if (!key || (!key.allowedMailboxIds.length && !key.allowedDomains.length)) return null;
  return { mailboxIds: key.allowedMailboxIds, domains: key.allowedDomains };
}

function restrictedError(what: string): AppError {
  return new AppError('forbidden', `这把 API Key 限定了可用的邮箱或域名，不能访问${what}`, {
    fix: 'GET /v1/me 查看 key.allowedMailboxIds 与 key.allowedDomains；换用覆盖它的 Key，或请用户在网页「API Key」页面调整范围',
    docs: '/references/errors.md#key-restricted',
  });
}

/** 域名是否在限定范围内（只看 domains；只限定了邮箱的 Key 对任何域名都返回 false） */
export function restrictionAllowsDomain(restriction: KeyRestriction, domain: string): boolean {
  return restriction.domains.includes(domain.trim().toLowerCase());
}

/** 已知认领行时的判定：id 在 mailboxIds 或 domain 在 domains 中 */
function restrictionAllowsMailbox(restriction: KeyRestriction, mailbox: { id: number; domain: string }): boolean {
  return restriction.mailboxIds.includes(mailbox.id) || restrictionAllowsDomain(restriction, mailbox.domain);
}

/** 地址不在 Key 限定范围内时 403 forbidden（docs: /references/errors.md#key-restricted）。域名命中时不查库 */
export async function assertKeyCanUseAddress(c: Context<AppContext>, address: string): Promise<void> {
  const restriction = keyRestriction(c);
  if (!restriction) return;
  const normalized = normalizeEmail(address);
  if (restrictionAllowsDomain(restriction, getEmailDomain(normalized))) return;
  if (restriction.mailboxIds.length) {
    const row = await c.env.db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(normalized).first<{ id: number }>();
    if (row && restriction.mailboxIds.includes(Number(row.id))) return;
  }
  throw restrictedError(` ${normalized}`);
}

/** 域名不在 Key 限定的 domains 中时 403（只限定了邮箱的 Key 不能使用任何域名级能力，如认领） */
export function assertKeyCanUseDomain(c: Context<AppContext>, domain: string): void {
  const restriction = keyRestriction(c);
  if (restriction && !restrictionAllowsDomain(restriction, domain)) throw restrictedError(`域名 ${domain.trim().toLowerCase()}`);
}

/** 已知认领行时的判定（免一次查询）：id 在 mailboxIds 或 domain 在 domains 中 */
export function assertKeyCanUseMailbox(c: Context<AppContext>, mailbox: { id: number; domain: string; address?: string }): void {
  const restriction = keyRestriction(c);
  if (restriction && !restrictionAllowsMailbox(restriction, mailbox)) {
    throw restrictedError(mailbox.address ? ` ${mailbox.address}` : `邮箱 #${mailbox.id}`);
  }
}

/** 按 id 确认邮箱都在 Key 范围内（一次查询，不限范围的 Key 不查库）；不存在的放过，交给调用方按原口径报错 */
export async function assertKeyCanUseMailboxIds(c: Context<AppContext>, ids: readonly number[]): Promise<void> {
  if (!keyRestriction(c) || !ids.length) return;
  const { results } = await c.env.db.prepare('SELECT id, domain, address FROM mailboxes WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all<{ id: number; domain: string; address: string }>();
  for (const box of results) assertKeyCanUseMailbox(c, { id: Number(box.id), domain: box.domain, address: box.address });
}

/** 限定了范围的 Key 只看得到范围内的邮箱（列表按认领行 id 与域名收窄；不限范围时原样返回） */
export function filterWithinKey<T extends { domain: string }>(c: Context<AppContext>, list: T[], idOf: (item: T) => number): T[] {
  const restriction = keyRestriction(c);
  return restriction ? list.filter((item) => restrictionAllowsMailbox(restriction, { id: idOf(item), domain: item.domain })) : list;
}

/**
 * 发件地址在 Key 范围内：from 解析后的 mailboxId 或 localPart+domain。发件邮箱不存在时放过，交给发信流程按原口径报 404。
 */
export async function assertKeyCanUseSender(
  c: Context<AppContext>,
  from: { mailboxId?: number; localPart?: string; domain?: string },
): Promise<void> {
  if (!keyRestriction(c)) return;
  if (from.mailboxId !== undefined) return assertKeyCanUseMailboxIds(c, [from.mailboxId]);
  if (from.localPart && from.domain) await assertKeyCanUseAddress(c, `${from.localPart}@${from.domain}`);
}

/** 限定了范围的 Key 不能用账户级能力（通知配置写入、通知健康等会涉及范围外邮件的接口） */
export function assertKeyUnrestricted(c: Context<AppContext>, what: string): void {
  if (keyRestriction(c)) throw restrictedError(what);
}
