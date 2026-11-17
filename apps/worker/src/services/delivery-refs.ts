import type { Db } from '../db/client.js';
import { createDb } from '../db/client.js';
import { emailDeliveryRefs } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import type { Env } from '../types.js';

/**
 * 投递回执是否启用：部署时设置了 GitHub Variable DELIVERY_EVENTS_QUEUE，CI 才注入 Worker 变量与 Queue consumer。
 * 未启用时外发不查抑制名单、不登记对应关系，定时任务不建订阅——没有任何额外的 D1 往返或 Cloudflare 调用。
 */
export function deliveryEventsQueue(env: Pick<Env, 'delivery_events_queue'>): string | null {
  return env.delivery_events_queue?.trim() || null;
}

export interface DeliveryRefInput {
  kind: 'message' | 'forward';
  messageId: number;
  sender: string;
  /** 本站写进原文的 Message-ID（可带尖括号）；中转转发没有 */
  rfcMessageId: string | null;
  /** forward：结果归属人 */
  ownerIds?: number[];
  targets: { recipient: string; providerMessageId: string | null }[];
}

export const stripBrackets = (value: string): string => value.trim().replace(/^<|>$/g, '');

/** 每个外部收件人一行；调用方把它们并进自己的 batch（发件结果与对应关系同一事务写入，不多一次往返） */
export function deliveryRefInserts(db: Db, input: DeliveryRefInput) {
  const createdAt = new Date();
  const rfcMessageId = input.rfcMessageId ? stripBrackets(input.rfcMessageId) : null;
  // 每行 8 个绑定，10 行一条语句，不超过 D1 的 100 参数上限
  return chunk(input.targets, 10).map((rows) => db.insert(emailDeliveryRefs).values(rows.map((row) => ({
    providerMessageId: row.providerMessageId || null, rfcMessageId, kind: input.kind, messageId: input.messageId,
    sender: input.sender.toLowerCase(), recipient: row.recipient.toLowerCase(), ownerIds: input.ownerIds ?? [], createdAt,
  }))).onConflictDoNothing());
}

/** 中转转发成功后登记（在 waitUntil 里，失败只记日志）；未启用投递回执时不写 */
export async function saveDeliveryRefs(env: Env, input: DeliveryRefInput): Promise<void> {
  if (!input.targets.length || !deliveryEventsQueue(env)) return;
  try {
    const db = createDb(env);
    const [first, ...rest] = deliveryRefInserts(db, input);
    await db.batch([first!, ...rest]);
  } catch (error) {
    console.error('投递回执对应关系保存失败:', error);
  }
}
