import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { RESERVED_USERNAMES, type UserSearchResults } from '@hpc-mail/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxShares, mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

// 共享给 CI 冒烟账号会干扰部署流水线：选人搜索不返回它，三条共享入口都拒绝它作为成员
const app = createApp();
const db = createDb(env);
const [RESERVED] = RESERVED_USERNAMES;

async function actor(username: string, role: 'admin' | 'user' = 'user') {
  // 直接落库：保留名在注册与管理员创建时已被拒绝，这里模拟 seed 脚本建出的冒烟账号
  const user = (await db.insert(users).values({ username, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
}

async function request(path: string, jwt: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function fixture() {
  await updateSettings(env, { security: { require2fa: false } });
  const reserved = await actor(RESERVED!);
  const owner = await actor('rs-owner');
  const admin = await actor('rs-admin', 'admin');
  const peer = await actor('smoke-peer');
  const box = (await db.insert(mailboxes).values({ address: 'rs-owner@reserved.test', domain: 'reserved.test', userId: owner.id })
    .returning().get())!;
  return { reserved, owner, admin, peer, box };
}

describe('系统保留用户不能作为共享成员', () => {
  let s: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { s = await fixture(); });

  it('共享选人与管理员选人搜索不返回保留用户名', async () => {
    for (const [path, jwt] of [['/mailboxes/share-users', s.owner.jwt], ['/admin/users/search', s.admin.jwt]] as const) {
      const response = await request(`${path}?q=smoke`, jwt);
      expect(response.status).toBe(200);
      const { items } = (await response.json() as { data: UserSearchResults }).data;
      // 对照：同样命中关键词的普通用户照常返回
      expect(items.map((item) => item.username), path).toEqual(['smoke-peer']);
    }
  });

  it('所有者共享、批量共享、管理员共享把保留用户作为接收人时 400，不写入名单', async () => {
    const attempts = [
      request('/mailboxes/shares', s.owner.jwt, 'PUT', { mailboxId: s.box.id, userIds: [s.peer.id, s.reserved.id] }),
      request('/mailboxes/shares/batch', s.owner.jwt, 'POST', { mailboxIds: [s.box.id], userIds: [s.reserved.id] }),
      request('/admin/mailbox-shares', s.admin.jwt, 'PUT', { mailboxId: s.box.id, userIds: [s.reserved.id] }),
      request('/admin/mailboxes/batch/share', s.admin.jwt, 'POST', { items: [{ address: s.box.address }], userIds: [s.reserved.id] }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(400);
      expect((await response.json() as { error: unknown }).error).toEqual({ code: 'validation_failed', message: '系统保留用户不能作为共享成员' });
    }
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, s.box.id)).all()).toHaveLength(0);

    // 对照：普通用户照常共享
    expect((await request('/mailboxes/shares', s.owner.jwt, 'PUT', { mailboxId: s.box.id, userIds: [s.peer.id] })).status).toBe(200);
    expect((await request('/mailboxes/shares/batch', s.owner.jwt, 'POST', { mailboxIds: [s.box.id], userIds: [s.admin.id] })).status).toBe(200);
    expect((await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, s.box.id)).all()).map((row) => row.userId).sort())
      .toEqual([s.peer.id, s.admin.id].sort());
  });
});
