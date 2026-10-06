import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { CreatedApiKey, MailboxTransferResult } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, attachments, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { handleInbound } from '../src/services/inbound.js';
import { releaseMailbox, transferMailbox, updateMailbox } from '../src/services/mailbox.js';
import { replaceMailboxShares, revokeMailboxShare } from '../src/services/mailbox-share.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
let sequence = 0;
async function fixture() {
  const prefix = `transfer-${++sequence}`;
  await updateSettings(env, {
    domains: { list: [{ domain: 'transfer.test', public: false, perUserLimit: 1 }] },
    mailbox_policy: { perUserLimit: 1, reservedLocalParts: ['support'] },
    code_extract: { enabled: false, aiEnabled: false }, quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function actor(suffix: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${suffix}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    return { ...user, jwt };
  }
  const admin = await actor('admin', 'admin');
  const old = await actor('old');
  const target = await actor('new');
  const grantee = await actor('shared');
  async function box(ownerId: number, suffix = 'box') {
    return (await db.insert(mailboxes).values({ address: `${prefix}-${suffix}@transfer.test`, domain: 'transfer.test', userId: ownerId, displayName: '保留显示名' }).returning().get())!;
  }
  return { admin, old, target, grantee, box };
}
async function request(path: string, token: string, body?: unknown, runtime: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function value<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function receive(address: string, label: string) {
  const raw = `From: sender@example.net\r\nTo: ${address}\r\nMessage-ID: <${label}@example.net>\r\nSubject: transfer\r\nContent-Type: text/plain\r\n\r\nprivate mail`;
  const ctx = createExecutionContext();
  await handleInbound({ to: address, from: 'sender@example.net', raw: new Response(raw).body!, headers: new Headers(),
    forward: async () => {}, setReject: () => {},
  } as unknown as ForwardableEmailMessage, env, ctx);
  await waitOnExecutionContext(ctx);
  return (await db.select().from(messages).where(eq(messages.messageId, `<${label}@example.net>`)).get())!;
}
function beforeWrite(hook: () => Promise<void>, mode: 'batch' | 'run' = 'batch'): Env {
  let once = false;
  const runHook = async () => { if (!once) { once = true; await hook(); } };
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch' && mode === 'batch') return async (statements: D1PreparedStatement[]) => { await runHook(); return target.batch(statements); };
    if (property === 'prepare' && mode === 'run') return (query: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(s, p) {
        if (p === 'bind') return (...args: unknown[]) => wrap(s.bind(...args));
        if (p === 'run' && /^(update|delete)/i.test(query)) return async () => { await runHook(); return s.run(); };
        const member = Reflect.get(s, p);
        return typeof member === 'function' ? member.bind(s) : member;
      } });
      return wrap(target.prepare(query));
    };
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } }) } as Env;
}

describe('管理员邮箱强制过户', () => {
  it('直接过户管理员自有邮箱，保留所有历史和附件，撤销共享且未来通知归新主人', async () => {
    const f = await fixture();
    const box = await f.box(f.admin.id);
    await f.box(f.target.id, 'already-at-quota');
    await db.insert(mailboxShares).values({ mailboxId: box.id, userId: f.grantee.id, grantedBy: f.admin.id });
    const original = await receive(box.address, box.address.split('@')[0]!);
    const sent = (await db.insert(messages).values({ address: box.address, domain: box.domain, direction: 'outbound', status: 'sent', bodyText: 'sent history', deletedAt: new Date() }).returning().get())!;
    await env.r2.put(`transfer/${box.id}.bin`, 'attachment proof');
    const attachment = (await db.insert(attachments).values({ messageId: original.id, r2Key: `transfer/${box.id}.bin`, filename: 'proof.txt', mimeType: 'text/plain', size: 16 }).returning().get())!;
    const body = { userId: f.target.id, expectedOwnerId: f.admin.id };
    const result = await value<MailboxTransferResult>(await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, body));
    expect(result).toMatchObject({ transferred: true, previousUserId: f.admin.id, revokedShares: 1,
      mailbox: { id: box.id, address: box.address, userId: f.target.id, displayName: box.displayName, createdAt: box.createdAt.toISOString(), messageCount: 2 } });
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.id, original.id)).get()).toEqual(original);
    expect(await db.select().from(messages).where(eq(messages.id, sent.id)).get()).toEqual(sent);
    expect(await db.select().from(attachments).where(eq(attachments.id, attachment.id)).get()).toEqual(attachment);
    expect(await (await env.r2.get(attachment.r2Key))!.text()).toBe('attachment proof');
    expect((await request(`/api/messages/${original.id}`, f.grantee.jwt)).status).toBe(404);
    expect((await request(`/api/messages/${original.id}`, f.target.jwt)).status).toBe(200);
    // 管理员的显式审阅权限仍在，默认个人列表不再有这个地址。
    const adminList = await value<Array<{ id: number }>>(await request('/api/mailboxes', f.admin.jwt));
    expect(adminList.map(item => item.id)).not.toContain(box.id);
    const next = await receive(box.address, `after-${box.id}`);
    expect(original.notifyOwnerIds).toEqual([f.admin.id]);
    expect(next.notifyOwnerIds).toEqual([f.target.id]);
    const audit = await db.select().from(adminAuditLogs).where(and(eq(adminAuditLogs.action, 'mailbox.transfer'), eq(adminAuditLogs.target, box.address)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: f.admin.id, actorName: f.admin.username });
    expect(audit[0]!.detail).toContain(f.target.username);
  });

  it('可过户别人认领的保留域邮箱，旧 JWT/Key 失去访问和发件权，新 Key 可以收发', async () => {
    const f = await fixture();
    const box = await f.box(f.old.id);
    const message = await receive(box.address, `other-${box.id}`);
    await updateSettings(env, { domains: { list: [] } });
    const oldKey = await value<CreatedApiKey>(await request('/api/api-keys', f.old.jwt, { name: 'before-transfer', scopes: ['mail.read', 'mail.send'] }), 201);
    const newKey = await value<CreatedApiKey>(await request('/api/api-keys', f.target.jwt, { name: 'after-transfer', scopes: ['mail.read', 'mail.send'] }), 201);
    await value(await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, { userId: f.target.id, expectedOwnerId: f.old.id }));
    for (const [prefix, token] of [['/api', f.old.jwt], ['/v1', oldKey.key]]) {
      expect((await request(`${prefix}/messages/${message.id}`, token!)).status).toBe(404);
      const sendPath = prefix === '/api' ? '/api/messages/send' : '/v1/messages';
      expect((await request(sendPath, token!, { from: { mailboxId: box.id }, to: [box.address], subject: 'denied', text: 'test' })).status).toBe(403);
    }
    expect((await request(`/v1/messages/${message.id}`, newKey.key)).status).toBe(200);
    const sent = await value<{ status: string }>(await request('/v1/messages', newKey.key, {
      from: { mailboxId: box.id }, to: [box.address], subject: 'new-owner-send', text: 'internal mail',
    }), 201);
    expect(sent.status).toBe('delivered');
  });

  it('拒绝非管理员、API Key、无效输入和不存在或禁用的目标', async () => {
    const f = await fixture();
    const box = await f.box(f.old.id);
    const path = `/api/admin/mailboxes/${box.id}/transfer`;
    const body = { userId: f.target.id, expectedOwnerId: f.old.id };
    expect((await request(path, f.old.jwt, body)).status).toBe(403);
    expect((await request(path, '', body)).status).toBe(401);
    const key = await value<CreatedApiKey>(await request('/api/api-keys', f.admin.jwt, { name: 'admin-key', scopes: ['mailbox.write'] }), 201);
    expect((await request(path, key.key, body)).status).toBe(401);
    for (const invalid of [{ userId: 0, expectedOwnerId: f.old.id }, { userId: f.target.id }, { ...body, expectedOwnerId: 1.5 }]) {
      expect((await request(path, f.admin.jwt, invalid)).status).toBe(400);
    }
    expect((await request('/api/admin/mailboxes/99999999/transfer', f.admin.jwt, body)).status).toBe(404);
    expect((await request(path, f.admin.jwt, { ...body, userId: 99999999 })).status).toBe(404);
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.target.id));
    expect((await request(path, f.admin.jwt, body)).status).toBe(400);
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())!.userId).toBe(f.old.id);
  });

  it('相同目标重试不再撤销新共享，陈旧主人不能覆盖不同的新主人', async () => {
    const f = await fixture();
    const box = await f.box(f.old.id);
    const body = { userId: f.admin.id, expectedOwnerId: f.old.id };
    await value(await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, body));
    await replaceMailboxShares(env, f.admin.id, box.id, [f.grantee.id]);
    const replay = await value<MailboxTransferResult>(await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, body));
    expect(replay).toMatchObject({ transferred: false, revokedShares: 0 });
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
    expect((await request(`/api/admin/mailboxes/${box.id}/transfer`, f.admin.jwt, { userId: f.target.id, expectedOwnerId: f.old.id })).status).toBe(409);
    const audit = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, box.address));
    expect(audit).toHaveLength(1);
  });

  it('写入边界的并发过户和用户禁用不能绕过校验或错误撤销共享', async () => {
    const f = await fixture();
    const box = await f.box(f.old.id);
    const racing = beforeWrite(async () => {
      await transferMailbox(env, f.admin, box.id, { userId: f.admin.id, expectedOwnerId: f.old.id });
      await replaceMailboxShares(env, f.admin.id, box.id, [f.grantee.id]);
    });
    await expect(transferMailbox(racing, f.admin, box.id, { userId: f.target.id, expectedOwnerId: f.old.id })).rejects.toMatchObject({ code: 'conflict' });
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
    const second = await f.box(f.old.id, 'disable-race');
    const disabling = beforeWrite(async () => { await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.target.id)); });
    await expect(transferMailbox(disabling, f.admin, second.id, { userId: f.target.id, expectedOwnerId: f.old.id })).rejects.toMatchObject({ code: 'conflict' });
    expect((await db.select().from(mailboxes).where(eq(mailboxes.id, second.id)).get())!.userId).toBe(f.old.id);
    expect(await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.target, second.address))).toHaveLength(0);
  });

  it('审计失败回滚归属和共享，不能产生成功但无审计的过户', async () => {
    const f = await fixture();
    const box = await f.box(f.admin.id);
    await replaceMailboxShares(env, f.admin.id, box.id, [f.grantee.id]);
    await env.db.prepare(`CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON admin_audit_logs
      WHEN NEW.action = 'mailbox.transfer' BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END`).run();
    try {
      await expect(transferMailbox(env, f.admin, box.id, { userId: f.target.id, expectedOwnerId: f.admin.id })).rejects.toThrow();
      expect((await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())!.userId).toBe(f.admin.id);
      expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
    } finally { await env.db.prepare('DROP TRIGGER fail_transfer_audit').run(); }
  });

  it('陈旧释放、改名和共享请求不能修改已过户邮箱或删除新主人共享', async () => {
    const f = await fixture();
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, f.target.id));
    for (const action of ['release', 'rename', 'share', 'revoke']) {
      const box = await f.box(f.admin.id, action);
      await replaceMailboxShares(env, f.admin.id, box.id, [f.grantee.id]);
      const racing = beforeWrite(async () => {
        await transferMailbox(env, f.admin, box.id, { userId: f.target.id, expectedOwnerId: f.admin.id });
        await replaceMailboxShares(env, f.target.id, box.id, [f.grantee.id]);
      }, action === 'rename' || action === 'revoke' ? 'run' : 'batch');
      const operation = action === 'release' ? releaseMailbox(racing, f.admin.id, box.id, true)
        : action === 'rename' ? updateMailbox(racing, f.admin.id, box.id, 'stale rename', true)
        : action === 'share' ? replaceMailboxShares(racing, f.admin.id, box.id, [])
        : revokeMailboxShare(racing, f.admin.id, box.id, f.grantee.id);
      await expect(operation).rejects.toMatchObject({ code: action === 'share' ? 'forbidden' : action === 'revoke' ? 'not_found' : 'conflict' });
      const current = (await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get())!;
      expect(current).toMatchObject({ userId: f.target.id, displayName: box.displayName });
      expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id))).toHaveLength(1);
    }
  });
});
