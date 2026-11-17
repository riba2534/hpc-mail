import { eq } from 'drizzle-orm';
import {
  DEFAULT_SETTINGS,
  MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_AUTH_USER_REQUESTS_PER_MINUTE,
  SETTING_SCHEMAS,
} from '@hpc-mail/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyToken, type JwtClaims } from '../lib/jwt.js';
import { getUserEpoch, sessionValidFor } from '../services/session.js';
import { getSettings } from '../services/setting.js';
import {
  andGuards,
  bumpCounter,
  counterResult,
  counterStatement,
  counterWithinGuard,
  minuteWindow,
  type CounterValue,
} from '../services/rate-counter.js';
import type { AppContext, AuthUser } from '../types.js';

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const header = c.req.header('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

/** sessions + users 合并读出的鉴权所需列（不含密码哈希、TOTP 密钥与恢复码） */
interface AuthRow {
  session_user_id: number;
  revoked_at: number | null;
  expires_at: number;
  id: number | null;
  username: string;
  role: AuthUser['role'];
  status: AuthUser['status'];
  auth_version: number;
  auth_version_migrated: number;
  created_at: number;
  avatar_key: string | null;
  totp_enabled_at: number | null;
}

/**
 * JWT + D1 会话 + 用户代 + 每请求查 users 单行验状态。
 *
 * 快路径把「会话行、用户行、security 设置、两条限流计数」合进一个 D1 batch（单次往返）。
 * 计数语句带守卫：只有会话有效、用户启用且鉴权版本一致时才递增，与原先「校验通过后再计数」等价。
 * 全站桶另加「该用户本窗口未超限」：单个用户超限后的请求只推高自己的桶，不会把全站打满。
 * 会话行缺失（旧 KV 会话待惰性迁移）或用户鉴权版本尚未迁入 D1 时，走原有慢路径。
 * 不缓存会话或用户状态：改密/禁用仍即时生效。
 */
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new AppError('unauthorized', '缺少访问令牌');

  const claims = await verifyToken(c.env.jwt_secret, token);
  if (!claims) throw new AppError('unauthorized', '令牌无效或已过期');

  const authUser = (await fastAuth(c, claims)) ?? (await slowAuth(c, claims));
  c.set('user', authUser);
  c.set('sessionId', claims.sid);
  await next();
};

/**
 * 全站桶的递增守卫：本用户本窗口未超限才计入。须排在同一 batch 里 auth-user 递增之后，
 * 读到的才是含本次请求的值。
 */
function userWithinGuard(userId: number, minute: number) {
  return counterWithinGuard('auth-user', String(userId), minute, MAX_AUTH_USER_REQUESTS_PER_MINUTE);
}

/** 全站桶为 null 表示守卫未通过（本用户已超限，未计入全站），此时已由用户桶判定拒绝 */
function assertWithinRate(userRate: CounterValue, globalRate: CounterValue | null): void {
  if (
    userRate.count > MAX_AUTH_USER_REQUESTS_PER_MINUTE ||
    (globalRate?.count ?? 0) > MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE
  ) {
    throw new AppError('rate_limited', '请求过于频繁，请稍后重试');
  }
}

function parseRequire2fa(raw: string | undefined): boolean {
  if (raw === undefined) return DEFAULT_SETTINGS.security.require2fa;
  try {
    const parsed = SETTING_SCHEMAS.security.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.require2fa : DEFAULT_SETTINGS.security.require2fa;
  } catch {
    return DEFAULT_SETTINGS.security.require2fa;
  }
}

/** 单次 batch 完成鉴权；需要回退慢路径时返回 null（此时计数未发生） */
async function fastAuth(c: Context<AppContext>, claims: JwtClaims): Promise<AuthUser | null> {
  const db = c.env.db;
  const now = Date.now();
  const minute = minuteWindow(1, now);
  const guard = {
    sql: `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = ?
      WHERE s.id = ? AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?
        AND u.status = 'active' AND u.auth_version_migrated = 1 AND u.auth_version = ?)`,
    params: [claims.sub, claims.sid, now, claims.uepoch],
  };
  const [authResult, securityResult, userRateResult, globalRateResult] = await db.batch([
    // 用户按 claims.sub 取（与原先「先验会话、再按 sub 查用户」一致），LEFT JOIN 以区分用户缺失
    db.prepare(`SELECT s.user_id AS session_user_id, s.revoked_at, s.expires_at, u.id, u.username, u.role, u.status, u.auth_version,
        u.auth_version_migrated, u.created_at, u.avatar_key, u.totp_enabled_at
      FROM sessions s LEFT JOIN users u ON u.id = ? WHERE s.id = ?`).bind(claims.sub, claims.sid),
    db.prepare(`SELECT value FROM settings WHERE key = 'security'`),
    counterStatement(c.env, 'auth-user', String(claims.sub), minute, 1, 0, guard),
    counterStatement(c.env, 'auth-global', 'instance', minute, 1, 0, andGuards(guard, userWithinGuard(claims.sub, minute))),
  ]);
  const row = authResult?.results?.[0] as AuthRow | undefined;
  if (!row) return null;
  // 会话必须属于令牌声明的用户：防止同一会话 id 被解释成另一个账号
  if (Number(row.session_user_id) !== claims.sub) throw new AppError('unauthorized', '会话已失效');
  if (row.revoked_at !== null || !(Number(row.expires_at) > now)) {
    throw new AppError('unauthorized', '会话已失效');
  }
  if (row.id === null) throw new AppError('unauthorized', '用户不存在');
  if (!row.auth_version_migrated) return null;
  if (row.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');
  if (claims.uepoch !== Number(row.auth_version)) throw new AppError('unauthorized', '会话已失效');

  // 守卫与读取同处一个事务，用户桶正常必有返回；防御性兜底按原路径单独计数。
  // 全站桶无返回只可能是本用户已超限，不再补计，否则超限请求又会推高全站桶
  const userRate = counterResult(userRateResult)
    ?? (await bumpCounter(c.env, 'auth-user', String(row.id), minuteWindow(1)));
  assertWithinRate(userRate, counterResult(globalRateResult));

  const authUser: AuthUser = {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: new Date(Number(row.created_at)),
    avatarKey: row.avatar_key,
    twoFactorEnabled: row.totp_enabled_at !== null,
  };
  const securityRaw = (securityResult?.results?.[0] as { value?: string } | undefined)?.value;
  await assertTwoFactorSatisfied(c, authUser, async () => parseRequire2fa(securityRaw));
  return authUser;
}

/** 原有逐步校验路径：负责未迁移鉴权版本的惰性迁移。会话只认 D1 且必须属于令牌用户，不再从 KV 迁入 */
async function slowAuth(c: Context<AppContext>, claims: JwtClaims): Promise<AuthUser> {
  if (!(await sessionValidFor(c.env, claims.sid, claims.sub))) {
    throw new AppError('unauthorized', '会话已失效');
  }

  const db = createDb(c.env);
  const row = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      status: users.status,
      authVersion: users.authVersion,
      authVersionMigrated: users.authVersionMigrated,
      createdAt: users.createdAt,
      avatarKey: users.avatarKey,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(users)
    .where(eq(users.id, claims.sub))
    .get();
  if (!row) throw new AppError('unauthorized', '用户不存在');
  if (row.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');
  const authVersion = row.authVersionMigrated ? row.authVersion : await getUserEpoch(c.env, row.id);
  if (claims.uepoch !== authVersion) throw new AppError('unauthorized', '会话已失效');

  // 两条计数合进一个 batch：全站桶排在用户桶之后，守卫读到含本次请求的用户计数
  const minute = minuteWindow(1);
  const [userRateResult, globalRateResult] = await c.env.db.batch([
    counterStatement(c.env, 'auth-user', String(row.id), minute),
    counterStatement(c.env, 'auth-global', 'instance', minute, 1, 0, userWithinGuard(row.id, minute)),
  ]);
  assertWithinRate(counterResult(userRateResult) ?? { count: 1, units: 0 }, counterResult(globalRateResult));

  const authUser: AuthUser = {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    avatarKey: row.avatarKey,
    twoFactorEnabled: !!row.totpEnabledAt,
  };
  await assertTwoFactorSatisfied(c, authUser, async () =>
    (await getSettings(c.env)).security.require2fa);
  return authUser;
}

/**
 * 站点开启「要求所有账户开启两步验证」时，未绑定的账号除以下路径外一律拒绝。
 * 放行的是「完成绑定所必需」的最小集合，否则用户会被锁在门外无法绑定。
 */
const TWO_FACTOR_EXEMPT = [
  /^\/api\/auth\/2fa\//,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/me$/,
  /^\/api\/config/,
];

/**
 * require2fa 的后端强制。此前这个设置项只下发给前端渲染一条横幅，登录链路里没有任何
 * 分支——未绑定的账号照旧能拿 7 天 JWT，走 API 的脚本连横幅都看不到，管理员以为已强制、
 * 实际上口令一泄就是全量沦陷。
 */
async function assertTwoFactorSatisfied(
  c: { req: { url: string } },
  user: AuthUser,
  require2fa: () => Promise<boolean>,
): Promise<void> {
  // 绝大多数请求在这里就返回，不会多查一次 settings
  if (user.twoFactorEnabled) return;
  const path = new URL(c.req.url).pathname;
  if (TWO_FACTOR_EXEMPT.some((re) => re.test(path))) return;
  if (!(await require2fa())) return;
  throw new AppError('totp_setup_required', '本站要求开启两步验证，请先完成绑定');
}

/** 需 admin 角色（须在 requireAuth 之后） */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  await next();
};
