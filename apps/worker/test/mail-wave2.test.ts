import {
  API_SCOPES, DEFAULT_SETTINGS, type CreatedApiKey, type ListMessagesQuery, type MessageDetail, type MessageSummary, type Settings,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, mailboxShares, mailboxes, messages, notificationJobs, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { describeSettingsChange } from '../src/services/audit.js';
import { handleInbound } from '../src/services/inbound.js';
import { deleteMessages, findNextMessage, getThread, listMessages, markAllRead } from '../src/services/message.js';
import { enqueueMailNotifications, processNotificationJobs } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { createSession } from '../src/services/session.js';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string, body: unknown, method = 'POST'): RequestInit =>
  ({ method, headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const rand = () => crypto.randomUUID().slice(0, 8);

/** 同文件用例共享 D1/KV：每个用例开头显式写入自己依赖的设置 */
async function baseSettings(patch: Partial<Settings> = {}) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }, { domain: 'w2.test', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: true, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    mailbox_policy: { perUserLimit: 0, reservedLocalParts: [...DEFAULT_SETTINGS.mailbox_policy.reservedLocalParts] },
    security: { require2fa: false },
    api: { enabled: true },
    ...patch,
  });
}

async function account(prefix: string, role: 'admin' | 'user' = 'user') {
  const username = `${prefix}-${rand()}`;
  const [user] = await createDb(env).insert(users)
    .values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await request('/api/api-keys', json(jwt, { name: `${username}-key`, scopes: [...API_SCOPES], rateLimit: 120 })), 201);
  return { id: user!.id, jwt, key: key.key };
}

async function own(userId: number, address: string) {
  const [row] = await createDb(env).insert(mailboxes)
    .values({ address, domain: address.split('@')[1]!, userId }).returning({ id: mailboxes.id });
  return row!.id;
}

async function mail(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  const [row] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@example.net',
    subject: 'hello', preview: 'hello', status: 'received', createdAt: new Date(), ...extra,
  }).returning({ id: messages.id });
  return row!.id;
}

async function readState(ids: number[]) {
  const rows = await createDb(env).select({ id: messages.id, isRead: messages.isRead }).from(messages).where(inArray(messages.id, ids)).all();
  return Object.fromEntries(rows.map((row) => [row.id, row.isRead]));
}

async function resetUnread(ids: number[]) {
  await createDb(env).update(messages).set({ isRead: false }).where(inArray(messages.id, ids));
}

/** 截获服务层发出的最后一条 select/update 及其绑定参数，返回 EXPLAIN QUERY PLAN 文本 */
async function lastPlan(kind: 'select' | 'update', run: (db: typeof env) => Promise<unknown>): Promise<string> {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const entry = { sql: query, params: [] as unknown[] };
        statements.push(entry);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { entry.params = args; return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await run({ ...env, db } as typeof env);
  const statement = statements.find((entry) => kind === 'update'
    ? entry.sql.startsWith('update "messages"')
    : entry.sql.startsWith('select') && entry.sql.includes('from "messages"'))!;
  const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(' | ');
}

async function maxMessageId() {
  const row = await createDb(env).select({ value: sql<number>`COALESCE(MAX(${messages.id}), 0)` }).from(messages).get();
  return Number(row?.value ?? 0);
}

describe('共享邮件的已读状态属于所有者', () => {
  it('alice 被共享 admin 地址后：标已读/全部已读（/api 与 /v1）不改 admin 那封；未读数与未读筛选不含共享邮件，其他视图照常', async () => {
    await baseSettings();
    const admin = await account('w2-share-admin', 'admin');
    const alice = await account('w2-share-alice');
    const shared = `w2-shared-${rand()}@hpc.email`;
    const mine = `w2-alice-${rand()}@hpc.email`;
    const boxId = await own(admin.id, shared);
    await own(alice.id, mine);
    await createDb(env).insert(mailboxShares).values({ mailboxId: boxId, userId: alice.id, grantedBy: admin.id });
    const adminMail = await mail(shared, { subject: 'shared secret' });
    const aliceMail = await mail(mine, { subject: 'alice own' });
    const ids = async (path: string, token: string) =>
      (await data<{ items: MessageSummary[] }>(await request(path, { headers: auth(token) }))).items.map((item) => item.id);

    for (const [prefix, token] of [['/api', alice.jwt], ['/v1', alice.key]] as const) {
      const marked = await data<{ changed: number }>(await request(`${prefix}/messages/read`, json(token, { ids: [adminMail, aliceMail], isRead: true })));
      expect(marked.changed, prefix).toBe(1);
      expect((await data<{ changed: number }>(await request(`${prefix}/messages/read`, json(token, { ids: [adminMail], isRead: false })))).changed).toBe(0);
      await resetUnread([aliceMail]);
      expect((await data<{ changed: number }>(await request(`${prefix}/messages/read-all`, json(token, {})))).changed, prefix).toBe(1);
      // 旧客户端带的 includeShared 会被剥掉，不再有任何效果
      expect((await data<{ changed: number }>(await request(`${prefix}/messages/read-all`, json(token, { includeShared: true })))).changed).toBe(0);
      expect((await readState([adminMail]))[adminMail], prefix).toBe(false);
      expect((await data<{ unread: number }>(await request(`${prefix}/messages/unread-count`, { headers: auth(token) }))).unread, prefix).toBe(0);
    }

    await resetUnread([aliceMail]);
    for (const [prefix, token] of [['/api', alice.jwt], ['/v1', alice.key]] as const) {
      expect((await data<{ unread: number }>(await request(`${prefix}/messages/unread-count`, { headers: auth(token) }))).unread).toBe(1);
      expect(await ids(`${prefix}/messages?unread=1`, token), prefix).toEqual([aliceMail]);
      expect(await ids(`${prefix}/messages?direction=inbound&unread=1`, token), prefix).toEqual([aliceMail]);
      expect(await ids(`${prefix}/messages?direction=inbound`, token), prefix).toEqual([aliceMail, adminMail].sort((a, b) => b - a));
    }
    // 搜索、星标视图仍显示共享邮件；所有者本人照常能改、且共享邮件计入所有者未读
    expect(await ids('/api/messages?q=shared%20secret', alice.jwt)).toEqual([adminMail]);
    expect((await data<{ changed: number }>(await request('/api/messages/star', json(alice.jwt, { ids: [adminMail], starred: true })))).changed).toBe(1);
    expect(await ids('/api/messages?starred=1', alice.jwt)).toEqual([adminMail]);
    expect((await data<{ unread: number }>(await request('/api/messages/unread-count', { headers: auth(admin.jwt) }))).unread).toBe(1);
    expect((await data<{ changed: number }>(await request('/api/messages/read', json(admin.jwt, { ids: [adminMail], isRead: true })))).changed).toBe(1);
  });
});

describe('全部已读按筛选执行', () => {
  it('address/domain/q 收窄，q 与列表搜索同一语义且不区分大小写', async () => {
    await baseSettings();
    const user = await account('w2-readall');
    const a1 = `w2-a1-${rand()}@hpc.email`;
    const a2 = `w2-a2-${rand()}@hpc.email`;
    const b1 = `w2-b1-${rand()}@w2.test`;
    for (const address of [a1, a2, b1]) await own(user.id, address);
    const m1 = await mail(a1, { subject: 'Invoice 42' });
    const m2 = await mail(a1, { subject: 'hello' });
    const m3 = await mail(a2, { subject: 'hello', bodyText: 'see the attached invoice' });
    const m4 = await mail(b1, { subject: 'INVOICE ready' });
    const m5 = await mail(b1, { subject: 'news', fromName: 'Invoice Bot' });
    const all = [m1, m2, m3, m4, m5];
    const readAll = async (body: Record<string, unknown>, token = user.jwt, prefix = '/api') => {
      await resetUnread(all);
      const { changed } = await data<{ changed: number }>(await request(`${prefix}/messages/read-all`, json(token, body)));
      const state = await readState(all);
      return { changed, read: all.filter((id) => state[id]) };
    };

    expect(await readAll({ address: a1 })).toEqual({ changed: 2, read: [m1, m2] });
    expect(await readAll({ domain: 'w2.test' })).toEqual({ changed: 2, read: [m4, m5] });
    expect(await readAll({ domain: 'hpc.email', q: 'INVOICE' })).toEqual({ changed: 2, read: [m1, m3] });
    expect(await readAll({ address: b1, q: 'news' }, user.key, '/v1')).toEqual({ changed: 1, read: [m5] });

    await resetUnread(all);
    const listed = await data<{ items: MessageSummary[] }>(await request('/api/messages?q=invoice&unread=1', { headers: auth(user.jwt) }));
    const { changed } = await data<{ changed: number }>(await request('/api/messages/read-all', json(user.jwt, { q: 'invoice' })));
    const state = await readState(all);
    expect(listed.items.map((item) => item.id).sort()).toEqual(all.filter((id) => state[id]).sort());
    expect(changed).toBe(listed.items.length);

    for (const body of [{ domain: 'not a domain' }, { address: 'bad' }, { q: 'x'.repeat(257) }]) {
      expect((await request('/api/messages/read-all', json(user.jwt, body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('管理员 scope=unclaimed 同样支持收窄，不碰已认领地址', async () => {
    await baseSettings();
    const admin = await account('w2-unclaimed-admin', 'admin');
    const owner = await account('w2-unclaimed-owner');
    const token = `w2tok${rand()}`;
    const claimed = `w2-claimed-${rand()}@hpc.email`;
    await own(owner.id, claimed);
    const x1 = await mail(`w2-x1-${rand()}@hpc.email`, { subject: `alpha ${token}` });
    const x2 = await mail(`w2-x2-${rand()}@hpc.email`, { subject: `beta ${token}` });
    const y1 = await mail(`w2-y1-${rand()}@w2.test`, { subject: `alpha ${token}` });
    const c1 = await mail(claimed, { subject: `alpha ${token}` });
    const ids = [x1, x2, y1, c1];
    const readAll = async (body: Record<string, unknown>) => {
      await resetUnread(ids);
      const { changed } = await data<{ changed: number }>(await request('/api/messages/read-all?scope=unclaimed', json(admin.jwt, body)));
      const state = await readState(ids);
      return { changed, read: ids.filter((id) => state[id]) };
    };
    expect(await readAll({ q: token })).toEqual({ changed: 3, read: [x1, x2, y1] });
    expect(await readAll({ q: token, domain: 'w2.test' })).toEqual({ changed: 1, read: [y1] });
    expect(await readAll({ q: `alpha ${token}`, domain: 'hpc.email' })).toEqual({ changed: 1, read: [x1] });
    expect((await request('/api/messages/read-all', json(owner.jwt, { scope: 'unclaimed', q: token }))).status).toBe(403);
  });

  it('收窄后的 UPDATE 仍按地址集合走 idx_messages_visible，domain 不把规划器带去扫整个域', async () => {
    await baseSettings();
    const user = await account('w2-plan');
    await own(user.id, `w2-plan-${rand()}@hpc.email`);
    const viewer = { userId: user.id, role: 'user' as const };
    for (const filters of [{}, { domain: 'hpc.email' }, { q: 'x' }, { address: 'a@hpc.email' }, { domain: 'hpc.email', q: 'x' }]) {
      const plan = await lastPlan('update', (db) => markAllRead(db, viewer, filters));
      expect(plan, JSON.stringify(filters)).toContain('idx_messages_visible');
      expect(plan, JSON.stringify(filters)).not.toContain('idx_messages_domain');
      expect(plan, JSON.stringify(filters)).not.toMatch(/SCAN messages/);
    }
  });

  it('列表带 domain 时认领/共享范围的执行计划与不带 domain 相同，不改走 idx_messages_domain', async () => {
    await baseSettings();
    const admin = await account('w2-list-plan-admin', 'admin');
    const user = await account('w2-list-plan');
    await own(user.id, `w2-list-plan-${rand()}@hpc.email`);
    const viewer = { userId: user.id, role: 'user' as const };
    const views: [Parameters<typeof listMessages>[1], Partial<ListMessagesQuery>][] = [
      [viewer, {}], [viewer, { direction: 'inbound' }], [viewer, { q: 'x' }], [viewer, { unread: true }],
      [viewer, { trash: true }], [viewer, { direction: 'outbound' }],
      [{ userId: admin.id, role: 'admin', scope: 'user', targetUserId: user.id }, {}],
    ];
    for (const [who, query] of views) {
      const list = (extra: Partial<ListMessagesQuery>) => lastPlan('select', (db) =>
        listMessages(db, who, { limit: 30, ...query, ...extra } as ListMessagesQuery));
      const withDomain = await list({ domain: 'hpc.email' });
      expect(withDomain, JSON.stringify(query)).not.toContain('idx_messages_domain');
      expect(withDomain, JSON.stringify(query)).toBe(await list({}));
    }
    // 未认领范围没有地址集合可走，仍由规划器按域名索引收窄
    expect(await lastPlan('select', (db) => listMessages(db, { userId: admin.id, role: 'admin', scope: 'unclaimed' },
      { limit: 30, domain: 'hpc.email' } as ListMessagesQuery))).toContain('idx_messages_domain');
  });
});

describe('认领可用性返回原因', () => {
  it('与认领同源：taken / reserved / quota / domain_limit / domain_unavailable', async () => {
    await baseSettings({
      domains: { list: [
        { domain: 'hpc.email', public: true, perUserLimit: 0 },
        { domain: 'w2lim.test', public: true, perUserLimit: 1 },
        { domain: 'w2priv.test', public: false, perUserLimit: 0 },
      ] },
      mailbox_policy: { perUserLimit: 3, reservedLocalParts: ['admin', 'postmaster'] },
    });
    const user = await account('w2-avail');
    const admin = await account('w2-avail-admin', 'admin');
    const other = await account('w2-avail-other');
    const check = async (token: string, localPart: string, domain: string, prefix = '/api') =>
      data<{ address: string; available: boolean; reason?: string }>(await request(`${prefix}/mailboxes/availability?localPart=${localPart}&domain=${domain}`, { headers: auth(token) }));
    const claim = (token: string, localPart: string, domain: string) => request('/api/mailboxes', json(token, { localPart, domain }));

    const free = `free${rand()}`;
    expect(await check(user.jwt, free, 'hpc.email')).toEqual({ address: `${free}@hpc.email`, available: true });
    expect(await check(user.jwt, 'admin', 'hpc.email')).toMatchObject({ available: false, reason: 'reserved' });
    expect(await check(user.key, 'postmaster', 'hpc.email', '/v1')).toMatchObject({ available: false, reason: 'reserved' });
    expect(await check(admin.jwt, 'postmaster', 'hpc.email')).toMatchObject({ available: true });
    expect(await check(user.jwt, 'x', 'nowhere.test')).toMatchObject({ available: false, reason: 'domain_unavailable' });
    expect(await check(user.jwt, 'x', 'w2priv.test')).toMatchObject({ available: false, reason: 'domain_unavailable' });
    expect((await claim(user.jwt, 'x', 'w2priv.test')).status).toBe(403);
    expect(await check(admin.jwt, `x${rand()}`, 'w2priv.test')).toMatchObject({ available: true });

    const taken = `taken${rand()}`;
    expect((await claim(other.jwt, taken, 'hpc.email')).status).toBe(201);
    expect(await check(user.jwt, taken, 'hpc.email')).toMatchObject({ available: false, reason: 'taken' });
    expect((await claim(user.jwt, taken, 'hpc.email')).status).toBe(409);

    expect((await claim(user.jwt, `lim${rand()}`, 'w2lim.test')).status).toBe(201);
    expect(await check(user.jwt, `lim${rand()}`, 'w2lim.test')).toMatchObject({ available: false, reason: 'domain_limit' });
    expect((await claim(user.jwt, `lim${rand()}`, 'w2lim.test')).status).toBe(403);

    for (let i = 0; i < 2; i++) expect((await claim(user.jwt, `q${i}${rand()}`, 'hpc.email')).status).toBe(201);
    expect(await check(user.key, `more${rand()}`, 'hpc.email', '/v1')).toMatchObject({ available: false, reason: 'quota' });
    const rejected = await claim(user.jwt, `more${rand()}`, 'hpc.email');
    expect(rejected.status).toBe(403);
    // 规则顺序一致：保留前缀先于配额与占用
    expect(await check(user.jwt, 'admin', 'hpc.email')).toMatchObject({ reason: 'reserved' });
  });
});

describe('wait 过滤与 scannedThroughId', () => {
  it('按完整地址、@域名、主题与验证码过滤，跳过不匹配的新邮件', async () => {
    await baseSettings();
    const user = await account('w2-wait');
    const address = `w2-wait-${rand()}@hpc.email`;
    await own(user.id, address);
    const viewer = { userId: user.id, role: 'user' as const };
    const base = await maxMessageId();
    const m1 = await mail(address, { fromAddress: 'news@shop.example', subject: 'Weekly deals', preview: 'deals' });
    const m2 = await mail(address, { fromAddress: 'noreply@github.com', subject: 'Welcome aboard', preview: 'hello there' });
    const m3 = await mail(address, { fromAddress: 'security@github.com', subject: '[GitHub] Verify sign in', preview: 'Your verification code is 482913', verificationCode: '482913' });
    const m4 = await mail(address, { fromAddress: 'login@other.example', subject: 'Login code', preview: 'Your login code: 774411', verificationCode: '774411' });
    const next = (filters: Parameters<typeof findNextMessage>[2]) => findNextMessage(env, viewer, { address, ...filters });

    expect(await next({ afterId: base })).toMatchObject({ message: { id: m1 }, scannedThroughId: m1 });
    expect(await next({ afterId: base, from: '@github.com' })).toMatchObject({ message: { id: m2 }, scannedThroughId: m2 });
    expect(await next({ afterId: base, from: 'security@github.com' })).toMatchObject({ message: { id: m3 }, scannedThroughId: m3 });
    expect(await next({ afterId: base, from: '@github.com', hasCode: true })).toMatchObject({ message: { id: m3, verificationCode: '482913' }, scannedThroughId: m3 });
    expect(await next({ afterId: base, subjectContains: 'login CODE' })).toMatchObject({ message: { id: m4 }, scannedThroughId: m4 });
    expect(await next({ afterId: base, hasCode: true })).toMatchObject({ message: { id: m3 } });
    // @域名是后缀匹配，不含子域；不匹配时游标推进到已检查的最后一封
    expect(await next({ afterId: base, from: '@hub.com' })).toEqual({ message: null, scannedThroughId: m4 });
    expect(await next({ afterId: m4, from: '@github.com' })).toEqual({ message: null, scannedThroughId: m4 });

    const waited = await data<{ message: MessageSummary | null; scannedThroughId: number }>(await request(
      `/v1/messages/wait?address=${address}&afterId=${base}&from=@GitHub.com&hasCode=1&timeout=1`, { headers: auth(user.key) }));
    expect(waited.message?.id).toBe(m3);
    expect(waited.scannedThroughId).toBe(m3);
    const none = await data<{ message: MessageSummary | null; scannedThroughId: number }>(await request(
      `/v1/messages/wait?address=${address}&afterId=${base}&subjectContains=nothing-like-this&timeout=1`, { headers: auth(user.key) }));
    expect(none).toEqual({ message: null, scannedThroughId: m4 });
    const idle = await data<{ message: null; scannedThroughId: number }>(await request(
      `/v1/messages/wait?address=${address}&afterId=${m4}&timeout=1`, { headers: auth(user.key) }));
    expect(idle).toEqual({ message: null, scannedThroughId: m4 });
    for (const query of ['from=not-an-address', 'from=@nodot', `subjectContains=${'x'.repeat(201)}`, 'hasCode=maybe']) {
      expect((await request(`/v1/messages/wait?${query}&timeout=1`, { headers: auth(user.key) })).status, query).toBe(400);
    }
  });

  it('hasCode 在 AI 兜底窗口内不跳过刚到的无码邮件，窗口过后才判为不匹配', async () => {
    await baseSettings({ code_extract: { enabled: true, aiEnabled: true } });
    const user = await account('w2-wait-ai');
    const address = `w2-wait-ai-${rand()}@hpc.email`;
    await own(user.id, address);
    const viewer = { userId: user.id, role: 'user' as const };
    const base = await maxMessageId();
    const fresh = await mail(address, { subject: 'Sign in to Example', preview: 'Use the code below' });
    const later = await mail(address, { subject: 'Your code', preview: 'Your verification code is 135790', verificationCode: '135790' });
    expect(await findNextMessage(env, viewer, { afterId: base, address, hasCode: true })).toEqual({ message: null, scannedThroughId: base });
    await createDb(env).update(messages).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(messages.id, fresh));
    expect(await findNextMessage(env, viewer, { afterId: base, address, hasCode: true })).toMatchObject({ message: { id: later }, scannedThroughId: later });
    await baseSettings();
  });
});

describe('回收站 deletedAt 与线程主题回退', () => {
  it('回收站列表返回 deletedAt，普通列表不返回', async () => {
    await baseSettings();
    const user = await account('w2-trash');
    const address = `w2-trash-${rand()}@hpc.email`;
    await own(user.id, address);
    const kept = await mail(address);
    const trashed = await mail(address);
    const before = Date.now();
    expect(await deleteMessages(env, { userId: user.id, role: 'user' }, [trashed])).toBe(1);
    const trash = await data<{ items: MessageSummary[] }>(await request(`/api/messages?trash=1&address=${address}`, { headers: auth(user.jwt) }));
    expect(trash.items.map((item) => item.id)).toEqual([trashed]);
    expect(Date.parse(trash.items[0]!.deletedAt!)).toBeGreaterThanOrEqual(before - 1000);
    const inbox = await data<{ items: MessageSummary[] }>(await request(`/v1/messages?address=${address}`, { headers: auth(user.key) }));
    expect(inbox.items.map((item) => item.id)).toEqual([kept]);
    expect(inbox.items[0]).not.toHaveProperty('deletedAt');
  });

  it('同名验证码邮件不归并；无线程头的回复/转发按前缀归并；两封都无前缀的同名邮件各自独立', async () => {
    await baseSettings();
    const user = await account('w2-thread');
    const address = `w2-thread-${rand()}@hpc.email`;
    await own(user.id, address);
    const viewer = { userId: user.id, role: 'user' as const };
    const ids = async (id: number) => (await getThread(env, viewer, id)).map((item) => item.id);
    const c1 = await mail(address, { subject: 'Your verification code', preview: 'Your verification code is 111111', verificationCode: '111111' });
    const c2 = await mail(address, { subject: 'Your verification code', preview: 'Your verification code is 222222', verificationCode: '222222' });
    const rc = await mail(address, { subject: 'Re: Your verification code', preview: 'thanks, got it' });
    expect(await ids(c1)).toEqual([c1]);
    expect(await ids(c2)).toEqual([c2]);
    expect(await ids(rc)).toEqual([rc]);

    const o1 = await mail(address, { subject: 'Project plan', preview: 'draft attached' });
    const r1 = await mail(address, { subject: 'Re: Project plan', preview: 'looks good' });
    const r2 = await mail(address, { subject: '回复：Project plan', preview: '收到' });
    const f1 = await mail(address, { subject: 'Fw: project plan', preview: 'fyi' });
    expect(await ids(o1)).toEqual([o1, r1, r2, f1]);
    expect(await ids(r2)).toEqual([o1, r1, r2, f1]);

    const n1 = await mail(address, { subject: 'Weekly report', preview: 'week 1' });
    const n2 = await mail(address, { subject: 'Weekly report', preview: 'week 2' });
    expect(await ids(n1)).toEqual([n1]);
    expect(await ids(n2)).toEqual([n2]);
  });
});

describe('验证链接收件识别与输出', () => {
  const verifyUrl = 'https://accounts.example.org/verify-email?token=Q2hlY2tUb2tlbjAxMjM0NTY3ODk';
  const htmlBody = `<p>Thanks for signing up. Please verify your email address.</p><a href="${verifyUrl}">Verify email</a>
    <p><a href="https://accounts.example.org/unsubscribe?u=1">Unsubscribe</a></p>`;

  it('SMTP 收件写入 verificationLink，列表/详情/wait/Webhook 输出同名字段', async () => {
    await baseSettings();
    const user = await account('w2-link');
    const address = `w2-link-${rand()}@hpc.email`;
    await own(user.id, address);
    const webhook = { enabled: true, url: 'https://notify.example.com/hpc', secret: '' };
    await updateUserNotifyPrefs(env, user.id, { webhook });
    const delivered: { message: { verificationLink?: string } }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }));
    const base = await maxMessageId();
    const raw = [`From: Example Accounts <no-reply@example.org>`, `To: ${address}`, 'Subject: Verify your email',
      `Message-ID: <w2-link-${rand()}@example.org>`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', htmlBody, ''].join('\r\n');
    const ctx = createExecutionContext();
    await handleInbound({ to: address, from: 'no-reply@example.org', headers: new Headers(), raw: new Response(raw).body!,
      forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
    await waitOnExecutionContext(ctx);

    const row = await createDb(env).select().from(messages).where(eq(messages.address, address)).get();
    expect(row!.verificationLink).toBe(verifyUrl);
    const list = await data<{ items: MessageSummary[] }>(await request(`/api/messages?address=${address}`, { headers: auth(user.jwt) }));
    expect(list.items[0]!.verificationLink).toBe(verifyUrl);
    const detail = await data<MessageDetail>(await request(`/v1/messages/${row!.id}`, { headers: auth(user.key) }));
    expect(detail.verificationLink).toBe(verifyUrl);
    const waited = await data<{ message: MessageSummary }>(await request(`/v1/messages/wait?address=${address}&afterId=${base}&timeout=1`, { headers: auth(user.key) }));
    expect(waited.message.verificationLink).toBe(verifyUrl);
    const job = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).get();
    expect((job!.payload as { message: { verificationLink: string } }).message.verificationLink).toBe(verifyUrl);
    expect(delivered.map((body) => body.message.verificationLink)).toEqual([verifyUrl]);

    // 升级前入队的载荷没有该字段：投递时补空串
    delivered.length = 0;
    const ids = await enqueueMailNotifications(env, null, { ownerIds: [user.id], text: 'legacy', message: {
      id: row!.id + 100000, address, fromAddress: 'legacy@example.org', fromName: 'Legacy', subject: 'legacy',
      verificationCode: '', preview: 'legacy', createdAt: new Date().toISOString() } });
    await processNotificationJobs(env, { jobIds: ids });
    expect(delivered.map((body) => body.message.verificationLink)).toEqual(['']);
  });

  it('站内投递副本同样识别；关闭自动提取时不识别', async () => {
    await baseSettings();
    const sender = await account('w2-link-sender');
    const receiver = await account('w2-link-receiver');
    const from = `w2-from-${rand()}@hpc.email`;
    const to = `w2-to-${rand()}@hpc.email`;
    const fromId = await own(sender.id, from);
    await own(receiver.id, to);
    const send = async (subject: string) => data<MessageSummary>(await request('/api/messages/send',
      json(sender.jwt, { from: { mailboxId: fromId }, to: [to], cc: [], bcc: [], subject, html: htmlBody })), 201);
    const sent = await send('Verify your email');
    expect(sent.verificationLink).toBe('');
    const copy = await createDb(env).select().from(messages).where(eq(messages.address, to)).get();
    expect(copy!.verificationLink).toBe(verifyUrl);

    await baseSettings({ code_extract: { enabled: false, aiEnabled: false } });
    await send('Verify your email again');
    const copies = await createDb(env).select().from(messages).where(eq(messages.address, to)).all();
    expect(copies.find((item) => item.subject.endsWith('again'))!.verificationLink).toBe('');
    await baseSettings();
  });
});

describe('管理设置审计', () => {
  it('目标只列真正变化的设置键，明细写域名增删与字段变化', () => {
    const before: Settings = {
      ...DEFAULT_SETTINGS,
      domains: { list: [{ domain: 'a.test', public: true, perUserLimit: 0 }, { domain: 'b.test', public: false, perUserLimit: 0 }], revision: 3 },
    };
    const after: Settings = {
      ...before,
      domains: { list: [{ domain: 'a.test', public: false, perUserLimit: 5 }, { domain: 'c.test', public: false, perUserLimit: 0 }], revision: 4 },
      mailbox_policy: { perUserLimit: 20, reservedLocalParts: [...before.mailbox_policy.reservedLocalParts, 'ceo'] },
    };
    const result = describeSettingsChange(before, after, ['domains', 'expectedDomainsRevision', 'mailbox_policy', 'site']);
    expect(result.target).toBe('domains、mailbox_policy');
    expect(result.detail).toContain('新增域名 c.test');
    expect(result.detail).toContain('移除域名 b.test');
    expect(result.detail).toContain('a.test 改为仅管理员，每人上限 0→5');
    expect(result.detail).toContain('mailbox_policy.perUserLimit: 50→20');
    expect(result.detail).toContain('mailbox_policy.reservedLocalParts +ceo');
    expect(result.detail).not.toContain('expectedDomainsRevision');
    expect(describeSettingsChange(before, before, ['site'])).toEqual({ target: 'site', detail: '无实际变更' });
    // 字段新增/缺失（升级前存量值）也能描述，不抛错
    const legacy = { ...before, security: {} as Settings['security'] };
    expect(describeSettingsChange(legacy, before, ['security']).detail).toBe('security.require2fa: undefined→false');
  });

  it('PUT /api/admin/settings 写入的审计记录不把 expectedDomainsRevision 当目标', async () => {
    await baseSettings();
    const admin = await account('w2-audit-admin', 'admin');
    const current = await getSettingsFresh(env);
    const added = `w2audit${rand()}.test`;
    await data(await request('/api/admin/settings', json(admin.jwt, {
      expectedDomainsRevision: current.domains.revision ?? 0,
      domains: { list: [...current.domains.list, { domain: added, public: false, perUserLimit: 0 }] },
    }, 'PUT')));
    const entry = await createDb(env).select().from(adminAuditLogs).where(eq(adminAuditLogs.actorId, admin.id)).get();
    expect(entry).toMatchObject({ action: 'settings.update', target: 'domains', detail: `新增域名 ${added}` });
    await baseSettings();
  });
});
