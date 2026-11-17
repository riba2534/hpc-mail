import type { TwoFactorDisabled, TwoFactorEnabled, TwoFactorSetup } from '@hpc-mail/shared';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { generateRecoveryCodes, generateTotpSecret, matchTotpStep, otpauthUri } from '../lib/totp.js';
import type { Env, ExecCtx } from '../types.js';
import { issueToken } from './auth.js';
import { verifyReauthPassword } from './reauth.js';
import { mirrorUserEpoch } from './session.js';

/** 开始登记：先重新验证密码（拿到会话令牌的人不能给账号绑上自己的验证器），再生成密钥（未启用） */
export async function setupTwoFactor(env: Env, userId: number, password: string): Promise<TwoFactorSetup> {
  await verifyReauthPassword(env, userId, password);
  const db = createDb(env);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AppError('not_found', '用户不存在');
  if (user.totpEnabledAt) throw new AppError('conflict', '两步验证已启用');
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ totpSecret: secret, totpEnabledAt: null, totpRecoveryCodes: null, totpLastStep: null })
    .where(eq(users.id, userId));
  return { secret, otpauthUri: otpauthUri(secret, user.username) };
}

/**
 * 校验一次性码并启用，返回一次性恢复码。启用、记录已用时间步与递增鉴权版本在同一条条件写入里：
 * 其他会话（包括可能失窃的旧令牌）立即失效，返回的 token 替换当前会话。
 * 验证码错误返回 400（不用 401，网页客户端遇到 401 会清掉会话）。
 */
export async function enableTwoFactor(env: Env, userId: number, code: string, ctx?: ExecCtx | null): Promise<TwoFactorEnabled> {
  const db = createDb(env);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.totpSecret) throw new AppError('validation_failed', '请先开始登记');
  if (user.totpEnabledAt) throw new AppError('conflict', '两步验证已启用');
  const step = await matchTotpStep(user.totpSecret, code);
  if (step === null) throw new AppError('validation_failed', '验证码错误，请重试');
  const { plain, hashes } = await generateRecoveryCodes();
  const updated = await db
    .update(users)
    .set({ totpEnabledAt: new Date(), totpRecoveryCodes: hashes, totpLastStep: step,
      authVersion: sql`${users.authVersion} + 1`, authVersionMigrated: true })
    .where(sql`${users.id} = ${userId} AND ${users.totpEnabledAt} IS NULL AND ${users.totpSecret} = ${user.totpSecret}
      AND (${users.totpLastStep} IS NULL OR ${users.totpLastStep} < ${step})`)
    .returning()
    .get();
  if (!updated) throw new AppError('conflict', '两步验证状态已改变，请刷新后重试');
  await mirrorUserEpoch(env, userId, updated.authVersion, ctx);
  return { recoveryCodes: plain, token: await issueToken(env, updated, ctx) };
}

/**
 * 关闭两步验证：必须重新验证当前密码（只凭 TOTP 码不能关闭）。已启用时递增鉴权版本让其他会话失效；
 * 只是取消未完成的登记时不影响其他会话。返回的 token 替换当前会话。
 */
export async function disableTwoFactor(env: Env, userId: number, password: string, ctx?: ExecCtx | null): Promise<TwoFactorDisabled> {
  await verifyReauthPassword(env, userId, password);
  const db = createDb(env);
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new AppError('not_found', '用户不存在');
  const enabled = user.totpEnabledAt !== null;
  const updated = await db
    .update(users)
    .set({ totpSecret: null, totpEnabledAt: null, totpRecoveryCodes: null, totpLastStep: null,
      ...(enabled ? { authVersion: sql`${users.authVersion} + 1`, authVersionMigrated: true } : {}) })
    .where(eq(users.id, userId))
    .returning()
    .get();
  if (!updated) throw new AppError('not_found', '用户不存在');
  if (enabled) await mirrorUserEpoch(env, userId, updated.authVersion, ctx);
  return { success: true, token: await issueToken(env, updated, ctx) };
}
