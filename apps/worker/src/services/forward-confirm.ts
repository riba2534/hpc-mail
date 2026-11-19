import {
  FORWARD_CONFIRM_TTL_HOURS,
  MAX_FORWARD_CONFIRM_MAILS_PER_DAY,
  type ConfirmForwardResult,
  type ForwardPendingTarget,
  type UpdateNotifyPrefsRequest,
  type UserNotifyPrefs,
} from '@hpc-mail/shared';
import { bytesToHex, sha256Hex } from '../lib/crypto.js';
import { normalizeEmail } from '../lib/email-address.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { getUserNotifyPrefs, readNotifyPrefsSnapshot, updateUserNotifyPrefs } from './notify-prefs.js';
import { counterResult, counterStatement, counterWithinGuard, dayWindow } from './rate-counter.js';
import { verifyReauthPassword } from './reauth.js';
import { sendSystemMail } from './system-mail.js';

/** 每用户每天的确认信计数（scheduled 的按天计数器回收已登记） */
export const FORWARD_CONFIRM_SCOPE = 'fwd-confirm';
const TTL_MS = FORWARD_CONFIRM_TTL_HOURS * 3_600_000;
const MAX_FORWARD_TARGETS = 5;

/** 仍在有效期内、等待目标邮箱确认的转发地址 */
export async function listPendingForwards(env: Env, userId: number): Promise<ForwardPendingTarget[]> {
  const { results } = await env.db.prepare(`SELECT address, expires_at FROM forward_confirmations
    WHERE user_id = ? AND expires_at > ? ORDER BY id`).bind(userId, Date.now()).all<{ address: string; expires_at: number }>();
  return results.map((row) => ({ address: row.address, expiresAt: new Date(Number(row.expires_at)).toISOString() }));
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function confirmationMail(username: string, address: string, link: string) {
  const intro = `HPC Mail 用户 ${username} 请求把其邮箱收到的邮件转发到 ${address}。`;
  const ignore = '如果你不认识这个请求，忽略本邮件即可，不会有任何邮件转发给你。';
  return {
    to: address,
    subject: '确认接收 HPC Mail 的邮件转发',
    text: `${intro}\n\n同意的话，请在 ${FORWARD_CONFIRM_TTL_HOURS} 小时内打开下面的链接并点击确认：\n${link}\n\n${ignore}\n`,
    html: `<p>${escapeHtml(intro)}</p><p>同意的话，请在 ${FORWARD_CONFIRM_TTL_HOURS} 小时内打开下面的链接并点击确认：</p>`
      + `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p style="color:#666">${escapeHtml(ignore)}</p>`,
  };
}

/**
 * 网页会话修改个人偏好（含转发）。forward.addresses 是期望的目标列表：已确认的（当前 forward.addresses 里的）保留；
 * 新增的先不生效，记入 forward_confirmations 并向该地址发确认信，目标邮箱的主人确认后才加入；
 * 不在列表里的待确认记录一并撤销。新增目标、启用转发或扩大转发内容时重新验证当前密码。
 * 升级前已配置的目标视为已确认。
 */
export async function updatePrefsWithForwardConfirmation(
  env: Env,
  user: { id: number; username: string },
  patch: UpdateNotifyPrefsRequest,
  origin: string,
  /** 发起修改的会话：重新验证密码的失败按会话计数 */
  sessionId: string,
): Promise<{ prefs: UserNotifyPrefs; pending: ForwardPendingTarget[] }> {
  if (!patch.forward) {
    const [prefs, pending] = await Promise.all([updateUserNotifyPrefs(env, user.id, patch), listPendingForwards(env, user.id)]);
    return { prefs, pending };
  }
  const snapshot = await readNotifyPrefsSnapshot(env, user.id);
  if (!snapshot) throw new AppError('not_found', '用户不存在');
  const current = snapshot.prefs;
  const confirmed = new Set(current.forward.addresses.map(normalizeEmail));
  const desired = [...new Set(patch.forward.addresses.map(normalizeEmail).filter(Boolean))];
  const keep = desired.filter((address) => confirmed.has(address));
  const added = desired.filter((address) => !confirmed.has(address));
  const now = Date.now();
  const { results: existing } = await env.db.prepare('SELECT address, expires_at FROM forward_confirmations WHERE user_id = ?')
    .bind(user.id).all<{ address: string; expires_at: number }>();
  const stillPending = new Set(existing.filter((row) => Number(row.expires_at) > now).map((row) => row.address));
  // 已在等待确认且未过期的不重发；过期或新加的重新生成 token 并发信
  const toSend = added.filter((address) => !stillPending.has(address));
  const contentMode = patch.forward.contentMode ?? current.forward.contentMode;
  const expandsContent = current.forward.contentMode === 'notice' && contentMode === 'protected';
  if (toSend.length || (patch.forward.enabled && (!current.forward.enabled || expandsContent))) {
    await verifyReauthPassword(env, { userId: user.id, sessionId }, patch.password);
  }
  if (toSend.length) {
    // 加上本次不超过每日上限才计数，超限的请求不推高计数
    const subject = String(user.id);
    const window = dayWindow();
    const counted = await counterStatement(env, FORWARD_CONFIRM_SCOPE, subject, window, toSend.length, 0,
      counterWithinGuard(FORWARD_CONFIRM_SCOPE, subject, window, MAX_FORWARD_CONFIRM_MAILS_PER_DAY - toSend.length)).all();
    if (!counterResult(counted)) {
      throw new AppError('rate_limited', `每天最多发送 ${MAX_FORWARD_CONFIRM_MAILS_PER_DAY} 封转发确认邮件，请明天再试`);
    }
  }

  // 保存经过密码验证的模式后才允许发出新确认链接。旧会话写入发生冲突时不产生可确认的外部目标。
  const prefs = await updateUserNotifyPrefs(
    env, user.id, { ...patch, forward: { ...patch.forward, contentMode, addresses: keep } },
    { allowEmptyForward: added.length > 0, snapshot },
  );
  const saved = JSON.stringify(prefs);
  const guard = "EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active' AND notify_prefs = ?)";
  const dropped = existing.map((row) => row.address).filter((address) => !added.includes(address));
  if (dropped.length) {
    await env.db.prepare('DELETE FROM forward_confirmations WHERE user_id = ? AND address IN (SELECT value FROM json_each(?)) AND ' + guard)
      .bind(user.id, JSON.stringify(dropped), user.id, saved).run();
  }

  const base = origin.replace(/\/+$/, '');
  for (const address of toSend) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = bytesToHex(bytes);
    const hash = await sha256Hex(token);
    const pending = await env.db.prepare(
      'INSERT INTO forward_confirmations (user_id, address, token_hash, expires_at) SELECT ?, ?, ?, ? WHERE ' + guard
      + ' ON CONFLICT(user_id, address) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at RETURNING id',
    ).bind(user.id, address, hash, now + TTL_MS, user.id, saved).first<{ id: number }>();
    if (!pending) throw new AppError('conflict', '通知偏好已变化，请刷新后重试');
    try {
      await sendSystemMail(env, confirmationMail(user.username, address, base + '/forward/confirm#token=' + token));
    } catch (error) {
      await env.db.prepare('DELETE FROM forward_confirmations WHERE id = ? AND token_hash = ?').bind(pending.id, hash).run();
      if (error instanceof AppError) throw error;
      console.error('转发确认邮件发送失败');
      throw new AppError('internal', '发送转发确认邮件失败，请稍后重试');
    }
  }
  return { prefs, pending: await listPendingForwards(env, user.id) };
}

/**
 * 目标邮箱的主人确认接收转发（公开接口，凭确认信里的一次性 token）：把地址加进用户已确认的转发目标。
 * 偏好按原始 JSON 做条件写入，与用户同时修改偏好竞争时重读重试；写入与删除确认记录在同一事务。
 * 写入还要求这条待确认记录仍在且未过期：用户撤销（删除待确认记录）与对方点击确认同时发生时，
 * 撤销先落库则确认失败，不会把已撤销的地址写回已确认的转发目标。
 */
export async function confirmForward(env: Env, token: string): Promise<ConfirmForwardResult> {
  const hash = await sha256Hex(token.trim());
  const invalid = () => new AppError('not_found', '确认链接无效或已过期');
  for (let attempt = 0; attempt < 3; attempt++) {
    // 每轮重读待确认记录与原始偏好（同一往返）：重试时记录已被撤销就按无效链接处理
    const [found, current] = await env.db.batch([
      env.db.prepare('SELECT id, user_id, address, expires_at FROM forward_confirmations WHERE token_hash = ?').bind(hash),
      env.db.prepare('SELECT notify_prefs FROM users WHERE id = (SELECT user_id FROM forward_confirmations WHERE token_hash = ?)').bind(hash),
    ]);
    const row = found?.results?.[0] as { id: number; user_id: number; address: string; expires_at: number } | undefined;
    if (!row || Number(row.expires_at) <= Date.now()) throw invalid();
    const userId = Number(row.user_id);
    const raw = current?.results?.[0] as { notify_prefs: string | null } | undefined;
    if (!raw) {
      await env.db.prepare('DELETE FROM forward_confirmations WHERE id = ?').bind(row.id).run();
      throw invalid();
    }
    const prefs = await getUserNotifyPrefs(env, userId);
    if (!prefs.forward.addresses.map(normalizeEmail).includes(row.address)) {
      if (prefs.forward.addresses.length >= MAX_FORWARD_TARGETS) throw new AppError('conflict', `转发目标已达 ${MAX_FORWARD_TARGETS} 个上限`);
      prefs.forward.addresses.push(row.address);
    }
    const next = JSON.stringify(prefs);
    const [updated] = await env.db.batch([
      env.db.prepare(`UPDATE users SET notify_prefs = ? WHERE id = ? AND notify_prefs IS ?
        AND EXISTS (SELECT 1 FROM forward_confirmations WHERE id = ? AND token_hash = ? AND expires_at > ?)`)
        .bind(next, userId, raw.notify_prefs, row.id, hash, Date.now()),
      env.db.prepare(`DELETE FROM forward_confirmations WHERE id = ? AND token_hash = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND notify_prefs = ?)`).bind(row.id, hash, userId, next),
    ]);
    if ((updated?.meta.changes ?? 0) === 1) return { address: row.address };
  }
  throw new AppError('conflict', '偏好正在被修改，请稍后重试');
}
