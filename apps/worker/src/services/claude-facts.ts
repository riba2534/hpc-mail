import type { Env } from '../types.js';

/**
 * 由官方来信归纳每个收件地址的 Claude 账号事实（claude_address_facts），供随机后缀按封号风险分配。
 *
 * 口径：只认通过认证的官方来信（见 AUTHENTIC）；欢迎信、收据、订阅确认、封号信或任意 Claude 产品邮件算账号，
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
const SENDER_DOMAIN = `lower(substr(from_address, instr(from_address, '@') + 1))`;
const OFFICIAL = `${SENDER_DOMAIN} IN (${CLAUDE_OFFICIAL_SENDER_DOMAINS.map((domain) => `'${domain}'`).join(', ')})`;
const SUSPENDED = `subject LIKE 'Your account has been suspended%'`;
/**
 * 认证口径：Cloudflare 的 DKIM 通过、签名域与发件域相同或为其父域、From/To/Subject 头各只有一个（auth.aligned），
 * 且收件地址出现在 To 头里——正版的官方邮件被原样重投到别的地址时 DKIM 照样通过，To 头却还是原来的收件人。
 */
const DKIM_DOMAIN = `json_extract(auth, '$.dkimDomain')`;
const AUTHENTIC = `json_extract(auth, '$.dkim') = 'pass' AND json_extract(auth, '$.aligned') = 1
    AND instr(${DKIM_DOMAIN}, '.') > 0
    AND (${SENDER_DOMAIN} = ${DKIM_DOMAIN} OR substr(${SENDER_DOMAIN}, -length(${DKIM_DOMAIN}) - 1) = '.' || ${DKIM_DOMAIN})
    AND EXISTS (SELECT 1 FROM json_each(recipients, '$.to') WHERE value = address)`;
const PAID = `(subject LIKE 'Your receipt from Anthropic%' OR subject LIKE '%subscription is confirmed%')`;
const ACCOUNT = `(${SUSPENDED} OR ${PAID} OR subject LIKE 'Welcome to Claude%' OR ${SENDER_DOMAIN} = 'email.claude.com')`;

/**
 * scope 是限定 messages 范围的 SQL 条件（含 ? 占位），由调用方绑定参数。
 * D1 没有 STAT4，规划器会为省掉 GROUP BY 排序沿其他索引扫全表，所以显式指定与 scope 对应的索引。
 */
export function harvestSql(scope: string, index: 'idx_messages_created_id' | 'idx_messages_purge_token'): string {
  return `INSERT INTO claude_address_facts (address, domain, paid, suspended, first_seen_at, suspended_at)
  SELECT address, domain, MAX(${PAID}), MAX(${SUSPENDED}), MIN(created_at), MIN(CASE WHEN ${SUSPENDED} THEN created_at END)
  FROM messages INDEXED BY ${index}
  WHERE ${scope} AND direction = 'inbound' AND send_channel <> 'internal' AND ${OFFICIAL} AND ${AUTHENTIC}
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
