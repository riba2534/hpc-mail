import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, deliveryObjectLeases, externalAttachmentLinks, mailboxes, messages, storageCleanupJobs, users } from '../src/db/schema.js';
import { chunk } from '../src/lib/d1.js';
import { signToken } from '../src/lib/jwt.js';
import { releaseMailbox } from '../src/services/mailbox.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { createSession } from '../src/services/session.js';
import { CLEANUP_JOBS_SQL, processStorageCleanup } from '../src/services/storage-cleanup.js';
import { deleteUser } from '../src/services/user.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
let sequence = 0;

/** 每个用例独占清理台账：processStorageCleanup 处理整张表 */
beforeEach(async () => { await db.delete(storageCleanupJobs); });

async function seed(messageCount = 1) {
  const name = `deferred-${++sequence}`;
  const user = (await db.insert(users).values({ username: name, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
  const address = `${name}@deferred.test`;
  const box = (await db.insert(mailboxes).values({ userId: user.id, address, domain: 'deferred.test' }).returning().get())!;
  const keys: string[] = [];
  const ids: number[] = [];
  for (let index = 0; index < messageCount; index++) {
    const raw = `deferred/${name}/${index}.eml`;
    const file = `deferred/${name}/${index}.bin`;
    await env.r2.put(raw, 'raw'); await env.r2.put(file, 'file');
    const message = (await db.insert(messages).values({ direction: 'inbound', address, domain: 'deferred.test', status: 'received',
      subject: `${name}-${index}`, rawR2Key: raw, deletedAt: new Date() }).returning().get())!;
    await db.insert(attachments).values({ messageId: message.id, r2Key: file });
    keys.push(raw, file); ids.push(message.id);
  }
  const sid = await createSession(env, user.id);
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  return { user, box, keys, ids, jwt };
}

/** R2 删除在开闸前挂起，用来观察请求是否等待清理 */
function gatedR2(onDelete?: (keys: string[]) => Promise<void>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const deletes: string[][] = [];
  const r2 = new Proxy(env.r2, { get(target, property) {
    if (property === 'delete') return async (keys: string | string[]) => {
      const list = [keys].flat();
      deletes.push(list);
      await onDelete?.(list);
      await gate;
      return target.delete(keys);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { env: { ...env, r2 } as Env, open, deletes };
}

const settled = (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'settled'),
  new Promise((resolve) => setTimeout(() => resolve('pending'), 300)),
]);
const stored = async (keys: string[]) => (await Promise.all(keys.map((key) => env.r2.head(key)))).filter(Boolean).length;
const jobsFor = async (keys: string[]) => (await db.select().from(storageCleanupJobs).where(inArray(storageCleanupJobs.r2Key, keys))).length;

describe('请求内 R2 清理移出关键路径', () => {
  it('释放并删除历史：有 ctx 时不等待 R2 删除，waitUntil 完成后对象与台账一并清除', async () => {
    const s = await seed(2);
    const gated = gatedR2();
    const ctx = createExecutionContext();
    const release = releaseMailbox(gated.env, s.user.id, s.box.id, false, true, ctx);
    expect(await settled(release)).toBe('settled');
    expect(await release).toEqual({ deletedMessages: 2 });
    // 元数据已在同一事务删除，台账保留到 R2 删除完成
    expect(await db.select().from(messages).where(inArray(messages.id, s.ids))).toHaveLength(0);
    expect(await jobsFor(s.keys)).toBe(s.keys.length);
    expect(await stored(s.keys)).toBe(s.keys.length);
    gated.open();
    await waitOnExecutionContext(ctx);
    expect(await stored(s.keys)).toBe(0);
    expect(await jobsFor(s.keys)).toBe(0);
  });

  it('没有 ctx 时保持同步：返回前已完成 R2 删除', async () => {
    const s = await seed();
    const gated = gatedR2();
    const release = releaseMailbox(gated.env, s.user.id, s.box.id, false, true);
    expect(await settled(release)).toBe('pending');
    gated.open();
    expect(await release).toEqual({ deletedMessages: 1 });
    expect(await stored(s.keys)).toBe(0);
    expect(await jobsFor(s.keys)).toBe(0);

    const purged = await seed();
    expect(await purgeMatchingMessages(env, eq(messages.address, purged.box.address))).toBe(1);
    expect(await stored(purged.keys)).toBe(0);
    expect(await jobsFor(purged.keys)).toBe(0);
  });

  it('DELETE /api/mailboxes/:id?deleteHistory=1 响应不等待 R2 删除', async () => {
    const s = await seed();
    const gated = gatedR2();
    const ctx = createExecutionContext();
    const response = Promise.resolve(app.request(`/api/mailboxes/${s.box.id}?deleteHistory=1`, { method: 'DELETE',
      headers: { Authorization: `Bearer ${s.jwt}` } }, gated.env, ctx));
    expect(await settled(response)).toBe('settled');
    const body = await (await response).json() as { data: { success: boolean; deletedMessages: number } };
    expect(body.data).toEqual({ success: true, deletedMessages: 1 });
    expect(await stored(s.keys)).toBe(s.keys.length);
    gated.open();
    await waitOnExecutionContext(ctx);
    expect(await stored(s.keys)).toBe(0);
  });

  it('同一请求多次延后清理串行执行，不重复删除同一对象', async () => {
    const s = await seed(2);
    const gated = gatedR2();
    const ctx = createExecutionContext();
    for (const id of s.ids) {
      expect(await purgeMatchingMessages(gated.env, eq(messages.id, id), 1000, ctx)).toBe(1);
    }
    gated.open();
    await waitOnExecutionContext(ctx);
    expect(await stored(s.keys)).toBe(0);
    const deleted = gated.deletes.flat();
    expect(deleted.sort()).toEqual([...s.keys].sort());
  });

  it('删除用户：有 ctx 时头像对象在 waitUntil 中删除', async () => {
    const s = await seed();
    const avatarKey = `avatar/deferred-${s.user.id}.png`;
    await env.r2.put(avatarKey, 'avatar');
    await db.update(users).set({ avatarKey }).where(eq(users.id, s.user.id));
    const admin = (await db.insert(users).values({ username: `deferred-admin-${s.user.id}`, passwordHash: 'test', role: 'admin' }).returning().get())!;
    const gated = gatedR2();
    const ctx = createExecutionContext();
    expect(await settled(deleteUser(gated.env, admin.id, s.user.id, ctx))).toBe('settled');
    expect(await env.r2.head(avatarKey)).not.toBeNull();
    gated.open();
    await waitOnExecutionContext(ctx);
    expect(await env.r2.head(avatarKey)).toBeNull();
  });
});

describe('台账清理按批判定引用', () => {
  async function jobsWith(keys: string[]) {
    for (const key of keys) await env.r2.put(key, 'object');
    for (const part of chunk(keys, 40)) await db.insert(storageCleanupJobs).values(part.map((r2Key) => ({ r2Key })));
  }

  /** 统计 D1 往返（每次 batch 与每条单独执行的语句各算一次）与 R2 删除调用 */
  function counting() {
    let trips = 0;
    const r2Calls: string[][] = [];
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        const method = Reflect.get(target, property);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          if (['first', 'all', 'run', 'raw'].includes(String(property))) trips++;
          return method.apply(target, args);
        };
      },
    });
    const counted = { ...env,
      db: new Proxy(env.db, { get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (property === 'batch') return (statements: D1PreparedStatement[]) => { trips++; return target.batch(statements); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } }),
      r2: new Proxy(env.r2, { get(target, property) {
        if (property === 'delete') return (keys: string | string[]) => { r2Calls.push([keys].flat()); return target.delete(keys); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } }),
    } as Env;
    return { env: counted, trips: () => trips, r2Calls };
  }

  it('只删孤儿对象；附件、正文、原始邮件、外链引用的对象保留且撤销台账，有租约的保留台账；往返次数与对象数无关', async () => {
    const s = await seed();
    const prefix = `cleanup-${s.user.id}`;
    const orphans = Array.from({ length: 95 }, (_, index) => `${prefix}/orphan-${index}`);
    const [shared, body, raw, link, leased] = ['shared', 'body', 'raw', 'link', 'leased'].map((name) => `${prefix}/${name}`) as [string, string, string, string, string];
    await jobsWith([...orphans, shared, body, raw, link, leased]);
    await db.insert(attachments).values({ messageId: s.ids[0]!, r2Key: shared });
    await db.insert(messages).values({ direction: 'inbound', address: s.box.address, domain: 'deferred.test', status: 'received', bodyR2Key: body, rawR2Key: raw });
    const owner = (await db.insert(attachments).values({ messageId: 999_999_999, r2Key: `${prefix}/link-source` }).returning().get())!;
    await db.insert(externalAttachmentLinks).values({ attachmentId: owner.id, r2Key: link, filename: 'f', mimeType: 'text/plain', size: 1, expiresAt: new Date(Date.now() + 86400000) });
    await db.insert(deliveryObjectLeases).values({ r2Key: leased, token: 'live', expiresAt: new Date(Date.now() + 60000) });

    const probe = counting();
    expect(await processStorageCleanup(probe.env, 200)).toBe(orphans.length + 4);
    expect(probe.trips()).toBe(2);
    expect(probe.r2Calls).toHaveLength(1);
    expect(probe.r2Calls[0]!.sort()).toEqual([...orphans].sort());
    expect(await stored(orphans)).toBe(0);
    expect(await stored([shared, body, raw, link, leased])).toBe(5);
    expect((await db.select().from(storageCleanupJobs)).map((job) => job.r2Key)).toEqual([leased]);
  });

  it('R2 删除失败保留台账并记录错误，恢复后重试成功', async () => {
    const keys = Array.from({ length: 3 }, (_, index) => `retry-${sequence}/${index}`);
    await jobsWith(keys);
    const broken = { ...env, r2: { delete: async () => { throw new Error('R2 temporarily unavailable'); } } } as unknown as Env;
    expect(await processStorageCleanup(broken)).toBe(0);
    const jobs = await db.select().from(storageCleanupJobs).where(inArray(storageCleanupJobs.r2Key, keys));
    expect(jobs.map((job) => job.lastError)).toEqual(keys.map(() => 'R2 cleanup failed; retry scheduled'));
    expect(await stored(keys)).toBe(keys.length);
    expect(await processStorageCleanup(env)).toBe(keys.length);
    expect(await stored(keys)).toBe(0);
    expect(await jobsFor(keys)).toBe(0);
  });

  it('判定后引用被并发删除：撤销台账时复核引用，留给下一轮删除对象', async () => {
    const s = await seed();
    const orphan = `race-${s.user.id}/orphan`;
    const referenced = `race-${s.user.id}/referenced`;
    await jobsWith([orphan, referenced]);
    await db.insert(attachments).values({ messageId: s.ids[0]!, r2Key: referenced });
    // 删除孤儿对象期间，引用 referenced 的最后一个附件行被删除（其清理登记因台账已存在而被忽略）
    const gated = gatedR2(async () => {
      await db.delete(attachments).where(eq(attachments.r2Key, referenced));
      await env.db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) VALUES (?)').bind(referenced).run();
    });
    gated.open();
    expect(await processStorageCleanup(gated.env)).toBe(1);
    expect(await jobsFor([referenced])).toBe(1);
    expect(await processStorageCleanup(env)).toBe(1);
    expect(await stored([orphan, referenced])).toBe(0);
    expect(await jobsFor([orphan, referenced])).toBe(0);
  });

  it('引用判定的每个子查询都走对应的 r2_key 索引', async () => {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${CLEANUP_JOBS_SQL}`).bind(Date.now(), 100).all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');
    for (const index of ['sqlite_autoindex_delivery_object_leases_1', 'idx_attachments_r2_key', 'idx_messages_body_r2', 'idx_messages_raw_r2', 'idx_external_links_r2', 'idx_draft_r2_key']) {
      expect(detail).toContain(index);
    }
    expect(detail).not.toMatch(/SCAN (attachments|messages|external_attachment_links|delivery_object_leases|draft_attachments)\b(?! USING)/);
  });
});
