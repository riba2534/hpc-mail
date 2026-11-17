import PostalMime from 'postal-mime';
import { sha256Hex } from '../lib/crypto.js';
import type { Env, ExecCtx } from '../types.js';
import { handleInbound, inboundIngestKey, MIME_LIMITS } from './inbound.js';

/**
 * 入站 pending 自愈。
 *
 * 附件（或 Worker 中途被回收）没保存完整的收件行停在 pending，原本只能等发件方用完全相同的字节重投来修复；
 * 发件方不重投、或重投字节不同（ingestKey 变了）时，这封信会永久缺附件、没有通知也不转发。
 * 定时任务从 R2 读回收件时存档的原文，构造一封合成的入站邮件重走 handleInbound：去重命中这一行的
 * pending 分支，补齐附件后原子转为完整状态，再照常做转发与通知（只有完成转换的一方执行后处理）。
 *
 * 修不了的标为 degraded 并写明原因：degraded 行会被 repairUnqueuedNotifications 补入通知，但不会再转发。
 * 原因里保留「保存失败」字样：发件方之后若用相同字节重投，收件链路仍会走修复路径补齐附件。
 */

/** pending 超过这么久才视为中断：收件请求本身早已结束，不会与正在进行的投递抢同一行 */
export const INBOUND_PENDING_STALE_MS = 15 * 60 * 1000;
/** 每轮最多处理的行数：每行要读原文、解析并写附件，控制单次 cron 时长 */
const REPAIR_BATCH = 5;
/** 自动修复失败达到这么多次就放弃，标为 degraded */
export const MAX_INBOUND_REPAIR_ATTEMPTS = 6;
/** 等待单行后处理（转发、AI 提码、通知入队）的上限，超时只记日志 */
const POST_PROCESS_WAIT_MS = 20_000;

/**
 * 方向与状态写成字面量，规划器才能确认命中 idx_messages_inbound_pending 部分索引（正常时 0 行）。
 * 失败过的排在后面：持续失败的行不会挡住新出现的 pending。导出供 EXPLAIN 回归。
 */
export const STALE_INBOUND_SQL = `SELECT id, address, ingest_key, raw_r2_key, inbound_repair_attempts AS attempts FROM messages
  WHERE direction = 'inbound' AND status = 'pending' AND created_at < ? ORDER BY inbound_repair_attempts, created_at LIMIT ?`;

interface PendingRow {
  id: number;
  address: string;
  ingest_key: string | null;
  raw_r2_key: string | null;
  attempts: number;
}

type RepairOutcome = 'repaired' | 'degraded' | 'retry' | 'gave_up';

/** 原文头部解析成 Headers（折行展开；非法字段名跳过）。转发的防环标记依赖它，必须来自原文 */
export function headersFromRaw(raw: Uint8Array): Headers {
  const text = new TextDecoder('latin1').decode(raw.subarray(0, Math.min(raw.byteLength, 256 * 1024)));
  const end = text.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Headers();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    try { headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim()); }
    catch { /* 非法字段名或值：原生 headers 同样不会包含它 */ }
  }
  return headers;
}

/** 合成的入站邮件：只读原文，不能原生转发或回信（转发降级为中转），拒收原因记下来 */
function syntheticMessage(to: string, raw: Uint8Array): { message: ForwardableEmailMessage; rejected: () => string | null } {
  let rejected: string | null = null;
  const headers = headersFromRaw(raw);
  const message = {
    from: (headers.get('return-path') ?? '').replace(/^<|>$/g, ''),
    to,
    headers,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    setReject(reason: string) { rejected = reason; },
    forward: () => Promise.reject(new Error('定时修复没有原生转发能力')),
    reply: () => Promise.reject(new Error('定时修复不能回信')),
  } as unknown as ForwardableEmailMessage;
  return { message, rejected: () => rejected };
}

/** 收集 waitUntil 的任务；处理完一行再等它们（含任务里再登记的任务）落地，超时只记日志 */
function collectingCtx(): { ctx: ExecCtx; settle: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  const ctx: ExecCtx = {
    waitUntil(promise) { tasks.push(promise.catch((error: unknown) => console.error('入站自愈后处理失败:', error))); },
  };
  const drain = async () => {
    for (let seen = 0; seen < tasks.length;) {
      const batch = tasks.slice(seen);
      seen = tasks.length;
      await Promise.allSettled(batch);
    }
  };
  const settle = async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), POST_PROCESS_WAIT_MS); });
    if (await Promise.race([drain().then(() => 'done' as const), timeout]) === 'timeout') {
      console.error(`入站自愈后处理 ${POST_PROCESS_WAIT_MS}ms 内未完成，交给后续定时任务补齐`);
    }
    if (timer !== null) clearTimeout(timer);
  };
  return { ctx, settle };
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

async function markDegraded(env: Env, id: number, detail: string): Promise<void> {
  await env.db.prepare(`UPDATE messages SET status = 'degraded', error_detail = ? WHERE id = ? AND status = 'pending'`)
    .bind(detail, id).run();
}

/** 记一次失败；达到上限时同一条语句直接转为 degraded */
async function recordFailure(env: Env, row: PendingRow, reason: string): Promise<RepairOutcome> {
  const attempts = row.attempts + 1;
  const gaveUp = attempts >= MAX_INBOUND_REPAIR_ATTEMPTS;
  await env.db.prepare(`UPDATE messages SET inbound_repair_attempts = ?, status = ?, error_detail = ?
    WHERE id = ? AND status = 'pending'`)
    .bind(attempts, gaveUp ? 'degraded' : 'pending', gaveUp
      ? `附件保存失败，自动修复 ${attempts} 次仍未成功（${reason}），请下载原始邮件查看`
      : `附件保存失败，自动修复第 ${attempts} 次未成功（${reason}），稍后重试`, row.id)
    .run();
  return gaveUp ? 'gave_up' : 'retry';
}

async function repairOne(env: Env, row: PendingRow): Promise<RepairOutcome> {
  const object = row.raw_r2_key ? await env.r2.get(row.raw_r2_key) : null;
  if (!object) {
    await markDegraded(env, row.id, '附件保存失败，且原始邮件未存档，无法自动修复');
    return 'degraded';
  }
  const raw = new Uint8Array(await object.arrayBuffer());
  // 与收件链路同口径算幂等键：对不上就不能重走收件，否则会插出一封新邮件
  let sourceMessageId = '';
  try { sourceMessageId = (await PostalMime.parse(raw, MIME_LIMITS)).messageId || ''; } catch { /* 收件时同样按空 Message-ID 计 */ }
  if (await inboundIngestKey(row.address, sourceMessageId, await sha256Hex(raw)) !== row.ingest_key) {
    await markDegraded(env, row.id, '附件保存失败，存档原文与记录不一致，无法自动修复');
    return 'degraded';
  }

  const { message, rejected } = syntheticMessage(row.address, raw);
  const { ctx, settle } = collectingCtx();
  try {
    await handleInbound(message, env, ctx);
  } catch (error) {
    await settle();
    return recordFailure(env, row, reasonOf(error));
  }
  await settle();
  const reason = rejected();
  if (reason) {
    await markDegraded(env, row.id, `附件保存失败，自动修复时收件被拒（${reason.slice(0, 200)}）`);
    return 'degraded';
  }
  const after = await env.db.prepare('SELECT status FROM messages WHERE id = ?').bind(row.id).first<{ status: string }>();
  if (after?.status === 'pending') return recordFailure(env, row, '修复未完成');
  return 'repaired';
}

/**
 * 修复超过 INBOUND_PENDING_STALE_MS 仍为 pending 的入站行，逐行串行处理；返回本轮处理的行数。
 * 单行出错只影响这一行（记一次失败），不影响后续行。
 */
export async function repairPendingInbound(env: Env, now = Date.now(), limit = REPAIR_BATCH): Promise<number> {
  const rows = (await env.db.prepare(STALE_INBOUND_SQL).bind(now - INBOUND_PENDING_STALE_MS, limit).all<PendingRow>()).results;
  if (!rows.length) return 0;
  const outcomes: Record<RepairOutcome, number> = { repaired: 0, degraded: 0, retry: 0, gave_up: 0 };
  for (const row of rows) {
    let outcome: RepairOutcome;
    try {
      outcome = await repairOne(env, { ...row, attempts: Number(row.attempts) });
    } catch (error) {
      console.error('入站自愈失败:', error);
      try { outcome = await recordFailure(env, { ...row, attempts: Number(row.attempts) }, reasonOf(error)); }
      catch (recordError) { console.error('入站自愈失败次数记录失败:', recordError); continue; }
    }
    outcomes[outcome]++;
  }
  console.log(JSON.stringify({ event: 'inbound_repair', candidates: rows.length, ...outcomes }));
  return rows.length;
}
