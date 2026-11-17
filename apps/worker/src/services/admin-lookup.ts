/**
 * /v1/admin 的查询接口：按一批地址、域名或用户名一次读出运维脚本要的视图，每个接口一次 D1 往返（一条语句或一个 batch）。
 * 都走唯一索引或已有的域名、所有者、地址索引，不扫全表（无条件列出全站托管域名除外）。
 */
import {
  claudeTierFromAmount,
  type AdminHostedDomainView, type AdminHostedDomainsLookupQuery, type AdminMailboxView, type AdminMailboxesQuery, type AdminUserView,
  type AdminUsersQuery, type ClaudeAddressFacts, type ClaudeDomainFacts, type ClaudeReceipt, type Role, type UserMailboxPolicy,
  type UserStatus,
} from '@hpc-mail/shared';
import { getEmailDomain } from '../lib/email-address.js';
import type { Env } from '../types.js';
import { SENDER_DOMAIN } from './claude-facts.js';

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : iso(ms));

/** 按 key 分组，组内保持行的先后顺序 */
function groupBy<T, V>(rows: readonly T[], key: (row: T) => string, value: (row: T) => V): Map<string, V[]> {
  const groups = new Map<string, V[]>();
  for (const row of rows) {
    const group = groups.get(key(row));
    if (group) group.push(value(row));
    else groups.set(key(row), [value(row)]);
  }
  return groups;
}

interface MailboxRow {
  id: number;
  address: string;
  domain: string;
  user_id: number;
  owner_name: string | null;
  created_at: number;
  grantee_id: number | null;
  grantee_name: string | null;
}

/** 已认领的邮箱、所有者与共享成员；按地址排序，成员按用户名排序 */
export async function lookupAdminMailboxes(env: Env, query: AdminMailboxesQuery): Promise<AdminMailboxView[]> {
  const [where, param] = query.addresses
    ? ['m.address IN (SELECT value FROM json_each(?))', JSON.stringify(query.addresses)]
    : ['m.domain = ?', query.domain!];
  const { results } = await env.db.prepare(`SELECT m.id, m.address, m.domain, m.user_id, o.username AS owner_name, m.created_at,
      s.user_id AS grantee_id, g.username AS grantee_name
    FROM mailboxes m
    LEFT JOIN users o ON o.id = m.user_id
    LEFT JOIN mailbox_shares s ON s.mailbox_id = m.id
    LEFT JOIN users g ON g.id = s.user_id
    WHERE ${where}
    ORDER BY m.address, g.username`).bind(param).all<MailboxRow>();
  const views = new Map<number, AdminMailboxView>();
  for (const row of results) {
    let view = views.get(row.id);
    if (!view) {
      view = {
        id: row.id, address: row.address, domain: row.domain, ownerId: row.user_id, ownerUsername: row.owner_name ?? '',
        grantees: [], createdAt: iso(row.created_at),
      };
      views.set(row.id, view);
    }
    // 被分享人用户行缺失的共享不展示（同共享列表）
    if (row.grantee_id !== null && row.grantee_name !== null) view.grantees.push({ userId: row.grantee_id, username: row.grantee_name });
  }
  return [...views.values()];
}

/** 按用户名查用户；不存在的不出现在结果里，按用户名排序 */
export async function lookupAdminUsers(env: Env, query: AdminUsersQuery): Promise<AdminUserView[]> {
  const { results } = await env.db.prepare(`SELECT id, username, role, status, mailbox_policy, mailbox_policy_revision, created_at
    FROM users WHERE username IN (SELECT value FROM json_each(?)) ORDER BY username`).bind(JSON.stringify(query.usernames))
    .all<{ id: number; username: string; role: Role; status: UserStatus; mailbox_policy: string | null;
      mailbox_policy_revision: number; created_at: number }>();
  return results.map((row) => ({
    id: row.id, username: row.username, role: row.role, status: row.status,
    mailboxPolicy: row.mailbox_policy === null ? null : JSON.parse(row.mailbox_policy) as UserMailboxPolicy,
    mailboxPolicyRevision: row.mailbox_policy_revision, createdAt: iso(row.created_at),
  }));
}

/** 托管域名与收发就绪状态；domains 与 owner 取交集，都不给时返回全站。按 id 升序 */
export async function lookupAdminHostedDomains(env: Env, query: AdminHostedDomainsLookupQuery): Promise<AdminHostedDomainView[]> {
  const conditions: string[] = [];
  const params: string[] = [];
  if (query.domains) {
    conditions.push('h.domain IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(query.domains));
  }
  if (query.owner !== undefined) {
    conditions.push('h.user_id = (SELECT id FROM users WHERE username = ?)');
    params.push(query.owner);
  }
  const { results } = await env.db.prepare(`SELECT h.id, h.domain, h.user_id, u.username AS owner_name, h.status, h.zone_status,
      h.routing_status, h.sending_status, h.catch_all_ready, h.created_at
    FROM hosted_domains h LEFT JOIN users u ON u.id = h.user_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY h.id`).bind(...params)
    .all<{ id: number; domain: string; user_id: number; owner_name: string | null; status: string; zone_status: string;
      routing_status: string; sending_status: string; catch_all_ready: number; created_at: number }>();
  return results.map((row) => {
    const catchAllReady = Boolean(row.catch_all_ready);
    return {
      id: row.id, domain: row.domain, ownerId: row.user_id, ownerUsername: row.owner_name ?? '',
      status: row.status, zoneStatus: row.zone_status, routingStatus: row.routing_status, sendingStatus: row.sending_status, catchAllReady,
      ready: row.status === 'active' && row.zone_status === 'active' && row.routing_status === 'ready'
        && row.sending_status === 'ready' && catchAllReady,
      createdAt: iso(row.created_at),
    };
  });
}

// ---------- Claude 事实与收据（/v1/admin/claude） ----------

/** 每个后缀的地址数、付费数与封号地址（按 domain 索引读 claude_address_facts）。?1 域名 JSON 数组 */
export const CLAUDE_DOMAIN_COUNTS_SQL = `SELECT domain, COUNT(*) AS addresses, SUM(paid > 0) AS paid, SUM(suspended > 0) AS suspended
  FROM claude_address_facts WHERE domain IN (SELECT value FROM json_each(?1)) GROUP BY domain`;
export const CLAUDE_DOMAIN_BANS_SQL = `SELECT domain, address, suspended_at FROM claude_address_facts
  WHERE domain IN (SELECT value FROM json_each(?1)) AND suspended > 0 ORDER BY suspended_at, address`;

/** 按请求顺序返回每个域名的 Claude 事实；没有事实的域名计数为 0。一次 batch */
export async function lookupClaudeDomains(env: Env, domains: string[]): Promise<ClaudeDomainFacts[]> {
  const list = JSON.stringify(domains);
  const [counts, bans] = await env.db.batch([
    env.db.prepare(CLAUDE_DOMAIN_COUNTS_SQL).bind(list),
    env.db.prepare(CLAUDE_DOMAIN_BANS_SQL).bind(list),
  ]);
  const countsBy = new Map((counts!.results as { domain: string; addresses: number; paid: number; suspended: number }[])
    .map((row) => [row.domain, row]));
  const bansBy = groupBy(bans!.results as { domain: string; address: string; suspended_at: number | null }[],
    (row) => row.domain, (row) => ({ address: row.address, suspendedAt: isoOrNull(row.suspended_at) }));
  return domains.map((domain) => {
    const row = countsBy.get(domain);
    return {
      domain,
      addresses: row?.addresses ?? 0,
      paid: row?.paid ?? 0,
      suspended: row?.suspended ?? 0,
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

interface ReceiptLookupRow {
  address: string;
  message_id: number | null;
  received_at: number;
  subject: string;
  amount_cents: number | null;
  currency: string | null;
  card_last4: string | null;
}

function receiptOf(row: ReceiptLookupRow): ClaudeReceipt {
  return {
    messageId: row.message_id,
    receivedAt: iso(row.received_at),
    subject: row.subject,
    amountCents: row.amount_cents,
    currency: row.currency,
    tier: claudeTierFromAmount(row.amount_cents),
    cardLast4: row.card_last4,
  };
}

/**
 * 按请求顺序返回每个地址的 Claude 事实：账号与封号标志来自 claude_address_facts，Anthropic 来信统计来自 messages，
 * 收据来自 claude_receipts，三条语句一次 batch。三处都没有记录的地址 known=false。
 */
export async function lookupClaudeAddresses(env: Env, addresses: string[]): Promise<ClaudeAddressFacts[]> {
  const list = JSON.stringify(addresses);
  const [facts, stats, receipts] = await env.db.batch([
    env.db.prepare(`SELECT address, paid, suspended, first_seen_at, suspended_at FROM claude_address_facts
      WHERE address IN (SELECT value FROM json_each(?1))`).bind(list),
    env.db.prepare(CLAUDE_MAIL_STATS_SQL).bind(list),
    env.db.prepare(CLAUDE_RECEIPTS_LOOKUP_SQL).bind(list),
  ]);
  const factsBy = new Map((facts!.results as { address: string; paid: number; suspended: number; first_seen_at: number;
    suspended_at: number | null }[]).map((row) => [row.address, row]));
  const statsBy = new Map((stats!.results as { address: string; mails: number; first_at: number; last_at: number; login_links: number }[])
    .map((row) => [row.address, row]));
  const receiptsBy = groupBy(receipts!.results as ReceiptLookupRow[], (row) => row.address, (row) => row);
  return addresses.map((address) => {
    const fact = factsBy.get(address);
    const stat = statsBy.get(address);
    const rows = receiptsBy.get(address) ?? [];
    const anthropicMails = stat?.mails ?? 0;
    // 最早一次见到 Anthropic 来信：事实、现存来信与收据（原邮件可能已永久删除）取最早
    const seen = [fact?.first_seen_at, stat?.first_at, rows[0]?.received_at].filter((ms) => ms !== undefined);
    const priced = rows.findLast((row) => row.amount_cents !== null);
    return {
      address,
      domain: getEmailDomain(address),
      known: fact !== undefined || anthropicMails > 0 || rows.length > 0,
      firstSeenAt: seen.length ? iso(Math.min(...seen)) : null,
      paid: Boolean(fact?.paid) || rows.length > 0,
      suspended: Boolean(fact?.suspended),
      suspendedAt: isoOrNull(fact?.suspended_at),
      anthropicMails,
      lastAnthropicMailAt: isoOrNull(stat?.last_at),
      loginLinkMails: stat?.login_links ?? 0,
      receipts: rows.map(receiptOf),
      tier: priced ? claudeTierFromAmount(priced.amount_cents) : null,
    };
  });
}
