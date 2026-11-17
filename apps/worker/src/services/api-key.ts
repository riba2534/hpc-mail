import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
  MAX_API_USER_REQUESTS_PER_MINUTE,
  MAX_WAIT_POLLS_PER_USER_PER_MINUTE,
  type ApiKeySelf,
  type ApiKeySummary,
  type ApiRequestLogEntry,
  type ApiScope,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type Page,
  type Role,
  type UpdateApiKeyRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { apiKeys, apiRequestLogs, rateCounters, users } from '../db/schema.js';
import { bytesToHex, sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { decodeCursor, toPage } from '../lib/pagination.js';
import type { Env } from '../types.js';
import { dayWindow, OUTBOUND_QUOTA_SCOPE } from './rate-counter.js';
import { getSettings } from './setting.js';

type ApiKeyRow = typeof apiKeys.$inferSelect;

function generateKey(): { key: string; keyPrefix: string; keySuffix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = bytesToHex(bytes);
  const key = `${API_KEY_PREFIX}${hex}`;
  return { key, keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6), keySuffix: hex.slice(-4) };
}

function hashApiKey(key: string): Promise<string> {
  return sha256Hex(key);
}

function serialize(row: ApiKeyRow, ownerUsername?: string): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keySuffix: row.keySuffix,
    scopes: row.scopes as ApiScope[],
    rateLimit: row.rateLimit,
    allowedIps: row.allowedIps,
    status: row.status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    allowedMailboxIds: row.allowedMailboxIds,
    allowedDomains: row.allowedDomains,
    ...(ownerUsername !== undefined ? { ownerUsername } : {}),
  };
}

/**
 * 只有管理员能让 Key 新带上 admin scope；IP 白名单与有效期与其他 scope 一样可选。
 * role 由路由传入（会话用户的角色）；服务层直调（脚本、测试）时读库。
 */
async function assertCanGrantAdmin(db: Db, ownerId: number, role: Role | undefined): Promise<void> {
  const ownerRole = role ?? (await db.select({ role: users.role }).from(users).where(eq(users.id, ownerId)).get())?.role ?? 'user';
  if (ownerRole !== 'admin') throw new AppError('forbidden', '只有管理员可以授予 admin scope');
}

/** 限定的邮箱必须是该用户当前认领的：一次查询数命中个数 */
async function assertOwnedMailboxes(env: Env, userId: number, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const row = await env.db.prepare(`SELECT COUNT(*) AS n FROM mailboxes
    WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(ids)).first<{ n: number }>();
  if (Number(row?.n ?? 0) !== ids.length) {
    throw new AppError('validation_failed', 'allowedMailboxIds 只能包含你当前认领的邮箱 id（GET /api/mailboxes 的 id）');
  }
}

function normalizeExpiry(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new AppError('validation_failed', '过期时间必须晚于当前时间');
  }
  return date;
}

/**
 * 创建 Key。authEpoch 传入会话令牌的用户鉴权版本（uepoch）时，插入条件同时要求用户的
 * auth_version 仍等于它：改密会递增版本并吊销全部 Key，与之并发的旧令牌请求不能在吊销后再插入新 Key。
 */
/** 服务层入参：密码重新验证在路由里做；限定范围缺省为不限 */
export type CreateApiKeyParams = Omit<CreateApiKeyRequest, 'password' | 'allowedMailboxIds' | 'allowedDomains'>
  & Partial<Pick<CreateApiKeyRequest, 'allowedMailboxIds' | 'allowedDomains'>>;

export async function createApiKey(
  env: Env,
  userId: number,
  req: CreateApiKeyParams,
  authEpoch?: number,
  role?: Role,
): Promise<CreatedApiKey> {
  const db = createDb(env);
  const { key, keyPrefix, keySuffix } = generateKey();
  const keyHash = await hashApiKey(key);
  const expiresAt = normalizeExpiry(req.expiresAt);
  const allowedMailboxIds = req.allowedMailboxIds ?? [];
  const allowedDomains = req.allowedDomains ?? [];
  if (req.scopes.includes('admin')) await assertCanGrantAdmin(db, userId, role);
  await assertOwnedMailboxes(env, userId, allowedMailboxIds);
  const epochGuard = authEpoch === undefined ? '' : 'AND EXISTS (SELECT 1 FROM users WHERE id = ? AND auth_version = ?)';
  const inserted = await env.db
    .prepare(
      `INSERT INTO api_keys
        (name, key_prefix, key_suffix, key_hash, user_id, scopes, allowed_ips, allowed_mailbox_ids, allowed_domains,
         rate_limit, status, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?
       WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND status <> 'revoked') < ? ${epochGuard}
       RETURNING id`,
    )
    .bind(
      req.name,
      keyPrefix,
      keySuffix,
      keyHash,
      userId,
      JSON.stringify(req.scopes),
      JSON.stringify(req.allowedIps),
      JSON.stringify(allowedMailboxIds),
      JSON.stringify(allowedDomains),
      req.rateLimit,
      expiresAt?.getTime() ?? null,
      userId,
      MAX_API_KEYS_PER_USER,
      ...(authEpoch === undefined ? [] : [userId, authEpoch]),
    )
    .first<{ id: number }>();
  if (!inserted) {
    // 未插入只在失败路径多读一次，区分「会话已失效」与「数量已满」
    if (authEpoch !== undefined) {
      const user = await db.select({ authVersion: users.authVersion }).from(users).where(eq(users.id, userId)).get();
      if (user?.authVersion !== authEpoch) throw new AppError('unauthorized', '会话已失效');
    }
    throw new AppError('forbidden', `每个用户最多保留 ${MAX_API_KEYS_PER_USER} 个 API Key`);
  }
  const row = await db.select().from(apiKeys).where(eq(apiKeys.id, inserted.id)).get();
  if (!row) throw new AppError('internal', 'API Key 创建失败');
  return { ...serialize(row), key };
}

/** userId 传入 = 只看自己的；不传 = admin 全站视图（含 ownerUsername） */
export async function listApiKeys(env: Env, userId?: number): Promise<ApiKeySummary[]> {
  const db = createDb(env);
  if (userId !== undefined) {
    const rows = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.id))
      .all();
    return rows.filter((r) => r.status !== 'revoked').map((r) => serialize(r));
  }
  const rows = await db
    .select({ key: apiKeys, username: users.username })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.userId))
    .orderBy(desc(apiKeys.id))
    .all();
  return rows.map((r) => serialize(r.key, r.username ?? ''));
}

async function requireKey(db: Db, id: number, userId?: number): Promise<ApiKeyRow> {
  const row = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!row || row.status === 'revoked') throw new AppError('not_found', 'API Key 不存在');
  if (userId !== undefined && row.userId !== userId) throw new AppError('not_found', 'API Key 不存在');
  return row;
}

/**
 * GET /v1/me：Key 行、用户行与今日外发计数合成一个 batch；配额上限取设置（鉴权刚读过，命中 isolate 缓存）。
 * 管理员不占外发配额，上限按 0 返回并标 exempt。
 */
export async function getApiKeySelf(env: Env, keyId: number, userId: number, now = new Date()): Promise<ApiKeySelf> {
  const db = createDb(env);
  const [[keyRows, userRows, counterRows], settings] = await Promise.all([
    db.batch([
      db.select().from(apiKeys).where(eq(apiKeys.id, keyId)),
      db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(eq(users.id, userId)),
      db.select({ count: rateCounters.count, units: rateCounters.units }).from(rateCounters)
        .where(and(eq(rateCounters.scope, OUTBOUND_QUOTA_SCOPE), eq(rateCounters.subject, String(userId)), eq(rateCounters.window, dayWindow(now)))),
    ]),
    getSettings(env),
  ]);
  const [key] = keyRows;
  const [user] = userRows;
  // 鉴权之后、读取之前被吊销或删除：按无效 Key 处理
  if (!key || key.status === 'revoked' || !user) throw new AppError('unauthorized', 'API Key 无效');
  const effectiveRole: Role = user.role === 'admin' && (key.scopes as ApiScope[]).includes('admin') ? 'admin' : 'user';
  // 外发配额按 Key 的执行角色：没有 admin scope 的管理员 Key 与普通用户一样受配额约束
  const exempt = effectiveRole === 'admin';
  return {
    key: {
      id: key.id, name: key.name, keyPrefix: key.keyPrefix, keySuffix: key.keySuffix, scopes: key.scopes as ApiScope[],
      rateLimit: key.rateLimit, allowedIps: key.allowedIps,
      expiresAt: key.expiresAt ? key.expiresAt.toISOString() : null, createdAt: key.createdAt.toISOString(),
      allowedMailboxIds: key.allowedMailboxIds, allowedDomains: key.allowedDomains,
      effectiveRole,
    },
    user,
    limits: { userRequestsPerMinute: MAX_API_USER_REQUESTS_PER_MINUTE, waitPollsPerMinute: MAX_WAIT_POLLS_PER_USER_PER_MINUTE },
    outbound: {
      sent: counterRows[0]?.count ?? 0,
      recipients: counterRows[0]?.units ?? 0,
      dailyLimit: exempt ? 0 : settings.quota.dailyOutbound,
      dailyRecipientLimit: exempt ? 0 : settings.quota.dailyRecipients,
      exempt,
      resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
    },
  };
}

export async function getApiKey(env: Env, id: number, userId?: number): Promise<ApiKeySummary> {
  const db = createDb(env);
  const row = await requireKey(db, id, userId);
  return serialize(row);
}

/** 修改 Key。新授予 admin scope 需要管理员；已带 admin 的 Key 改名、改状态、白名单或有效期不再校验角色 */
export async function updateApiKey(
  env: Env,
  id: number,
  req: UpdateApiKeyRequest,
  userId?: number,
  role?: Role,
): Promise<ApiKeySummary> {
  const db = createDb(env);
  const current = await requireKey(db, id, userId);
  if (req.scopes?.includes('admin') && !current.scopes.includes('admin')) await assertCanGrantAdmin(db, current.userId, role);
  if (req.allowedMailboxIds) await assertOwnedMailboxes(env, current.userId, req.allowedMailboxIds);
  const patch: Partial<ApiKeyRow> = {};
  if (req.name !== undefined) patch.name = req.name;
  if (req.scopes !== undefined) patch.scopes = req.scopes;
  if (req.rateLimit !== undefined) patch.rateLimit = req.rateLimit;
  if (req.allowedIps !== undefined) patch.allowedIps = req.allowedIps;
  if (req.status !== undefined) patch.status = req.status;
  if (req.allowedMailboxIds !== undefined) patch.allowedMailboxIds = req.allowedMailboxIds;
  if (req.allowedDomains !== undefined) patch.allowedDomains = req.allowedDomains;
  // 续期：null 改为永久，字符串按新过期时间；undefined 不动
  if (req.expiresAt !== undefined) {
    patch.expiresAt = req.expiresAt === null ? null : normalizeExpiry(req.expiresAt);
  }
  // 吊销不可逆：条件里复核状态，与并发吊销竞争时不能把已吊销的 Key 改回 active
  const [row] = await db.update(apiKeys).set(patch).where(and(eq(apiKeys.id, id), ne(apiKeys.status, 'revoked'))).returning();
  if (!row) throw new AppError('not_found', 'API Key 不存在');
  return serialize(row);
}

export async function revokeApiKey(env: Env, id: number, userId?: number): Promise<void> {
  const db = createDb(env);
  await requireKey(db, id, userId);
  await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, id));
}

/**
 * 吊销用户全部未吊销的 Key，供改密/重置密码与密码更新放进同一个 batch：
 * 守卫要求用户密码已是本次写入的新哈希（带随机盐，唯一），密码更新未生效时不吊销。
 * 返回被吊销 Key 的 id 列表。
 */
export function revokeAllApiKeysQuery(db: Db, userId: number, newPasswordHash: string) {
  return db
    .update(apiKeys)
    .set({ status: 'revoked' })
    .where(and(eq(apiKeys.userId, userId), ne(apiKeys.status, 'revoked'),
      sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${userId} AND ${users.passwordHash} = ${newPasswordHash})`))
    .returning({ id: apiKeys.id });
}

export async function listApiKeyLogs(
  env: Env,
  apiKeyId: number,
  cursor: string | undefined,
  limit: number,
): Promise<Page<ApiRequestLogEntry>> {
  const db = createDb(env);
  const cursorId = decodeCursor(cursor);
  const rows = await db
    .select()
    .from(apiRequestLogs)
    .where(
      cursorId
        ? and(eq(apiRequestLogs.apiKeyId, apiKeyId), lt(apiRequestLogs.id, cursorId))
        : eq(apiRequestLogs.apiKeyId, apiKeyId),
    )
    .orderBy(desc(apiRequestLogs.id))
    .limit(limit + 1)
    .all();
  const page = toPage(rows, limit, (r) => r.id);
  return {
    items: page.items.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      ip: r.ip,
      durationMs: r.durationMs,
      count: r.requestCount,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}
