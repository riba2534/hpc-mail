/**
 * /v1/admin 的查询接口：按一批地址、域名或用户名一次读出运维脚本要的视图，每个接口一条语句（一次 D1 往返）。
 * 都走唯一索引或已有的域名、所有者索引，不扫全表（无条件列出全站托管域名除外）。
 */
import type {
  AdminHostedDomainView, AdminHostedDomainsLookupQuery, AdminMailboxView, AdminMailboxesQuery, AdminUserView, AdminUsersQuery,
  Role, UserMailboxPolicy, UserStatus,
} from '@hpc-mail/shared';
import type { Env } from '../types.js';

const iso = (ms: number) => new Date(Number(ms)).toISOString();

/** 重复的查询参数用逗号拼成一个值，交给 adminLookupList 拆分（?addresses=a&addresses=b 与 ?addresses=a,b 等价） */
export function joinRepeatedQuery(queries: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(queries).map(([key, values]) => [key, values.join(',')]));
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
