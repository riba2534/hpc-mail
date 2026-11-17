import type { MessageSummary } from '@hpc-mail/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { idempotencyRecords, messages, attachments } from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { summarize } from './message.js';
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

function keyOf(actor: IdempotencyActor, key: string) {
  return and(eq(idempotencyRecords.actorType, actor.type), eq(idempotencyRecords.actorId, actor.id), eq(idempotencyRecords.key, key));
}

function recordOf(handle: IdempotencyHandle) {
  return and(keyOf(handle.actor, handle.key), eq(idempotencyRecords.requestHash, handle.requestHash));
}

/**
 * 原子占用幂等键。pending 与已绑定发件行的记录不自动重发，避免外部副作用结果不明时重复投递；
 * failed 且未绑定发件行的记录一定没有外发，同内容重试时原子收回继续发送。
 */
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
  const handle = { actor, key, requestHash } satisfies IdempotencyHandle;
  // 冲突后记录可能恰好被删除（外发前 4xx 的请求会删掉自己的记录），再试一次插入
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await db
      .insert(idempotencyRecords)
      .values({
        actorType: actor.type,
        actorId: actor.id,
        key,
        requestHash,
        status: 'pending',
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key })
      .get();
    if (inserted) return { kind: 'owner', handle };

    const existing = await db.select().from(idempotencyRecords).where(keyOf(actor, key)).get();
    if (!existing) continue;
    if (existing.requestHash !== requestHash) {
      throw new AppError('idempotency_mismatch', '相同 Idempotency-Key 不能用于不同的发信内容，请使用新的 Key');
    }
    if (existing.status === 'completed' && existing.responseJson) {
      try {
        return { kind: 'replay', response: JSON.parse(existing.responseJson) as MessageSummary };
      } catch {
        throw new AppError('send_in_progress', '原发送已完成，但缓存结果损坏，请查询已发送邮件');
      }
    }
    if (existing.messageId) {
      const row = await db.select().from(messages).where(eq(messages.id, existing.messageId)).get();
      if (row && row.status !== 'pending') {
        const attachment = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.messageId, row.id)).get();
        const response = summarize(row, !!attachment, false);
        try { await completeIdempotentSend(env, handle, response); }
        catch (error) { console.error('Idempotency recovery persistence deferred:', error); }
        return { kind: 'replay', response };
      }
    } else if (existing.status === 'failed') {
      // 条件更新只有一个请求能收回；并发的另一方落到下面的「处理中」。
      // createdAt 一并刷新：清理按 createdAt 计保留期，沿用旧值会让收回后完成的结果当天被删，
      // 响应丢失后同 Key 重试就会重复发信
      const now = new Date();
      const reclaimed = await db
        .update(idempotencyRecords)
        .set({ status: 'pending', errorDetail: '', updatedAt: now, createdAt: now })
        .where(and(recordOf(handle), eq(idempotencyRecords.status, 'failed'), isNull(idempotencyRecords.messageId)))
        .returning({ key: idempotencyRecords.key })
        .get();
      if (reclaimed) return { kind: 'owner', handle };
    }
    throw new AppError('send_in_progress', '该发信请求正在处理或结果待确认，请查询发送结果，不要换 Key 重发');
  }
  throw new AppError('send_in_progress', '幂等状态暂不可用，请稍后查询发送结果');
}

/**
 * 把幂等键绑定到刚创建的发件行（外发之前调用）。绑定与「绑定失败则把发件行标为 failed」
 * 在同一个 batch 事务里完成：失败说明记录已不归本请求所有，此时尚未外发，
 * 发件行不能永久停在 pending。
 */
export async function bindIdempotentSend(
  env: Env,
  handle: IdempotencyHandle | null | undefined,
  messageId: number,
): Promise<void> {
  if (!handle) return;
  const db = createDb(env);
  const detail = '发送幂等状态已变化，本次未外发';
  const [bound] = await db.batch([
    db.update(idempotencyRecords)
      .set({ messageId, updatedAt: new Date() })
      .where(and(recordOf(handle), eq(idempotencyRecords.status, 'pending')))
      .returning({ messageId: idempotencyRecords.messageId }),
    db.update(messages)
      .set({ status: 'failed', errorDetail: detail })
      .where(and(eq(messages.id, messageId), eq(messages.status, 'pending'),
        // 按主键复核上一条是否绑定成功
        sql`NOT EXISTS (SELECT 1 FROM ${idempotencyRecords} WHERE ${recordOf(handle)} AND ${idempotencyRecords.messageId} = ${messageId})`)),
  ]);
  if (!bound.length) throw new AppError('send_in_progress', `${detail}，请查询发送记录`);
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
    .where(and(recordOf(handle), eq(idempotencyRecords.status, 'pending')));
}

/**
 * 发送失败时处理本请求持有的幂等记录。条件都带「未绑定发件行」：一旦绑定就可能已外发，
 * 结果不明，保留原键供查询，绝不授权重发。
 * - 外发前的 4xx 业务错误（校验、权限、限流、配额等）：删除记录，调用方修正后可用同一 Key 重试；
 * - 其余错误：标 failed，同内容重试时由 beginIdempotentSend 收回。
 * 幂等自身的 409 表示记录不归本请求所有，不动它。
 */
export async function failIdempotentSend(
  env: Env,
  handle: IdempotencyHandle | null,
  error: unknown,
): Promise<void> {
  if (!handle) return;
  if (error instanceof AppError && (error.code === 'send_in_progress' || error.code === 'idempotency_mismatch')) return;
  const db = createDb(env);
  const owned = and(recordOf(handle), eq(idempotencyRecords.status, 'pending'), isNull(idempotencyRecords.messageId));
  if (error instanceof AppError && error.status < 500) {
    await db.delete(idempotencyRecords).where(owned);
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  await db
    .update(idempotencyRecords)
    .set({ status: 'failed', errorDetail: detail.slice(0, 2000), updatedAt: new Date() })
    .where(owned);
}
