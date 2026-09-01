import { eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import type { Env } from '../types.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const sessKey = (sid: string) => `sess:${sid}`;
const uepochKey = (userId: number) => `uepoch:${userId}`;
const INSTANCE_EPOCH_KEY = 'instance_epoch';

/** 创建会话：D1 是鉴权真源；KV 过渡期双写，确保回滚旧 Worker 时新会话仍可用。 */
export async function createSession(env: Env, userId: number): Promise<string> {
  const sid = crypto.randomUUID();
  const now = Date.now();
  const db = createDb(env);
  await db.insert(sessions).values({
    id: sid,
    userId,
    createdAt: new Date(now),
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000),
  });
  try {
    await env.kv.put(sessKey(sid), JSON.stringify({ userId, createdAt: now }), {
      expirationTtl: SESSION_TTL_SECONDS,
    });
  } catch (e) {
    console.error('会话 KV 兼容写入失败:', e);
  }
  return sid;
}

export async function sessionExists(env: Env, sid: string): Promise<boolean> {
  const db = createDb(env);
  const row = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
  if (row) return row.revokedAt === null && row.expiresAt.getTime() > Date.now();

  // 首次升级时把仍有效的旧 KV 会话惰性迁入 D1；此后撤销均以 D1 强一致状态为准。
  try {
    const legacy = await env.kv.get<{ userId?: number; createdAt?: number }>(sessKey(sid), 'json');
    if (!legacy?.userId) return false;
    const now = Date.now();
    await db
      .insert(sessions)
      .values({
        id: sid,
        userId: legacy.userId,
        createdAt: new Date(legacy.createdAt || now),
        expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000),
      })
      .onConflictDoNothing();
    const migrated = await db.select().from(sessions).where(eq(sessions.id, sid)).get();
    return !!migrated && migrated.revokedAt === null && migrated.expiresAt.getTime() > now;
  } catch {
    return false;
  }
}

export async function destroySession(env: Env, sid: string): Promise<void> {
  const db = createDb(env);
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sid));
  try {
    await env.kv.delete(sessKey(sid));
  } catch (e) {
    console.error('会话 KV 兼容删除失败:', e);
  }
}

/** 用户代：D1 强一致；缺省视为 0。 */
export async function getUserEpoch(env: Env, userId: number): Promise<number> {
  const db = createDb(env);
  const row = await db
    .select({ authVersion: users.authVersion, migrated: users.authVersionMigrated })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) return 0;
  if (row.migrated) return row.authVersion;
  // 升级兼容：旧版本可能已在 KV 中把用户版本 bump 到非零，首次读取时迁入 D1。
  let legacy = 0;
  try {
    legacy = Number(await env.kv.get(uepochKey(userId))) || 0;
  } catch {
    // 新用户默认版本为 0；KV 仅用于升级兼容，故障不能阻断正常鉴权。
  }
  await db
    .update(users)
    .set({ authVersion: legacy, authVersionMigrated: true })
    .where(eq(users.id, userId));
  return legacy;
}

export async function bumpUserEpoch(env: Env, userId: number): Promise<number> {
  const db = createDb(env);
  const updated = await db
    .update(users)
    .set({ authVersion: sql`${users.authVersion} + 1`, authVersionMigrated: true })
    .where(eq(users.id, userId))
    .returning({ authVersion: users.authVersion })
    .get();
  const next = updated?.authVersion ?? ((Number(await env.kv.get(uepochKey(userId))) || 0) + 1);
  // 兼容回滚旧 Worker；新 Worker 不再以 KV 为鉴权真源。
  try {
    await env.kv.put(uepochKey(userId), String(next));
  } catch (e) {
    console.error('用户鉴权版本 KV 兼容写入失败:', e);
  }
  return next;
}

/** 实例代（清库全员下线）；缺省视为 0 */
export async function getInstanceEpoch(env: Env): Promise<number> {
  const v = await env.kv.get(INSTANCE_EPOCH_KEY);
  return v ? Number(v) || 0 : 0;
}

export { SESSION_TTL_SECONDS };
