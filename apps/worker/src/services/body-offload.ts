import { runLimited } from '../lib/concurrency.js';
import { mailText } from '../lib/text.js';
import type { Env } from '../types.js';
import { BODY_PREVIEW_BYTES, bodyFitsInline, searchableBody, type StoredBody } from './mail-body.js';
import { bodyKey } from './storage.js';

/**
 * 历史正文回填（R18）：旧版本把 ≤256KB 的正文整段内联在 messages 行里，超过的在 D1 留 64KB 预览。
 * 定时任务按 id 分批把它们改成新形态——完整 text/html 在 R2（bodyR2Key），D1 只留 BODY_PREVIEW_BYTES 的搜索文本、
 * body_html 清空：
 * - 内联行：写 R2 → 回读逐字节比对 → 同一事务里改行（行仍未变才改）；
 * - 已在 R2 的旧行：读 R2 核对它确实是 D1 预览的全文后，只缩小 D1 列。
 * 进度（游标、计数、失败行）记在 settings 表的一行里，中断后从游标继续；单行失败只记录并跳过，过一段时间再重试，
 * D1 里的全文保持不动、照常可读。不变式与读取口径见 mail-body.ts：D1 被清空的行一定带 bodyR2Key，各版本代码都能读全。
 */

/** 进度行的 key：不在 SETTING_SCHEMAS 中，设置读取与管理接口都不会带出它 */
export const BODY_OFFLOAD_PROGRESS_KEY = 'maintenance.body_offload';
/** 每次按 id 检查的行数；其中需要处理的行在同一次里完成（内联行正文 ≤256KB，单次读取有上界） */
export const BODY_OFFLOAD_SCAN_ROWS = 25;
/** 只处理创建满 1 小时的行：投递中、附件修复中的行可能还在改写正文；部署窗口里旧版本写的行也由此稍后补上 */
const SETTLE_MS = 60 * 60_000;
/** 搬迁中对象的租约：进程中途被回收时租约到期，清理链路按引用复核后回收没被引用的对象 */
const LEASE_MS = 15 * 60_000;
/** R2 并发：已在 R2 的旧正文大小没有上限，压低同时驻留内存的对象数 */
const R2_CONCURRENCY = 2;
/** 失败记录最多保留的条数；每条过 RETRY_AFTER_MS 重试，累计 MAX_ATTEMPTS 次后只保留供排查 */
const MAX_FAILED = 50;
const RETRY_AFTER_MS = 6 * 60 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_PER_RUN = 5;

export interface BodyOffloadFailure {
  id: number;
  error: string;
  at: number;
  attempts: number;
}

export interface BodyOffloadProgress {
  /** 已检查到的最大 id：此前的行已是新形态，或记在 failed 里 */
  cursor: number;
  /** 正文从 D1 搬到 R2 的行数 */
  moved: number;
  /** 正文原已在 R2、只缩小 D1 预览的行数 */
  shrunk: number;
  failed: BodyOffloadFailure[];
  /** 累计失败次数（failed 只保留最近 MAX_FAILED 条） */
  failedTotal: number;
  /** 游标已追到 1 小时前的最新行；failed 为空时说明历史数据已回填完 */
  caughtUp: boolean;
  updatedAt: number;
}

/**
 * D1 正文还不是新形态时才取回正文列：有 body_html，或 body_text 可能超过预览上限。
 * length() 数字符，一个字符最多 4 字节，≤ 上限/4 个字符一定放得下；超过的再由 JS 按字节精确判断。
 */
const NEEDS_WORK = `(body_html <> '' OR length(body_text) > ${Math.floor(BODY_PREVIEW_BYTES / 4)})`;
const ROW_COLUMNS = `id, created_at, ingest_key, body_r2_key,
  CASE WHEN ${NEEDS_WORK} THEN body_text END AS body_text,
  CASE WHEN ${NEEDS_WORK} THEN body_html END AS body_html`;
/** 游标之后按主键取一批（导出供 EXPLAIN 回归）。?1 游标 id、?2 批量 */
export const BODY_OFFLOAD_SCAN_SQL = `SELECT ${ROW_COLUMNS} FROM messages WHERE id > ?1 ORDER BY id LIMIT ?2`;
const RETRY_ROWS_SQL = `SELECT ${ROW_COLUMNS} FROM messages WHERE id IN (SELECT value FROM json_each(?1))`;

interface ScanRow {
  id: number;
  created_at: number;
  ingest_key: string | null;
  body_r2_key: string | null;
  body_text: string | null;
  body_html: string | null;
}

type Plan =
  | { kind: 'move'; id: number; key: string; text: string; html: string }
  | { kind: 'shrink'; id: number; key: string; text: string; html: string };

const encoder = new TextEncoder();

function emptyProgress(): BodyOffloadProgress {
  return { cursor: 0, moved: 0, shrunk: 0, failed: [], failedTotal: 0, caughtUp: false, updatedAt: 0 };
}

function parseProgress(raw: string | undefined): BodyOffloadProgress {
  if (raw === undefined) return emptyProgress();
  try {
    const value = JSON.parse(raw) as Partial<BodyOffloadProgress>;
    if (!Number.isSafeInteger(value.cursor) || value.cursor! < 0) return emptyProgress();
    return { ...emptyProgress(), ...value, failed: Array.isArray(value.failed) ? value.failed : [] };
  } catch {
    return emptyProgress();
  }
}

/** 这一行要做什么；null 表示已是新形态（D1 里没有 HTML、搜索文本不超上限），不必处理 */
function planFor(row: ScanRow): Plan | null {
  if (row.body_text === null || row.body_html === null) return null;
  if (bodyFitsInline(row.body_text, row.body_html)) return null;
  if (row.body_r2_key) return { kind: 'shrink', id: row.id, key: row.body_r2_key, text: row.body_text, html: row.body_html };
  // 收件行沿用收件链路的确定对象名（重投修复会覆盖同一对象，不留孤儿）；其余行按 id 命名
  return { kind: 'move', id: row.id, key: bodyKey(row.ingest_key ?? `msg-${row.id}`), text: row.body_text, html: row.body_html };
}

/** 新形态 D1 里的搜索文本，与新写入同一口径（searchableBody） */
function searchText(full: StoredBody): string {
  return searchableBody(full.text, mailText(full.text, full.html));
}

/** 写 R2 并回读逐字节比对，返回 D1 改写语句 */
async function moveRow(env: Env, plan: Extract<Plan, { kind: 'move' }>): Promise<D1PreparedStatement> {
  const payload = JSON.stringify({ text: plan.text, html: plan.html } satisfies StoredBody);
  await env.r2.put(plan.key, payload, { httpMetadata: { contentType: 'application/json' } });
  const stored = await env.r2.get(plan.key);
  if (!stored) throw new Error('R2 回读不到刚写入的正文');
  if ((await stored.text()) !== payload) throw new Error('R2 回读内容与 D1 正文不一致');
  // 行在读取后被改写（旧版本修复、外发改正文）时长度对不上，本次不改，留给下一轮重读
  return env.db.prepare(`UPDATE messages SET body_r2_key = ?1, body_text = ?2, body_html = ''
    WHERE id = ?3 AND body_r2_key IS NULL
      AND length(CAST(body_text AS BLOB)) = ?4 AND length(CAST(body_html AS BLOB)) = ?5`)
    .bind(plan.key, searchText(plan), plan.id, encoder.encode(plan.text).length, encoder.encode(plan.html).length);
}

/** 正文已在 R2：核对 R2 是 D1 预览的全文后，只缩小 D1 列 */
async function shrinkRow(env: Env, plan: Extract<Plan, { kind: 'shrink' }>): Promise<D1PreparedStatement> {
  const object = await env.r2.get(plan.key);
  if (!object) throw new Error('R2 正文对象不存在，保留 D1 预览');
  const full = JSON.parse(await object.text()) as Partial<Record<keyof StoredBody, unknown>>;
  if (typeof full.text !== 'string' || typeof full.html !== 'string') throw new Error('R2 正文格式无效');
  if (!full.text.startsWith(plan.text) || !full.html.startsWith(plan.html)) throw new Error('D1 预览与 R2 正文不一致');
  return env.db.prepare(`UPDATE messages SET body_text = ?1, body_html = '' WHERE id = ?2 AND body_r2_key = ?3`)
    .bind(searchText({ text: full.text, html: full.html }), plan.id, plan.key);
}

/**
 * 回填一批（每 5 分钟的定时任务调用），返回本次改写的行数。
 * D1 往返：读进度 1 次、取行 1 次、有内联行时登记租约 1 次、改行 + 释放租约 + 写进度 1 次（同一事务）。
 */
export async function offloadMailBodies(env: Env, now = Date.now()): Promise<number> {
  const stored = await env.db.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(BODY_OFFLOAD_PROGRESS_KEY).first<{ value: string }>();
  const progress = parseProgress(stored?.value);
  const due = progress.failed
    .filter((item) => item.attempts < MAX_ATTEMPTS && now - item.at >= RETRY_AFTER_MS)
    .slice(0, RETRY_PER_RUN);
  const [scanned, retried] = await env.db.batch<ScanRow>([
    env.db.prepare(BODY_OFFLOAD_SCAN_SQL).bind(progress.cursor, BODY_OFFLOAD_SCAN_ROWS),
    env.db.prepare(RETRY_ROWS_SQL).bind(JSON.stringify(due.map((item) => item.id))),
  ]);

  const plans: Plan[] = [];
  let cursor = progress.cursor;
  let caughtUp = (scanned?.results.length ?? 0) < BODY_OFFLOAD_SCAN_ROWS;
  for (const row of scanned?.results ?? []) {
    if (Number(row.created_at) > now - SETTLE_MS) {
      caughtUp = true;
      break;
    }
    cursor = row.id;
    const plan = planFor(row);
    if (plan) plans.push(plan);
  }
  // 重试的行：已被删除或已是新形态的直接移出失败记录
  const retryIds = new Set(due.map((item) => item.id));
  for (const row of retried?.results ?? []) {
    const plan = planFor(row);
    if (plan && !plans.some((item) => item.id === plan.id)) plans.push(plan);
  }

  const leaseToken = crypto.randomUUID();
  const moves = plans.filter((plan) => plan.kind === 'move');
  if (moves.length) {
    // 写对象前登记租约：清理链路不删租约中的对象。同时撤掉这些对象名残留的清理台账（此前中断的尝试留下的），
    // 本次没能被引用的对象在收尾时重新登记
    const keys = JSON.stringify(moves.map((plan) => plan.key));
    await env.db.batch([
      env.db.prepare(`INSERT OR IGNORE INTO delivery_object_leases (r2_key, token, expires_at)
        SELECT value, ?1, ?2 FROM json_each(?3)`).bind(leaseToken, now + LEASE_MS, keys),
      env.db.prepare('DELETE FROM storage_cleanup_jobs WHERE r2_key IN (SELECT value FROM json_each(?1))').bind(keys),
    ]);
  }

  const updates: { plan: Plan; statement: D1PreparedStatement }[] = [];
  const failures = new Map<number, string>();
  await runLimited(plans, R2_CONCURRENCY, async (plan) => {
    try {
      updates.push({ plan, statement: plan.kind === 'move' ? await moveRow(env, plan) : await shrinkRow(env, plan) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(plan.id, message.slice(0, 200));
      console.error('正文回填失败，跳过该行:', plan.id, message);
    }
  });

  if (!plans.length && !retryIds.size && cursor === progress.cursor && caughtUp === progress.caughtUp) return 0;
  const count = (kind: Plan['kind'], items: { plan: Plan }[]) => items.filter((item) => item.plan.kind === kind).length;
  // 先按全部改写成功计数，提交后发现没改到的行再更正
  const next = withFailures({
    ...progress,
    cursor,
    caughtUp,
    moved: progress.moved + count('move', updates),
    shrunk: progress.shrunk + count('shrink', updates),
    failed: progress.failed.filter((item) => !retryIds.has(item.id)),
    updatedAt: now,
  }, failures, progress.failed, now);

  const statements: D1PreparedStatement[] = updates.map((item) => item.statement);
  if (moves.length) {
    statements.push(
      // 行在搬迁期间被删除或改写、或这一行失败：对象没被引用，登记清理（清理时仍按引用复核）
      env.db.prepare(`INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key)
        SELECT r2_key FROM delivery_object_leases WHERE token = ?1
          AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.body_r2_key = delivery_object_leases.r2_key)`).bind(leaseToken),
      env.db.prepare('DELETE FROM delivery_object_leases WHERE token = ?1').bind(leaseToken),
    );
  }
  const written = JSON.stringify(next);
  statements.push(writeProgress(env, written, stored?.value ?? null));
  const results = await env.db.batch(statements);

  // 读取之后行被删除或改写（长度对不上）的没有改到：记为失败，到期重试时重新读取（已删除的会移出记录）
  const missed = updates.filter((_, index) => (results[index]?.meta.changes ?? 0) === 0);
  if (missed.length) {
    const corrected = withFailures({
      ...next,
      moved: next.moved - count('move', missed),
      shrunk: next.shrunk - count('shrink', missed),
    }, new Map(missed.map((item) => [item.plan.id, '回填期间该行被删除或改写'])), progress.failed, now);
    try {
      await writeProgress(env, JSON.stringify(corrected), written).run();
    } catch (error) {
      console.error('正文回填进度更正失败:', error);
    }
  }
  const changed = updates.length - missed.length;
  if (changed || failures.size || missed.length) {
    console.log(JSON.stringify({ event: 'body_offload', cursor, changed, failed: failures.size + missed.length, caughtUp }));
  }
  return changed;
}

/** 把本次失败并入记录：累加尝试次数，按时间只保留最近 MAX_FAILED 条 */
function withFailures(
  progress: BodyOffloadProgress,
  failures: Map<number, string>,
  previous: BodyOffloadFailure[],
  now: number,
): BodyOffloadProgress {
  if (!failures.size) return progress;
  const attempts = new Map(previous.map((item) => [item.id, item.attempts]));
  const failed = [
    ...progress.failed.filter((item) => !failures.has(item.id)),
    ...[...failures].map(([id, error]) => ({ id, error, at: now, attempts: (attempts.get(id) ?? 0) + 1 })),
  ].sort((a, b) => a.at - b.at || a.id - b.id);
  return { ...progress, failed: failed.slice(-MAX_FAILED), failedTotal: progress.failedTotal + failures.size };
}

/** 进度按读到的原值比较后写入：并发的两次运行做的是同样的幂等工作，后提交的一方不覆盖先提交的进度 */
function writeProgress(env: Env, value: string, expected: string | null): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value IS ?3`)
    .bind(BODY_OFFLOAD_PROGRESS_KEY, value, expected);
}
