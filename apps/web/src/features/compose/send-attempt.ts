import type { InternalSendMailRequest } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

interface SendAttempt { key: string; payloadHash: string }
export const sendAttemptKeyForUser = (userId: number) => `hpc-compose-send-attempt:${userId}`;

/** Hash the validated request, including identity, recipients and attachment references. */
export async function hashSendPayload(payload: InternalSendMailRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readSendAttempt(userId: number): SendAttempt | null {
  try {
    const value = JSON.parse(localStorage.getItem(sendAttemptKeyForUser(userId)) ?? 'null') as SendAttempt | null;
    return value && typeof value.key === 'string' && value.key.length > 0
      && typeof value.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(value.payloadHash) ? value : null;
  } catch { return null; }
}

export function persistSendAttempt(userId: number, attempt: SendAttempt): boolean {
  try {
    const value = JSON.stringify(attempt);
    localStorage.setItem(sendAttemptKeyForUser(userId), value);
    return localStorage.getItem(sendAttemptKeyForUser(userId)) === value;
  } catch { return false; }
}

export function clearSendAttempt(userId: number, key: string | null): void {
  try {
    // A different tab may already have started another send; only clear this attempt.
    if (key && readSendAttempt(userId)?.key === key) localStorage.removeItem(sendAttemptKeyForUser(userId));
  } catch { /* current-page refs still provide a safe retry if storage is unavailable */ }
}

/**
 * 发送失败后如何处置幂等键：
 * - uncertain：请求可能已到达服务器并完成投递，只是响应没回来（网络、超时、5xx 等）。保留同一个 key，重试可安全重放结果；
 * - in_progress：服务器确认同一个 key 正在处理或结果待确认。保留 key，不自动重试，引导用户去已发送核对；
 * - key_mismatch：这个 key 已绑定其他内容，当前内容一定没有用它发出。换新 key，由用户再次发送；
 * - rejected：明确的业务错误，没有外发。换新 key，修正后再发。
 */
type SendFailure = 'uncertain' | 'in_progress' | 'key_mismatch' | 'rejected';
/** 发信引用的原邮件：回复线程头或转发附件的来源 */
export type SendSource = 'reply' | 'forward';

export function classifySendError(error: unknown): SendFailure {
  if (!(error instanceof ApiError)) return 'uncertain';
  if (error.code === 'send_in_progress') return 'in_progress';
  if (error.code === 'idempotency_mismatch') return 'key_mismatch';
  const uncertain = ['network', 'timeout', 'conflict', 'malformed', 'session_changed'].includes(error.code)
    || error.httpStatus === 408
    || (error.httpStatus !== null && error.httpStatus >= 500);
  return uncertain ? 'uncertain' : 'rejected';
}

/**
 * 发信引用的原邮件已删除或对发件人不可见（服务端 404 source_unavailable）。来源按请求里带的字段区分；
 * 服务端先校验转发附件再校验回复线程，两者都带时归到转发。
 */
export function missingSendSource(
  error: unknown,
  payload: Pick<InternalSendMailRequest, 'replyToMessageId' | 'forwardAttachmentsFrom'>,
): SendSource | null {
  if (!(error instanceof ApiError) || error.code !== 'source_unavailable') return null;
  if (payload.forwardAttachmentsFrom) return 'forward';
  if (payload.replyToMessageId) return 'reply';
  return null;
}
