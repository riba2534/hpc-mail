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
import { getUserNotifyPrefs, updateUserNotifyPrefs } from './notify-prefs.js';
import { bumpCounter, dayWindow } from './rate-counter.js';
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
 * 不在列表里的待确认记录一并撤销。新增目标或把转发从关改为开时先重新验证当前密码。
 * 升级前已配置的目标视为已确认。
 */
export async function updatePrefsWithForwardConfirmation(
  env: Env,
  user: { id: number; username: string },
  patch: UpdateNotifyPrefsRequest,
  origin: string,
): Promise<{ prefs: UserNotifyPrefs; pending: ForwardPendingTarget[] }> {
  if (!patch.forward) {
    return { prefs: await updateUserNotifyPrefs(env, user.id, patch), pending: await listPendingForwards(env, user.id) };
  }
  const current = await getUserNotifyPrefs(env, user.id);
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
  // 要发新确认信，或把转发从关改为开时重新验证密码；只是保留已在等待确认的地址不需要
  if (toSend.length || (patch.forward.enabled && !current.forward.enabled)) {
    await verifyReauthPassword(env, user.id, patch.password);
  }
  if (toSend.length) {
    const window = dayWindow();
    const counted = await bumpCounter(env, FORWARD_CONFIRM_SCOPE, String(user.id), window, toSend.length);
    if (counted.count > MAX_FORWARD_CONFIRM_MAILS_PER_DAY) {
      await bumpCounter(env, FORWARD_CONFIRM_SCOPE, String(user.id), window, -toSend.length);
      throw new AppError('rate_limited', `每天最多发送 ${MAX_FORWARD_CONFIRM_MAILS_PER_DAY} 封转发确认邮件，请明天再试`);
    }
  }

  const base = origin.replace(/\/+$/, '');
  for (const address of toSend) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = bytesToHex(bytes);
    await env.db.prepare(`INSERT INTO forward_confirmations (user_id, address, token_hash, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, address) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at`)
      .bind(user.id, address, await sha256Hex(token), now + TTL_MS).run();
    try {
      await sendSystemMail(env, confirmationMail(user.username, address, `${base}/forward/confirm#token=${token}`));
    } catch (error) {
      await env.db.prepare('DELETE FROM forward_confirmations WHERE user_id = ? AND address = ?').bind(user.id, address).run();
      if (error instanceof AppError) throw error;
      console.error('转发确认邮件发送失败:', error instanceof Error ? error.message : error);
      throw new AppError('internal', `确认邮件发送到 ${address} 失败，请稍后重试`);
    }
  }

  // 撤销不在期望列表里的待确认记录（已确认的目标不会有待确认记录）
  const dropped = existing.map((row) => row.address).filter((address) => !added.includes(address));
  if (dropped.length) {
    await env.db.prepare(`DELETE FROM forward_confirmations WHERE user_id = ? AND address IN (SELECT value FROM json_each(?))`)
      .bind(user.id, JSON.stringify(dropped)).run();
  }
  const prefs = await updateUserNotifyPrefs(env, user.id, { ...patch, forward: { enabled: patch.forward.enabled, addresses: keep } },
    { allowEmptyForward: added.length > 0 });
  return { prefs, pending: await listPendingForwards(env, user.id) };
}

/**
 * 目标邮箱的主人确认接收转发（公开接口，凭确认信里的一次性 token）：把地址加进用户已确认的转发目标。
 * 偏好按原始 JSON 做条件写入，与用户同时修改偏好竞争时重读重试；写入与删除确认记录在同一事务。
 */
export async function confirmForward(env: Env, token: string): Promise<ConfirmForwardResult> {
  const hash = await sha256Hex(token.trim());
  const row = await env.db.prepare('SELECT id, user_id, address, expires_at FROM forward_confirmations WHERE token_hash = ?')
    .bind(hash).first<{ id: number; user_id: number; address: string; expires_at: number }>();
  if (!row || Number(row.expires_at) <= Date.now()) throw new AppError('not_found', '确认链接无效或已过期');
  const userId = Number(row.user_id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await env.db.prepare('SELECT notify_prefs FROM users WHERE id = ?').bind(userId).first<{ notify_prefs: string | null }>();
    if (!raw) {
      await env.db.prepare('DELETE FROM forward_confirmations WHERE id = ?').bind(row.id).run();
      throw new AppError('not_found', '确认链接无效或已过期');
    }
    const prefs = await getUserNotifyPrefs(env, userId);
    if (!prefs.forward.addresses.map(normalizeEmail).includes(row.address)) {
      if (prefs.forward.addresses.length >= MAX_FORWARD_TARGETS) throw new AppError('conflict', `转发目标已达 ${MAX_FORWARD_TARGETS} 个上限`);
      prefs.forward.addresses.push(row.address);
    }
    const next = JSON.stringify(prefs);
    const [updated] = await env.db.batch([
      env.db.prepare('UPDATE users SET notify_prefs = ? WHERE id = ? AND notify_prefs IS ?').bind(next, userId, raw.notify_prefs),
      env.db.prepare(`DELETE FROM forward_confirmations WHERE id = ? AND token_hash = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ? AND notify_prefs = ?)`).bind(row.id, hash, userId, next),
    ]);
    if ((updated?.meta.changes ?? 0) === 1) return { address: row.address };
  }
  throw new AppError('conflict', '偏好正在被修改，请稍后重试');
}
