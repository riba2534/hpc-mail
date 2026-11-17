import type { CreateInviteRequest, Invite } from '@hpc-mail/shared';
import { desc, eq, isNotNull } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { invites, users } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';

type InviteRow = typeof invites.$inferSelect;
const CODE_LENGTH = 12;
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH * 2);
  crypto.getRandomValues(bytes);
  let out = '';
  const limit = Math.floor(256 / CHARS.length) * CHARS.length;
  for (const byte of bytes) {
    if (byte >= limit) continue;
    out += CHARS[byte % CHARS.length];
    if (out.length === CODE_LENGTH) break;
  }
  return out.length === CODE_LENGTH ? out : (out + generateCode()).slice(0, CODE_LENGTH);
}

function computeStatus(row: InviteRow, now = Date.now()): Invite['status'] {
  if (row.status === 'revoked') return 'revoked';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  if (row.usedCount >= row.maxUses) return 'exhausted';
  return 'usable';
}

function serialize(row: InviteRow, usedBy: string[] = []): Invite {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    status: computeStatus(row),
    usedBy,
  };
}

export async function createInvites(
  env: Env,
  createdBy: number,
  req: CreateInviteRequest,
): Promise<Invite[]> {
  const db = createDb(env);
  const expiresAt = req.expiresAt ? new Date(req.expiresAt) : null;
  const values = Array.from({ length: req.count }, () => ({
    code: generateCode(),
    maxUses: req.maxUses,
    usedCount: 0,
    expiresAt,
    note: req.note,
    status: 'active' as const,
    createdBy,
  }));
  // 每行绑定 7 个参数，一次最多 50 行会超过 D1 的 100 个上限：每批 14 行，放进同一个 batch（一次往返、同一事务）
  const [first, ...rest] = chunk(values, 14).map((part) => db.insert(invites).values(part).returning());
  const rows = (await db.batch([first!, ...rest])).flat();
  return rows.map((row) => serialize(row));
}

export async function listInvites(env: Env): Promise<Invite[]> {
  const db = createDb(env);
  const [rows, registrants] = await Promise.all([
    db.select().from(invites).orderBy(desc(invites.id)).all(),
    db
      .select({ inviteId: users.inviteId, username: users.username })
      .from(users)
      .where(isNotNull(users.inviteId))
      .all(),
  ]);
  const byInvite = new Map<number, string[]>();
  for (const r of registrants) {
    if (r.inviteId === null) continue;
    const list = byInvite.get(r.inviteId) ?? [];
    list.push(r.username);
    byInvite.set(r.inviteId, list);
  }
  return rows.map((row) => serialize(row, byInvite.get(row.id) ?? []));
}

export async function revokeInvite(env: Env, id: number): Promise<void> {
  const db = createDb(env);
  const row = await db.select({ id: invites.id }).from(invites).where(eq(invites.id, id)).get();
  if (!row) throw new AppError('not_found', '邀请码不存在');
  await db.update(invites).set({ status: 'revoked' }).where(eq(invites.id, id));
}
