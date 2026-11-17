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
 *
 * 修复大邮件时 isolate 可能因内存或 CPU 上限被平台直接终止，catch 拦不到、之后的代码都不执行。所以：
 * - 领取语句里先把尝试次数加一再处理（成功后清零），被终止的行下一轮排在新行之后，累计中断满上限就放弃；
 * - 每轮有数量与时间上限；cron 把自愈排在其余 5 分钟步骤和心跳之后（scheduled.ts），被终止也不连累它们；
 * - 核对与重走收件分两次读原文，核对用的那份不在 handleInbound 期间常驻，峰值内存与首次收件相同。
 */

/** pending 超过这么久才视为中断：收件请求本身早已结束，不会与正在进行的投递抢同一行 */
export const INBOUND_PENDING_STALE_MS = 15 * 60 * 1000;
/** 每轮最多处理的行数：每行要读原文、解析并写附件，控制单次 cron 时长 */
const REPAIR_BATCH = 5;
/** 每轮的时间预算：超出后不再领取新行（已领取的那行照常做完） */
const REPAIR_BUDGET_MS = 60_000;
/** 自动修复失败达到这么多次就放弃，标为 degraded */
export const MAX_INBOUND_REPAIR_ATTEMPTS = 6;
/** 等待单行后处理（转发、AI 提码、通知入队）的上限，超时只记日志 */
const POST_PROCESS_WAIT_MS = 20_000;

/**
 * 候选行：只扫 idx_messages_inbound_pending 部分索引（正常时 0 行）。带 deleted_at 条件时规划器会改走
 * idx_messages_live 扫全站，所以用 INDEXED BY 固定；方向与状态写成字面量才满足部分索引的条件。
 * 失败或被中断过的排在后面，不挡住新出现的 pending；回收站里的不修；本轮已领取过的（?3，JSON 数组）不再领取，
 * 每行一轮最多试一次，重试间隔至少一个 cron 周期。导出供 EXPLAIN 回归。
 */
export const STALE_INBOUND_SQL = `SELECT id FROM messages INDEXED BY idx_messages_inbound_pending
  WHERE direction = 'inbound' AND status = 'pending' AND created_at < ?1 AND deleted_at IS NULL
    AND inbound_repair_attempts < ?2 AND id NOT IN (SELECT value FROM json_each(?3))
  ORDER BY inbound_repair_attempts, created_at LIMIT 1`;

/**
 * 领取一行：同一条语句里先把尝试次数加一（先占位再处理），并写下「第 N 次在处理途中被中断」。
 * isolate 中途被终止时这次尝试已计数、说明也留在行上；正常结束时收件链路或失败记录会覆盖这条说明。
 */
const CLAIM_SQL = `UPDATE messages SET inbound_repair_attempts = inbound_repair_attempts + 1,
    error_detail = '自动修复第 ' || (inbound_repair_attempts + 1) || ' 次在处理途中被中断（可能超出运行内存或 CPU 上限），稍后重试'
  WHERE id = (${STALE_INBOUND_SQL}) AND status = 'pending'
  RETURNING id, address, ingest_key, raw_r2_key, inbound_repair_attempts AS attempts`;

/**
 * 尝试次数已满仍是 pending（最后一次在处理途中被终止，或放弃后发件方重投又失败把它写回 pending）：
 * 转 degraded，说明里带上最后一次的原因（去掉重复的「附件保存失败，」前缀与「稍后重试」），保留「保存失败」供原样重投修复
 */
const GIVE_UP_SQL = `UPDATE messages SET status = 'degraded',
    error_detail = '附件保存失败，自动修复已达 ' || CAST(?2 AS INTEGER) || ' 次上限（最后一次：' || replace(replace(error_detail, '附件保存失败，', ''), '，稍后重试', '') || '），请下载原始邮件查看'
  WHERE direction = 'inbound' AND status = 'pending' AND created_at < ?1 AND inbound_repair_attempts >= ?2`;

interface PendingRow {
  id: number;
  address: string;
  ingest_key: string | null;
  raw_r2_key: string | null;
  /** 含本次领取在内的尝试次数 */
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

/** 合成的入站邮件：原文直接以 R2 流交给收件链路，不能原生转发或回信（转发降级为中转），拒收原因记下来 */
function syntheticMessage(to: string, object: R2ObjectBody, headers: Headers): { message: ForwardableEmailMessage; rejected: () => string | null } {
  let rejected: string | null = null;
  const message = {
    from: (headers.get('return-path') ?? '').replace(/^<|>$/g, ''),
    to,
    headers,
    raw: object.body,
    rawSize: object.size,
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

/** 记一次可捕获的失败（次数已在领取时加过）；达到上限时同一条语句直接转为 degraded */
async function recordFailure(env: Env, row: PendingRow, reason: string): Promise<RepairOutcome> {
  const gaveUp = row.attempts >= MAX_INBOUND_REPAIR_ATTEMPTS;
  await env.db.prepare(`UPDATE messages SET status = ?, error_detail = ? WHERE id = ? AND status = 'pending'`)
    .bind(gaveUp ? 'degraded' : 'pending', gaveUp
      ? `附件保存失败，自动修复 ${row.attempts} 次仍未成功（${reason}），请下载原始邮件查看`
      : `附件保存失败，自动修复第 ${row.attempts} 次未成功（${reason}），稍后重试`, row.id)
    .run();
  return gaveUp ? 'gave_up' : 'retry';
}

/**
 * 核对存档原文：与收件链路同口径算幂等键，对不上就不能重走收件，否则会插出一封新邮件。
 * 原文只在这个函数里持有，返回后即可回收，不与 handleInbound 里的那份同时常驻。
 */
async function inspectArchive(env: Env, row: PendingRow): Promise<{ headers: Headers } | { degraded: string }> {
  const object = row.raw_r2_key ? await env.r2.get(row.raw_r2_key) : null;
  if (!object) return { degraded: '附件保存失败，且原始邮件未存档，无法自动修复' };
  const raw = new Uint8Array(await object.arrayBuffer());
  let sourceMessageId = '';
  try { sourceMessageId = (await PostalMime.parse(raw, MIME_LIMITS)).messageId || ''; } catch { /* 收件时同样按空 Message-ID 计 */ }
  if (await inboundIngestKey(row.address, sourceMessageId, await sha256Hex(raw)) !== row.ingest_key) {
    return { degraded: '附件保存失败，存档原文与记录不一致，无法自动修复' };
  }
  return { headers: headersFromRaw(raw) };
}

async function repairOne(env: Env, row: PendingRow): Promise<RepairOutcome> {
  const inspected = await inspectArchive(env, row);
  const object = 'headers' in inspected ? await env.r2.get(row.raw_r2_key!) : null;
  if (!object) {
    await markDegraded(env, row.id, 'degraded' in inspected ? inspected.degraded : '附件保存失败，且原始邮件未存档，无法自动修复');
    return 'degraded';
  }

  const { message, rejected } = syntheticMessage(row.address, object, (inspected as { headers: Headers }).headers);
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
  // 已不是 pending 就算修好，尝试次数清零；仍是 pending 记一次失败
  const after = await env.db.prepare(`UPDATE messages
    SET inbound_repair_attempts = CASE WHEN status = 'pending' THEN inbound_repair_attempts ELSE 0 END
    WHERE id = ? RETURNING status`).bind(row.id).first<{ status: string }>();
  if (after?.status === 'pending') return recordFailure(env, row, '修复未完成');
  return 'repaired';
}

export interface RepairOptions {
  /** 本轮最多领取的行数 */
  limit?: number;
  /** 本轮的时间预算（毫秒），超出后不再领取新行 */
  budgetMs?: number;
  /** 计时用的时钟（测试注入） */
  clock?: () => number;
}

/**
 * 修复超过 INBOUND_PENDING_STALE_MS 仍为 pending 的入站行：每次领取一行、处理完再领下一行，
 * 受数量与时间上限约束；返回本轮领取的行数。单行出错只影响这一行，不影响后续行。
 * 先把中断满上限的行放弃（与第一次领取合在一个 batch，正常时只有这一次 D1 往返）。
 */
export async function repairPendingInbound(env: Env, now = Date.now(), opts: RepairOptions = {}): Promise<number> {
  const { limit = REPAIR_BATCH, budgetMs = REPAIR_BUDGET_MS, clock = Date.now } = opts;
  const deadline = clock() + budgetMs;
  const cutoff = now - INBOUND_PENDING_STALE_MS;
  const tried: number[] = [];
  const claim = () => env.db.prepare(CLAIM_SQL).bind(cutoff, MAX_INBOUND_REPAIR_ATTEMPTS, JSON.stringify(tried));
  const [abandoned, first] = await env.db.batch<PendingRow>([
    env.db.prepare(GIVE_UP_SQL).bind(cutoff, MAX_INBOUND_REPAIR_ATTEMPTS),
    claim(),
  ]);
  const outcomes: Record<RepairOutcome | 'abandoned', number> = {
    repaired: 0, degraded: 0, retry: 0, gave_up: 0, abandoned: abandoned?.meta.changes ?? 0,
  };
  let row = first?.results[0];
  let claimed = 0;
  while (row) {
    claimed++;
    tried.push(Number(row.id));
    const current = { ...row, attempts: Number(row.attempts) };
    let outcome: RepairOutcome;
    try {
      outcome = await repairOne(env, current);
    } catch (error) {
      console.error('入站自愈失败:', error);
      try { outcome = await recordFailure(env, current, reasonOf(error)); }
      catch (recordError) { console.error('入站自愈失败记录失败:', recordError); outcome = 'retry'; }
    }
    outcomes[outcome]++;
    if (claimed >= limit || clock() >= deadline) break;
    row = (await claim().first<PendingRow>()) ?? undefined;
  }
  if (claimed || outcomes.abandoned) console.log(JSON.stringify({ event: 'inbound_repair', claimed, ...outcomes }));
  return claimed;
}
