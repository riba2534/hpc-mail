import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { DEFAULT_USER_NOTIFY_PREFS, type UserNotifyPrefs } from '@hpc-mail/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxes, notificationJobs, users } from '../src/db/schema.js';
import { FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE, forwardReceivedMail, type ForwardMail } from '../src/services/forwarding.js';
import { handleInbound } from '../src/services/inbound.js';
import { FORWARD_TARGET_DAILY_LIMIT } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
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

async function seedUser(name: string, targets: string[], status: 'active' | 'disabled' = 'active') {
  const [user] = await db.insert(users).values({ username: name, passwordHash: 'x', role: 'user', status }).returning({ id: users.id });
  const prefs: UserNotifyPrefs = { ...DEFAULT_USER_NOTIFY_PREFS, forward: { enabled: true, addresses: targets } };
  await updateUserNotifyPrefs(env, user!.id, { forward: prefs.forward });
  return { id: user!.id, prefs };
}

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

async function setRelayQuota(relayDaily: number, relayPerUserDaily: number) {
  await updateSettings(env, { quota: { dailyOutbound: 0, dailyRecipients: 0, relayDaily, relayPerUserDaily } });
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
    await forwardReceivedMail(relay.env, mail([owner.id]), [owner.prefs]);
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
    await forwardReceivedMail(relay.env, mail([owner.id]), [owner.prefs]);
    expect(relay.sent).toHaveLength(2);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);

    // 原生 forward 成功不占中转额度
    const native = { headers: new Headers(), forward: vi.fn(async () => {}) } as unknown as ForwardableEmailMessage;
    const nativeMail = mail([owner.id]);
    await forwardReceivedMail(relay.env, nativeMail, [owner.prefs], native);
    expect(native.forward).toHaveBeenCalledTimes(3);
    expect(relay.sent).toHaveLength(2);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(2);
    const nativeRows = await db.select().from(notificationJobs).where(eq(notificationJobs.messageId, nativeMail.messageId)).all();
    expect(nativeRows.map((row) => [row.status, row.forwardMode])).toEqual([['succeeded', 'native'], ['succeeded', 'native'], ['succeeded', 'native']]);

    await setRelayQuota(0, 0);
    await forwardReceivedMail(relay.env, mail([owner.id]), [owner.prefs]);
    expect(relay.sent).toHaveLength(5);
    expect(await count(FORWARD_RELAY_SCOPE, 'instance')).toBe(5);
  });

  it('按归属人日上限：用尽的人跳过、其他人不受影响；同一目标多位归属人时由还有额度的人计入，全部用尽才跳过', async () => {
    await setRelayQuota(0, 1);
    const a = await seedUser('fq-user-a', ['fq-a@ext.test']);
    const b = await seedUser('fq-user-b', ['fq-b@ext.test']);
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, mail([a.id]), [a.prefs]);
    await forwardReceivedMail(relay.env, mail([a.id]), [a.prefs]);
    await forwardReceivedMail(relay.env, mail([b.id]), [b.prefs]);
    expect(relay.sent.map((item) => item.to)).toEqual(['fq-a@ext.test', 'fq-b@ext.test']);
    expect(await count(FORWARD_RELAY_USER_SCOPE, String(a.id))).toBe(1);
    expect((await forwardRows(a.id)).map((row) => [row.status, row.mode, row.error])).toEqual([
      ['skipped', '', '今日中转转发额度已用尽'], ['succeeded', 'relay', ''],
    ]);

    const c = await seedUser('fq-user-c', ['fq-shared@ext.test']);
    const d = await seedUser('fq-user-d', ['fq-shared@ext.test']);
    await bumpCounter(env, FORWARD_RELAY_USER_SCOPE, String(c.id), dayWindow());
    const shared = relayEnv();
    await forwardReceivedMail(shared.env, mail([c.id, d.id]), [c.prefs, d.prefs]);
    expect(shared.sent.map((item) => item.to)).toEqual(['fq-shared@ext.test']);
    expect([await count(FORWARD_RELAY_USER_SCOPE, String(c.id)), await count(FORWARD_RELAY_USER_SCOPE, String(d.id))]).toEqual([1, 1]);
    await forwardReceivedMail(shared.env, mail([c.id, d.id]), [c.prefs, d.prefs]);
    expect(shared.sent).toHaveLength(1);
    expect([await count(FORWARD_RELAY_USER_SCOPE, String(c.id)), await count(FORWARD_RELAY_USER_SCOPE, String(d.id))]).toEqual([1, 1]);
    for (const owner of [c, d]) {
      expect((await forwardRows(owner.id)).map((row) => row.status)).toEqual(['skipped', 'succeeded']);
    }
  });

  it('域名或目标的日计数已满时跳过，两个计数都不再累加', async () => {
    await setRelayQuota(0, 0);
    const owner = await seedUser('fq-target-full', ['fq-full@ext.test']);
    await bumpCounter(env, 'fwd-target', 'fq-full@ext.test', dayWindow(), FORWARD_TARGET_DAILY_LIMIT);
    const relay = relayEnv();
    const target = mail([owner.id], 'fq-target-full@quota-full.test');
    await forwardReceivedMail(relay.env, target, [owner.prefs]);
    expect(relay.sent).toHaveLength(0);
    expect(await count('fwd-target', 'fq-full@ext.test')).toBe(FORWARD_TARGET_DAILY_LIMIT);
    expect(await count('fwd-domain', 'quota-full.test')).toBe(0);
    expect(await forwardRows(owner.id)).toEqual([{ target: 'fq-full@ext.test', status: 'skipped', mode: '', error: '今日转发额度已用尽' }]);
  });
});

describe('停用归属人不转发（R27）', () => {
  it('站内互投只传偏好时补读状态：停用的人原生与中转都不转发，同目标的启用归属人照常', async () => {
    await setRelayQuota(0, 0);
    const disabled = await seedUser('fq-disabled', ['fq-off@ext.test', 'fq-both@ext.test'], 'disabled');
    const active = await seedUser('fq-enabled', ['fq-both@ext.test']);
    const relay = relayEnv();
    await forwardReceivedMail(relay.env, mail([disabled.id]), [disabled.prefs]);
    expect(relay.sent).toHaveLength(0);
    await forwardReceivedMail(relay.env, mail([disabled.id, active.id]), [disabled.prefs, active.prefs]);
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
