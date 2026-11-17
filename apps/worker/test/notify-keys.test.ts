import type { ApiScope, MailboxShareGrant, NotificationHealth, NotifyPrefsView } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxes, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { bumpCounter, dayWindow } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import type { Env } from '../src/types.js';
import { TEST_PASSWORD, testPasswordHash } from './key-helpers.js';

const app = createApp();
const db = createDb(env);
let seq = 0;

function mailEnv() {
  const captured: { to: string; text: string }[] = [];
  const send = vi.fn(async (mail: { to: string; raw?: string; 'EmailMessage::raw'?: string }) => {
    // workerd 的 EmailMessage 把原文存在 EmailMessage::raw 上
    const parsed = await PostalMime.parse(await new Response(mail.raw ?? mail['EmailMessage::raw']).text());
    captured.push({ to: mail.to, text: parsed.text ?? '' });
  });
  return { runtime: { ...env, email: { send } } as unknown as Env, captured };
}
const { runtime, captured } = mailEnv();

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
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
async function errorCode(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error?: { code: string } }).error?.code };
}

async function account(name: string) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    api: { enabled: true }, security: { require2fa: false },
  });
  const [user] = await db.insert(users).values({ username: `nk-${name}-${++seq}`, role: 'user', passwordHash: await testPasswordHash(),
    status: 'active', authVersionMigrated: true }).returning();
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid: await createSession(env, user!.id), epoch: 0, uepoch: 0 });
  const key = async (scopes: ApiScope[], extra: { allowedMailboxIds?: number[]; allowedDomains?: string[] } = {}) =>
    (await createApiKey(env, user!.id, { name: `k-${++seq}`, scopes, rateLimit: 600, allowedIps: [], ...extra })).key;
  return { id: user!.id, username: user!.username, jwt, key };
}
const own = async (userId: number, address: string) =>
  (await db.insert(mailboxes).values({ address, domain: address.split('@')[1]!, userId }).returning().get())!;

describe('通知配置开放给 notify.read / notify.write', () => {
  it('读取掩码偏好；可改飞书等通道；不能改转发；scope 与限定范围都会拦截', async () => {
    const user = await account('notify');
    await updateUserNotifyPrefs(env, user.id, { webhook: { enabled: true, url: 'https://hooks.example.com/a', secret: 'shh' } });
    const reader = await user.key(['notify.read']);
    const writer = await user.key(['notify.read', 'notify.write']);
    const prefs = await data<NotifyPrefsView>(await request('/v1/notify-prefs', { headers: auth(reader) }));
    expect(prefs.webhook).toMatchObject({ enabled: true, secret: '******' });
    expect(prefs.forwardPending).toEqual([]);
    expect((await request('/v1/notify-prefs', json(reader, { feishu: { enabled: false, webhookUrl: '', secret: '' } }, 'PUT'))).status).toBe(403);
    const updated = await data<NotifyPrefsView>(await request('/v1/notify-prefs',
      json(writer, { pushdeer: { enabled: true, endpoint: '', pushkey: 'PDU_TEST' } }, 'PUT')));
    expect(updated.pushdeer).toMatchObject({ enabled: true, pushkey: '******' });
    expect(updated.webhook.secret).toBe('******');
    expect(await errorCode(await request('/v1/notify-prefs', json(writer, { forward: { enabled: true, addresses: ['x@example.net'] } }, 'PUT'))))
      .toEqual({ status: 403, code: 'forbidden' });
    expect((await data<NotificationHealth>(await request('/v1/notify-prefs/health', { headers: auth(reader) }))).channels).toHaveLength(4);

    const box = await own(user.id, `nk-notify-box-${seq}@hpc.email`);
    const scoped = await user.key(['notify.read', 'notify.write'], { allowedMailboxIds: [box.id] });
    expect((await request('/v1/notify-prefs', { headers: auth(scoped) })).status).toBe(200);
    expect((await request('/v1/notify-prefs', json(scoped, { pushdeer: { enabled: false, endpoint: '', pushkey: '' } }, 'PUT'))).status).toBe(403);
    expect((await request('/v1/notify-prefs/health', { headers: auth(scoped) })).status).toBe(403);
    expect((await request('/v1/notify-prefs/feishu-test', { method: 'POST', headers: auth(scoped) })).status).toBe(403);
  });
});

describe('共享管理开放给 mailbox.share', () => {
  it('按 userId 共享、列出、批量追加、撤销；限定范围的 Key 只能管理范围内的邮箱', async () => {
    const owner = await account('share-owner');
    const reader = await account('share-reader');
    const a = await own(owner.id, `nk-share-a-${seq}@hpc.email`);
    const b = await own(owner.id, `nk-share-b-${seq}@hpc.email`);
    const noScope = await owner.key(['mailbox.read']);
    expect((await request('/v1/mailboxes/shares', { headers: auth(noScope) })).status).toBe(403);
    const key = await owner.key(['mailbox.share']);
    const grant = await data<MailboxShareGrant>(await request('/v1/mailboxes/shares', json(key, { mailboxId: a.id, userIds: [reader.id] }, 'PUT')));
    expect(grant.grantees.map((item) => item.userId)).toEqual([reader.id]);
    const batch = await data<MailboxShareGrant[]>(await request('/v1/mailboxes/shares/batch', json(key, { mailboxIds: [a.id, b.id], userIds: [reader.id] })));
    expect(batch.map((item) => item.mailboxId).sort()).toEqual([a.id, b.id].sort());
    expect((await data<MailboxShareGrant[]>(await request('/v1/mailboxes/shares', { headers: auth(key) }))).length).toBeGreaterThanOrEqual(2);
    // 不是自己的邮箱不能共享
    const theirs = await own(reader.id, `nk-share-theirs-${seq}@hpc.email`);
    expect((await request('/v1/mailboxes/shares', json(key, { mailboxId: theirs.id, userIds: [owner.id] }, 'PUT'))).status).toBeGreaterThanOrEqual(400);

    const scoped = await owner.key(['mailbox.share'], { allowedMailboxIds: [a.id] });
    const listed = await data<MailboxShareGrant[]>(await request('/v1/mailboxes/shares', { headers: auth(scoped) }));
    expect(listed.map((item) => item.mailboxId)).toEqual([a.id]);
    expect((await request('/v1/mailboxes/shares', json(scoped, { mailboxId: b.id, userIds: [] }, 'PUT'))).status).toBe(403);
    expect((await request('/v1/mailboxes/shares/batch', json(scoped, { mailboxIds: [a.id, b.id], userIds: [reader.id] }))).status).toBe(403);
    expect((await request(`/v1/mailboxes/shares/${b.id}/grantees/${reader.id}`, { method: 'DELETE', headers: auth(scoped) })).status).toBe(403);
    expect((await request(`/v1/mailboxes/shares/${a.id}/grantees/${reader.id}`, { method: 'DELETE', headers: auth(scoped) })).status).toBe(200);
  });
});

describe('新增转发目标要重新验证密码并经目标邮箱确认', () => {
  const tokenOf = (text: string) => /#token=([0-9a-f]{64})/.exec(text)?.[1];

  it('新地址先进入 forwardPending 并收到确认信，确认后才写进转发目标；token 只能用一次', async () => {
    const user = await account('forward');
    const target = `nk-target-${seq}@example.net`;
    const body = { forward: { enabled: true, addresses: [target] } };
    expect(await errorCode(await request('/api/me/notify-prefs', json(user.jwt, body, 'PUT')))).toEqual({ status: 403, code: 'reauth_required' });
    expect(await errorCode(await request('/api/me/notify-prefs', json(user.jwt, { ...body, password: 'wrong' }, 'PUT')))).toEqual({ status: 403, code: 'reauth_failed' });
    const saved = await data<NotifyPrefsView>(await request('/api/me/notify-prefs', json(user.jwt, { ...body, password: TEST_PASSWORD }, 'PUT')));
    expect(saved.forward).toEqual({ enabled: true, addresses: [] });
    expect(saved.forwardPending.map((item) => item.address)).toEqual([target]);
    const mail = captured.filter((item) => item.to === target).at(-1)!;
    expect(mail.text).toContain(user.username);
    const token = tokenOf(mail.text)!;
    expect(token).toBeTruthy();
    // 再保存同样的列表不重发、不要密码之外的东西变化
    const sentBefore = captured.length;
    await data(await request('/api/me/notify-prefs', json(user.jwt, { ...body, password: TEST_PASSWORD }, 'PUT')));
    expect(captured.length).toBe(sentBefore);

    expect((await data<{ address: string }>(await request('/api/forward-confirmations/confirm', json('', { token })))).address).toBe(target);
    const after = await data<NotifyPrefsView>(await request('/api/me/notify-prefs', { headers: auth(user.jwt) }));
    expect(after.forward).toEqual({ enabled: true, addresses: [target] });
    expect(after.forwardPending).toEqual([]);
    expect((await request('/api/forward-confirmations/confirm', json('', { token }))).status).toBe(404);
    // 已确认的目标保留，关闭转发不需要密码
    expect((await data<NotifyPrefsView>(await request('/api/me/notify-prefs', json(user.jwt, { forward: { enabled: false, addresses: [target] } }, 'PUT')))).forward)
      .toEqual({ enabled: false, addresses: [target] });
    // 重新打开需要密码
    expect((await request('/api/me/notify-prefs', json(user.jwt, { forward: { enabled: true, addresses: [target] } }, 'PUT'))).status).toBe(403);
  });

  it('从列表里去掉待确认的地址会撤销确认；每天的确认信有上限', async () => {
    const user = await account('forward-cancel');
    const target = `nk-cancel-${seq}@example.net`;
    await data(await request('/api/me/notify-prefs', json(user.jwt, { forward: { enabled: true, addresses: [target] }, password: TEST_PASSWORD }, 'PUT')));
    const token = tokenOf(captured.filter((item) => item.to === target).at(-1)!.text)!;
    const cleared = await data<NotifyPrefsView>(await request('/api/me/notify-prefs', json(user.jwt, { forward: { enabled: false, addresses: [] } }, 'PUT')));
    expect(cleared.forwardPending).toEqual([]);
    expect((await request('/api/forward-confirmations/confirm', json('', { token }))).status).toBe(404);

    await bumpCounter(env, 'fwd-confirm', String(user.id), dayWindow(), 20);
    expect(await errorCode(await request('/api/me/notify-prefs',
      json(user.jwt, { forward: { enabled: true, addresses: [`nk-over-${seq}@example.net`] }, password: TEST_PASSWORD }, 'PUT'))))
      .toEqual({ status: 429, code: 'rate_limited' });
    expect((await db.select().from(users).where(eq(users.id, user.id)).get())!.notifyPrefs?.forward.addresses ?? []).toEqual([]);
  });
});
