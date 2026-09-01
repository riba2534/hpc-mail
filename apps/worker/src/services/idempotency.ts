import type { MessageSummary } from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { idempotencyRecords } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';

export type IdempotencyActor = { type: 'user' | 'api_key'; id: number };

export interface IdempotencyHandle {
  actor: IdempotencyActor;
  key: string;
  requestHash: string;
}

export type IdempotencyStart =
  | { kind: 'owner'; handle: IdempotencyHandle | null }
  | { kind: 'replay'; response: MessageSummary };

function normalizeKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError('validation_failed', 'Idempotency-Key 必须是 1-128 位可见 ASCII 字符');
  }
  return key;
}

/** 原子占用幂等键。pending/failed 均不自动重发，避免外部副作用结果不明时重复投递。 */
export async function beginIdempotentSend(
  env: Env,
  actor: IdempotencyActor,
  rawKey: string | undefined,
  request: unknown,
): Promise<IdempotencyStart> {
  const key = normalizeKey(rawKey);
  if (!key) return { kind: 'owner', handle: null };
  const requestHash = await sha256Hex(JSON.stringify(request));
  const db = createDb(env);
  const now = new Date();
  const inserted = await db
    .insert(idempotencyRecords)
    .values({
      actorType: actor.type,
      actorId: actor.id,
      key,
      requestHash,
      status: 'pending',
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyRecords.key })
    .get();
  const handle = { actor, key, requestHash } satisfies IdempotencyHandle;
  if (inserted) return { kind: 'owner', handle };

  const existing = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.actorType, actor.type),
        eq(idempotencyRecords.actorId, actor.id),
        eq(idempotencyRecords.key, key),
      ),
    )
    .get();
  if (!existing) throw new AppError('conflict', '幂等状态暂不可用，请稍后查询发送结果');
  if (existing.requestHash !== requestHash) {
    throw new AppError('conflict', '相同 Idempotency-Key 不能用于不同的发信内容');
  }
  if (existing.status === 'completed' && existing.responseJson) {
    try {
      return { kind: 'replay', response: JSON.parse(existing.responseJson) as MessageSummary };
    } catch {
      throw new AppError('conflict', '原发送已完成，但缓存结果损坏，请查询已发送邮件');
    }
  }
  if (existing.status === 'failed') {
    throw new AppError('conflict', existing.errorDetail || '该幂等请求此前已失败，请使用新的 Idempotency-Key');
  }
  throw new AppError('conflict', '该发信请求正在处理或结果待确认，请勿重复提交');
}

export async function completeIdempotentSend(
  env: Env,
  handle: IdempotencyHandle | null,
  response: MessageSummary,
): Promise<void> {
  if (!handle) return;
  const db = createDb(env);
  await db
    .update(idempotencyRecords)
    .set({ status: 'completed', responseJson: JSON.stringify(response), errorDetail: '', updatedAt: new Date() })
    .where(
      and(
        eq(idempotencyRecords.actorType, handle.actor.type),
        eq(idempotencyRecords.actorId, handle.actor.id),
        eq(idempotencyRecords.key, handle.key),
        eq(idempotencyRecords.requestHash, handle.requestHash),
        eq(idempotencyRecords.status, 'pending'),
      ),
    );
}

export async function failIdempotentSend(
  env: Env,
  handle: IdempotencyHandle | null,
  error: unknown,
): Promise<void> {
  if (!handle) return;
  const detail = error instanceof Error ? error.message : String(error);
  const db = createDb(env);
  await db
    .update(idempotencyRecords)
    .set({ status: 'failed', errorDetail: detail.slice(0, 2000), updatedAt: new Date() })
    .where(
      and(
        eq(idempotencyRecords.actorType, handle.actor.type),
        eq(idempotencyRecords.actorId, handle.actor.id),
        eq(idempotencyRecords.key, handle.key),
        eq(idempotencyRecords.requestHash, handle.requestHash),
        eq(idempotencyRecords.status, 'pending'),
      ),
    );
}
