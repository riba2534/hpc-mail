import { DEFAULT_SETTINGS, SETTING_SCHEMAS } from '@hpc-mail/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors.js';
import { verifyToken, type JwtClaims } from '../lib/jwt.js';
import { limitSessionRequest } from '../services/rate-limit.js';
import type { AppContext, AuthUser, Env } from '../types.js';

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
  created_at: number;
  avatar_key: string | null;
  totp_enabled_at: number | null;
}

/**
 * JWT + D1 会话 + 用户代 + 每请求查 users 单行验状态。
 *
 * 快路径把「会话行、用户行、security 设置」合进一个只读 D1 batch（单次往返）。
 * 校验通过后才过限流（Rate Limiting binding，不写 D1）：失效会话、禁用账号的请求不计数；
 * 用户桶拒绝的请求不再进全站桶，单个用户超限打不满全站。
 * 不缓存会话或用户状态：改密/禁用仍即时生效。
 */
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new AppError('unauthorized', '缺少访问令牌');

  const claims = await verifyToken(c.env.jwt_secret, token);
  if (!claims) throw new AppError('unauthorized', '令牌无效或已过期');

  const authUser = await fastAuth(c, claims);
  c.set('user', authUser);
  c.set('sessionId', claims.sid);
  c.set('authEpoch', claims.uepoch);
  await next();
};

/** 用户每分钟上限与全站上限（services/rate-limit.ts）；须在会话与用户校验通过之后调用 */
async function assertWithinRate(env: Env, userId: number): Promise<void> {
  if (await limitSessionRequest(env, userId)) throw new AppError('rate_limited', '请求过于频繁，请稍后重试');
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

/** 单次只读 batch 完成鉴权：会话只认 D1，且必须属于令牌声明的用户 */
async function fastAuth(c: Context<AppContext>, claims: JwtClaims): Promise<AuthUser> {
  const db = c.env.db;
  const now = Date.now();
  const [authResult, securityResult] = await db.batch([
    // 用户按 claims.sub 取（与原先「先验会话、再按 sub 查用户」一致），LEFT JOIN 以区分用户缺失
    db.prepare(`SELECT s.user_id AS session_user_id, s.revoked_at, s.expires_at, u.id, u.username, u.role, u.status, u.auth_version,
        u.created_at, u.avatar_key, u.totp_enabled_at
      FROM sessions s LEFT JOIN users u ON u.id = ? WHERE s.id = ?`).bind(claims.sub, claims.sid),
    db.prepare(`SELECT value FROM settings WHERE key = 'security'`),
  ]);
  const row = authResult?.results?.[0] as AuthRow | undefined;
  if (!row) throw new AppError('unauthorized', '会话已失效');
  // 会话必须属于令牌声明的用户：防止同一会话 id 被解释成另一个账号
  if (Number(row.session_user_id) !== claims.sub) throw new AppError('unauthorized', '会话已失效');
  if (row.revoked_at !== null || !(Number(row.expires_at) > now)) {
    throw new AppError('unauthorized', '会话已失效');
  }
  if (row.id === null) throw new AppError('unauthorized', '用户不存在');
  if (row.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');
  if (claims.uepoch !== Number(row.auth_version)) throw new AppError('unauthorized', '会话已失效');
  await assertWithinRate(c.env, row.id);

  const authUser: AuthUser = {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: new Date(Number(row.created_at)),
    avatarKey: row.avatar_key,
    twoFactorEnabled: row.totp_enabled_at !== null,
  };
  assertTwoFactorSatisfied(c, authUser, (securityResult?.results?.[0] as { value?: string } | undefined)?.value);
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
function assertTwoFactorSatisfied(c: { req: { url: string } }, user: AuthUser, securityRaw: string | undefined): void {
  // 绝大多数请求在这里就返回，不解析 security 设置
  if (user.twoFactorEnabled) return;
  const path = new URL(c.req.url).pathname;
  if (TWO_FACTOR_EXEMPT.some((re) => re.test(path))) return;
  if (!parseRequire2fa(securityRaw)) return;
  throw new AppError('totp_setup_required', '本站要求开启两步验证，请先完成绑定');
}

/** 需 admin 角色（须在 requireAuth 之后） */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  await next();
};
