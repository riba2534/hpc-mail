import type { InternalSendMailRequest } from '@hpc-mail/shared';

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
