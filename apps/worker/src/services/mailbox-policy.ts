import { userMailboxPolicySchema, type Role, type Settings, type UserMailboxPolicy } from '@hpc-mail/shared';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export type MailboxPolicyUser = Pick<typeof users.$inferSelect, 'id' | 'role' | 'status' | 'mailboxPolicy' | 'mailboxPolicyRevision'>;

/** 认领规则只依赖这两项设置 */
export type ClaimSettings = Pick<Settings, 'domains' | 'mailbox_policy'>;

export interface EffectiveMailboxPolicy {
  perUserLimit: number;
  domains: UserMailboxPolicy['domains'];
  reservedLocalParts: string[];
}

/**
 * 按凭据的有效角色收窄：账户角色与凭据角色取较低的。没有 admin scope 的管理员 Key 按普通用户规则认领、
 * 看可认领域名（公共域名、保留前缀与额度），不按 users.role 套用管理员规则
 */
export function asActor(user: MailboxPolicyUser, actorRole: Role): MailboxPolicyUser {
  return actorRole === 'admin' || user.role !== 'admin' ? user : { ...user, role: 'user' };
}

/** 唯一的权限解析：专属配置替代公共域名及额度，但仍需域名存在于系统中。 */
export function resolveMailboxPolicy(settings: ClaimSettings, user: MailboxPolicyUser): EffectiveMailboxPolicy {
  if (user.role === 'admin') {
    return { perUserLimit: 0, domains: settings.domains.list.map(({ domain }) => ({ domain, perUserLimit: 0 })), reservedLocalParts: [] };
  }
  if (user.mailboxPolicy !== null) {
    const parsed = userMailboxPolicySchema.safeParse(user.mailboxPolicy);
    // 存储损坏不能降级成更宽松的公共权限。
    if (!parsed.success) throw new AppError('internal', '邮箱权限配置无效，请联系管理员');
    const configured = new Set(settings.domains.list.map(({ domain }) => domain));
    return { ...parsed.data, domains: parsed.data.domains.filter(({ domain }) => configured.has(domain)),
      reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
  }
  return { perUserLimit: settings.mailbox_policy.perUserLimit,
    domains: settings.domains.list.filter((entry) => entry.public).map(({ domain, perUserLimit }) => ({ domain, perUserLimit })),
    reservedLocalParts: settings.mailbox_policy.reservedLocalParts };
}

// 单独读取与合进 D1 batch 的读取共用同一条语句与同一个行解码，避免两条路径判定漂移。

interface PolicyUserRow {
  id: number;
  role: MailboxPolicyUser['role'];
  status: MailboxPolicyUser['status'];
  mailbox_policy: string | null;
  mailbox_policy_revision: number;
}

export function mailboxPolicyUserStatement(db: D1Database, userId: number): D1PreparedStatement {
  return db.prepare('SELECT id, role, status, mailbox_policy, mailbox_policy_revision FROM users WHERE id = ?').bind(userId);
}

/** 行解码与校验：用户缺失 → not_found，禁用 → user_disabled */
export function mailboxPolicyUserFromResult(result: D1Result | undefined): MailboxPolicyUser {
  const row = result?.results?.[0] as PolicyUserRow | undefined;
  if (!row) throw new AppError('not_found', '用户不存在');
  if (row.status !== 'active') throw new AppError('user_disabled', '用户已被禁用');
  return {
    id: Number(row.id),
    role: row.role,
    status: row.status,
    mailboxPolicy: row.mailbox_policy === null ? null : JSON.parse(row.mailbox_policy) as UserMailboxPolicy,
    mailboxPolicyRevision: Number(row.mailbox_policy_revision),
  };
}

export async function loadMailboxPolicyUser(db: Db, userId: number): Promise<MailboxPolicyUser> {
  return mailboxPolicyUserFromResult(await mailboxPolicyUserStatement(db.$client, userId).all());
}

/** 认领只需这两项设置；直读 D1（强一致），解析交给 setting.ts 的 mergeSettingRows */
export function claimSettingsStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT key, value FROM settings WHERE key IN ('domains', 'mailbox_policy')`);
}
