import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { DEFAULT_USER_NOTIFY_PREFS, type UserNotifyPrefs } from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxes, notificationJobs, users } from '../src/db/schema.js';
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
  const sent: { to: string; raw: string }[] = [];
  const send = async (message: { to: string; raw: string }) => { sent.push({ to: message.to, raw: message.raw }); };
  return { env: { ...env, email: { send } } as unknown as Env, sent };
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
  it('全站日上限：超限记 skipped、计数不再累加；原生成功不计入；0 表示不限但照常计数', async () => {
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

    // 原生 forward 成功不占中转额度
    const native = { headers: new Headers(), forward: vi.fn(async () => {}) } as unknown as ForwardableEmailMessage;
    const nativeMail = await claimedMail(owner.id);
    await forwardReceivedMail(relay.env, nativeMail, await owners(owner), native);
    expect(native.forward).toHaveBeenCalledTimes(3);
    expect(relay.sent).toHaveLength(2);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);
    const nativeRows = await db.select().from(notificationJobs).where(eq(notificationJobs.messageId, nativeMail.messageId)).all();
    expect(nativeRows.map((row) => [row.status, row.forwardMode])).toEqual([['succeeded', 'native'], ['succeeded', 'native'], ['succeeded', 'native']]);

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

    // 快照只有一人、但地址不归他（收信后才被别人认领）：按未认领计
    const other = await seedUser('fq-unclaimed-later', ['un-later@ext.test']);
    await setRelayQuota(0, 1, 0);
    const later = mail([a1.id]);
    await db.insert(mailboxes).values({ address: later.toAddress, domain: later.domain, userId: other.id });
    await forwardReceivedMail(relay.env, later, await owners(a1));
    expect(await count(FORWARD_RELAY_SCOPE, 'unclaimed')).toBe(5);
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
    expect(forward).toHaveBeenCalled();
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
    const failing = { ...env, email: { send: async () => { throw new Error('send rejected'); } } } as unknown as Env;
    await forwardReceivedMail(failing, await refundMail('r3', 'refund-fail.test'), await owners(owner));
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(1);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(owner.id))).toBe(1);
    // 发送尝试过，域名与目标计数照算
    expect(await count('fwd-domain', 'refund-fail.test')).toBe(1);
    expect((await forwardRows(owner.id)).map((row) => [row.status, row.mode, row.error])).toEqual([
      ['failed', 'relay', 'send rejected'], ['skipped', '', '全站今日中转转发额度已用尽'], ['succeeded', 'relay', ''],
    ]);
  });

  it('域名或目标的日计数已满时跳过，两个计数都不再累加', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-target-full', ['fq-full@ext.test']);
    await bumpCounter(env, 'fwd-target', 'fq-full@ext.test', dayWindow(), FORWARD_TARGET_DAILY_LIMIT);
    const relay = relayEnv();
    const target = mail([owner.id], 'fq-target-full@quota-full.test');
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
    const disabled = await seedUser('fq-disabled', ['fq-off@ext.test', 'fq-both@ext.test'], 'disabled');
    const active = await seedUser('fq-enabled', ['fq-both@ext.test']);
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
