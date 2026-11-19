import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { DEFAULT_USER_NOTIFY_PREFS, type UserNotifyPrefs } from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { emailDeliveryRefs, mailboxes, notificationJobs, users } from '../src/db/schema.js';
import { FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE, forwardReceivedMail, type ForwardMail } from '../src/services/forwarding.js';
import { handleInbound } from '../src/services/inbound.js';
import { FORWARD_TARGET_DAILY_LIMIT } from '../src/services/notification-jobs.js';
import { loadNotifyOwners, updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { bumpCounter, dayWindow, readCounter } from '../src/services/rate-counter.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const db = createDb(env);
let sequence = 0;

/** 全站中转计数在同一文件的用例间共享，每个用例从零开始 */
beforeEach(async () => {
  await env.db.prepare('DELETE FROM rate_counters WHERE scope = ?').bind(FORWARD_RELAY_SCOPE).run();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

async function seedUser(name: string, targets: string[], status: 'active' | 'disabled' = 'active', role: 'user' | 'admin' = 'user') {
  const [user] = await db.insert(users).values({ username: name, passwordHash: 'x', role, status }).returning({ id: users.id });
  const prefs: UserNotifyPrefs = { ...DEFAULT_USER_NOTIFY_PREFS, forward: { enabled: true, addresses: targets } };
  await updateUserNotifyPrefs(env, user!.id, { forward: prefs.forward });
  return { id: user!.id, prefs };
}

/** 转发归属人的状态与偏好，同收件链路用 loadNotifyOwners 读出 */
const owners = (...seeded: { id: number }[]) => loadNotifyOwners(env, seeded.map((user) => user.id));

function relayEnv() {
  const sent: { from: string; to: string; raw: string }[] = [];
  const send = vi.fn(async (message: { from: string; to: string; raw: string }) => {
    sent.push(message);
    return { messageId: 'cf-mock-provider-id' };
  });
  return { env: { ...env, email: { send }, site_origin: 'https://mail.example.test' } as unknown as Env, sent, send };
}

function mail(ownerIds: number[], toAddress = `fq-${++sequence}@quota.test`): ForwardMail {
  return {
    messageId: 900_000 + ++sequence, ownerIds, fromAddress: 'sender@example.net', fromName: 'Sender',
    toAddress, domain: toAddress.split('@')[1]!, subject: 'quota subject', text: 'quota body', html: '', replyTo: [], attachments: [],
  };
}

/** 已认领地址的来信：地址归 owner，归属人快照只有 owner */
async function claimedMail(ownerId: number): Promise<ForwardMail> {
  const item = mail([ownerId]);
  await db.insert(mailboxes).values({ address: item.toAddress, domain: item.domain, userId: ownerId });
  return item;
}

async function setRelayQuota(relayDaily: number, relayPerUserDaily: number, relayUnclaimedDaily = 0) {
  await updateSettings(env, { quota: { dailyOutbound: 0, dailyRecipients: 0, relayDaily, relayPerUserDaily, relayUnclaimedDaily } });
}

const count = async (scope: string, subject: string) => (await readCounter(env, scope, subject, dayWindow())).count;

async function forwardRows(userId: number) {
  return (await db.select().from(notificationJobs)
    .where(and(eq(notificationJobs.userId, userId), eq(notificationJobs.channel, 'forward'))).all())
    .map((row) => ({ target: row.target, status: row.status, mode: row.forwardMode, error: row.lastError }))
    .sort((a, b) => a.target.localeCompare(b.target) || a.status.localeCompare(b.status));
}

describe('转发中转配额（R06）', () => {
  it('全站日上限：超限记 skipped、计数不再累加；所有目标均走中转；0 表示不限但照常计数', async () => {
    await setRelayQuota(2, 0);
    const owner = await seedUser('fq-site', ['t1@ext.test', 't2@ext.test', 't3@ext.test']);
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, await claimedMail(owner.id), await owners(owner));
    expect(relay.sent.map((item) => item.to).sort()).toEqual(['t1@ext.test', 't2@ext.test']);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);
    // 第三个目标被拒时，按人计数占到的一格退回
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(owner.id))).toBe(2);
    expect(await forwardRows(owner.id)).toEqual([
      { target: 't1@ext.test', status: 'succeeded', mode: 'relay', error: '' },
      { target: 't2@ext.test', status: 'succeeded', mode: 'relay', error: '' },
      { target: 't3@ext.test', status: 'skipped', mode: '', error: '全站今日中转转发额度已用尽' },
    ]);
    // 中转信声明自动转发
    expect(relay.sent[0]!.raw).toMatch(/^Auto-Submitted: auto-forwarded\r$/m);

    // 已满后再来的中转请求不推高计数
    await forwardReceivedMail(relay.env, await claimedMail(owner.id), await owners(owner));
    expect(relay.sent).toHaveLength(2);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);

    // 即使存在可调用的原生转发入口，额度用尽时也不回退原样转发
    const native = { headers: new Headers(), forward: vi.fn(async () => {}) } as unknown as ForwardableEmailMessage;
    const nativeMail = await claimedMail(owner.id);
    await forwardReceivedMail(relay.env, nativeMail, await owners(owner), native);
    expect(native.forward).not.toHaveBeenCalled();
    expect(relay.sent).toHaveLength(2);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);
    const nativeRows = await db.select().from(notificationJobs).where(eq(notificationJobs.messageId, nativeMail.messageId)).all();
    expect(nativeRows.map((row) => [row.status, row.forwardMode])).toEqual([['skipped', ''], ['skipped', ''], ['skipped', '']]);

    await setRelayQuota(0, 0);
    await forwardReceivedMail(relay.env, await claimedMail(owner.id), await owners(owner));
    expect(relay.sent).toHaveLength(5);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(5);
  });

  it('按归属人日上限：已认领地址用尽的人跳过、其他人不受影响', async () => {
    await setRelayQuota(0, 1);
    const a = await seedUser('fq-user-a', ['fq-a@ext.test']);
    const b = await seedUser('fq-user-b', ['fq-b@ext.test']);
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, await claimedMail(a.id), await owners(a));
    await forwardReceivedMail(relay.env, await claimedMail(a.id), await owners(a));
    await forwardReceivedMail(relay.env, await claimedMail(b.id), await owners(b));
    expect(relay.sent.map((item) => item.to)).toEqual(['fq-a@ext.test', 'fq-b@ext.test']);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(a.id))).toBe(1);
    expect((await forwardRows(a.id)).map((row) => [row.status, row.mode, row.error])).toEqual([
      ['skipped', '', '今日中转转发额度已用尽'], ['succeeded', 'relay', ''],
    ]);
  });

  /** 未认领地址按每位管理员各计一份时，外部来信能把全站中转额度按管理员人数成倍耗掉（N2） */
  it('未认领地址（站内互投）：全体管理员共用一个计数，不按人叠加，也不占个人额度', async () => {
    await setRelayQuota(0, 1, 3);
    const a1 = await seedUser('fq-unclaimed-a1', ['un-a1@ext.test', 'un-shared@ext.test'], 'active', 'admin');
    const a2 = await seedUser('fq-unclaimed-a2', ['un-a2@ext.test', 'un-shared@ext.test'], 'active', 'admin');
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, mail([a1.id, a2.id]), await owners(a1, a2));
    expect(relay.sent.map((item) => item.to).sort()).toEqual(['un-a1@ext.test', 'un-a2@ext.test', 'un-shared@ext.test']);
    expect(await count(FORWARD_RELAY_SCOPE, 'unclaimed')).toBe(3);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(3);
    expect([await count(FORWARD_RELAY_USER_SCOPE, String(a1.id)), await count(FORWARD_RELAY_USER_SCOPE, String(a2.id))]).toEqual([0, 0]);

    // 共用额度用尽：再来的信全部跳过，计数不再累加，已占的域名与目标计数退回
    const domainBefore = await count('fwd-domain', 'quota.test');
    await forwardReceivedMail(relay.env, mail([a1.id, a2.id]), await owners(a1, a2));
    expect(relay.sent).toHaveLength(3);
    expect(await count(FORWARD_RELAY_SCOPE, 'unclaimed')).toBe(3);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(3);
    expect(await count('fwd-domain', 'quota.test')).toBe(domainBefore);
    expect((await forwardRows(a1.id)).filter((row) => row.status === 'skipped').map((row) => row.error))
      .toEqual(['未认领地址今日中转转发额度已用尽', '未认领地址今日中转转发额度已用尽']);

    // 收信后地址已由其他用户认领，旧管理员的转发权限立即失效
    const other = await seedUser('fq-unclaimed-later', ['un-later@ext.test']);
    await setRelayQuota(0, 1, 0);
    const later = mail([a1.id]);
    await db.insert(mailboxes).values({ address: later.toAddress, domain: later.domain, userId: other.id });
    await forwardReceivedMail(relay.env, later, await owners(a1));
    expect(await count(FORWARD_RELAY_SCOPE, 'unclaimed')).toBe(3);
    expect(relay.sent).toHaveLength(3);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(a1.id))).toBe(0);
  });

  it('未认领地址（入站收件）：同样计入共用计数', async () => {
    await setRelayQuota(0, 1, 1);
    await updateSettings(env, { code_extract: { enabled: false, aiEnabled: false } });
    const admin = await seedUser('fq-unclaimed-inbound', ['un-inbound@ext.test'], 'active', 'admin');
    const address = 'fq-unclaimed-inbound@quota-inbound.test';
    const relay = relayEnv();
    const forward = vi.fn(async () => { throw new Error('destination not verified'); });
    const raw = ['From: Sender <sender@example.net>', `To: ${address}`, 'Subject: fq unclaimed', 'Message-ID: <fq-unclaimed@example.net>',
      'Content-Type: text/plain; charset=utf-8', '', 'hello', ''].join('\r\n');
    const ctx = createExecutionContext();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleInbound({ raw: new Response(raw).body!, headers: new Headers(), to: address, from: 'sender@example.net', forward,
      setReject: vi.fn() } as unknown as ForwardableEmailMessage, relay.env, ctx);
    await waitOnExecutionContext(ctx);
    // 本文件之前用例的管理员同样是归属人：共用额度 1，只中转出去一封
    expect(forward).not.toHaveBeenCalled();
    expect(relay.sent).toHaveLength(1);
    expect(await count(FORWARD_RELAY_SCOPE, 'unclaimed')).toBe(1);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(admin.id))).toBe(0);
  });

  /** 中转被跳过时域名与目标计数、中转抛错时中转额度一度不退（N4） */
  it('中转因额度跳过时退还域名与目标计数；中转抛错时退还中转额度', async () => {
    await setRelayQuota(1, 0);
    const owner = await seedUser('fq-refund', ['fq-refund@ext.test']);
    const relay = relayEnv();
    const refundMail = async (local: string, domain: string) => {
      const item = mail([owner.id], `${local}@${domain}`);
      await db.insert(mailboxes).values({ address: item.toAddress, domain: item.domain, userId: owner.id });
      return item;
    };
    await forwardReceivedMail(relay.env, await refundMail('r1', 'refund.test'), await owners(owner));
    await forwardReceivedMail(relay.env, await refundMail('r2', 'refund.test'), await owners(owner));
    expect(relay.sent).toHaveLength(1);
    expect(await count('fwd-domain', 'refund.test')).toBe(1);
    expect(await count('fwd-target', 'fq-refund@ext.test')).toBe(1);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(owner.id))).toBe(1);

    await setRelayQuota(0, 0);
    const failing = { ...env, email: { send: async () => { throw Object.assign(new Error('SMTP provider details'), { code: 'E_DELIVERY_FAILED' }); } } } as unknown as Env;
    await forwardReceivedMail(failing, await refundMail('r3', 'refund-fail.test'), await owners(owner));
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(1);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(owner.id))).toBe(1);
    // 发送尝试过，域名与目标计数照算
    expect(await count('fwd-domain', 'refund-fail.test')).toBe(1);
    expect((await forwardRows(owner.id)).map((row) => [row.status, row.mode, row.error])).toEqual([
      ['failed', 'relay', '邮件服务拒绝了转发，请检查目标地址及发送额度'], ['skipped', '', '全站今日中转转发额度已用尽'], ['succeeded', 'relay', ''],
    ]);
  });

  it('域名或目标的日计数已满时跳过，两个计数都不再累加', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-target-full', ['fq-full@ext.test']);
    await bumpCounter(env, 'fwd-target', 'fq-full@ext.test', dayWindow(), FORWARD_TARGET_DAILY_LIMIT);
    const relay = relayEnv();
    const target = mail([owner.id], 'fq-target-full@quota-full.test');
    await db.insert(mailboxes).values({ address: target.toAddress, domain: target.domain, userId: owner.id });
    await forwardReceivedMail(relay.env, target, await owners(owner));
    expect(relay.sent).toHaveLength(0);
    expect(await count('fwd-target', 'fq-full@ext.test')).toBe(FORWARD_TARGET_DAILY_LIMIT);
    expect(await count('fwd-domain', 'quota-full.test')).toBe(0);
    expect(await forwardRows(owner.id)).toEqual([{ target: 'fq-full@ext.test', status: 'skipped', mode: '', error: '今日转发额度已用尽' }]);
  });
});

describe('停用归属人不转发（R27）', () => {
  it('停用的归属人原生与中转都不转发，同目标的启用归属人照常', async () => {
    await setRelayQuota(0, 0);
    const disabled = await seedUser('fq-disabled', ['fq-off@ext.test', 'fq-both@ext.test'], 'disabled', 'admin');
    const active = await seedUser('fq-enabled', ['fq-both@ext.test'], 'active', 'admin');
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, mail([disabled.id]), await owners(disabled));
    expect(relay.sent).toHaveLength(0);
    await forwardReceivedMail(relay.env, mail([disabled.id, active.id]), await owners(disabled, active));
    expect(relay.sent.map((item) => item.to)).toEqual(['fq-both@ext.test']);
    expect(await forwardRows(disabled.id)).toEqual([]);
    expect((await forwardRows(active.id)).map((row) => row.status)).toEqual(['succeeded']);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(disabled.id))).toBe(0);
  });

  it('入站收件：认领地址的主人已停用时不调用原生 forward，也不中转', async () => {
    await setRelayQuota(0, 0);
    await updateSettings(env, { code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedUser('fq-inbound-off', ['fq-inbound@ext.test'], 'disabled');
    const address = 'fq-inbound-off@quota.test';
    await db.insert(mailboxes).values({ address, domain: 'quota.test', userId: owner.id, displayName: '' });
    const relay = relayEnv();
    const forward = vi.fn(async () => { throw new Error('destination not verified'); });
    const raw = ['From: Sender <sender@example.net>', `To: ${address}`, 'Subject: fq inbound', 'Message-ID: <fq-inbound@example.net>',
      'Content-Type: text/plain; charset=utf-8', '', 'hello', ''].join('\r\n');
    const ctx = createExecutionContext();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleInbound({ raw: new Response(raw).body!, headers: new Headers(), to: address, from: 'sender@example.net', forward,
      setReject: vi.fn() } as unknown as ForwardableEmailMessage, relay.env, ctx);
    await waitOnExecutionContext(ctx);
    expect(forward).not.toHaveBeenCalled();
    expect(relay.sent).toHaveLength(0);
    expect(await forwardRows(owner.id)).toEqual([]);
  });
});

describe('自动转发隐私', () => {
  const tinyGif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (ch) => ch.charCodeAt(0));

  it('转到 Gmail 的两种 MIME 正文都去追踪，只内联来自同一邮件的光栅图片', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-private-gmail', ['private-gmail@gmail.com']);
    const item = await claimedMail(owner.id);
    const tracked = 'https://tracking.example.test/ls/click?upn=opaque-secret';
    const login = 'https://login.example.test/start?auth=keep-secret';
    item.html = `<div><img src="https://tracking.example.test/wf/open?upn=id">Hello `
      + `<a href="${tracked}">Track</a><a href="${login}">Login</a>`
      + '<img src="cid:good@inline.test"><img src="cid:invalid@inline.test"></div>';
    item.text = `Hello\n${tracked}\n${login}`;
    item.attachments = [
      { filename: 'good.gif', mimeType: 'image/gif', disposition: 'inline', contentId: 'good@inline.test', content: tinyGif },
      { filename: 'invalid.gif', mimeType: 'image/gif', disposition: 'inline', contentId: 'invalid@inline.test', content: new Uint8Array([1, 2, 3]) },
      { filename: 'nested.eml', mimeType: 'message/rfc822', disposition: 'attachment', contentId: '', content: new Uint8Array([1]) },
    ];
    const relay = relayEnv();
    relay.env.delivery_events_queue = 'local-email-observability-test';
    const nativeForward = vi.fn();
    await forwardReceivedMail(relay.env, item, await owners(owner), { forward: nativeForward, headers: new Headers() } as unknown as ForwardableEmailMessage);
    expect(nativeForward).not.toHaveBeenCalled();
    expect(relay.sent.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 'no-reply@mail.example.test', to: 'private-gmail@gmail.com' },
    ]);
    const parsed = await PostalMime.parse(relay.sent[0]!.raw);
    expect(parsed.html).not.toContain('tracking.example.test');
    expect(parsed.html).not.toContain('cid:invalid');
    expect(parsed.html).toContain('cid:good%40inline.test');
    expect(parsed.html).toContain(login);
    expect(parsed.html).toContain(`href="https://mail.example.test/mail/${item.messageId}"`);
    expect(parsed.text).not.toContain(tracked);
    expect(parsed.text).toContain(login);
    expect(parsed.attachments.map((attachment) => [attachment.filename, attachment.disposition]))
      .toEqual([['good.gif', 'inline'], ['invalid.gif', 'attachment']]);
    expect(parsed.replyTo?.map((address) => address.address)).toEqual(['sender@example.net']);
    const [receipt] = await db.select().from(emailDeliveryRefs).where(eq(emailDeliveryRefs.messageId, item.messageId));
    expect(receipt).toMatchObject({
      sender: 'no-reply@mail.example.test', providerMessageId: 'cf-mock-provider-id',
      rfcMessageId: parsed.messageId?.replace(/^<|>$/g, ''), ownerIds: [owner.id],
    });
  });

  it('部分附件超限时改为站内导航，不生成签名链接或外部图片', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-private-big', ['private-big@gmail.com']);
    const item = await claimedMail(owner.id);
    item.html = '<p>Important</p><img src="cid:good@inline.test"><img src="https://original.example.test/pixel">';
    item.attachments = [
      { filename: 'good.gif', mimeType: 'image/gif', disposition: 'inline', contentId: 'good@inline.test', content: tinyGif },
      { filename: 'large.dat', mimeType: 'application/octet-stream', disposition: 'attachment', contentId: '', content: new Uint8Array(4 * 1024 * 1024) },
    ];
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, item, await owners(owner));
    const parsed = await PostalMime.parse(relay.sent[0]!.raw);
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.html).toContain('Important');
    expect(parsed.html).toContain(`https://mail.example.test/mail/${item.messageId}`);
    expect(parsed.html).not.toMatch(/<img|cid:|\/api\/attachments|original\.example/);
  });

  it('仅通知只发主题和站内入口，旧偏好快照不能解除新选择的保护', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-private-notice', ['private-notice@gmail.com']);
    const item = await claimedMail(owner.id);
    const previous = await owners(owner);
    await updateUserNotifyPrefs(env, owner.id, { forward: { ...owner.prefs.forward, contentMode: 'notice' } });
    item.subject = 'New verification https://login.example.test/start?auth=secret';
    item.text = 'your private code 492719';
    item.html = '<img src="https://original.example.test/pixel">';
    item.attachments = [{ filename: 'good.gif', mimeType: 'image/gif', disposition: 'attachment', contentId: '', content: tinyGif }];
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, item, previous);
    const parsed = await PostalMime.parse(relay.sent[0]!.raw);
    expect(parsed.subject).toBe('New verification （链接已省略）');
    expect(parsed.replyTo ?? []).toEqual([]);
    expect(parsed.html ?? '').toBe('');
    expect(parsed.attachments).toHaveLength(0);
    expect(parsed.text).toContain(`https://mail.example.test/mail/${item.messageId}`);
    expect(parsed.text).not.toMatch(/492719|original\.example|sender@example\.net/);
  });

  it('结果不明时保留额度与唯一记录，并发与重复交付均不重发', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-private-unknown', ['private-unknown@gmail.com']);
    const item = await claimedMail(owner.id);
    const current = await owners(owner);
    const relay = relayEnv();
    relay.send.mockRejectedValue(new Error('possible acceptance followed by timeout'));
    await Promise.all([forwardReceivedMail(relay.env, item, current), forwardReceivedMail(relay.env, item, current)]);
    await forwardReceivedMail(relay.env, item, current);
    expect(relay.send).toHaveBeenCalledTimes(1);
    expect(await forwardRows(owner.id)).toEqual([{
      target: 'private-unknown@gmail.com', status: 'unknown', mode: 'relay', error: '邮件服务返回的投递结果未确认',
    }]);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(1);
  });
});
