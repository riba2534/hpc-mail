import {
  API_SCOPES, DEFAULT_SETTINGS, type ApiScope, type CreatedApiKey, type MessageDetail, type MessageSummary, type Settings,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { handleInbound } from '../src/services/inbound.js';
import { findNextMessage, getMessageDetail } from '../src/services/message.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); });

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const json = (token: string, body: unknown): RequestInit =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function errorOf(response: Response, status: number): Promise<string> {
  const body = await response.json() as { error: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error.code;
}
const rand = () => crypto.randomUUID().slice(0, 8);

/** 同文件用例共享 D1/KV：每个用例开头显式写入自己依赖的设置 */
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

/** 建用户（JWT + 一把指定 scope 的 Key）并认领 `{prefix}-{随机}@hpc.email` */
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
  return { id: user!.id, jwt, key: key.key, localPart, address, mailboxId: box!.id };
}

async function mail(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  const [row] = await createDb(env).insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@example.net',
    subject: 'hello', preview: 'hello', status: 'received', messageId: `<${rand()}@example.net>`, createdAt: new Date(), ...extra,
  }).returning({ id: messages.id });
  return row!.id;
}

/** 给邮件挂一个 R2 中真实存在的附件 */
async function attach(messageId: number, filename = 'proof.txt', extra: Partial<typeof attachments.$inferInsert> = {}) {
  const r2Key = `att/${messageId}/${rand()}`;
  await env.r2.put(r2Key, `content of ${filename}`);
  const [row] = await createDb(env).insert(attachments)
    .values({ messageId, r2Key, filename, mimeType: 'text/plain', size: 10 + filename.length, ...extra }).returning({ id: attachments.id });
  return row!.id;
}

async function maxMessageId(): Promise<number> {
  const row = await createDb(env).select({ id: sql<number>`coalesce(max(${messages.id}), 0)` }).from(messages).get();
  return row!.id;
}

async function outboundCount(subject: string): Promise<number> {
  const rows = await createDb(env).select({ id: messages.id }).from(messages).where(eq(messages.subject, subject)).all();
  return rows.length;
}

describe('X01 已存验证码不被摘要重提覆盖', () => {
  it('真码在第 160 字之后、摘要开头有年份和订单号：列表、wait、线程与详情都返回收件时存下的码', async () => {
    await baseSettings();
    const owner = await account('x01');
    const base = await maxMessageId();
    const body = [
      'Order #20261117 was placed on November 17, 2026 and is waiting for you to sign in on a new device.',
      'We need to confirm it is really you before the checkout can continue, so please enter the code below within ten minutes.',
      'Your verification code is 482913.',
    ].join('\r\n');
    const raw = `From: Shop <security@shop.example>\r\nTo: ${owner.address}\r\nSubject: Your verification code\r\nMessage-ID: <x01-${rand()}@shop.example>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n`;
    const ctx = createExecutionContext();
    await handleInbound({ to: owner.address, from: 'security@shop.example', headers: new Headers(), raw: new Response(raw).body!,
      forward: async () => {}, setReject: () => {} } as unknown as ForwardableEmailMessage, env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    expect(row!.verificationCode).toBe('482913');
    expect(row!.preview).not.toContain('482913');

    const codes = {
      apiList: (await data<{ items: MessageSummary[] }>(await request(`/api/messages?address=${owner.address}`, auth(owner.jwt)))).items[0]!.verificationCode,
      v1List: (await data<{ items: MessageSummary[] }>(await request(`/v1/messages?address=${owner.address}`, auth(owner.key)))).items[0]!.verificationCode,
      wait: (await data<{ message: MessageSummary | null }>(await request(
        `/v1/messages/wait?address=${owner.address}&afterId=${base}&hasCode=1&timeout=1`, auth(owner.key)))).message?.verificationCode,
      thread: (await data<{ items: MessageSummary[] }>(await request(`/api/messages/${row!.id}/thread`, auth(owner.jwt)))).items[0]!.verificationCode,
      apiDetail: (await data<MessageDetail>(await request(`/api/messages/${row!.id}`, auth(owner.jwt)))).verificationCode,
      v1Detail: (await data<MessageDetail>(await request(`/v1/messages/${row!.id}`, auth(owner.key)))).verificationCode,
    };
    expect(codes).toEqual({ apiList: '482913', v1List: '482913', wait: '482913', thread: '482913', apiDetail: '482913', v1Detail: '482913' });
  });

  it('已存值为空的历史行只按摘要重提，详情与列表同一口径', async () => {
    await baseSettings();
    const owner = await account('x01-legacy');
    const body = 'Order #20261117 was placed on November 17, 2026.\n' + 'Please keep this email for your records. '.repeat(5) + '\nYour verification code is 482913.';
    const id = await mail(owner.address, { subject: 'Your verification code', bodyText: body, preview: body.replace(/\s+/g, ' ').slice(0, 160), verificationCode: '' });
    const listed = (await data<{ items: MessageSummary[] }>(await request(`/api/messages?address=${owner.address}`, auth(owner.jwt)))).items[0]!;
    const detail = await data<MessageDetail>(await request(`/api/messages/${id}`, auth(owner.jwt)));
    expect(detail.verificationCode).toBe(listed.verificationCode);
  });
});

describe('X03 wait 不越过附件未就绪的收件', () => {
  it('pending 收件停住游标，转为完整后带附件返回；发件人不匹配的照常跳过；超过等待窗口不再挡住后面的邮件', async () => {
    await baseSettings();
    const owner = await account('x03');
    const viewer = { userId: owner.id, role: 'user' as const };
    const base = await maxMessageId();
    const pending = await mail(owner.address, { fromAddress: 'billing@vendor.example', subject: 'Invoice attached', status: 'pending' });
    const later = await mail(owner.address, { fromAddress: 'login@other.example', subject: 'Your code', preview: 'Your verification code is 135790', verificationCode: '135790' });
    const next = (filters: Omit<Parameters<typeof findNextMessage>[2], 'address'>) => findNextMessage(env, viewer, { address: owner.address, ...filters });

    expect(await next({ afterId: base })).toEqual({ message: null, scannedThroughId: base });
    expect(await next({ afterId: base, from: '@vendor.example' })).toEqual({ message: null, scannedThroughId: base });
    expect(await next({ afterId: base, hasCode: true })).toEqual({ message: null, scannedThroughId: base });
    expect(await next({ afterId: base, from: '@other.example' })).toMatchObject({ message: { id: later }, scannedThroughId: later });
    expect(await data(await request(`/v1/messages/wait?address=${owner.address}&afterId=${base}&timeout=1`, auth(owner.key))))
      .toEqual({ message: null, scannedThroughId: base });

    await attach(pending, 'invoice.pdf');
    await createDb(env).update(messages).set({ status: 'received' }).where(eq(messages.id, pending));
    expect(await next({ afterId: base })).toMatchObject({ message: { id: pending, hasAttachments: true }, scannedThroughId: pending });

    const stuck = await mail(owner.address, { subject: 'Stuck upload', status: 'pending', createdAt: new Date(Date.now() - 3 * 60_000) });
    expect(await next({ afterId: later })).toMatchObject({ message: { id: stuck }, scannedThroughId: stuck });
  });
});

describe('X06 unread-count 显式校验 scope', () => {
  it('只接受 mine，其他范围 400，不静默退回个人未读数', async () => {
    await baseSettings();
    const admin = await account('x06-admin', 'admin');
    await mail(admin.address);
    const unread = (await data<{ unread: number }>(await request('/v1/messages/unread-count', auth(admin.key)))).unread;
    expect(unread).toBe(1);
    expect((await data<{ unread: number }>(await request('/v1/messages/unread-count?scope=mine', auth(admin.key)))).unread).toBe(unread);
    for (const query of ['scope=unclaimed', `scope=user&userId=${admin.id}`, 'scope=all', 'scope=']) {
      expect(await errorOf(await request(`/v1/messages/unread-count?${query}`, auth(admin.key)), 400), query).toBe('validation_failed');
    }
  });
});

describe('R09 发信引用来源邮件需要读取权限与可见性', () => {
  const send = (key: string, from: string, extra: Record<string, unknown>) => request('/v1/messages', json(key, {
    from: { localPart: from, domain: 'hpc.email' }, to: [`r09-sink-${rand()}@hpc.email`], text: 'body', ...extra,
  }));

  it('只有 mail.send 的 Key 不能转发附件或回复，普通发信不受影响', async () => {
    await baseSettings();
    const owner = await account('r09-sendonly', 'user', ['mail.send']);
    const source = await mail(owner.address, { subject: 'Original' });
    await attach(source);
    for (const [label, extra] of [['forward', { forwardAttachmentsFrom: source }], ['reply', { replyToMessageId: source }]] as const) {
      const subject = `r09-sendonly-${label}-${rand()}`;
      expect(await errorOf(await send(owner.key, owner.localPart, { subject, ...extra }), 403), label).toBe('forbidden');
      expect(await outboundCount(subject)).toBe(0);
    }
    const sent = await data<MessageSummary>(await send(owner.key, owner.localPart, { subject: `r09-plain-${rand()}` }), 201);
    expect(sent.status).toBe('delivered');
  });

  it('来源按 mine 判定：本人与共享来的收件可转发；他人私有邮件与不存在的 id 同为 404', async () => {
    await baseSettings();
    const owner = await account('r09-owner');
    const other = await account('r09-other');
    const own = await mail(owner.address, { subject: 'Own original' });
    await attach(own, 'own.txt');
    const sharedSource = await mail(other.address, { subject: 'Shared original' });
    await attach(sharedSource, 'shared.txt');
    const privateSource = await mail(other.address, { subject: 'Private original' });
    await attach(privateSource, 'private.txt');

    const forwarded = await data<MessageSummary>(await send(owner.key, owner.localPart, { subject: `r09-own-${rand()}`, forwardAttachmentsFrom: own, replyToMessageId: own }), 201);
    expect(forwarded.hasAttachments).toBe(true);

    for (const source of [privateSource, 999_999_999]) {
      for (const field of ['forwardAttachmentsFrom', 'replyToMessageId']) {
        const subject = `r09-hidden-${rand()}`;
        expect(await errorOf(await send(owner.key, owner.localPart, { subject, [field]: source }), 404), `${field}=${source}`).toBe('not_found');
        expect(await outboundCount(subject)).toBe(0);
      }
    }

    await createDb(env).insert(mailboxShares).values({ mailboxId: other.mailboxId, userId: owner.id, grantedBy: other.id });
    const viaShare = await data<MessageSummary>(await send(owner.key, owner.localPart, { subject: `r09-shared-${rand()}`, forwardAttachmentsFrom: sharedSource }), 201);
    expect(viaShare.hasAttachments).toBe(true);
  });

  it('管理员 Key 只能引用自己的与未认领地址的邮件，不能借此外发其他用户的私有邮件', async () => {
    await baseSettings();
    const admin = await account('r09-admin', 'admin');
    const user = await account('r09-user');
    const privateSource = await mail(user.address, { subject: 'User private' });
    await attach(privateSource, 'user.txt');
    const unclaimedSource = await mail(`r09-unclaimed-${rand()}@hpc.email`, { subject: 'Unclaimed original' });
    await attach(unclaimedSource, 'unclaimed.txt');

    for (const field of ['forwardAttachmentsFrom', 'replyToMessageId']) {
      const subject = `r09-admin-hidden-${rand()}`;
      expect(await errorOf(await send(admin.key, admin.localPart, { subject, [field]: privateSource }), 404), field).toBe('not_found');
      expect(await outboundCount(subject)).toBe(0);
    }
    const fromUnclaimed = await data<MessageSummary>(await send(admin.key, admin.localPart, {
      subject: `r09-admin-unclaimed-${rand()}`, forwardAttachmentsFrom: unclaimedSource, replyToMessageId: unclaimedSource,
    }), 201);
    expect(fromUnclaimed.hasAttachments).toBe(true);
  });
});

describe('R05 站内详情签名 URL 与 JWT 附件下载', () => {
  it('同一小时内详情的附件与内嵌图 URL 不变，打开 6 分钟后仍可下载', async () => {
    await baseSettings();
    const owner = await account('r05-sign');
    const id = await mail(owner.address, { subject: 'Inline picture', bodyHtml: '<p>Logo</p><img src="cid:logo-1">' });
    const attId = await attach(id, 'logo.png', { contentId: 'logo-1', disposition: 'inline' });
    const viewer = { userId: owner.id, role: 'user' as const };
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(hour + 60_000);
    const first = await getMessageDetail(env, viewer, id);
    now.mockReturnValue(hour + 59 * 60_000);
    const second = await getMessageDetail(env, viewer, id);
    expect(second.attachments[0]!.url).toBe(first.attachments[0]!.url);
    expect(second.bodyHtml).toBe(first.bodyHtml);
    expect(first.bodyHtml).toContain(`/api/attachments/${attId}?exp=`);

    const url = first.attachments[0]!.url;
    expect(Number(new URL(url, 'https://hpc.email').searchParams.get('exp')) * 1000 - (hour + 59 * 60_000)).toBeGreaterThanOrEqual(3_600_000);
    now.mockReturnValue(hour + 65 * 60_000);
    const download = await request(url);
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe('content of logo.png');
  });

  it('JWT 下载与详情同一可见范围：管理员带 scope=user 审计他人附件，普通用户不能用 scope=user，非法 scope 显式拒绝', async () => {
    await baseSettings();
    const admin = await account('r05-admin', 'admin');
    const owner = await account('r05-owner');
    const stranger = await account('r05-stranger');
    const attId = await attach(await mail(owner.address, { subject: 'Private attachment' }), 'private.txt');
    const download = (token: string, query = '') => request(`/api/attachments/${attId}${query}`, auth(token));

    expect((await download(owner.jwt)).status).toBe(200);
    expect(new TextDecoder().decode(await (await download(admin.jwt, `?scope=user&userId=${owner.id}`)).arrayBuffer())).toBe('content of private.txt');
    expect(await errorOf(await download(admin.jwt), 404)).toBe('not_found');
    expect(await errorOf(await download(admin.jwt, `?scope=user&userId=${stranger.id}`), 404)).toBe('not_found');
    expect(await errorOf(await download(stranger.jwt, `?scope=user&userId=${owner.id}`), 403)).toBe('forbidden');
    expect(await errorOf(await download(stranger.jwt), 404)).toBe('not_found');
    expect(await errorOf(await download(admin.jwt, '?scope=all'), 400)).toBe('validation_failed');
  });
});
