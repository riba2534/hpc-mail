import type { MessageSummary } from '@hpc-mail/shared';
import { env } from 'cloudflare:test';
import { and, count, eq, lt } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import {
  adminAuditLogs,
  apiKeys,
  attachments,
  idempotencyRecords,
  invites,
  mailboxes,
  messages,
  sessions,
  users,
} from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { hashRecoveryCode } from '../src/lib/totp.js';
import { login, register } from '../src/services/auth.js';
import { createApiKey } from '../src/services/api-key.js';
import {
  beginIdempotentSend,
  completeIdempotentSend,
} from '../src/services/idempotency.js';
import { claimMailbox } from '../src/services/mailbox.js';
import { findNextMessage, purgeMessages } from '../src/services/message.js';
import { sendMail } from '../src/services/outbound.js';
import { updateSettings } from '../src/services/setting.js';
import { runScheduled } from '../src/services/scheduled.js';
import { validateNotifyWebhookUrl } from '../src/services/webhook-notify.js';

async function seedUser(username: string, role: 'admin' | 'user' = 'user'): Promise<number> {
  const db = createDb(env);
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash: 'x', role, status: 'active' })
    .returning({ id: users.id });
  return row!.id;
}

function fakeSummary(id = 1): MessageSummary {
  return {
    id,
    direction: 'outbound',
    address: 'sender@hpc.email',
    domain: 'hpc.email',
    fromAddress: 'sender@hpc.email',
    fromName: 'sender',
    subject: 'test',
    preview: 'test',
    verificationCode: '',
    status: 'sent',
    errorDetail: '',
    recipientsTo: ['to@example.com'],
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    size: 4,
    createdAt: new Date().toISOString(),
  };
}

describe('一致性与资源治理', () => {
  it('同一幂等键并发只允许一个请求成为 owner，完成后可重放结果', async () => {
    const actor = { type: 'api_key' as const, id: 991001 };
    const key = `idem-${crypto.randomUUID()}`;
    const request = { to: ['to@example.com'], subject: 'same' };
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => beginIdempotentSend(env, actor, key, request)),
    );
    const owners = attempts
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof beginIdempotentSend>>> => result.status === 'fulfilled')
      .map((result) => result.value)
      .filter((result) => result.kind === 'owner');
    expect(owners).toHaveLength(1);
    const owner = owners[0]!;
    if (owner.kind !== 'owner') throw new Error('expected owner');
    await completeIdempotentSend(env, owner.handle, fakeSummary(991001));
    const replay = await beginIdempotentSend(env, actor, key, request);
    expect(replay.kind).toBe('replay');
    if (replay.kind === 'replay') expect(replay.response.id).toBe(991001);
  });

  it('增量读取 25 封突发邮件时严格按 id 正序且不漏信', async () => {
    const db = createDb(env);
    const userId = await seedUser(`wait-${crypto.randomUUID().slice(0, 8)}`);
    const address = `${crypto.randomUUID().slice(0, 8)}@hpc.email`;
    await db.insert(mailboxes).values({ address, domain: 'hpc.email', userId, displayName: '' });
    const inserted: { id: number }[] = [];
    for (let index = 0; index < 25; index++) {
      const [row] = await db
        .insert(messages)
        .values({
          direction: 'inbound' as const,
          address,
          domain: 'hpc.email',
          fromAddress: 'sender@example.com',
          subject: `burst-${index}`,
          preview: `burst-${index}`,
          status: 'received',
        })
        .returning({ id: messages.id });
      inserted.push(row!);
    }
    const expected = inserted.map((row) => row.id).sort((a, b) => a - b);
    const actual: number[] = [];
    let afterId = 0;
    for (;;) {
      const next = await findNextMessage(env, { userId, role: 'user' }, { afterId, address });
      if (!next) break;
      actual.push(next.id);
      afterId = next.id;
    }
    expect(actual).toEqual(expected);
  });

  it('永久删除只能作用于回收站邮件', async () => {
    const db = createDb(env);
    const userId = await seedUser(`purge-${crypto.randomUUID().slice(0, 8)}`);
    const address = `${crypto.randomUUID().slice(0, 8)}@hpc.email`;
    await db.insert(mailboxes).values({ address, domain: 'hpc.email', userId, displayName: '' });
    const [row] = await db
      .insert(messages)
      .values({ direction: 'inbound', address, domain: 'hpc.email', status: 'received' })
      .returning({ id: messages.id });
    expect(await purgeMessages(env, { userId, role: 'user' }, [row!.id])).toBe(0);
    expect(await db.select().from(messages).where(eq(messages.id, row!.id)).get()).toBeTruthy();
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row!.id));
    expect(await purgeMessages(env, { userId, role: 'user' }, [row!.id])).toBe(1);
  });

  it('站内多收件人共享同一份附件对象', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
      quota: { dailyOutbound: 200, dailyRecipients: 500 },
    });
    const userId = await seedUser(`share-${crypto.randomUUID().slice(0, 8)}`);
    const senderLocal = `sender-${crypto.randomUUID().slice(0, 8)}`;
    await claimMailbox(env, userId, 'user', { localPart: senderLocal, domain: 'hpc.email' });
    const recipientA = `a-${crypto.randomUUID().slice(0, 8)}@hpc.email`;
    const recipientB = `b-${crypto.randomUUID().slice(0, 8)}@hpc.email`;
    const summary = await sendMail(
      env,
      { waitUntil: () => undefined },
      { userId, role: 'user' },
      {
        from: { localPart: senderLocal, domain: 'hpc.email' },
        to: [recipientA, recipientB],
        cc: [],
        bcc: [],
        subject: 'shared attachment',
        text: 'body',
      },
      [{
        filename: 'proof.txt',
        mimeType: 'text/plain',
        contentId: '',
        disposition: 'attachment',
        bytes: new TextEncoder().encode('same bytes'),
      }],
      'https://hpc.email',
    );
    const db = createDb(env);
    const attachmentRows = await db.select().from(attachments).all();
    const related = attachmentRows.filter((row) => row.r2Key.startsWith(`att/${summary.id}/`));
    expect(related).toHaveLength(3);
    expect(new Set(related.map((row) => row.r2Key)).size).toBe(1);
    const objects = await env.r2.list({ prefix: `att/${summary.id}/` });
    expect(objects.objects).toHaveLength(1);
  });

  it('并发认领不能突破每用户 1 个地址的配额', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
      mailbox_policy: { perUserLimit: 1, reservedLocalParts: [] },
    });
    const userId = await seedUser(`claim-${crypto.randomUUID().slice(0, 8)}`);
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        claimMailbox(env, userId, 'user', { localPart: `claim-${userId}-${index}`, domain: 'hpc.email' }),
      ),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('数据库触发器保证并发操作后仍至少有一个 active admin', async () => {
    const db = createDb(env);
    const a = await seedUser(`admin-a-${crypto.randomUUID().slice(0, 8)}`, 'admin');
    const b = await seedUser(`admin-b-${crypto.randomUUID().slice(0, 8)}`, 'admin');
    await Promise.allSettled([
      env.db.prepare('UPDATE users SET status = ? WHERE id = ?').bind('disabled', a).run(),
      env.db.prepare('UPDATE users SET status = ? WHERE id = ?').bind('disabled', b).run(),
    ]);
    const active = await db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.status, 'active')))
      .get();
    expect(active?.value).toBeGreaterThanOrEqual(1);
  });

  it('用户名冲突不会消费邀请码，成功建户才原子消费', async () => {
    const db = createDb(env);
    const existing = `invite-existing-${crypto.randomUUID().slice(0, 8)}`;
    await seedUser(existing);
    const code = `I${crypto.randomUUID().replace(/-/g, '').slice(0, 11).toUpperCase()}`;
    const [invite] = await db
      .insert(invites)
      .values({ code, maxUses: 1, usedCount: 0, status: 'active' })
      .returning({ id: invites.id });
    await updateSettings(env, { register_mode: 'invite' });
    await expect(register(env, { username: existing, password: 'password123', inviteCode: code }, '10.0.0.1'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(invites).where(eq(invites.id, invite!.id)).get())?.usedCount).toBe(0);
    await register(
      env,
      { username: `invite-new-${crypto.randomUUID().slice(0, 8)}`, password: 'password123', inviteCode: code },
      '10.0.0.2',
    );
    expect((await db.select().from(invites).where(eq(invites.id, invite!.id)).get())?.usedCount).toBe(1);
  });

  it('同一恢复码并发登录只能成功一次', async () => {
    const db = createDb(env);
    const username = `recovery-${crypto.randomUUID().slice(0, 8)}`;
    const recovery = 'abcd-efgh';
    await db.insert(users).values({
      username,
      passwordHash: await hashPassword('password123'),
      role: 'user',
      status: 'active',
      totpEnabledAt: new Date(),
      totpRecoveryCodes: [await hashRecoveryCode(recovery)],
    });
    const attempts = await Promise.allSettled([
      login(env, { username, password: 'password123', totp: recovery }, '10.1.0.1'),
      login(env, { username, password: 'password123', totp: recovery }, '10.1.0.2'),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('API Key 数量上限在并发创建时仍生效', async () => {
    const userId = await seedUser(`keys-${crypto.randomUUID().slice(0, 8)}`);
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        createApiKey(env, userId, {
          name: `key-${index}`,
          scopes: ['mail.read'],
          rateLimit: 120,
          allowedIps: [],
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    const db = createDb(env);
    expect((await db.select({ value: count() }).from(apiKeys).where(eq(apiKeys.userId, userId)).get())?.value).toBe(10);
  });

  it('定时任务清理过期会话、幂等记录和管理员审计日志', async () => {
    const db = createDb(env);
    const userId = await seedUser(`cron-${crypto.randomUUID().slice(0, 8)}`);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db.insert(sessions).values({
      id: `expired-${crypto.randomUUID()}`,
      userId,
      createdAt: old,
      expiresAt: old,
    });
    await db.insert(idempotencyRecords).values({
      actorType: 'user',
      actorId: userId,
      key: `old-${crypto.randomUUID()}`,
      requestHash: 'hash',
      status: 'completed',
      responseJson: '{}',
      updatedAt: old,
      createdAt: old,
    });
    await db.insert(adminAuditLogs).values({
      actorId: userId,
      actorName: 'cron',
      action: 'test',
      createdAt: old,
    });
    await runScheduled(env);
    expect(await db.select().from(sessions).where(lt(sessions.expiresAt, new Date())).get()).toBeUndefined();
    expect(await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.actorId, userId)).get()).toBeUndefined();
    expect(await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorId, userId)).get()).toBeUndefined();
  });
});

describe('Webhook SSRF 字面地址拦截', () => {
  it.each([
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://[fc00::1]/hook',
    'https://[fe80::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://metadata.google.internal/hook',
    'https://127.0.0.1.nip.io/hook',
  ])('拒绝 %s', (url) => {
    expect(validateNotifyWebhookUrl(url)).toBeNull();
  });

  it('允许普通公网 HTTPS 地址', () => {
    expect(validateNotifyWebhookUrl('https://hooks.example.com/mail')).not.toBeNull();
  });
});
