import {
  API_SCOPES, DEFAULT_SETTINGS, type ApiScope, type CreatedApiKey, type MessageDetail, type MessageSummary, type Settings,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxShares, mailboxes, messages, stars, users } from '../src/db/schema.js';
import { AppError } from '../src/lib/errors.js';
import { etagMatches } from '../src/lib/etag.js';
import { signToken } from '../src/lib/jwt.js';
import {
  getMessageContent,
  getMessageDetail,
  getMessageDetailConditional,
  getRawMessageObject,
  getThread,
  loadAttachmentForViewer,
  loadSourceMessage,
  type Viewer,
} from '../src/services/message.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); });

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const headers = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });
const json = (token: string, body: unknown): RequestInit =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const rand = () => crypto.randomUUID().slice(0, 8);

async function baseSettings(patch: Partial<Settings> = {}) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: true, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    mailbox_policy: { perUserLimit: 0, reservedLocalParts: [...DEFAULT_SETTINGS.mailbox_policy.reservedLocalParts] },
    security: { require2fa: false },
    api: { enabled: true },
    ...patch,
  });
}

async function account(prefix: string, role: 'admin' | 'user' = 'user', scopes: ApiScope[] = [...API_SCOPES]) {
  const username = `${prefix}-${rand()}`;
  const [user] = await createDb(env).insert(users)
    .values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await request('/api/api-keys', json(jwt, { name: `${username}-key`, scopes, rateLimit: 120 })), 201);
  const localPart = username.toLowerCase();
  const address = `${localPart}@hpc.email`;
  const [box] = await createDb(env).insert(mailboxes).values({ address, domain: 'hpc.email', userId: user!.id }).returning({ id: mailboxes.id });
  return { id: user!.id, role, jwt, key: key.key, localPart, address, mailboxId: box!.id };
}

async function mail(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  const [row] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@example.net',
    subject: 'hello', preview: 'hello', bodyText: 'hello body', status: 'received', messageId: `<${rand()}@example.net>`,
    createdAt: new Date(), ...extra,
  }).returning({ id: messages.id });
  return row!.id;
}

async function attach(messageId: number, filename = 'proof.txt', extra: Partial<typeof attachments.$inferInsert> = {}) {
  const r2Key = `att/${messageId}/${rand()}`;
  await env.r2.put(r2Key, `content of ${filename}`);
  const [row] = await createDb(env).insert(attachments)
    .values({ messageId, r2Key, filename, mimeType: 'text/plain', size: 10 + filename.length, ...extra }).returning({ id: attachments.id });
  return row!.id;
}

/** 记录 D1 往返：单条语句执行（first/all/run/raw）与 batch 各算一次；batch 里的语句不单独计 */
function tracedEnv() {
  const calls: { kind: 'single' | 'batch'; sql: string[] }[] = [];
  const statements = new WeakMap<object, { real: D1PreparedStatement; sql: string }>();
  const wrap = (real: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === 'first' || property === 'all' || property === 'run' || property === 'raw') {
          return (...args: unknown[]) => {
            calls.push({ kind: 'single', sql: [sql] });
            return (target[property] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { real, sql });
    return proxy;
  };
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === 'batch') {
        return (list: D1PreparedStatement[]) => {
          calls.push({ kind: 'batch', sql: list.map((s) => statements.get(s)?.sql ?? '?') });
          return target.batch(list.map((s) => statements.get(s)?.real ?? s));
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, db } as Env, calls, reset: () => { calls.length = 0; } };
}

const viewerOf = (user: { id: number; role: 'admin' | 'user' }, extra: Partial<Viewer> = {}): Viewer =>
  ({ userId: user.id, role: user.role, ...extra });

async function notFound(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe('详情、附件、原始邮件、线程的可见性合批（R21）', () => {
  it('详情一次往返：整行、可见性、星标一条语句，附件一条，同一 batch；不再单独查共享与已认领', async () => {
    await baseSettings();
    const owner = await account('rt-detail');
    const id = await mail(owner.address);
    await attach(id);
    await createDb(env).insert(stars).values({ userId: owner.id, messageId: id });
    const traced = tracedEnv();
    const detail = await getMessageDetail(traced.env, viewerOf(owner), id);
    expect(detail.isStarred).toBe(true);
    expect(detail.hasAttachments).toBe(true);
    expect(traced.calls.map((call) => call.kind)).toEqual(['batch']);
    expect(traced.calls[0]!.sql).toHaveLength(2);
  });

  it('附件、原始邮件、翻译正文、来源邮件各一次往返', async () => {
    await baseSettings();
    const owner = await account('rt-single');
    const id = await mail(owner.address, { rawR2Key: `raw/${rand()}` });
    const attId = await attach(id);
    const traced = tracedEnv();
    const viewer = viewerOf(owner);

    expect((await loadAttachmentForViewer(traced.env, viewer, attId)).id).toBe(attId);
    expect(traced.calls).toHaveLength(1);
    traced.reset();
    await getRawMessageObject(traced.env, viewer, id);
    expect(traced.calls).toHaveLength(1);
    traced.reset();
    expect((await getMessageContent(traced.env, viewer, id)).bodyText).toBe('hello body');
    expect(traced.calls).toHaveLength(1);
    traced.reset();
    expect((await loadSourceMessage(traced.env, viewer, id, 'x', 'reply')).address).toBe(owner.address);
    expect(traced.calls).toHaveLength(1);
  });

  it('线程：目标与可见性一条语句，附件与星标随行取回；已查过的键不再查', async () => {
    await baseSettings();
    const owner = await account('rt-thread');
    const rootId = `<${rand()}@example.net>`;
    const root = await mail(owner.address, { subject: 'Plan', messageId: rootId });
    const reply = await mail(owner.address, { subject: 'Re: Plan', messageId: `<${rand()}@example.net>`, inReplyTo: rootId, references: rootId });
    await attach(reply);
    await createDb(env).insert(stars).values({ userId: owner.id, messageId: root });
    const traced = tracedEnv();
    const thread = await getThread(traced.env, viewerOf(owner), root);
    expect(thread.map((m) => m.id)).toEqual([root, reply]);
    expect(thread.map((m) => [m.isStarred, m.hasAttachments])).toEqual([[true, false], [false, true]]);
    // 目标 1 次 + 第 1 轮（根的键）1 次 + 第 2 轮（回复新出现的键）1 次；第 2 轮不再带根的键
    expect(traced.calls).toHaveLength(3);
    expect(traced.calls[2]!.sql[0]).toMatch(/"message_id" in \(\?\)/);
    expect(traced.calls.flatMap((call) => call.sql).some((sql) => /from "stars" where/i.test(sql))).toBe(false);
  });

  it('可见性矩阵与原规则一致：自有、共享（未删除收件、认领人启用）、未认领、scope=user/unclaimed', async () => {
    await baseSettings();
    const owner = await account('rt-vis-owner');
    const member = await account('rt-vis-member');
    const stranger = await account('rt-vis-stranger');
    const admin = await account('rt-vis-admin', 'admin');
    await createDb(env).insert(mailboxShares).values({ mailboxId: owner.mailboxId, userId: member.id, grantedBy: owner.id });
    const inbound = await mail(owner.address);
    const deleted = await mail(owner.address, { deletedAt: new Date() });
    const outbound = await mail(owner.address, { direction: 'outbound' });
    const unclaimed = await mail(`rt-vis-free-${rand()}@hpc.email`);
    const ownerAtt = await attach(inbound);

    const visible = async (viewer: Viewer, id: number) => getMessageDetail(env, viewer, id).then(() => true, () => false);
    expect(await visible(viewerOf(owner), deleted)).toBe(true);
    expect(await visible(viewerOf(member), inbound)).toBe(true);
    expect(await visible(viewerOf(member), deleted)).toBe(false);
    expect(await visible(viewerOf(member), outbound)).toBe(false);
    expect(await visible(viewerOf(stranger), inbound)).toBe(false);
    expect(await visible(viewerOf(member), unclaimed)).toBe(false);
    expect(await visible(viewerOf(admin), unclaimed)).toBe(true);
    expect(await visible(viewerOf(admin), inbound)).toBe(false);
    expect(await visible(viewerOf(admin, { scope: 'mine' }), unclaimed)).toBe(false);
    expect(await visible(viewerOf(admin, { scope: 'unclaimed' }), unclaimed)).toBe(true);
    expect(await visible(viewerOf(admin, { scope: 'unclaimed' }), inbound)).toBe(false);
    expect(await visible(viewerOf(admin, { scope: 'user', targetUserId: owner.id }), outbound)).toBe(true);
    expect(await visible(viewerOf(admin, { scope: 'user', targetUserId: member.id }), inbound)).toBe(false);
    expect(await loadAttachmentForViewer(env, viewerOf(member), ownerAtt).then(() => true)).toBe(true);
    expect(await notFound(loadAttachmentForViewer(env, viewerOf(stranger), ownerAtt))).toBe('not_found');
    expect(await notFound(getRawMessageObject(env, viewerOf(stranger), inbound))).toBe('not_found');
    expect(await notFound(getThread(env, viewerOf(stranger), inbound))).toBe('not_found');

    // 认领人停用后共享失效
    await createDb(env).update(users).set({ status: 'disabled' }).where(eq(users.id, owner.id));
    expect(await visible(viewerOf(member), inbound)).toBe(false);
    await createDb(env).update(users).set({ status: 'active' }).where(eq(users.id, owner.id));
  });

  it('admin 裸开未认领邮件时线程沿用未认领范围', async () => {
    await baseSettings();
    const admin = await account('rt-thread-admin', 'admin');
    const free = `rt-thread-free-${rand()}@hpc.email`;
    const rootId = `<${rand()}@example.net>`;
    const root = await mail(free, { subject: 'Hi', messageId: rootId });
    const reply = await mail(free, { subject: 'Re: Hi', inReplyTo: rootId });
    expect((await getThread(env, viewerOf(admin), reply)).map((m) => m.id)).toEqual([root, reply]);
  });
});

describe('来源邮件不可用时 details.source 标明是哪一个引用', () => {
  const send = (key: string, from: string, extra: Record<string, unknown>) => request('/v1/messages', json(key, {
    from: { localPart: from, domain: 'hpc.email' }, to: [`src-sink-${rand()}@hpc.email`], text: 'body', subject: `src-${rand()}`, ...extra,
  }));
  const errorOf = async (response: Response) => {
    const body = await response.json() as { error: { code: string; details?: { source?: string } } };
    expect(response.status, JSON.stringify(body)).toBe(404);
    return body.error;
  };

  it('回复、转发、两者都带（先校验转发）、附件丢失', async () => {
    await baseSettings();
    const owner = await account('src-owner');
    const other = await account('src-other');
    const own = await mail(owner.address);
    const hidden = await mail(other.address);

    expect(await errorOf(await send(owner.key, owner.localPart, { replyToMessageId: hidden })))
      .toMatchObject({ code: 'source_unavailable', details: { source: 'reply' } });
    expect(await errorOf(await send(owner.key, owner.localPart, { forwardAttachmentsFrom: hidden })))
      .toMatchObject({ code: 'source_unavailable', details: { source: 'forward' } });
    expect(await errorOf(await send(owner.key, owner.localPart, { forwardAttachmentsFrom: own, replyToMessageId: hidden })))
      .toMatchObject({ code: 'source_unavailable', details: { source: 'reply' } });
    expect(await errorOf(await send(owner.key, owner.localPart, { forwardAttachmentsFrom: hidden, replyToMessageId: own })))
      .toMatchObject({ code: 'source_unavailable', details: { source: 'forward' } });

    const broken = await mail(owner.address);
    await createDb(env).insert(attachments).values({ messageId: broken, r2Key: `att/${broken}/gone`, filename: 'gone.txt', mimeType: 'text/plain', size: 4 });
    expect(await errorOf(await send(owner.key, owner.localPart, { forwardAttachmentsFrom: broken })))
      .toMatchObject({ code: 'source_unavailable', details: { source: 'forward' } });
  });
});

describe('详情 ETag / If-None-Match（R19）', () => {
  it('etagMatches：弱比较、逗号分隔多个标签、* 匹配', () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('*', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"abd"', 'W/"abc"')).toBe(false);
    expect(etagMatches('', 'W/"abc"')).toBe(false);
    expect(etagMatches(undefined, 'W/"abc"')).toBe(false);
  });

  it('/v1 与 /api 详情带 ETag；带匹配的 If-None-Match 返回 304 空正文；邮件变化后重新返回 200', async () => {
    await baseSettings();
    const owner = await account('etag-owner');
    const id = await mail(owner.address);
    for (const [path, token] of [[`/v1/messages/${id}`, owner.key], [`/api/messages/${id}`, owner.jwt]] as const) {
      const first = await request(path, headers(token));
      expect(first.status).toBe(200);
      const etag = first.headers.get('ETag')!;
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
      expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
      expect((await first.json() as { data: MessageDetail }).data.bodyText).toBe('hello body');

      const again = await request(path, headers(token, { 'If-None-Match': etag }));
      expect(again.status, path).toBe(304);
      expect(again.headers.get('ETag')).toBe(etag);
      expect(await again.text()).toBe('');

      const stale = await request(path, headers(token, { 'If-None-Match': 'W/"0000"' }));
      expect(stale.status).toBe(200);
      expect(stale.headers.get('ETag')).toBe(etag);
      expect((await stale.json() as { data: MessageDetail }).data.bodyText).toBe('hello body');
    }

    const before = (await request(`/v1/messages/${id}`, headers(owner.key))).headers.get('ETag')!;
    await data(await request('/v1/messages/read', json(owner.key, { ids: [id], isRead: true })));
    const afterRead = await request(`/v1/messages/${id}`, headers(owner.key, { 'If-None-Match': before }));
    expect(afterRead.status).toBe(200);
    const readEtag = afterRead.headers.get('ETag')!;
    expect(readEtag).not.toBe(before);
    await data(await request('/v1/messages/star', json(owner.key, { ids: [id], starred: true })));
    expect((await request(`/v1/messages/${id}`, headers(owner.key, { 'If-None-Match': readEtag }))).status).toBe(200);
  });

  it('ETag 按查看者区分；不可见邮件即使 If-None-Match: * 也是 404', async () => {
    await baseSettings();
    const owner = await account('etag-viewer-owner');
    const member = await account('etag-viewer-member');
    const stranger = await account('etag-viewer-stranger');
    await createDb(env).insert(mailboxShares).values({ mailboxId: owner.mailboxId, userId: member.id, grantedBy: owner.id });
    const id = await mail(owner.address);
    const ownerEtag = (await request(`/v1/messages/${id}`, headers(owner.key))).headers.get('ETag')!;
    const memberResponse = await request(`/v1/messages/${id}`, headers(member.key, { 'If-None-Match': ownerEtag }));
    expect(memberResponse.status).toBe(200);
    expect(memberResponse.headers.get('ETag')).not.toBe(ownerEtag);
    const probe = await request(`/v1/messages/${id}`, headers(stranger.key, { 'If-None-Match': '*' }));
    expect(probe.status).toBe(404);
    expect(probe.headers.get('ETag')).toBeNull();
  });

  it('304 只用一次往返且不补读正文；ETag 不一致才补读正文', async () => {
    await baseSettings();
    const owner = await account('etag-rt');
    const id = await mail(owner.address, { bodyHtml: '<p>html body</p>' });
    const viewer = viewerOf(owner);
    const fresh = await getMessageDetailConditional(env, viewer, id);
    if (fresh.notModified) throw new Error('首次读取不应是 304');
    const traced = tracedEnv();
    expect(await getMessageDetailConditional(traced.env, viewer, id, { ifNoneMatch: fresh.etag })).toEqual({ etag: fresh.etag, notModified: true });
    expect(traced.calls.map((call) => call.kind)).toEqual(['batch']);
    traced.reset();
    const changed = await getMessageDetailConditional(traced.env, viewer, id, { ifNoneMatch: 'W/"other"' });
    expect(changed.notModified).toBe(false);
    if (!changed.notModified) expect(changed.detail).toMatchObject({ bodyText: 'hello body', bodyHtml: '<p>html body</p>' });
    expect(traced.calls.map((call) => call.kind)).toEqual(['batch', 'single']);
    expect(traced.calls[1]!.sql[0]).toMatch(/body_text/);
  });

  it('有附件时 ETag 随签名时间桶变化：/v1 按分钟，站内按整点；无附件不随时间变化', async () => {
    await baseSettings();
    const owner = await account('etag-bucket');
    const plain = await mail(owner.address);
    const withAtt = await mail(owner.address);
    await attach(withAtt);
    const viewer = viewerOf(owner);
    const etagAt = async (ms: number, id: number, ttl?: number) => {
      vi.spyOn(Date, 'now').mockReturnValue(ms);
      const result = await getMessageDetailConditional(env, viewer, id, { attachmentTtlSeconds: ttl });
      vi.restoreAllMocks();
      return result.etag;
    };
    const base = Date.UTC(2026, 10, 17, 8, 0, 10);
    expect(await etagAt(base, plain, 300)).toBe(await etagAt(base + 3 * 3600_000, plain, 300));
    expect(await etagAt(base, withAtt, 300)).toBe(await etagAt(base + 30_000, withAtt, 300));
    expect(await etagAt(base, withAtt, 300)).not.toBe(await etagAt(base + 60_000, withAtt, 300));
    expect(await etagAt(base, withAtt)).toBe(await etagAt(base + 30 * 60_000, withAtt));
    expect(await etagAt(base, withAtt)).not.toBe(await etagAt(base + 3600_000, withAtt));
  });

  it('列表等其他 GET 不带 ETag', async () => {
    await baseSettings();
    const owner = await account('etag-list');
    await mail(owner.address);
    const list = await request('/v1/messages', headers(owner.key));
    expect(list.status).toBe(200);
    expect(list.headers.get('ETag')).toBeNull();
    expect((await list.json() as { data: { items: MessageSummary[] } }).data.items.length).toBeGreaterThan(0);
  });
});
