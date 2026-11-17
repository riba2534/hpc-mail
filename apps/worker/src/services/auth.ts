import type {
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  SessionUser,
} from '@hpc-mail/shared';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import {
  bumpCounter, counterStatement, minuteWindow, readCounter, releaseCounters, reserveCounters, type CounterLimit,
} from './rate-counter.js';
import { signToken } from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { hashRecoveryCode, verifyTotp } from '../lib/totp.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import { revokeAllApiKeysQuery } from './api-key.js';
import { avatarUrl } from './avatar.js';
import { getSystemFromAddress } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { sendPushDeerNotification } from './pushdeer.js';
import { getUserEpoch, mirrorUserEpoch, createSession, destroySession } from './session.js';
import { getSettings } from './setting.js';

const LOGIN_WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;
const REGISTER_WINDOW_SECONDS = 60 * 60;
const MAX_REGISTER_PER_WINDOW = 10;

const LOGIN_FAIL_SCOPE = 'login-fail';
const REGISTER_SCOPE = 'reg';

/** IPv6 地址展开成 8 组数值（末尾点分 IPv4 折成两组）；不是合法 IPv6 时为 null */
function ipv6Groups(value: string): number[] | null {
  let text = value;
  const dotted = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const tail = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    text = `${text.slice(0, text.length - dotted[0].length)}${dotted[0].startsWith(':') ? ':' : ''}${tail}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * 计数用的 IP：IPv6 按 /64 聚合（一户通常分到整段 /64，按单个地址计数换个地址就绕过）；
 * IPv4 映射地址（::ffff:1.2.3.4，含十六进制写法 ::ffff:102:304）按 IPv4；::/64 里只有回环、未指定与
 * 已废弃的 IPv4 兼容地址，不属于哪一户，按完整地址各自成桶；无法解析的原样。
 */
export function ipBucket(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!value.includes(':')) return value;
  const groups = ipv6Groups(value);
  if (!groups) return value;
  const hex = (list: number[]) => list.map((group) => group.toString(16)).join(':');
  if (groups.slice(0, 4).every((group) => group === 0)) {
    if (groups[4] === 0 && groups[5] === 0xffff) {
      return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.');
    }
    return hex(groups);
  }
  return `${hex(groups.slice(0, 4))}::/64`;
}

interface LoginCounters {
  pair: CounterLimit;
  ip: CounterLimit;
}

/**
 * 登录失败计数的两个维度：(用户名|IP) 与 IP。
 *
 * 不按纯用户名计：攻击者对任意已知用户名（seed 出来的 admin 用户名基本可猜）换几个 IP 打满失败上限，
 * 就能让该账号连正确口令也登不上，受害者换 IP 也没用——限流在校验口令之前。掺 IP 后攻击者只能锁住自己，
 * 防爆破由 IP 维度（同一 IP 或同一 /64 对任意账号累计）兜住。
 */
async function loginCounters(username: string, ip: string): Promise<LoginCounters> {
  const window = minuteWindow(LOGIN_WINDOW_MINUTES);
  const bucket = ipBucket(ip);
  const [pairHash, ipHash] = await Promise.all([
    sha256Hex(`id:${username.toLowerCase()}|${bucket}`),
    sha256Hex(`ip:${bucket}`),
  ]);
  return {
    pair: { scope: LOGIN_FAIL_SCOPE, subject: `u:${pairHash}`, window, limit: MAX_FAILURES },
    ip: { scope: LOGIN_FAIL_SCOPE, subject: `i:${ipHash}`, window, limit: MAX_FAILURES },
  };
}

/** 登录限流按固定 15 分钟窗口计，到窗口结束还要等的秒数（Retry-After） */
export function loginRetryAfterSeconds(nowMs = Date.now()): number {
  const windowMs = LOGIN_WINDOW_MINUTES * 60_000;
  return Math.max(1, Math.ceil(((minuteWindow(LOGIN_WINDOW_MINUTES, nowMs) + 1) * windowMs - nowMs) / 1000));
}

/**
 * 先占一次失败名额再校验口令：两个维度各自守卫递增，任一已满就退回另一维度、直接拒绝。
 * 先读后写时并发请求都读到同一个旧计数，单个 IP 并发即可远超上限。
 */
async function reserveLoginAttempt(env: Env, username: string, ip: string): Promise<LoginCounters> {
  const counters = await loginCounters(username, ip);
  const [pairFull, ipFull] = await reserveCounters(env, [counters.pair, counters.ip]);
  if (pairFull || ipFull) throw new AppError('rate_limited', '登录尝试过于频繁，请稍后再试');
  return counters;
}

/** 与猜口令无关的失败退回本次占位；退回失败只记日志，不盖掉原本的错误 */
async function releaseLoginAttempt(env: Env, counters: LoginCounters): Promise<void> {
  try {
    await releaseCounters(env, [counters.pair, counters.ip]);
  } catch (error) {
    console.error('登录占位退回失败:', error);
  }
}

/**
 * 登录成功：(用户名|IP) 维度清零，IP 维度只退回本次占位——之前的失败照算，
 * 否则用自己的账号登录一次就能清空 IP 维度，再对其他用户名继续猜。
 */
async function settleLoginSuccess(env: Env, counters: LoginCounters): Promise<void> {
  const { pair, ip } = counters;
  await env.db.batch([
    // 置回 0 而不是删行（清理任务会按窗口回收）
    env.db.prepare('UPDATE rate_counters SET count = 0 WHERE scope = ? AND subject = ? AND "window" = ?')
      .bind(pair.scope, pair.subject, pair.window),
    counterStatement(env, ip.scope, ip.subject, ip.window, -1),
  ]);
}

/** 注册按 IP 限流：每 IP 每小时上限（含失败尝试），堵开放模式灌号与邀请码暴力猜测 */
async function assertRegisterAllowed(env: Env, ip: string): Promise<void> {
  const subject = await sha256Hex(ip.toLowerCase());
  const window = minuteWindow(REGISTER_WINDOW_SECONDS / 60);
  const cur = await readCounter(env, REGISTER_SCOPE, subject, window);
  if (cur.count >= MAX_REGISTER_PER_WINDOW) {
    throw new AppError('rate_limited', '注册尝试过于频繁，请稍后再试');
  }
}

async function recordRegisterAttempt(env: Env, ip: string): Promise<void> {
  const subject = await sha256Hex(ip.toLowerCase());
  await bumpCounter(env, REGISTER_SCOPE, subject, minuteWindow(REGISTER_WINDOW_SECONDS / 60));
}

function toSessionUser(row: typeof users.$inferSelect): SessionUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    avatarUrl: avatarUrl(row.id, row.avatarKey),
    twoFactorEnabled: !!row.totpEnabledAt,
  };
}

/**
 * 登录时校验两步验证：TOTP 或恢复码（恢复码用后即弃）。
 * 未提供码但已启用 → 抛 totp_required 让前端追加输入。
 */
async function verifyLoginTwoFactor(
  env: Env,
  user: typeof users.$inferSelect,
  totp: string | undefined,
): Promise<void> {
  if (!user.totpEnabledAt) return;
  if (!totp) throw new AppError('totp_required', '需要两步验证码');
  const cleaned = totp.replace(/\s/g, '');
  if (user.totpSecret && (await verifyTotp(user.totpSecret, cleaned))) return;
  // 尝试恢复码（用后从列表移除）
  const codes = user.totpRecoveryCodes ?? [];
  if (codes.length) {
    const hash = await hashRecoveryCode(cleaned.toLowerCase());
    if (codes.includes(hash)) {
      const db = createDb(env);
      const result = await db
        .update(users)
        .set({ totpRecoveryCodes: codes.filter((c) => c !== hash) })
        .where(and(eq(users.id, user.id), eq(users.totpRecoveryCodes, codes)))
        .run();
      // 带旧 JSON 条件的单条 UPDATE：两个并发请求只有一个能消费同一恢复码。
      if ((result.meta.changes ?? 0) === 1) return;
    }
  }
  throw new AppError('bad_credentials', '两步验证码错误');
}

/** 签发会话令牌；ctx 用于把会话 KV 兼容写放进 waitUntil，不阻塞响应 */
async function issueToken(env: Env, user: typeof users.$inferSelect, ctx?: ExecCtx | null): Promise<string> {
  const sid = await createSession(env, user.id, user, ctx);
  return signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: user.authVersion });
}

export async function login(
  env: Env,
  req: LoginRequest,
  ip: string,
  ctx?: ExecCtx | null,
): Promise<LoginResponse> {
  const counters = await reserveLoginAttempt(env, req.username, ip);
  const db = createDb(env);
  let user: typeof users.$inferSelect | undefined;
  let token: string;
  let issuing = false;
  try {
    user = await db.select().from(users).where(eq(users.username, req.username)).get();
    if (user && !user.authVersionMigrated) {
      await getUserEpoch(env, user.id);
      user = await db.select().from(users).where(eq(users.id, user.id)).get();
    }
    const valid = user ? await verifyPassword(req.password, user.passwordHash) : false;
    if (!user || !valid) throw new AppError('bad_credentials', '用户名或密码错误');
    if (user.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');
    await verifyLoginTwoFactor(env, user, req.totp);
    issuing = true;
    token = await issueToken(env, user, ctx);
  } catch (error) {
    // 猜错口令或两步验证码记作一次失败、占位保留：口令已对时只剩 6 位验证码要猜，同样靠这里的上限防爆破。
    // 停用、需要验证码、读库或签发异常（含签发时凭据恰好被改）与猜测无关，退回本次占位
    const wrongGuess = !issuing && error instanceof AppError && error.code === 'bad_credentials';
    if (!wrongGuess) await releaseLoginAttempt(env, counters);
    throw error;
  }
  await settleLoginSuccess(env, counters);
  const previousIp = user.lastLoginIp;
  await db
    .update(users)
    .set({ lastLoginAt: new Date(), lastLoginIp: ip })
    .where(eq(users.id, user.id));

  // 新 IP 登录飞书告警：与上次登录 IP 不同则异步推送（走登录用户自己的个人飞书，不阻塞登录）
  if (ctx && previousIp && previousIp !== ip) {
    ctx.waitUntil(
      (async () => {
        try {
          const prefs = await getUserNotifyPrefs(env, user.id);
          const systemFrom = await getSystemFromAddress(env);
          try {
            await sendFeishuNotification(prefs.feishu, {
              subject: `⚠ 账号 ${user.username} 新 IP 登录`,
              fromAddress: systemFrom,
              fromName: 'HPC Mail',
              toAddress: user.username,
              code: '',
              body: `本次登录 IP：${ip}\n上次登录 IP：${previousIp}\n若非本人操作，请立即修改密码。`,
            });
          } catch (e) {
            console.error('新 IP 登录飞书告警失败:', e);
          }
          try {
            await sendPushDeerNotification(prefs.pushdeer, {
              subject: `⚠ 账号 ${user.username} 新 IP 登录`,
              fromAddress: systemFrom,
              fromName: 'HPC Mail',
              toAddress: user.username,
              code: '',
              body: `本次登录 IP：${ip}\n上次登录 IP：${previousIp}\n若非本人操作，请立即修改密码。`,
            });
          } catch (e) {
            console.error('新 IP 登录 PushDeer 告警失败:', e);
          }
        } catch (e) {
          console.error('新 IP 登录告警异常:', e);
        }
      })(),
    );
  }

  return { token, user: toSessionUser(user) };
}

export async function register(env: Env, req: RegisterRequest, ip: string, ctx?: ExecCtx | null): Promise<LoginResponse> {
  await assertRegisterAllowed(env, ip);
  await recordRegisterAttempt(env, ip);
  const settings = await getSettings(env);
  const mode = settings.register_mode;
  if (mode === 'closed') throw new AppError('registration_closed', '注册已关闭');

  const db = createDb(env);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, req.username)).get();
  if (existing) throw new AppError('conflict', '用户名已存在');

  const passwordHash = await hashPassword(req.password);
  let row: typeof users.$inferSelect | undefined;
  if (mode === 'invite') {
    if (!req.inviteCode) throw new AppError('invite_invalid', '需要邀请码');
    try {
      // INSERT ... SELECT 与迁移中的 AFTER INSERT trigger 处于同一 SQLite 写事务：
      // 只有仍可用的邀请码能建户，建户失败也不会消耗次数。
      const inserted = await env.db
        .prepare(
          `INSERT INTO users
            (username, password_hash, role, status, invite_id, last_login_at, last_login_ip)
           SELECT ?, ?, 'user', 'active', id, ?, ?
           FROM invites
           WHERE code = ? AND status = 'active' AND used_count < max_uses
             AND (expires_at IS NULL OR expires_at > ?)
           RETURNING id`,
        )
        .bind(req.username, passwordHash, Date.now(), ip, req.inviteCode, Date.now())
        .first<{ id: number }>();
      if (!inserted) throw new AppError('invite_invalid', '邀请码无效或已用尽');
      row = await db.select().from(users).where(eq(users.id, inserted.id)).get();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed: users.username')) {
        throw new AppError('conflict', '用户名已存在');
      }
      if (message.includes('invite_invalid')) {
        throw new AppError('invite_invalid', '邀请码无效或已用尽');
      }
      throw error;
    }
  } else {
    [row] = await db
      .insert(users)
      .values({
        username: req.username,
        passwordHash,
        role: 'user',
        status: 'active',
        inviteId: null,
        lastLoginAt: new Date(),
        lastLoginIp: ip,
      })
      .returning();
  }
  if (!row) throw new AppError('internal', '用户创建失败');
  const token = await issueToken(env, row!, ctx);
  return { token, user: toSessionUser(row!) };
}

/**
 * 改密并递增鉴权版本踢掉其他会话。revokeApiKeys（未传按 true）时同一 batch 事务里吊销本人全部 API Key：
 * 账号可能已泄露，旧 Key 不比较鉴权版本，不吊销就会在改密后继续有效。
 */
export async function changePassword(
  env: Env,
  user: AuthUser,
  req: ChangePasswordRequest,
  ctx?: ExecCtx | null,
): Promise<ChangePasswordResponse> {
  const db = createDb(env);
  const row = await db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) throw new AppError('not_found', '用户不存在');
  if (!(await verifyPassword(req.oldPassword, row.passwordHash))) {
    throw new AppError('bad_credentials', '原密码错误');
  }
  const passwordHash = await hashPassword(req.newPassword);
  const update = db.update(users).set({ passwordHash,
    authVersion: sql`${users.authVersion} + 1`, authVersionMigrated: true })
    .where(and(eq(users.id, user.id), eq(users.passwordHash, row.passwordHash), eq(users.authVersion, row.authVersion)))
    .returning();
  let updated: typeof users.$inferSelect | undefined;
  let revokedApiKeys = 0;
  if (req.revokeApiKeys !== false) {
    const [rows, revoked] = await db.batch([update, revokeAllApiKeysQuery(db, user.id, passwordHash)]);
    updated = rows[0];
    revokedApiKeys = revoked.length;
  } else {
    updated = await update.get();
  }
  if (!updated) throw new AppError('conflict', '密码已在另一请求中修改，请重新登录');
  await mirrorUserEpoch(env, user.id, updated.authVersion, ctx);
  const token = await issueToken(env, updated, ctx);
  return { token, user: toSessionUser(updated), revokedApiKeys };
}

export async function logout(env: Env, sid: string, ctx?: ExecCtx | null): Promise<void> {
  await destroySession(env, sid, ctx);
}
