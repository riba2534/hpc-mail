import { eq } from 'drizzle-orm';
import {
  MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_AUTH_USER_REQUESTS_PER_MINUTE,
} from '@hpc-mail/shared';
import type { MiddlewareHandler } from 'hono';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { getUserEpoch, sessionExists } from '../services/session.js';
import { getSettings } from '../services/setting.js';
import { bumpCounter, minuteWindow } from '../services/rate-counter.js';
import type { AppContext, AuthUser } from '../types.js';

function bearer(c: { req: { header: (k: string) => string | undefined } }): string | null {
  const header = c.req.header('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

/** JWT + KV 会话 + 用户代/实例代 + 每请求查 users 单行验状态 */
export const requireAuth: MiddlewareHandler<AppContext> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new AppError('unauthorized', '缺少访问令牌');

  const claims = await verifyToken(c.env.jwt_secret, token);
  if (!claims) throw new AppError('unauthorized', '令牌无效或已过期');

  if (!(await sessionExists(c.env, claims.sid))) {
    throw new AppError('unauthorized', '会话已失效');
  }

  const db = createDb(c.env);
  const row = await db.select().from(users).where(eq(users.id, claims.sub)).get();
  if (!row) throw new AppError('unauthorized', '用户不存在');
  if (row.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');
  const authVersion = row.authVersionMigrated ? row.authVersion : await getUserEpoch(c.env, row.id);
  if (claims.uepoch !== authVersion) throw new AppError('unauthorized', '会话已失效');

  const minute = minuteWindow(1);
  const [userRate, globalRate] = await Promise.all([
    bumpCounter(c.env, 'auth-user', String(row.id), minute),
    bumpCounter(c.env, 'auth-global', 'instance', minute),
  ]);
  if (
    userRate.count > MAX_AUTH_USER_REQUESTS_PER_MINUTE ||
    globalRate.count > MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE
  ) {
    throw new AppError('rate_limited', '请求过于频繁，请稍后重试');
  }

  const authUser: AuthUser = {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
    avatarKey: row.avatarKey,
    twoFactorEnabled: !!row.totpEnabledAt,
  };
  await assertTwoFactorSatisfied(c, authUser);

  c.set('user', authUser);
  c.set('sessionId', claims.sid);
  await next();
};

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
  c: { env: AppContext['Bindings']; req: { url: string } },
  user: AuthUser,
): Promise<void> {
  // 绝大多数请求在这里就返回，不会多查一次 settings
  if (user.twoFactorEnabled) return;
  const path = new URL(c.req.url).pathname;
  if (TWO_FACTOR_EXEMPT.some((re) => re.test(path))) return;
  const settings = await getSettings(c.env);
  if (!settings.security.require2fa) return;
  throw new AppError('totp_setup_required', '本站要求开启两步验证，请先完成绑定');
}

/** 需 admin 角色（须在 requireAuth 之后） */
export const requireAdmin: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') throw new AppError('forbidden', '需要管理员权限');
  await next();
};
