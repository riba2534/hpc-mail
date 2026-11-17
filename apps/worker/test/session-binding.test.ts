import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { invites, sessions, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { register } from '../src/services/auth.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { createUser } from '../src/services/user.js';

/**
 * 2026-10-11 串号事故回归：换库切换窗口里，旧库签发给用户 A（id 103）的令牌带着 KV 里的旧会话，
 * 在新库被惰性迁入并按 id 103 解析成了另一个用户 B。会话必须只认 D1，且必须属于令牌声明的用户。
 */
const app = createApp();
const rand = () => Math.random().toString(36).slice(2, 10);

async function me(jwt: string) {
  const ctx = createExecutionContext();
  const response = await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${jwt}` } }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function user(prefix: string, migrated = true) {
  const [row] = await createDb(env).insert(users)
    .values({ username: `${prefix}-${rand()}`, role: 'user', passwordHash: 'x', status: 'active', authVersionMigrated: migrated })
    .returning();
  return row!;
}

describe('会话与令牌用户绑定', () => {
  it('正常会话可以通过鉴权', async () => {
    const a = await user('bind-ok');
    const sid = await createSession(env, a.id);
    const response = await me(await signToken(env.jwt_secret, { sub: a.id, sid, epoch: 0, uepoch: 0 }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { username: string } }).data.username).toBe(a.username);
  });

  it('只存在于 KV 的旧会话不再迁入，令牌被拒绝且不会落库', async () => {
    const b = await user('bind-kv');
    const sid = crypto.randomUUID();
    await env.kv.put(`sess:${sid}`, JSON.stringify({ userId: b.id, createdAt: Date.now() }));
    const response = await me(await signToken(env.jwt_secret, { sub: b.id, sid, epoch: 0, uepoch: 0 }));
    expect(response.status).toBe(401);
    expect(await createDb(env).select().from(sessions).where(eq(sessions.id, sid)).get()).toBeUndefined();
  });

  it('会话属于另一个用户时拒绝（快路径与未迁移用户的慢路径都适用）', async () => {
    const owner = await user('bind-owner');
    const sid = await createSession(env, owner.id);
    for (const other of [await user('bind-other'), await user('bind-legacy', false)]) {
      const response = await me(await signToken(env.jwt_secret, { sub: other.id, sid, epoch: 0, uepoch: 0 }));
      expect(response.status, other.username).toBe(401);
    }
    // 会话本身未受影响，原主人仍可使用
    expect((await me(await signToken(env.jwt_secret, { sub: owner.id, sid, epoch: 0, uepoch: 0 }))).status).toBe(200);
  });
});

describe('新用户写入即为已迁移（auth_version_migrated 恒为 1，回滚到上一版本时直接走其快路径）', () => {
  it('开放注册、邀请码注册、管理员创建三条插入路径', async () => {
    const db = createDb(env);
    const migratedOf = async (username: string) =>
      (await db.select().from(users).where(eq(users.username, username)).get())!.authVersionMigrated;
    try {
      await updateSettings(env, { register_mode: 'open' });
      const open = `bind-open-${rand()}`;
      await register(env, { username: open, password: 'password123' }, '10.9.0.1');
      expect(await migratedOf(open)).toBe(true);

      const code = `M${crypto.randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`;
      await db.insert(invites).values({ code, maxUses: 1, usedCount: 0, status: 'active' });
      await updateSettings(env, { register_mode: 'invite' });
      const invited = `bind-invite-${rand()}`;
      await register(env, { username: invited, password: 'password123', inviteCode: code }, '10.9.0.2');
      expect(await migratedOf(invited)).toBe(true);
    } finally {
      await updateSettings(env, { register_mode: 'closed' });
    }

    const created = `bind-admin-${rand()}`;
    await createUser(env, { username: created, password: 'password123', role: 'user' });
    expect(await migratedOf(created)).toBe(true);
  });
});
