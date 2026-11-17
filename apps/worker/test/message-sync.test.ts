import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { ListMessagesQuery, MessageListPage, MessageSyncResult } from '@hpc-mail/shared';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments as attachmentsTable, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import {
  countUnread, findNextMessage, getMessageDetail, getThread, listMessages, syncMessages, UNREAD_COUNT_CAP,
} from '../src/services/message.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const post = (token: string, body: unknown): RequestInit =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const rand = () => crypto.randomUUID().slice(0, 8);

/** 同文件用例共享 D1/KV：用户名与地址都带随机后缀 */
async function account(prefix: string, role: 'admin' | 'user' = 'user') {
  await updateSettings(env, { api: { enabled: true } });
  const [user] = await createDb(env).insert(users)
    .values({ username: `${prefix}-${rand()}`, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await createApiKey(env, user!.id, { name: `${prefix}-key`, scopes: ['mail.read', 'mail.write'], rateLimit: 1000, allowedIps: [] });
  const address = `${prefix}-${rand()}@sync.test`;
  const [box] = await createDb(env).insert(mailboxes).values({ address, domain: 'sync.test', userId: user!.id }).returning({ id: mailboxes.id });
  return { id: user!.id, role, jwt, key: key.key, address, boxId: box!.id };
}

async function mail(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  const [row] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@example.net',
    subject: 'hello', preview: 'hello', status: 'received', ...extra,
  }).returning({ id: messages.id });
  return row!.id;
}

const list = (token: string, query: string) => request(`/api/messages?${query}`, auth(token)).then((r) => data<MessageListPage>(r));
const sync = (token: string, query: string) => request(`/api/messages/sync?${query}`, auth(token)).then((r) => data<MessageSyncResult>(r));

describe('GET /api/messages/sync 与列表首页 head', () => {
  it('同一筛选、同一 limit 下 sync 与列表首页 head 相同；unread 同 /unread-count；后续页、增量页与 /v1 不带 head', async () => {
    const owner = await account('sync-owner');
    const viewer = await account('sync-viewer');
    await createDb(env).insert(mailboxShares).values({ mailboxId: owner.boxId, userId: viewer.id, grantedBy: owner.id });
    const ids = [
      await mail(viewer.address, { subject: 'hello alpha' }),
      await mail(viewer.address, { direction: 'outbound', status: 'sent', isRead: true, recipients: { to: ['x@example.net'], cc: [], bcc: [] } }),
      await mail(owner.address, { subject: 'shared hello' }),
      await mail(viewer.address, { isRead: true }),
      await mail(viewer.address, { deletedAt: new Date() }),
    ];
    await data(await request('/api/messages/star', post(viewer.jwt, { ids: [ids[2]], starred: true })));

    const unread = (await data<{ unread: number }>(await request('/api/messages/unread-count', auth(viewer.jwt)))).unread;
    expect(unread).toBe(1);
    const filters = ['', 'direction=inbound', 'direction=outbound', 'unread=1', 'starred=1', 'trash=1', 'q=hello',
      'domain=sync.test', `address=${encodeURIComponent(owner.address)}`, 'limit=1', 'limit=2&direction=inbound', 'scope=mine'];
    const heads = new Set<string>();
    for (const filter of filters) {
      const page = await list(viewer.jwt, filter);
      const polled = await sync(viewer.jwt, filter);
      expect(typeof page.head, filter).toBe('string');
      expect(polled, filter).toEqual({ unread, head: page.head });
      heads.add(page.head!);
    }
    // 不同首页给出不同指纹（共 12 组筛选，其中 domain/scope=mine 与全部视图首页相同）
    expect(heads.size).toBeGreaterThanOrEqual(8);

    // sync 忽略 cursor/afterId；带 cursor 或 afterId 的列表页不是首页，不带 head
    const first = await list(viewer.jwt, 'limit=1');
    expect(first.nextCursor).toBeTruthy();
    expect(await sync(viewer.jwt, `limit=1&cursor=${first.nextCursor}&afterId=${ids[4]}`)).toEqual({ unread, head: first.head });
    const second = await list(viewer.jwt, `limit=1&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second).not.toHaveProperty('head');
    expect(await list(viewer.jwt, `afterId=${ids[0]}`)).not.toHaveProperty('head');
    const v1 = await data<MessageListPage>(await request('/v1/messages', auth(viewer.key)));
    expect(v1.items.length).toBeGreaterThan(0);
    expect(v1).not.toHaveProperty('head');
  });

  it('head 随首页任何可见变化而变（已读/星标/验证码与链接补写/状态/删除恢复/新邮件/nextCursor），首页外的变化不改', async () => {
    const user = await account('sync-head');
    const m1 = await mail(user.address);
    const m2 = await mail(user.address);
    const m3 = await mail(user.address);
    const query = 'limit=2';
    const head = async () => {
      const polled = await sync(user.jwt, query);
      expect((await list(user.jwt, query)).head).toBe(polled.head);
      return polled.head;
    };
    const steps: [string, () => Promise<unknown>][] = [
      ['已读', () => request('/api/messages/read', post(user.jwt, { ids: [m3], isRead: true }))],
      ['星标', () => request('/api/messages/star', post(user.jwt, { ids: [m2], starred: true }))],
      ['验证码补写', () => createDb(env).update(messages).set({ verificationCode: 'AB12CD' }).where(eq(messages.id, m3))],
      ['验证链接补写', () => createDb(env).update(messages).set({ verificationLink: 'https://example.net/verify?t=1' }).where(eq(messages.id, m2))],
      ['状态', () => createDb(env).update(messages).set({ status: 'degraded' }).where(eq(messages.id, m3))],
    ];
    let previous = await head();
    expect(await head()).toBe(previous);
    // 首页外（m1 是第 3 封）的已读变化不影响首页
    await data(await request('/api/messages/read', post(user.jwt, { ids: [m1], isRead: true })));
    expect(await head()).toBe(previous);
    for (const [label, change] of steps) {
      await change();
      const next = await head();
      expect(next, label).not.toBe(previous);
      previous = next;
    }

    const beforeDelete = previous;
    await data(await request('/api/messages/delete', post(user.jwt, { ids: [m3] })));
    const afterDelete = await head();
    expect(afterDelete).not.toBe(beforeDelete);
    await data(await request('/api/messages/restore', post(user.jwt, { ids: [m3] })));
    expect(await head()).toBe(beforeDelete);

    // 只有 nextCursor 变化：删掉首页之外唯一的一封，首页条目不变但不再有下一页
    const page = await list(user.jwt, query);
    expect(page.nextCursor).toBeTruthy();
    await createDb(env).update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, m1));
    const noMore = await list(user.jwt, query);
    expect(noMore.items).toEqual(page.items);
    expect(noMore.nextCursor).toBeNull();
    expect(noMore.head).not.toBe(page.head);
    expect((await sync(user.jwt, query)).head).toBe(noMore.head);

    await mail(user.address);
    expect(await head()).not.toBe(noMore.head);
  });

  it('/api 未读数封顶 1000（unread-count 与 sync 一致），/v1 与服务层默认保持精确', async () => {
    const user = await account('sync-cap');
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1005)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', ?, 'sync.test', 'bulk@example.net', 'bulk', 'bulk', 'received' FROM n`).bind(user.address).run();
    expect(UNREAD_COUNT_CAP).toBe(1000);
    expect((await data<{ unread: number }>(await request('/api/messages/unread-count', auth(user.jwt)))).unread).toBe(1000);
    expect((await sync(user.jwt, '')).unread).toBe(1000);
    expect((await data<{ unread: number }>(await request('/v1/messages/unread-count', auth(user.key)))).unread).toBe(1005);
    expect(await countUnread(env, user.id, 'user')).toBe(1005);
    expect(await countUnread(env, user.id, 'user', 2000)).toBe(1005);
    // 低于上限时与精确值相同
    const few = await createDb(env).select({ id: messages.id }).from(messages).where(eq(messages.address, user.address)).limit(10);
    await createDb(env).update(messages).set({ isRead: true }).where(inArray(messages.id, few.map((row) => row.id)));
    expect((await sync(user.jwt, '')).unread).toBe(995);
  });

  it('scope/userId 校验与列表一致；unread 始终是调用者自己的未读', async () => {
    const admin = await account('sync-admin', 'admin');
    const user = await account('sync-scope');
    await mail(user.address);
    await mail(`sync-unclaimed-${rand()}@sync.test`);
    const adminUnread = (await data<{ unread: number }>(await request('/api/messages/unread-count', auth(admin.jwt)))).unread;
    for (const [query, status] of [['scope=unclaimed', 403], [`scope=user&userId=${admin.id}`, 403], ['scope=user', 400], ['scope=all', 400], ['limit=0', 400]] as const) {
      expect((await request(`/api/messages?${query}`, auth(user.jwt))).status, query).toBe(status);
      expect((await request(`/api/messages/sync?${query}`, auth(user.jwt))).status, query).toBe(status);
    }
    for (const query of ['scope=unclaimed', `scope=user&userId=${user.id}`, `scope=user&userId=${user.id}&direction=inbound`]) {
      const page = await list(admin.jwt, query);
      expect(page.items.length, query).toBeGreaterThan(0);
      expect(await sync(admin.jwt, query), query).toEqual({ unread: adminUnread, head: page.head });
    }
  });

  it('线程、等信与详情共用同一套附件/星标标记，两种标记互不串位', async () => {
    const user = await account('sync-flag-callers');
    const viewer = { userId: user.id, role: 'user' as const };
    const withAttachment = await mail(user.address, { subject: 'topic', messageId: '<flag-root@sync>' });
    const starredOnly = await mail(user.address, { subject: 'Re: topic', inReplyTo: '<flag-root@sync>' });
    await createDb(env).insert(attachmentsTable).values({ messageId: withAttachment, r2Key: `att/${withAttachment}/a` });
    await data(await request('/api/messages/star', post(user.jwt, { ids: [starredOnly], starred: true })));
    const flags = (items: { id: number; hasAttachments: boolean; isStarred: boolean }[]) =>
      items.map(({ id, hasAttachments, isStarred }) => ({ id, hasAttachments, isStarred }));
    const expected = [
      { id: withAttachment, hasAttachments: true, isStarred: false },
      { id: starredOnly, hasAttachments: false, isStarred: true },
    ];
    expect(flags(await getThread(env, viewer, starredOnly))).toEqual(expected);
    const first = await findNextMessage(env, viewer, { afterId: withAttachment - 1 });
    const second = await findNextMessage(env, viewer, { afterId: withAttachment });
    expect(flags([first.message!, second.message!])).toEqual(expected);
    const details = [await getMessageDetail(env, viewer, withAttachment), await getMessageDetail(env, viewer, starredOnly)];
    expect(flags(details)).toEqual(expected);
  });

  it('整页 100 封时附件与星标标记按 D1 参数上限分批，仍在一次 batch 里合并正确', async () => {
    const user = await account('sync-flags');
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', ?, 'sync.test', 'bulk@example.net', 'bulk', 'bulk', 'received' FROM n`).bind(user.address).run();
    const page = await listMessages(env, { userId: user.id, role: 'user' }, { limit: 100 } as ListMessagesQuery);
    expect(page.items).toHaveLength(100);
    // 第 1 封落在第一批、最后一封落在第二批（每批 90 个 id）
    const picked = [page.items[0]!.id, page.items[99]!.id];
    await createDb(env).insert(attachmentsTable).values(picked.map((messageId) => ({ messageId, r2Key: `att/${messageId}/a` })));
    await data(await request('/api/messages/star', post(user.jwt, { ids: picked, starred: true })));
    const flagged = await list(user.jwt, 'limit=100');
    const marks = (key: 'hasAttachments' | 'isStarred') => flagged.items.filter((item) => item[key]).map((item) => item.id).sort();
    expect(marks('hasAttachments')).toEqual([...picked].sort());
    expect(marks('isStarred')).toEqual([...picked].sort());
  });

  it('列表、sync、wait 各一次 D1 往返：标记随行取回，未读数与首页同一 batch，分流的两条语句也在同一 batch', async () => {
    const user = await account('sync-trips');
    const first = await mail(user.address);
    await mail(user.address);
    await createDb(env).insert(attachmentsTable).values({ messageId: first, r2Key: `att/${first}/a` });
    const counting = () => {
      let prepared = 0;
      let batched = 0;
      let batches = 0;
      const db = new Proxy(env.db, {
        get(target, property) {
          if (property === 'prepare') return (query: string) => { prepared++; return target.prepare(query); };
          if (property === 'batch') return (statements: D1PreparedStatement[]) => { batches++; batched += statements.length; return target.batch(statements); };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      // 每条语句恰好执行一次：batch 算一次往返，batch 之外的语句各算一次
      return { env: { ...env, db } as typeof env, trips: () => batches + prepared - batched };
    };
    const viewer = { userId: user.id, role: 'user' as const };
    for (const query of [{}, { direction: 'inbound' as const }, { domain: 'sync.test' }, { q: 'hello' }, { address: 'nobody@sync.test' }]) {
      const label = JSON.stringify(query);
      const listed = counting();
      const page = await listMessages(listed.env, viewer, { limit: 30, ...query } as ListMessagesQuery);
      expect(listed.trips(), label).toBe(1);
      if (!('address' in query)) expect(page.items.find((item) => item.id === first)?.hasAttachments, label).toBe(true);
      const synced = counting();
      await syncMessages(synced.env, viewer, { limit: 30, ...query } as ListMessagesQuery);
      expect(synced.trips(), label).toBe(1);
    }
    // wait 命中：摘要与标记同一条语句（原先命中后再查一次标记）；include=body 再取一次整行与附件
    const waited = counting();
    const found = await findNextMessage(waited.env, viewer, { afterId: first - 1 });
    expect(found.message).toMatchObject({ id: first, hasAttachments: true, isStarred: false });
    expect(waited.trips()).toBe(1);
    const withBody = counting();
    await findNextMessage(withBody.env, viewer, { afterId: first - 1, include: 'body' });
    expect(withBody.trips()).toBe(2);
  });
});
