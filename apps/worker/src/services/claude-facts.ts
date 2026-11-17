import { claudeTierFromAmount, type ClaudeAddressFacts, type ClaudeDomainFacts, type ClaudeReceipt } from '@hpc-mail/shared';
import type { Env } from '../types.js';

/**
 * 由官方来信归纳每个收件地址的 Claude 账号事实（claude_address_facts），供随机后缀按封号风险分配。
 *
 * 口径：只认通过认证的官方来信（见 CLAUDE_AUTHENTIC）；欢迎信、收据、订阅确认、封号信或任意 Claude 产品邮件算账号，
 * 只有登录魔法链接的不算。归纳幂等且单调：标志只会由否变是、时间取最早，cron 窗口重叠或永久删除前补归纳都可以重复执行。
 * 界面上写作「根据历史来信判定」。
 *
 * 2026-11 起要求 DKIM：此前按 MIME From 与主题归纳的事实保持原样，不回溯推翻；没有认证结果（auth 为 NULL）的
 * 历史邮件此后不再参与归纳（它们在收到后一小时内已被 cron 归纳过，永久删除前的补归纳不会再改变什么）。
 *
 * migrations/0019_claude_address_facts.sql 的一次性回填是当时口径的快照（已执行，不再修改）。
 */

/**
 * 官方发件域精确白名单，按线上来信统计确定（2026-11）：封号、收据、欢迎信全部来自前两个域名，
 * 另两个是研究与 Safeguards（Intercom）来信。只比对整个发件域，不做子串匹配，
 * 否则 anthropic-safeguards@evil.example 一类伪造来信就能给地址打上封号标记、让整个域名退出 Claude 策略。
 */
const CLAUDE_OFFICIAL_SENDER_DOMAINS = [
  'email.claude.com', 'mail.anthropic.com', 'research.anthropic.com', 'anthropic-safeguards.intercom-mail.com',
] as const;

/** 第一个 @ 之后的部分；含多个 @ 的畸形地址取出的不是合法域名，不会命中白名单 */
export const SENDER_DOMAIN = `lower(substr(from_address, instr(from_address, '@') + 1))`;
export const CLAUDE_OFFICIAL_SENDER = `${SENDER_DOMAIN} IN (${CLAUDE_OFFICIAL_SENDER_DOMAINS.map((domain) => `'${domain}'`).join(', ')})`;
const SUSPENDED = `subject LIKE 'Your account has been suspended%'`;
/** Anthropic 收据来信的主题（services/claude-receipts.ts 按同一主题解析收据） */
export const CLAUDE_RECEIPT_SUBJECT = `subject LIKE 'Your receipt from Anthropic%'`;
/**
 * 认证口径：Cloudflare 的 DKIM 通过、签名域与发件域相同或为其父域、From/To/Subject 头各只有一个（auth.aligned），
 * 且收件地址出现在 To 头里——正版的官方邮件被原样重投到别的地址时 DKIM 照样通过，To 头却还是原来的收件人。
 */
const DKIM_DOMAIN = `json_extract(auth, '$.dkimDomain')`;
export const CLAUDE_AUTHENTIC = `(json_extract(auth, '$.dkim') = 'pass' AND json_extract(auth, '$.aligned') = 1
    AND instr(${DKIM_DOMAIN}, '.') > 0
    AND (${SENDER_DOMAIN} = ${DKIM_DOMAIN} OR substr(${SENDER_DOMAIN}, -length(${DKIM_DOMAIN}) - 1) = '.' || ${DKIM_DOMAIN})
    AND EXISTS (SELECT 1 FROM json_each(recipients, '$.to') WHERE value = address))`;
const PAID = `(${CLAUDE_RECEIPT_SUBJECT} OR subject LIKE '%subscription is confirmed%')`;
const ACCOUNT = `(${SUSPENDED} OR ${PAID} OR subject LIKE 'Welcome to Claude%' OR ${SENDER_DOMAIN} = 'email.claude.com')`;

/**
 * scope 是限定 messages 范围的 SQL 条件（含 ? 占位），由调用方绑定参数。
 * D1 没有 STAT4，规划器会为省掉 GROUP BY 排序沿其他索引扫全表，所以显式指定与 scope 对应的索引。
 */
export function harvestSql(scope: string, index: 'idx_messages_created_id' | 'idx_messages_purge_token'): string {
  return `INSERT INTO claude_address_facts (address, domain, paid, suspended, first_seen_at, suspended_at)
  SELECT address, domain, MAX(${PAID}), MAX(${SUSPENDED}), MIN(created_at), MIN(CASE WHEN ${SUSPENDED} THEN created_at END)
  FROM messages INDEXED BY ${index}
  WHERE ${scope} AND direction = 'inbound' AND send_channel <> 'internal' AND ${CLAUDE_OFFICIAL_SENDER} AND ${CLAUDE_AUTHENTIC}
  GROUP BY address HAVING MAX(${ACCOUNT}) = 1
  ON CONFLICT(address) DO UPDATE SET
    paid = MAX(claude_address_facts.paid, excluded.paid),
    suspended = MAX(claude_address_facts.suspended, excluded.suspended),
    first_seen_at = MIN(claude_address_facts.first_seen_at, excluded.first_seen_at),
    suspended_at = COALESCE(MIN(claude_address_facts.suspended_at, excluded.suspended_at),
      claude_address_facts.suspended_at, excluded.suspended_at)`;
}

/** 永久删除前归纳即将删除的邮件，与删除同一个 batch 提交 */
export function harvestPurgeStatement(env: Env, token: string): D1PreparedStatement {
  return env.db.prepare(harvestSql('purge_token = ?', 'idx_messages_purge_token')).bind(token);
}

/** 归纳 since 之后收到的邮件；cron 用重叠窗口兜住邮件到达与统计之间的间隔 */
export async function harvestRecentClaudeFacts(env: Env, sinceMs: number): Promise<number> {
  const result = await env.db.prepare(harvestSql('created_at >= ?', 'idx_messages_created_id')).bind(sinceMs).run();
  return result.meta.changes ?? 0;
}

// ---------- 管理员查询（/v1/admin/claude） ----------

type Row = Record<string, unknown>;
const iso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

/** 每个后缀的地址数、付费数与封号地址（按 domain 索引读 claude_address_facts）。?1 域名 JSON 数组 */
export const CLAUDE_DOMAIN_COUNTS_SQL = `SELECT domain, COUNT(*) AS addresses, SUM(paid > 0) AS paid, SUM(suspended > 0) AS suspended
  FROM claude_address_facts WHERE domain IN (SELECT value FROM json_each(?1)) GROUP BY domain`;
export const CLAUDE_DOMAIN_BANS_SQL = `SELECT domain, address, suspended_at FROM claude_address_facts
  WHERE domain IN (SELECT value FROM json_each(?1)) AND suspended > 0 ORDER BY suspended_at, address`;

/** 按请求顺序返回每个域名的 Claude 事实；没有事实的域名计数为 0。一次 batch */
export async function lookupClaudeDomains(env: Env, domains: string[]): Promise<ClaudeDomainFacts[]> {
  const list = JSON.stringify(domains);
  const [counts, bans] = await env.db.batch<Row>([
    env.db.prepare(CLAUDE_DOMAIN_COUNTS_SQL).bind(list),
    env.db.prepare(CLAUDE_DOMAIN_BANS_SQL).bind(list),
  ]);
  const countsBy = new Map((counts?.results ?? []).map((row) => [String(row.domain), row]));
  const bansBy = new Map<string, ClaudeDomainFacts['suspendedAddresses']>();
  for (const row of bans?.results ?? []) {
    const banned = bansBy.get(String(row.domain)) ?? [];
    banned.push({ address: String(row.address), suspendedAt: iso(row.suspended_at) });
    bansBy.set(String(row.domain), banned);
  }
  return domains.map((domain) => {
    const row = countsBy.get(domain);
    return {
      domain,
      addresses: Number(row?.addresses ?? 0),
      paid: Number(row?.paid ?? 0),
      suspended: Number(row?.suspended ?? 0),
      suspendedAddresses: bansBy.get(domain) ?? [],
    };
  });
}

/** 发件域为 anthropic.com、claude.com 或它们的子域；含多个 @ 的畸形地址不算 */
const ANTHROPIC_SENDER = `(instr(${SENDER_DOMAIN}, '@') = 0 AND (${SENDER_DOMAIN} IN ('anthropic.com', 'claude.com')
  OR ${SENDER_DOMAIN} LIKE '%.anthropic.com' OR ${SENDER_DOMAIN} LIKE '%.claude.com'))`;
const LOGIN_LINK = `(subject LIKE 'Secure link to log in to Claude%' OR subject LIKE 'Your secure link to Claude%')`;
/**
 * 每个地址的 Anthropic 来信统计，含回收站。json_each 驱动外层循环，每个地址按等值走 address 前缀索引，
 * 只读这些地址自己的邮件（导出供 EXPLAIN 回归）。?1 地址 JSON 数组
 */
export const CLAUDE_MAIL_STATS_SQL = `SELECT j.value AS address, COUNT(*) AS mails, MIN(m.created_at) AS first_at,
  MAX(m.created_at) AS last_at, SUM(${LOGIN_LINK}) AS login_links
  FROM json_each(?1) j CROSS JOIN messages m ON m.address = j.value
  WHERE m.direction = 'inbound' AND m.send_channel <> 'internal' AND ${ANTHROPIC_SENDER}
  GROUP BY j.value`;
/** 收据按收到时间升序；原邮件已永久删除的 message_id 显示为 null（按主键查邮件是否还在）。?1 地址 JSON 数组 */
export const CLAUDE_RECEIPTS_LOOKUP_SQL = `SELECT r.address,
  CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id) THEN r.message_id END AS message_id,
  r.received_at, r.subject, r.amount_cents, r.currency, r.card_last4
  FROM claude_receipts r WHERE r.address IN (SELECT value FROM json_each(?1)) ORDER BY r.received_at, r.id`;

function receiptOf(row: Row): ClaudeReceipt {
  const amountCents = row.amount_cents === null ? null : Number(row.amount_cents);
  return {
    messageId: row.message_id === null ? null : Number(row.message_id),
    receivedAt: iso(row.received_at)!,
    subject: String(row.subject),
    amountCents,
    currency: (row.currency as string | null) ?? null,
    tier: claudeTierFromAmount(amountCents),
    cardLast4: (row.card_last4 as string | null) ?? null,
  };
}

/**
 * 按请求顺序返回每个地址的 Claude 事实：账号与封号标志来自 claude_address_facts，Anthropic 来信统计来自 messages，
 * 收据来自 claude_receipts，三条语句一次 batch。三处都没有记录的地址 known=false。
 */
export async function lookupClaudeAddresses(env: Env, addresses: string[]): Promise<ClaudeAddressFacts[]> {
  const list = JSON.stringify(addresses);
  const [facts, stats, receipts] = await env.db.batch<Row>([
    env.db.prepare(`SELECT address, paid, suspended, first_seen_at, suspended_at FROM claude_address_facts
      WHERE address IN (SELECT value FROM json_each(?1))`).bind(list),
    env.db.prepare(CLAUDE_MAIL_STATS_SQL).bind(list),
    env.db.prepare(CLAUDE_RECEIPTS_LOOKUP_SQL).bind(list),
  ]);
  const factsBy = new Map((facts?.results ?? []).map((row) => [String(row.address), row]));
  const statsBy = new Map((stats?.results ?? []).map((row) => [String(row.address), row]));
  const receiptsBy = new Map<string, ClaudeReceipt[]>();
  for (const row of receipts?.results ?? []) {
    const own = receiptsBy.get(String(row.address)) ?? [];
    own.push(receiptOf(row));
    receiptsBy.set(String(row.address), own);
  }
  return addresses.map((address) => {
    const fact = factsBy.get(address);
    const stat = statsBy.get(address);
    const own = receiptsBy.get(address) ?? [];
    const anthropicMails = Number(stat?.mails ?? 0);
    // 最早一次见到 Anthropic 来信：事实、现存来信与收据（原邮件可能已永久删除）取最早
    const seen = [fact?.first_seen_at, stat?.first_at, own[0] ? Date.parse(own[0].receivedAt) : null]
      .filter((value) => value !== null && value !== undefined).map(Number);
    const priced = own.findLast((receipt) => receipt.amountCents !== null);
    return {
      address,
      domain: address.slice(address.lastIndexOf('@') + 1),
      known: fact !== undefined || anthropicMails > 0 || own.length > 0,
      firstSeenAt: seen.length ? iso(Math.min(...seen)) : null,
      paid: Boolean(fact?.paid) || own.length > 0,
      suspended: Boolean(fact?.suspended),
      suspendedAt: iso(fact?.suspended_at),
      anthropicMails,
      lastAnthropicMailAt: iso(stat?.last_at),
      loginLinkMails: Number(stat?.login_links ?? 0),
      receipts: own,
      tier: priced ? priced.tier : null,
    };
  });
}
