import { AppError } from '../lib/errors.js';
import { verifyPassword } from '../lib/password.js';
import type { Env } from '../types.js';
import { counterResult, minuteWindow, releaseCounters, reserveStatement, type CounterLimit } from './rate-counter.js';

/**
 * 重新验证密码的失败计数：按会话、15 分钟窗口。按会话而不是按用户计：拿到失窃会话的人只能用完自己会话的额度，
 * 锁不住受害者在其他会话里改密、开关两步验证（这些是自助踢掉攻击者的手段）；新会话只能凭密码登录产生，
 * 每个失窃会话的猜测次数仍然有上限
 */
export const REAUTH_FAIL_SCOPE = 'reauth-fail';
const REAUTH_WINDOW_MINUTES = 15;
export const MAX_REAUTH_FAILURES = 5;

/** 发起重新验证的会话：密码按 userId 校验，失败按 sessionId 计数 */
export interface ReauthActor {
  userId: number;
  sessionId: string;
}

/** 重新验证通过后返回的账号信息（两步验证开关用，免再读一次用户行） */
export interface ReauthUser {
  username: string;
  totpEnabled: boolean;
}

/**
 * 带失败节流的密码校验：缺少 password 返回 403 reauth_required，密码错误返回 403 reauth_failed（不用 401：网页客户端遇到 401
 * 会清掉会话）。每个会话 15 分钟内最多失败 MAX_REAUTH_FAILURES 次，先占位再校验，并发请求也超不过；超过返回 429。
 * 占位与读用户行（columns 须含 password_hash）同一个 batch；校验失败时占位保留，记作一次失败；
 * 通过后返回用户行与退回占位的函数，调用方可以把退回与自己的写入并行。
 */
async function checkPassword<T extends { password_hash: string }>(
  env: Env, actor: ReauthActor, password: string | null | undefined, columns: string,
): Promise<{ row: T; release: () => Promise<void> }> {
  if (!password) {
    throw new AppError('reauth_required', '该操作需要输入当前密码', {
      fix: '在请求体里带上当前登录密码 password 后重试',
      docs: '/references/errors.md#reauth_required',
    });
  }
  const counter: CounterLimit = {
    scope: REAUTH_FAIL_SCOPE, subject: actor.sessionId, window: minuteWindow(REAUTH_WINDOW_MINUTES), limit: MAX_REAUTH_FAILURES,
  };
  const [reserved, user] = await env.db.batch([
    reserveStatement(env, counter),
    env.db.prepare(`SELECT ${columns} FROM users WHERE id = ?`).bind(actor.userId),
  ]);
  if (!counterResult(reserved)) throw new AppError('rate_limited', '密码验证失败次数过多，请 15 分钟后再试');
  const row = user?.results?.[0] as T | undefined;
  const release = () => releaseCounters(env, [counter]);
  if (!row) {
    await release();
    throw new AppError('unauthorized', '用户不存在');
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new AppError('reauth_failed', '当前密码错误', { docs: '/references/errors.md#reauth_failed' });
  }
  return { row, release };
}

/**
 * 敏感操作（创建 API Key、新增转发目标、开关两步验证）前重新验证当前密码，只用于网页会话（JWT）路径。
 * 拿到会话令牌的人因此不能借这些接口爆破原密码。验证通过时退回本次占位。
 */
export async function verifyReauthPassword(env: Env, actor: ReauthActor, password: string | null | undefined): Promise<ReauthUser> {
  const { row, release } = await checkPassword<{ username: string; password_hash: string; totp_enabled_at: number | null }>(
    env, actor, password, 'username, password_hash, totp_enabled_at');
  await release();
  return { username: row.username, totpEnabled: row.totp_enabled_at !== null };
}

/**
 * 改密的原密码校验：与 verifyReauthPassword 同一个失败计数与错误口径，改密接口不能用来绕过节流爆破原密码。
 * 返回改密写入需要的旧哈希与凭据版本；占位的退回交给调用方，与改密写入并行，不多一次串行往返
 */
export async function verifyOldPassword(env: Env, actor: ReauthActor, password: string): Promise<{
  passwordHash: string; authVersion: number; release: () => Promise<void>;
}> {
  const { row, release } = await checkPassword<{ password_hash: string; auth_version: number }>(env, actor, password, 'password_hash, auth_version');
  return { passwordHash: row.password_hash, authVersion: Number(row.auth_version), release };
}
