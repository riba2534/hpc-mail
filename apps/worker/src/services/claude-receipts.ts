import { htmlToText } from '../lib/text.js';
import type { Env } from '../types.js';
import { CLAUDE_AUTHENTIC, CLAUDE_OFFICIAL_SENDER, CLAUDE_RECEIPT_SUBJECT } from './claude-facts.js';
import { readMailBody } from './mail-body.js';

/**
 * Anthropic 收据（claude_receipts）：从官方收据来信（主题 `Your receipt from Anthropic…`）解析金额、币种与扣款卡尾号，
 * 供 /v1/admin/claude/addresses 返回收据与 Max 档位。不随邮件删除，同一封邮件只记一次（message_id 唯一，重复采集幂等）。
 *
 * 三条采集路径：
 * - 5 分钟定时任务采最近 1 小时尚未记录的收据（harvestRecentClaudeReceipts），新收据尽快可查；
 * - 同一定时任务按 id 游标分批回填（backfillClaudeReceipts），只扫 1 小时之前的行，追上后继续跟随新行，
 *   定时任务中断超过 1 小时的漏网之鱼也由它补上；
 * - 永久删除前与删除同一个 batch 用纯 SQL 采集（harvestReceiptsPurgeStatement），邮件删掉后收据仍在。
 */

/**
 * 0028 迁移（messages.auth）上线的时间：此前收到的邮件都没有认证结果，PR #27 首次部署后曾回滚，
 * 修复版本约 15:56Z 才稳定上线，取 16:00Z 覆盖这段旧版本收信的时间。
 */
export const RECEIPT_LEGACY_AUTH_CUTOFF_MS = Date.UTC(2026, 10, 17, 16);

/**
 * 信任口径与 claude_address_facts 一致：有认证结果的信要求 DKIM 对齐且收件地址在 To 头里；
 * 截止时间之前没有认证结果的历史收据按当时的口径（官方发件域精确白名单 + 主题）接受，与当时归纳的地址事实一致；
 * 截止时间之后仍没有认证结果的不采。
 */
const TRUSTED = `(${CLAUDE_AUTHENTIC} OR (auth IS NULL AND created_at < ${RECEIPT_LEGACY_AUTH_CUTOFF_MS}))`;
/** 可以作为收据采集的来信（未加 messages 别名，列名直接引用） */
export const RECEIPT_SQL = `(direction = 'inbound' AND send_channel <> 'internal' AND ${CLAUDE_RECEIPT_SUBJECT}
  AND ${CLAUDE_OFFICIAL_SENDER} AND ${TRUSTED})`;
const NOT_RECORDED = 'NOT EXISTS (SELECT 1 FROM claude_receipts r WHERE r.message_id = messages.id)';

/** 定时任务每轮只采最近这段时间的收据；更早的由游标回填负责 */
export const RECEIPT_WINDOW_MS = 60 * 60_000;
/** 最近窗口单轮最多处理的收据数 */
const WINDOW_LIMIT = 50;
/** 回填单轮按 id 检查的行数与最多记录的收据数 */
export const RECEIPT_BACKFILL_SCAN_ROWS = 1000;
const BACKFILL_MAX_RECEIPTS = 200;
/** 单轮最多读 R2 全文的次数与时长（正文里找不到金额、且全文在 R2 时才读）；超出的收据留给下一轮 */
const R2_READS_PER_RUN = 10;
const R2_TIME_PER_RUN_MS = 10_000;

/** 进度行的 key：不在 SETTING_SCHEMAS 中，设置读取与管理接口都不会带出它 */
export const RECEIPT_BACKFILL_PROGRESS_KEY = 'maintenance.claude_receipts';

export interface ReceiptBackfillProgress {
  /** 已检查到的最大 id */
  cursor: number;
  /** 回填累计写入的收据数 */
  recorded: number;
  /** 游标已追到 1 小时前的最新行：历史收据已回填完，此后每轮只检查新行 */
  caughtUp: boolean;
  updatedAt: number;
}

export interface ParsedReceipt {
  amountCents: number | null;
  currency: string | null;
  cardLast4: string | null;
}

const CURRENCIES: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const MONEY = String.raw`([$€£])\s?(\d+(?:,\d{3})*)(?:\.(\d{2}))?(?!\d)`;
/** 先认实付金额，没有时取抬头金额 */
const AMOUNT_PATTERNS = [
  new RegExp(String.raw`Amount paid\s*:?\s*${MONEY}`, 'i'),
  new RegExp(String.raw`Receipt from Anthropic, PBC\s*${MONEY}`, 'i'),
];
/** `Paid on … with - 1234`，卡组织名可能出现在破折号前（`with Visa - 1234`） */
const CARD_PATTERN = /\bwith\s+(?:[A-Za-z][A-Za-z ]{0,20}\s)?-\s*(\d{4})(?!\d)/;

/** 从收据正文解析金额（美分）、币种与卡尾号；解析不到的为 null */
export function parseClaudeReceipt(text: string): ParsedReceipt {
  let amountCents: number | null = null;
  let currency: string | null = null;
  for (const pattern of AMOUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const cents = Number(match[2]!.replace(/,/g, '')) * 100 + Number(match[3] ?? '0');
    if (!Number.isSafeInteger(cents)) continue;
    amountCents = cents;
    currency = CURRENCIES[match[1]!] ?? null;
    break;
  }
  return { amountCents, currency, cardLast4: CARD_PATTERN.exec(text)?.[1] ?? null };
}

interface ReceiptRow {
  id: number;
  address: string;
  domain: string;
  created_at: number;
  subject: string;
  body_text: string;
  body_r2_key: string | null;
}

interface ReceiptRecord extends ParsedReceipt {
  messageId: number;
  address: string;
  domain: string;
  receivedAt: number;
  subject: string;
}

/** 本轮剩余的 R2 读取次数与截止时间 */
interface Budget { r2: number; until: number }

const newBudget = (): Budget => ({ r2: R2_READS_PER_RUN, until: Date.now() + R2_TIME_PER_RUN_MS });

/**
 * 解析一封收据：先看 D1 里的正文；找不到金额且全文在 R2 时读全文（纯文本，没有时用 HTML 转出的文本）。
 * R2 次数或时长用完返回 null（留给下一轮）；R2 读取出错时按 D1 正文的解析结果记录，不卡住回填。
 */
async function recordOf(env: Env, row: ReceiptRow, budget: Budget): Promise<ReceiptRecord | null> {
  let parsed = parseClaudeReceipt(row.body_text);
  if (parsed.amountCents === null && row.body_r2_key) {
    if (budget.r2 <= 0 || Date.now() >= budget.until) return null;
    budget.r2--;
    try {
      const full = await readMailBody(env, { bodyText: row.body_text, bodyHtml: '', bodyR2Key: row.body_r2_key });
      const fromText = parseClaudeReceipt(full.bodyText);
      const fromFull = fromText.amountCents === null && full.bodyHtml ? parseClaudeReceipt(htmlToText(full.bodyHtml)) : fromText;
      parsed = {
        amountCents: fromFull.amountCents,
        currency: fromFull.currency,
        cardLast4: fromFull.cardLast4 ?? parsed.cardLast4,
      };
    } catch (error) {
      console.error('收据全文读取失败，按 D1 正文记录:', row.id, error);
    }
  }
  return {
    messageId: Number(row.id), address: row.address, domain: row.domain, receivedAt: Number(row.created_at), subject: row.subject, ...parsed,
  };
}

/** 一条语句写入一批收据；已记录的邮件跳过 */
function insertStatement(env: Env, records: ReceiptRecord[]): D1PreparedStatement {
  return env.db.prepare(`INSERT INTO claude_receipts (message_id, address, domain, received_at, subject, amount_cents, currency, card_last4)
    SELECT json_extract(value, '$.messageId'), json_extract(value, '$.address'), json_extract(value, '$.domain'),
      json_extract(value, '$.receivedAt'), json_extract(value, '$.subject'), json_extract(value, '$.amountCents'),
      json_extract(value, '$.currency'), json_extract(value, '$.cardLast4')
    FROM json_each(?1) WHERE true
    ON CONFLICT (message_id) DO NOTHING`).bind(JSON.stringify(records));
}

/** 最近窗口内尚未记录的收据（导出供 EXPLAIN 回归）。?1 起始时间、?2 上限 */
export const RECEIPT_WINDOW_SQL = `SELECT id, address, domain, created_at, subject, body_text, body_r2_key
  FROM messages INDEXED BY idx_messages_created_id
  WHERE created_at >= ?1 AND ${RECEIPT_SQL} AND ${NOT_RECORDED}
  ORDER BY created_at, id LIMIT ?2`;

/** 采集最近 1 小时收到、尚未记录的收据，返回新记录数 */
export async function harvestRecentClaudeReceipts(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.db.prepare(RECEIPT_WINDOW_SQL).bind(now - RECEIPT_WINDOW_MS, WINDOW_LIMIT).all<ReceiptRow>();
  const budget = newBudget();
  const records: ReceiptRecord[] = [];
  for (const row of results) {
    const record = await recordOf(env, row, budget);
    if (record) records.push(record);
  }
  if (!records.length) return 0;
  return (await insertStatement(env, records).run()).meta.changes ?? 0;
}

/**
 * 游标之后按主键取一批（导出供 EXPLAIN 回归）：先按主键判定每行是不是待记录的收据（只物化 id、时间与判定结果），
 * 只有收据再按主键取回正文等列，其余行这些列为 null。?1 游标 id、?2 批量
 */
export const RECEIPT_BACKFILL_SCAN_SQL = `WITH scanned AS MATERIALIZED (
    SELECT id, created_at, (${RECEIPT_SQL} AND ${NOT_RECORDED}) AS receipt FROM messages WHERE id > ?1 ORDER BY id LIMIT ?2)
  SELECT s.id, s.created_at, s.receipt, m.address, m.domain, m.subject, m.body_text, m.body_r2_key
  FROM scanned s LEFT JOIN messages m ON s.receipt AND m.id = s.id
  ORDER BY s.id`;

function emptyProgress(): ReceiptBackfillProgress {
  return { cursor: 0, recorded: 0, caughtUp: false, updatedAt: 0 };
}

function parseProgress(raw: string | undefined): ReceiptBackfillProgress {
  if (raw === undefined) return emptyProgress();
  try {
    const value = JSON.parse(raw) as Partial<ReceiptBackfillProgress>;
    if (!Number.isSafeInteger(value.cursor) || value.cursor! < 0) return emptyProgress();
    return { ...emptyProgress(), ...value };
  } catch {
    return emptyProgress();
  }
}

/**
 * 历史回填一批（每 5 分钟的定时任务调用），返回本轮新记录的收据数。
 * 只检查创建满 1 小时的行（更新的由最近窗口采集负责）；碰到更新的行或取不满一批即 caughtUp，之后每轮从游标继续检查新行。
 * D1 往返：读进度 1 次、取行 1 次、写收据与进度 1 次（同一事务）。
 */
export async function backfillClaudeReceipts(env: Env, now = Date.now(), scanRows = RECEIPT_BACKFILL_SCAN_ROWS): Promise<number> {
  const stored = await env.db.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(RECEIPT_BACKFILL_PROGRESS_KEY).first<{ value: string }>();
  const progress = parseProgress(stored?.value);
  const { results } = await env.db.prepare(RECEIPT_BACKFILL_SCAN_SQL).bind(progress.cursor, scanRows)
    .all<ReceiptRow & { receipt: number }>();

  const budget = newBudget();
  const records: ReceiptRecord[] = [];
  let cursor = progress.cursor;
  let caughtUp = results.length < scanRows;
  for (const row of results) {
    if (Number(row.created_at) >= now - RECEIPT_WINDOW_MS) {
      caughtUp = true;
      break;
    }
    if (row.receipt) {
      // 收据数或 R2 额度到上限：游标停在这一行之前，下一轮接着处理
      if (records.length >= BACKFILL_MAX_RECEIPTS) {
        caughtUp = false;
        break;
      }
      const record = await recordOf(env, row, budget);
      if (!record) {
        caughtUp = false;
        break;
      }
      records.push(record);
    }
    cursor = Number(row.id);
  }

  if (!records.length && cursor === progress.cursor && caughtUp === progress.caughtUp) return 0;
  const statements: D1PreparedStatement[] = records.length ? [insertStatement(env, records)] : [];
  const next: ReceiptBackfillProgress = { cursor, caughtUp, recorded: progress.recorded + records.length, updatedAt: now };
  // 收据与进度同一事务提交；进度按读到的原值比较后写入，并发的另一轮已推进时不覆盖（收据写入本身幂等）
  statements.push(env.db.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value IS ?3`)
    .bind(RECEIPT_BACKFILL_PROGRESS_KEY, JSON.stringify(next), stored?.value ?? null));
  const batch = await env.db.batch(statements);
  const inserted = records.length ? batch[0]?.meta.changes ?? 0 : 0;
  if (inserted || cursor !== progress.cursor) {
    console.log(JSON.stringify({ event: 'claude_receipts_backfill', cursor, inserted, caughtUp }));
  }
  return inserted;
}

/**
 * 永久删除前采集即将删除的收据，与删除同一个 batch 提交（纯 SQL，口径同上）。
 * 金额取 `Amount paid $` 或 `Receipt from Anthropic, PBC $` 之后的数字，卡尾号取 `with - ` 之后的 4 位数字，解析不到的列留空；
 * 已由定时任务记录过的邮件保持原记录。
 */
const PURGE_AMOUNT = `CASE WHEN instr(body_text, 'Amount paid $') > 0 THEN substr(body_text, instr(body_text, 'Amount paid $') + 13, 20)
  WHEN instr(body_text, 'Receipt from Anthropic, PBC $') > 0 THEN substr(body_text, instr(body_text, 'Receipt from Anthropic, PBC $') + 29, 20) END`;
const PURGE_CARD = `CASE WHEN instr(body_text, 'with - ') > 0 THEN substr(body_text, instr(body_text, 'with - ') + 7, 5) END`;
export const RECEIPT_PURGE_SQL = `INSERT INTO claude_receipts (message_id, address, domain, received_at, subject, amount_cents, currency, card_last4)
  SELECT id, address, domain, created_at, subject,
    CASE WHEN amount GLOB '[0-9]*' THEN CAST(round(CAST(replace(amount, ',', '') AS REAL) * 100) AS INTEGER) END,
    CASE WHEN amount GLOB '[0-9]*' THEN 'USD' END,
    CASE WHEN card GLOB '[0-9][0-9][0-9][0-9]' OR card GLOB '[0-9][0-9][0-9][0-9][^0-9]' THEN substr(card, 1, 4) END
  FROM (SELECT id, address, domain, created_at, subject, ${PURGE_AMOUNT} AS amount, ${PURGE_CARD} AS card
    FROM messages INDEXED BY idx_messages_purge_token WHERE purge_token = ?1 AND ${RECEIPT_SQL})
  WHERE true
  ON CONFLICT (message_id) DO NOTHING`;

export function harvestReceiptsPurgeStatement(env: Env, token: string): D1PreparedStatement {
  return env.db.prepare(RECEIPT_PURGE_SQL).bind(token);
}
