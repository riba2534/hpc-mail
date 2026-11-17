import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { TOKEN_TTL_SECONDS } from '../lib/jwt.js';
import type { Env } from '../types.js';


/**
 * 创建会话：只写 D1（鉴权真源，没有 KV 镜像）。
 * 传入 verified 时用条件 INSERT 原子复核凭据未在校验之后被改掉（并发改密/禁用/重置 2FA）。
 */
export async function createSession(env: Env, userId: number, verified?: {
  authVersion: number; passwordHash: string; totpEnabledAt?: Date | null; totpSecret?: string | null;
}): Promise<string> {
  const sid = crypto.randomUUID();
  const now = Date.now();
  // 会话与 JWT 同寿命：会话行比令牌活得久没有意义，只会让撤销前的窗口更长
  const expiresAt = now + TOKEN_TTL_SECONDS * 1000;
  if (verified) {
    const inserted = await env.db.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at)
      SELECT ?, id, ?, ? FROM users
      WHERE id = ? AND status = 'active' AND auth_version = ? AND password_hash = ?
        AND totp_enabled_at IS ? AND totp_secret IS ? RETURNING id`)
      .bind(sid, now, expiresAt, userId, verified.authVersion, verified.passwordHash,
        verified.totpEnabledAt?.getTime() ?? null, verified.totpSecret ?? null)
      .first<{ id: string }>();
    if (!inserted) throw new AppError('bad_credentials', '账号凭据已改变，请重新登录');
  } else {
    await createDb(env).insert(sessions)
      .values({ id: sid, userId, createdAt: new Date(now), expiresAt: new Date(expiresAt) });
  }
  return sid;
}

export async function destroySession(env: Env, sid: string): Promise<void> {
  await createDb(env).update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sid));
}
