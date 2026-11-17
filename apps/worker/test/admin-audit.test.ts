import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, attachments, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { MAIL_READ_USER_ACTION, userMailReadAuditStatement } from '../src/services/audit.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { grantLegacyAdminScope } from './key-helpers.js';

const app = createApp();
const db = createDb(env);
const IP = '203.0.113.9';
let sequence = 0;

async function fixture() {
  const prefix = `audit-${++sequence}`;
  await updateSettings(env, { security: { require2fa: false }, api: { enabled: true } });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
    const created = await createApiKey(env, user.id, { name, scopes: ['mail.read', 'mail.write', 'mailbox.read', 'mailbox.write'], rateLimit: 1000, allowedIps: [] });
    // 管理员沿用存量 Key 的形态（迁移 0022 自动加上 admin scope），审计用例要它的跨用户能力
    if (role === 'admin') await grantLegacyAdminScope(env, created.id);
    return { ...user, jwt, key: created.key, keyId: created.id };
  }
  const admin = await actor('admin', 'admin');
  const owner = await actor('owner');
  async function box(ownerId: number, suffix: string, displayName = '') {
    return (await db.insert(mailboxes).values({ address: `${prefix}-${suffix}@audit.test`, domain: 'audit.test', userId: ownerId, displayName }).returning().get())!;
  }
  async function mail(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
    return (await db.insert(messages).values({ address, domain: address.split('@')[1]!, direction: 'inbound', status: 'received',
      fromAddress: 'sender@example.net', subject: 'secret', bodyText: 'code 123456', ...extra }).returning().get())!;
  }
  return { prefix, actor, admin, owner, box, mail };
}

async function request(path: string, token: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function expectStatus(response: Response, status = 200) {
  // 原始邮件与附件是二进制正文，按字节读再解码，免得 .text() 告警
  const text = new TextDecoder().decode(await response.arrayBuffer());
  expect(response.status, text).toBe(status);
  return text;
}

const auditsBy = (actorId: number, action?: string) => db.select().from(adminAuditLogs)
  .where(and(eq(adminAuditLogs.actorId, actorId), action === undefined ? undefined : eq(adminAuditLogs.action, action))).all();

describe('管理员释放与改名他人邮箱的审计', () => {
  it('释放他人邮箱记 mailbox.release：原所有者、deleteHistory 与删除条数；/v1 记 Key 所属用户', async () => {
    const f = await fixture();
    const purged = await f.box(f.owner.id, 'purged');
    await f.mail(purged.address);
    await f.mail(purged.address, { deletedAt: new Date() });
    await expectStatus(await request(`/api/mailboxes/${purged.id}?deleteHistory=1`, f.admin.jwt, 'DELETE'));
    const kept = await f.box(f.owner.id, 'kept');
    await f.mail(kept.address);
    await expectStatus(await request(`/v1/mailboxes/${kept.id}`, f.admin.key, 'DELETE'));

    const rows = await auditsBy(f.admin.id, 'mailbox.release');
    expect(rows.map((row) => row.target).sort()).toEqual([kept.address, purged.address].sort());
    const [purgeRow, keepRow] = [rows.find((row) => row.target === purged.address)!, rows.find((row) => row.target === kept.address)!];
    expect(purgeRow).toMatchObject({ actorName: f.admin.username, ip: IP,
      detail: `原所有者 ${f.owner.username} (#${f.owner.id})；永久删除历史邮件 2 封` });
    expect(keepRow).toMatchObject({ actorName: f.admin.username, ip: IP,
      detail: `原所有者 ${f.owner.username} (#${f.owner.id})；保留历史邮件（API Key #${f.admin.keyId}）` });
    expect(await db.select().from(messages).where(eq(messages.address, purged.address)).all()).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.address, kept.address)).all()).toHaveLength(1);
  });

  it('释放自己的邮箱不记审计；普通用户释放也不记', async () => {
    const f = await fixture();
    const own = await f.box(f.admin.id, 'own');
    const users = await f.box(f.owner.id, 'self');
    await expectStatus(await request(`/api/mailboxes/${own.id}?deleteHistory=1`, f.admin.jwt, 'DELETE'));
    await expectStatus(await request(`/api/mailboxes/${users.id}`, f.owner.jwt, 'DELETE'));
    expect(await auditsBy(f.admin.id)).toEqual([]);
    expect(await auditsBy(f.owner.id)).toEqual([]);
  });

  it('释放审计与释放同一事务：审计写不进去时邮箱、共享与历史邮件都保留', async () => {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'atomic');
    const member = await f.actor('member');
    await db.insert(mailboxShares).values({ mailboxId: box.id, userId: member.id, grantedBy: f.owner.id });
    await f.mail(box.address);
    await env.db.prepare(`CREATE TRIGGER fail_release_audit BEFORE INSERT ON admin_audit_logs
      WHEN NEW.action = 'mailbox.release' BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END`).run();
    try {
      await expectStatus(await request(`/api/mailboxes/${box.id}?deleteHistory=1`, f.admin.jwt, 'DELETE'), 500);
    } finally {
      await env.db.prepare('DROP TRIGGER fail_release_audit').run();
    }
    expect(await db.select().from(mailboxes).where(eq(mailboxes.id, box.id)).get()).toBeDefined();
    expect(await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, box.id)).all()).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.address, box.address)).all()).toHaveLength(1);
  });

  it('改他人邮箱发件名记 mailbox.update 前后值；值未变或改自己的不记', async () => {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'rename', '旧名字');
    await expectStatus(await request(`/api/mailboxes/${box.id}`, f.admin.jwt, 'PUT', { displayName: '新名字' }));
    await expectStatus(await request(`/v1/mailboxes/${box.id}`, f.admin.key, 'PUT', { displayName: 'Key 改名' }));
    await expectStatus(await request(`/api/mailboxes/${box.id}`, f.admin.jwt, 'PUT', { displayName: 'Key 改名' }));
    const own = await f.box(f.admin.id, 'own-rename', 'a');
    await expectStatus(await request(`/api/mailboxes/${own.id}`, f.admin.jwt, 'PUT', { displayName: 'b' }));
    await expectStatus(await request(`/api/mailboxes/${box.id}`, f.owner.jwt, 'PUT', { displayName: '主人自己改' }));

    const rows = await auditsBy(f.admin.id, 'mailbox.update');
    expect(rows.map((row) => [row.target, row.detail])).toEqual([
      [box.address, `发件名「旧名字」→「新名字」；所有者 ${f.owner.username} (#${f.owner.id})`],
      [box.address, `发件名「新名字」→「Key 改名」；所有者 ${f.owner.username} (#${f.owner.id})（API Key #${f.admin.keyId}）`],
    ]);
    expect(await auditsBy(f.owner.id)).toEqual([]);
  });

  it('管理员取消共享的审计 target 为邮箱地址', async () => {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'unshare');
    const member = await f.actor('member');
    await db.insert(mailboxShares).values({ mailboxId: box.id, userId: member.id, grantedBy: f.owner.id });
    await expectStatus(await request(`/api/admin/mailbox-shares/${box.id}/grantees/${member.id}`, f.admin.jwt, 'DELETE'));
    expect(await auditsBy(f.admin.id, 'mailbox.unshare')).toMatchObject([{ target: box.address, detail: `移除共享 user#${member.id}（mailbox#${box.id}）` }]);
  });
});

describe('管理员永久删除未认领地址邮件的审计', () => {
  it('/api 与 /v1 的 scope=unclaimed purge 记条数；删自己的邮件或没删到时不记', async () => {
    const f = await fixture();
    const address = `${f.prefix}-nobody@audit.test`;
    const trashed = [await f.mail(address, { deletedAt: new Date() }), await f.mail(address, { deletedAt: new Date() })];
    const live = await f.mail(address);
    const viaKey = await f.mail(address, { deletedAt: new Date() });
    const purge = (token: string, prefix: string, ids: number[], scope?: string) =>
      request(`${prefix}/messages/purge`, token, 'POST', { ids, ...(scope ? { scope } : {}) });
    await expectStatus(await purge(f.admin.jwt, '/api', [...trashed.map((message) => message.id), live.id], 'unclaimed'));
    await expectStatus(await purge(f.admin.key, '/v1', [viaKey.id], 'unclaimed'));
    await expectStatus(await purge(f.admin.jwt, '/api', [live.id], 'unclaimed'));
    const own = await f.box(f.admin.id, 'own-trash');
    const mine = await f.mail(own.address, { deletedAt: new Date() });
    await expectStatus(await purge(f.admin.jwt, '/api', [mine.id]));

    const rows = await auditsBy(f.admin.id, 'mail.purge_unclaimed');
    expect(rows.map((row) => row.detail)).toEqual([
      `永久删除未认领地址的邮件 2 封；请求的 id：${trashed[0]!.id}、${trashed[1]!.id}、${live.id}`,
      `永久删除未认领地址的邮件 1 封；请求的 id：${viaKey.id}（API Key #${f.admin.keyId}）`,
    ]);
    expect(rows.every((row) => row.target === 'scope=unclaimed' && row.ip === IP)).toBe(true);
  });
});

describe('管理员以 scope=user 读取他人邮件的审计', () => {
  async function readable() {
    const f = await fixture();
    const box = await f.box(f.owner.id, 'inbox');
    const rawKey = `audit-raw/${f.prefix}.eml`;
    await env.r2.put(rawKey, 'From: a@b.c\r\n\r\nraw');
    const message = await f.mail(box.address, { rawR2Key: rawKey, messageId: `<${f.prefix}@audit.test>` });
    const attKey = `audit-att/${f.prefix}.txt`;
    await env.r2.put(attKey, 'attachment');
    const attachment = (await db.insert(attachments).values({ messageId: message.id, r2Key: attKey, filename: 'a.txt', mimeType: 'text/plain', size: 10 }).returning().get())!;
    return { ...f, box, message, attachment };
  }

  const readsOf = (adminId: number) => auditsBy(adminId, MAIL_READ_USER_ACTION);

  it('各读取入口（/api 与 /v1）都会记一条，target 为 user#目标 id', async () => {
    const f = await readable();
    const q = `scope=user&userId=${f.owner.id}`;
    const paths: Array<[string, 'jwt' | 'key']> = [
      [`/api/messages?${q}`, 'jwt'],
      [`/api/messages/sync?${q}`, 'jwt'],
      [`/api/messages/${f.message.id}?${q}`, 'jwt'],
      [`/api/messages/${f.message.id}/thread?${q}`, 'jwt'],
      [`/api/messages/${f.message.id}/raw?${q}`, 'jwt'],
      [`/api/attachments/${f.attachment.id}?${q}`, 'jwt'],
      [`/v1/messages?${q}`, 'key'],
      [`/v1/messages/${f.message.id}?${q}`, 'key'],
      [`/v1/messages/${f.message.id}/thread?${q}`, 'key'],
      [`/v1/messages/${f.message.id}/raw?${q}`, 'key'],
      [`/v1/messages/${f.message.id}/attachments/${f.attachment.id}?${q}`, 'key'],
    ];
    for (const [path, auth] of paths) {
      // 每个入口用一个新管理员：去重以（管理员、目标用户、日）为键
      const admin = await f.actor(`reader-${paths.findIndex(([p]) => p === path)}`, 'admin');
      await expectStatus(await request(path, auth === 'jwt' ? admin.jwt : admin.key));
      const rows = await readsOf(admin.id);
      expect(rows, path).toHaveLength(1);
      expect(rows[0], path).toMatchObject({ actorName: admin.username, target: `user#${f.owner.id}`, ip: IP });
      expect(rows[0]!.detail, path).toBe(`查看 ${f.owner.username} 的邮件，当日首次：GET ${path.split('?')[0]}`
        + (auth === 'key' ? `（API Key #${admin.keyId}）` : ''));
    }
  });

  it('同一管理员对同一用户当日只记一条，换目标用户另记', async () => {
    const f = await readable();
    const other = await f.actor('other');
    const q = `scope=user&userId=${f.owner.id}`;
    for (const path of [`/api/messages?${q}`, `/api/messages/sync?${q}`, `/api/messages/${f.message.id}?${q}`, `/v1/messages?${q}`]) {
      await expectStatus(await request(path, path.startsWith('/v1') ? f.admin.key : f.admin.jwt));
    }
    await expectStatus(await request(`/api/messages?scope=user&userId=${other.id}`, f.admin.jwt));
    expect((await readsOf(f.admin.id)).map((row) => row.target)).toEqual([`user#${f.owner.id}`, `user#${other.id}`]);
  });

  it('去重在数据库语句里完成：同日重复执行不再写入，次日再写一条', async () => {
    const f = await fixture();
    const actor = { id: f.admin.id, ip: IP };
    const now = Date.UTC(2026, 10, 17, 23, 59);
    expect((await userMailReadAuditStatement(env, actor, f.owner.id, 'GET /x', now).run()).meta.changes).toBe(1);
    expect((await userMailReadAuditStatement(env, actor, f.owner.id, 'GET /y', now).run()).meta.changes).toBe(0);
    // 已有行的 created_at 是数据库当前时间；把它挪到前一天，模拟跨 UTC 日
    await db.update(adminAuditLogs).set({ createdAt: new Date(now - 86_400_000) }).where(eq(adminAuditLogs.actorId, f.admin.id));
    expect((await userMailReadAuditStatement(env, actor, f.owner.id, 'GET /z', now).run()).meta.changes).toBe(1);
    expect(await readsOf(f.admin.id)).toHaveLength(2);
  });

  it('普通用户、管理员读自己或未认领、scope=user 指向自己时不写读取审计', async () => {
    const f = await readable();
    await expectStatus(await request('/api/messages', f.admin.jwt));
    await expectStatus(await request('/api/messages?scope=mine', f.admin.jwt));
    await expectStatus(await request('/api/messages?scope=unclaimed', f.admin.jwt));
    await expectStatus(await request(`/api/messages?scope=user&userId=${f.admin.id}`, f.admin.jwt));
    await expectStatus(await request(`/api/messages/${f.message.id}?scope=unclaimed`, f.admin.jwt), 404);
    await expectStatus(await request(`/api/messages/${f.message.id}`, f.owner.jwt));
    await expectStatus(await request('/v1/messages', f.owner.key));
    expect(await readsOf(f.admin.id)).toEqual([]);
    expect(await auditsBy(f.owner.id)).toEqual([]);
  });
});
