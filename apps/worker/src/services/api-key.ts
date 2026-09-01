import {
  API_KEY_PREFIX,
  MAX_API_KEYS_PER_USER,
  type ApiKeySummary,
  type ApiRequestLogEntry,
  type ApiScope,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  type Page,
  type UpdateApiKeyRequest,
} from '@hpc-mail/shared';
import { and, desc, eq, lt } from 'drizzle-orm';
import { createDb, type Db } from '../db/client.js';
import { apiKeys, apiRequestLogs, users } from '../db/schema.js';
import { bytesToHex, sha256Hex } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { encodeCursor, decodeCursor } from '../lib/pagination.js';
import type { Env } from '../types.js';

type ApiKeyRow = typeof apiKeys.$inferSelect;

function generateKey(): { key: string; keyPrefix: string; keySuffix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = bytesToHex(bytes);
  const key = `${API_KEY_PREFIX}${hex}`;
  return { key, keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6), keySuffix: hex.slice(-4) };
}

export function hashApiKey(key: string): Promise<string> {
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
    ...(ownerUsername !== undefined ? { ownerUsername } : {}),
  };
}

function normalizeExpiry(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new AppError('validation_failed', '过期时间必须晚于当前时间');
  }
  return date;
}

export async function createApiKey(
  env: Env,
  userId: number,
  req: CreateApiKeyRequest,
): Promise<CreatedApiKey> {
  const db = createDb(env);
  const { key, keyPrefix, keySuffix } = generateKey();
  const keyHash = await hashApiKey(key);
  const expiresAt = normalizeExpiry(req.expiresAt);
  const inserted = await env.db
    .prepare(
      `INSERT INTO api_keys
        (name, key_prefix, key_suffix, key_hash, user_id, scopes, allowed_ips, rate_limit, status, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?
       WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND status <> 'revoked') < ?
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
      req.rateLimit,
      expiresAt?.getTime() ?? null,
      userId,
      MAX_API_KEYS_PER_USER,
    )
    .first<{ id: number }>();
  if (!inserted) {
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

export async function getApiKey(env: Env, id: number, userId?: number): Promise<ApiKeySummary> {
  const db = createDb(env);
  const row = await requireKey(db, id, userId);
  return serialize(row);
}

export async function updateApiKey(
  env: Env,
  id: number,
  req: UpdateApiKeyRequest,
  userId?: number,
): Promise<ApiKeySummary> {
  const db = createDb(env);
  await requireKey(db, id, userId);
  const patch: Partial<ApiKeyRow> = {};
  if (req.name !== undefined) patch.name = req.name;
  if (req.scopes !== undefined) patch.scopes = req.scopes;
  if (req.rateLimit !== undefined) patch.rateLimit = req.rateLimit;
  if (req.allowedIps !== undefined) patch.allowedIps = req.allowedIps;
  if (req.status !== undefined) patch.status = req.status;
  // 续期：null 改为永久，字符串按新过期时间；undefined 不动
  if (req.expiresAt !== undefined) {
    patch.expiresAt = req.expiresAt === null ? null : normalizeExpiry(req.expiresAt);
  }
  const [row] = await db.update(apiKeys).set(patch).where(eq(apiKeys.id, id)).returning();
  return serialize(row!);
}

export async function revokeApiKey(env: Env, id: number, userId?: number): Promise<void> {
  const db = createDb(env);
  await requireKey(db, id, userId);
  await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, id));
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
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map((r) => ({
      id: r.id,
      requestId: r.requestId,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      ip: r.ip,
      durationMs: r.durationMs,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
  };
}
