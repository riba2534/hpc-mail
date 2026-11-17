import { RESERVED_USERNAMES, type AdminUser, type CreateUserRequest, type SearchUsersQuery, type UpdateUserRequest, type UserSearchResults } from '@hpc-mail/shared';
import { and, asc, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { mailboxes, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import type { Env, ExecCtx } from '../types.js';
import { revokeAllApiKeysQuery } from './api-key.js';
import { avatarUrl } from './avatar.js';
import { getSettingsFresh } from './setting.js';

type UserRow = typeof users.$inferSelect;

function isLastAdminConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('last_active_admin');
}

/** 保证不会移除最后一个可用 admin（禁用/降级/删除该 admin 前调用） */
async function assertNotLastAdmin(db: Db, targetId: number): Promise<void> {
  const other = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), ne(users.id, targetId)))
    .get();
  if (!other) throw new AppError('forbidden', '至少保留一个可用管理员，无法执行此操作');
}

/** 全部启用状态的管理员 id：未认领地址收到的邮件按这些管理员的个人偏好处理 */
export async function getActiveAdminIds(env: Env): Promise<number[]> {
  const db = createDb(env);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
    .all();
  return rows.map((r) => r.id);
}

const apiKeyCountSql = sql<number>`(SELECT COUNT(*) FROM api_keys WHERE api_keys.user_id = users.id)`;

function serialize(row: UserRow, mailboxAddresses: string[], apiKeyCount: number): AdminUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    mailboxCount: mailboxAddresses.length,
    mailboxPolicy: row.mailboxPolicy,
    mailboxPolicyRevision: row.mailboxPolicyRevision,
    mailboxes: mailboxAddresses,
    apiKeyCount,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
    avatarUrl: avatarUrl(row.id, row.avatarKey),
  };
}

async function listMailboxAddresses(db: Db, userId: number): Promise<string[]> {
  const rows = await db
    .select({ address: mailboxes.address })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId))
    .orderBy(mailboxes.address)
    .all();
  return rows.map((r) => r.address);
}

export async function listUsers(env: Env): Promise<AdminUser[]> {
  const db = createDb(env);
  const rows = await db
    .select({ user: users, apiKeyCount: apiKeyCountSql })
    .from(users)
    .orderBy(desc(users.id))
    .all();
  const addressRows = await db
    .select({ userId: mailboxes.userId, address: mailboxes.address })
    .from(mailboxes)
    .orderBy(mailboxes.address)
    .all();
  const byUser = new Map<number, string[]>();
  for (const r of addressRows) {
    const list = byUser.get(r.userId);
    if (list) list.push(r.address);
    else byUser.set(r.userId, [r.address]);
  }
  return rows.map((r) => serialize(r.user, byUser.get(r.user.id) ?? [], Number(r.apiKeyCount)));
}

/**
 * 选人搜索（共享成员、托管域名成员、过户目标）：只读必要字段，限制结果数，不扫描/返回用户的全部邮箱及 Key 统计；
 * 系统保留账号（CI 冒烟用户）不出现在候选里。
 */
export async function searchUsers(env: Env, req: SearchUsersQuery, opts: { includeRole?: boolean } = {}): Promise<UserSearchResults> {
  const rows = await createDb(env).select({ id: users.id, username: users.username, role: users.role })
    .from(users)
    .where(and(eq(users.status, 'active'),
      notInArray(users.username, [...RESERVED_USERNAMES]),
      sql`instr(lower(${users.username}), ${req.q}) > 0`,
      req.excludeUserId === undefined ? undefined : ne(users.id, req.excludeUserId)))
    .orderBy(sql`CASE WHEN lower(${users.username}) = ${req.q} THEN 0
      WHEN substr(lower(${users.username}), 1, ${req.q.length}) = ${req.q} THEN 1 ELSE 2 END`, asc(users.username))
    .limit(req.limit + 1).all();
  // 只有管理员的搜索带角色：普通用户的共享候选搜索不能用来定位管理员账号
  const items = rows.slice(0, req.limit).map((row) => (opts.includeRole ? row : { id: row.id, username: row.username }));
  return { items, hasMore: rows.length > req.limit };
}

export async function createUser(env: Env, req: CreateUserRequest): Promise<AdminUser> {
  const db = createDb(env);
  if (RESERVED_USERNAMES.includes(req.username)) throw new AppError('conflict', '该用户名为系统保留，不能使用');
  const existing = await db.select().from(users).where(eq(users.username, req.username)).get();
  if (existing) throw new AppError('conflict', '用户名已存在');
  const passwordHash = await hashPassword(req.password);
  const [row] = await db
    .insert(users)
    .values({ username: req.username, passwordHash, role: req.role, status: 'active', authVersionMigrated: true })
    .returning();
  return serialize(row!, [], 0);
}

/**
 * 管理员修改用户。重置密码时同一 batch 事务里吊销该用户全部 API Key（不可选）：
 * 重置通常意味着账号可能失窃，Key 不比较鉴权版本，只踢会话收不回它。
 */
export async function updateUser(
  env: Env,
  actingUserId: number,
  id: number,
  req: UpdateUserRequest,
): Promise<{ user: AdminUser; revokedApiKeys: number }> {
  const db = createDb(env);
  const target = await db.select().from(users).where(eq(users.id, id)).get();
  if (!target) throw new AppError('not_found', '用户不存在');

  const patch: Partial<UserRow> = {};
  let bumpEpoch = false;
  let domainsRevision: number | undefined;
  if (req.mailboxPolicy !== undefined) {
    if (req.expectedMailboxPolicyRevision !== target.mailboxPolicyRevision) {
      throw new AppError('conflict', '邮箱权限已被其他请求修改，请刷新后重试');
    }
    if (req.mailboxPolicy !== null) {
      const settings = await getSettingsFresh(env);
      const configured = new Set(settings.domains.list.map(({ domain }) => domain));
      if (req.mailboxPolicy.domains.some(({ domain }) => !configured.has(domain))) {
        throw new AppError('validation_failed', '只能授权已配置的系统域名');
      }
      domainsRevision = settings.domains.revision ?? 0;
    }
    patch.mailboxPolicy = req.mailboxPolicy;
  }

  if (req.status !== undefined) {
    if (req.status === 'disabled' && id === actingUserId) {
      throw new AppError('forbidden', '不能禁用自己');
    }
    // 禁用一个 admin 前，确保还有其他可用 admin
    if (req.status === 'disabled' && target.role === 'admin') {
      await assertNotLastAdmin(db, id);
    }
    patch.status = req.status;
    if (req.status === 'disabled') bumpEpoch = true;
  }
  // admin 降级为普通用户前，确保还有其他可用 admin（防降到 0 admin）
  if (req.role !== undefined) {
    if (req.role !== 'admin' && target.role === 'admin') {
      await assertNotLastAdmin(db, id);
    }
    patch.role = req.role;
  }
  if (req.password !== undefined) {
    patch.passwordHash = await hashPassword(req.password);
    bumpEpoch = true;
  }

  let row: UserRow | undefined;
  let revokedApiKeys = 0;
  try {
    const update = db.update(users).set({ ...patch,
      ...(req.mailboxPolicy !== undefined || req.role !== undefined ? { mailboxPolicyRevision: sql`${users.mailboxPolicyRevision} + 1` } : {}),
      ...(bumpEpoch ? { authVersion: sql`${users.authVersion} + 1` } : {}),
    }).where(and(eq(users.id, id),
      req.mailboxPolicy === undefined ? undefined : eq(users.mailboxPolicyRevision, req.expectedMailboxPolicyRevision!),
      domainsRevision === undefined ? undefined : sql`COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) = ${domainsRevision}`,
    )).returning();
    if (patch.passwordHash) {
      const [rows, revoked] = await db.batch([update, revokeAllApiKeysQuery(db, id, patch.passwordHash)]);
      row = rows[0];
      revokedApiKeys = revoked.length;
    } else {
      [row] = await update;
    }
  } catch (error) {
    if (isLastAdminConstraint(error)) {
      throw new AppError('forbidden', '至少保留一个可用管理员，无法执行此操作');
    }
    throw error;
  }
  if (!row) throw new AppError('conflict', '用户或域名配置已改变，请刷新后重试');

  const count = await db
    .select({ apiKeyCount: apiKeyCountSql })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return { user: serialize(row!, await listMailboxAddresses(db, id), Number(count?.apiKeyCount ?? 0)), revokedApiKeys };
}

/**
 * 删除用户：级联清理 mailboxes / mailbox_shares / api_keys / stars / 头像 R2 对象，避免僵尸数据。
 * messages 不动（仍按 address 归属，随地址回未认领态）。
 */
export async function deleteUser(env: Env, actingUserId: number, id: number, ctx?: ExecCtx | null): Promise<void> {
  if (id === actingUserId) throw new AppError('forbidden', '不能删除自己');
  const db = createDb(env);
  const target = await db
    .select({ id: users.id, role: users.role, avatarKey: users.avatarKey })
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (!target) throw new AppError('not_found', '用户不存在');
  if (target.role === 'admin') await assertNotLastAdmin(db, id);
  // 托管域名不能没有所有者：先过户或删除
  const hosted = await env.db.prepare("SELECT domain FROM hosted_domains WHERE user_id = ? AND status <> 'deleting' LIMIT 5")
    .bind(id).all<{ domain: string }>();
  if (hosted.results.length) {
    throw new AppError('conflict', `该用户还拥有托管域名 ${hosted.results.map((row) => row.domain).join('、')}，请先过户或删除`);
  }

  // D1 batch 作为一个事务提交：最后管理员触发器若拒绝 DELETE，前面的关联清理也会整体回滚。
  try {
    await env.db.batch([
      env.db.prepare('DELETE FROM hosted_domain_members WHERE user_id = ?').bind(id),
      env.db.prepare('DELETE FROM mailbox_shares WHERE user_id = ?').bind(id),
      env.db
        .prepare('DELETE FROM mailbox_shares WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)')
        .bind(id),
      env.db.prepare('DELETE FROM mailboxes WHERE user_id = ?').bind(id),
      env.db.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(id),
      env.db.prepare('DELETE FROM stars WHERE user_id = ?').bind(id),
      env.db.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
  } catch (error) {
    if (isLastAdminConstraint(error)) {
      throw new AppError('forbidden', '至少保留一个可用管理员，无法执行此操作');
    }
    throw error;
  }
  if (target.avatarKey) {
    // 头像对象尽力删除：有 ctx 时放进 waitUntil，不阻塞响应
    const removal = env.r2.delete(target.avatarKey).catch((e: unknown) => {
      console.error('删除用户头像对象失败:', e);
    });
    if (ctx) ctx.waitUntil(removal);
    else await removal;
  }
}
