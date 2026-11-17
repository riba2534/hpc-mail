import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import type { Env } from '../types.js';
import { minuteWindow, releaseCounters, reserveCounters, type CounterLimit } from './rate-counter.js';

/** 重新验证密码的失败计数：按用户、15 分钟窗口 */
export const REAUTH_FAIL_SCOPE = 'reauth-fail';
const REAUTH_WINDOW_MINUTES = 15;
export const MAX_REAUTH_FAILURES = 5;

/**
 * 敏感操作（创建 API Key、新增转发目标、开关两步验证）前重新验证当前密码，只用于网页会话（JWT）路径。
 * 缺少 password 返回 403 reauth_required，密码错误返回 403 reauth_failed（不用 401：网页客户端遇到 401 会清掉会话）。
 * 每个用户 15 分钟内最多失败 MAX_REAUTH_FAILURES 次，先占位再校验，并发请求也超不过；超过返回 429。
 * 拿到会话令牌的人因此不能借这些接口爆破原密码。验证通过时退回本次占位。
 */
export async function verifyReauthPassword(env: Env, userId: number, password: string | null | undefined): Promise<void> {
  if (!password) {
    throw new AppError('reauth_required', '该操作需要输入当前密码', {
      fix: '在请求体里带上当前登录密码 password 后重试',
      docs: '/references/errors.md#reauth_required',
    });
  }
  const counter: CounterLimit = {
    scope: REAUTH_FAIL_SCOPE, subject: String(userId), window: minuteWindow(REAUTH_WINDOW_MINUTES), limit: MAX_REAUTH_FAILURES,
  };
  const [full] = await reserveCounters(env, [counter]);
  if (full) throw new AppError('rate_limited', '密码验证失败次数过多，请 15 分钟后再试');
  const row = await createDb(env).select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).get();
  if (!row) {
    await releaseCounters(env, [counter]);
    throw new AppError('unauthorized', '用户不存在');
  }
  // 校验失败时占位保留，记作一次失败
  if (!(await verifyPassword(password, row.passwordHash))) {
    throw new AppError('reauth_failed', '当前密码错误', { docs: '/references/errors.md#reauth_failed' });
  }
  await releaseCounters(env, [counter]);
}
