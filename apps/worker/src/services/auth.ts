import type {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  SessionUser,
} from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { bumpCounter, minuteWindow, readCounter } from './rate-counter.js';
import { signToken } from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { hashRecoveryCode, verifyTotp } from '../lib/totp.js';
import type { AuthUser, Env, ExecCtx } from '../types.js';
import { avatarUrl } from './avatar.js';
import { getSystemFromAddress } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { getUserEpoch, bumpUserEpoch, createSession, destroySession } from './session.js';
import { getSettings } from './setting.js';

const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;
const REGISTER_WINDOW_SECONDS = 60 * 60;
const MAX_REGISTER_PER_WINDOW = 10;

const LOGIN_FAIL_SCOPE = 'login-fail';
const REGISTER_SCOPE = 'reg';

/**
 * 登录失败计数的两个维度。
 *
 * 关键改动：用户名维度的 key 里**掺入了 IP**。原先按纯用户名锁定，攻击者对任意已知
 * 用户名（seed 出来的 admin 用户名基本可猜）每 15 分钟发 5 次错误密码，就能让该账号
 * 持续无法登录，受害者换 IP 也没用——这是一条定向 DoS。掺 IP 后攻击者只能锁住自己，
 * 而防爆破仍由 IP 维度（同一 IP 对任意账号累计）兜住。
 */
async function loginSubjects(username: string, ip: string): Promise<string[]> {
  const [idHash, ipHash] = await Promise.all([
    sha256Hex(`id:${username.toLowerCase()}|${ip.toLowerCase()}`),
    sha256Hex(`ip:${ip.toLowerCase()}`),
  ]);
  return [`u:${idHash}`, `i:${ipHash}`];
}

function loginWindow(): number {
  return minuteWindow(LOGIN_WINDOW_SECONDS / 60);
}

async function assertLoginAllowed(env: Env, username: string, ip: string): Promise<void> {
  const window = loginWindow();
  const subjects = await loginSubjects(username, ip);
  const records = await Promise.all(
    subjects.map((s) => readCounter(env, LOGIN_FAIL_SCOPE, s, window)),
  );
  if (records.some((r) => r.count >= MAX_FAILURES)) {
    throw new AppError('rate_limited', '登录尝试过于频繁，请稍后再试');
  }
}

async function recordLoginFailure(env: Env, username: string, ip: string): Promise<void> {
  const window = loginWindow();
  const subjects = await loginSubjects(username, ip);
  await Promise.all(subjects.map((s) => bumpCounter(env, LOGIN_FAIL_SCOPE, s, window)));
}

async function resetLoginFailures(env: Env, username: string, ip: string): Promise<void> {
  const window = loginWindow();
  const subjects = await loginSubjects(username, ip);
  // 登录成功清零：置回 0 而不是删行（删行要额外一次查询，清理任务会按窗口回收）
  await Promise.all(
    subjects.map(async (s) => {
      const cur = await readCounter(env, LOGIN_FAIL_SCOPE, s, window);
      if (cur.count > 0) await bumpCounter(env, LOGIN_FAIL_SCOPE, s, window, -cur.count);
    }),
  );
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

async function issueToken(env: Env, userId: number): Promise<string> {
  const [sid, uepoch] = await Promise.all([
    createSession(env, userId),
    getUserEpoch(env, userId),
  ]);
  return signToken(env.jwt_secret, { sub: userId, sid, epoch: 0, uepoch });
}

export async function login(
  env: Env,
  req: LoginRequest,
  ip: string,
  ctx?: ExecCtx,
): Promise<LoginResponse> {
  await assertLoginAllowed(env, req.username, ip);
  const db = createDb(env);
  const user = await db.select().from(users).where(eq(users.username, req.username)).get();
  const valid = user ? await verifyPassword(req.password, user.passwordHash) : false;
  if (!user || !valid) {
    await recordLoginFailure(env, req.username, ip);
    throw new AppError('bad_credentials', '用户名或密码错误');
  }
  if (user.status !== 'active') throw new AppError('user_disabled', '账号已被禁用');

  try {
    await verifyLoginTwoFactor(env, user, req.totp);
  } catch (e) {
    // 验证码错误计入失败限流；仅「需要验证码」的提示不计
    if (e instanceof AppError && e.code === 'bad_credentials') {
      await recordLoginFailure(env, req.username, ip);
    }
    throw e;
  }

  await resetLoginFailures(env, req.username, ip);
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
          await sendFeishuNotification(prefs.feishu, {
            subject: `⚠ 账号 ${user.username} 新 IP 登录`,
            fromAddress: await getSystemFromAddress(env),
            fromName: 'HPC Mail',
            toAddress: user.username,
            code: '',
            body: `本次登录 IP：${ip}\n上次登录 IP：${previousIp}\n若非本人操作，请立即修改密码。`,
          });
        } catch (e) {
          console.error('新 IP 登录告警失败:', e);
        }
      })(),
    );
  }

  const token = await issueToken(env, user.id);
  return { token, user: toSessionUser(user) };
}

export async function register(env: Env, req: RegisterRequest, ip: string): Promise<LoginResponse> {
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
  const token = await issueToken(env, row!.id);
  return { token, user: toSessionUser(row!) };
}

export async function changePassword(
  env: Env,
  user: AuthUser,
  req: ChangePasswordRequest,
): Promise<LoginResponse> {
  const db = createDb(env);
  const row = await db.select().from(users).where(eq(users.id, user.id)).get();
  if (!row) throw new AppError('not_found', '用户不存在');
  if (!(await verifyPassword(req.oldPassword, row.passwordHash))) {
    throw new AppError('bad_credentials', '原密码错误');
  }
  const passwordHash = await hashPassword(req.newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  await bumpUserEpoch(env, user.id);
  // 旧会话全部失效，签发新 token 保持当前会话
  const token = await issueToken(env, user.id);
  return { token, user: toSessionUser(row) };
}

export async function logout(env: Env, sid: string): Promise<void> {
  await destroySession(env, sid);
}
