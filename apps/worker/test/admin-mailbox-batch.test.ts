import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  MAX_ADMIN_MAILBOX_BATCH, type AdminMailboxBatchResult, type BatchClaimMailboxResult,
} from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { adminAuditLogs, hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { createApiKey } from '../src/services/api-key.js';
import { userMailReadAuditStatement } from '../src/services/audit.js';
import { adminReleaseMailboxes, adminShareMailboxes, adminTransferMailboxes, adminUnshareMailboxes } from '../src/services/mailbox-admin-batch.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const DOMAIN = 'adminbatch.test';
const PRIVATE_DOMAIN = 'private.adminbatch.test';
let sequence = 0;

async function fixture() {
  const prefix = `ab-${++sequence}`;
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }, { domain: PRIVATE_DOMAIN, public: false, perUserLimit: 0 }] },
    mailbox_policy: { perUserLimit: 0, reservedLocalParts: ['support'] },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  const admin = await actor('admin', 'admin');
  const owner = await actor('owner');
  const target = await actor('target');
  const member = await actor('member');
  const address = (name: string, domain = DOMAIN) => `${prefix}-${name}@${domain}`;
  async function box(ownerId: number, name: string, domain = DOMAIN) {
    return (await db.insert(mailboxes).values({ address: address(name, domain), domain, userId: ownerId }).returning().get())!;
  }
  async function mail(to: string) {
    return (await db.insert(messages).values({ address: to, domain: to.split('@')[1]!, direction: 'inbound', status: 'received', subject: 'history' }).returning().get())!;
  }
  return { prefix, actor, admin, owner, target, member, address, box, mail };
}

async function post(path: string, token: string, body: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api/admin/mailboxes/batch/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Request-ID': `req-${path}-${sequence}` },
    body: JSON.stringify(body) }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T; error?: { code: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}

async function errorCode(response: Response, status: number): Promise<string> {
  const body = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error.code;
}

const audits = (actorId: number, action: string) => db.select().from(adminAuditLogs)
  .where(and(eq(adminAuditLogs.actorId, actorId), eq(adminAuditLogs.action, action))).all();
const ownerOf = async (id: number) => (await db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())?.userId;
const membersOf = async (id: number) => (await db.select().from(mailboxShares).where(eq(mailboxShares.mailboxId, id)).all())
  .map((share) => share.userId).sort((a, b) => a - b);

/** 第 at 次 batch 执行前运行一次 hook，模拟读取与提交之间的并发修改 */
function beforeBatch(hook: () => Promise<void>, at = 1): Env {
  let calls = 0;
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (++calls === at) await hook();
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

/** 记录每次 batch 的语句数 */
function countingBatch(sizes: number[]): Env {
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      sizes.push(statements.length);
      return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

describe('管理员批量邮箱接口：鉴权与参数', () => {
  it('只接受管理员 JWT：普通用户 403，API Key 401', async () => {
    const f = await fixture();
    const key = await createApiKey(env, f.admin.id, { name: 'k', scopes: ['mailbox.write'], rateLimit: 100, allowedIps: [] });
    const body = { items: [{ address: f.address('x') }] };
    expect(await errorCode(await post('release', f.owner.jwt, body), 403)).toBe('forbidden');
    expect((await post('release', key.key, body)).status).toBe(401);
  });

  it(`超过 ${MAX_ADMIN_MAILBOX_BATCH} 项、地址重复或格式非法时整批 400`, async () => {
    const f = await fixture();
    const many = Array.from({ length: MAX_ADMIN_MAILBOX_BATCH + 1 }, (_, i) => ({ address: f.address(`m${i}`) }));
    expect(await errorCode(await post('release', f.admin.jwt, { items: many }), 400)).toBe('validation_failed');
    expect(await errorCode(await post('release', f.admin.jwt, { items: [{ address: f.address('d') }, { address: f.address('D').toUpperCase() }] }), 400))
      .toBe('validation_failed');
    for (const address of ['no-at-sign', 'a@b', '-bad@adminbatch.test']) {
      expect(await errorCode(await post('share', f.admin.jwt, { userIds: [f.member.id], items: [{ address }] }), 400)).toBe('validation_failed');
    }
    expect(await errorCode(await post('transfer', f.admin.jwt, { userId: f.target.id, items: [{ address: f.address('t') }] }), 400))
      .toBe('validation_failed');
  });
});

describe('批量认领', () => {
  it('按目标用户自己的规则认领：保留前缀停止、已占用跳过，每个认领到的地址记 mailbox.claim', async () => {
    const f = await fixture();
    await f.box(f.member.id, 'taken');
    const result = await data<BatchClaimMailboxResult>(await post('claim', f.admin.jwt, { userId: f.owner.id, items: [
      { localPart: `${f.prefix}-a`, domain: DOMAIN },
      { localPart: `${f.prefix}-taken`, domain: DOMAIN },
      { localPart: 'support', domain: DOMAIN },
      { localPart: `${f.prefix}-never`, domain: DOMAIN },
    ] }));
    expect(result.claimed.map((mailbox) => [mailbox.address, mailbox.userId])).toEqual([[f.address('a'), f.owner.id]]);
    expect(result.taken.map((item) => item.localPart)).toEqual([`${f.prefix}-taken`]);
    expect(result.stoppedBy?.code).toBe('forbidden');
    expect(result.notAttempted.map((item) => item.localPart)).toEqual(['support', `${f.prefix}-never`]);
    expect(await audits(f.admin.id, 'mailbox.claim')).toMatchObject([{ target: f.address('a'),
      detail: `为 ${f.owner.username} (#${f.owner.id}) 认领；批量请求 req-claim-${sequence}` }]);
  });

  it('目标用户无权认领的私有域名与未生效的托管域名被拒；目标用户不存在 404、已禁用 400', async () => {
    const f = await fixture();
    const hosted = `${f.prefix}.hosted.test`;
    await db.insert(hostedDomains).values({ domain: hosted, userId: f.owner.id, status: 'pending' });
    for (const domain of [PRIVATE_DOMAIN, hosted]) {
      const result = await data<BatchClaimMailboxResult>(await post('claim', f.admin.jwt, { userId: f.owner.id, items: [{ localPart: 'x', domain }] }));
      expect(result.claimed).toEqual([]);
      expect(result.stoppedBy?.code, domain).toBe('forbidden');
    }
    expect(await errorCode(await post('claim', f.admin.jwt, { userId: 999_999, items: [{ localPart: 'x', domain: DOMAIN }] }), 404)).toBe('not_found');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.target.id));
    expect(await errorCode(await post('claim', f.admin.jwt, { userId: f.target.id, items: [{ localPart: 'x', domain: DOMAIN }] }), 400))
      .toBe('validation_failed');
  });
});

describe('批量释放', () => {
  it('逐项结果：可释放的项一起提交（删除历史、撤销共享、每项一行审计），不存在与所有者不符的项不处理', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'a');
    const b = await f.box(f.target.id, 'b');
    const guarded = await f.box(f.owner.id, 'guarded');
    await db.insert(mailboxShares).values([{ mailboxId: a.id, userId: f.member.id, grantedBy: f.owner.id }]);
    await f.mail(a.address);
    await f.mail(a.address);
    await f.mail(guarded.address);
    const result = await data<AdminMailboxBatchResult>(await post('release', f.admin.jwt, { deleteHistory: true, items: [
      { address: a.address, expectedOwnerId: f.owner.id },
      { address: f.address('missing') },
      { address: guarded.address, expectedOwnerId: f.target.id },
      { address: b.address.toUpperCase() },
    ] }));
    expect(result).toMatchObject({ done: 2, unchanged: 0, failed: 2 });
    expect(result.results).toEqual([
      { address: a.address, status: 'done', mailboxId: a.id, ownerId: f.owner.id, error: null, deletedMessages: 2, revokedShares: 1 },
      { address: f.address('missing'), status: 'failed', mailboxId: null, ownerId: null, error: { code: 'not_found', message: '邮箱不存在' } },
      { address: guarded.address, status: 'failed', mailboxId: guarded.id, ownerId: f.owner.id,
        error: { code: 'conflict', message: '邮箱归属已改变，请刷新后重新确认' } },
      { address: b.address, status: 'done', mailboxId: b.id, ownerId: f.target.id, error: null, deletedMessages: 0, revokedShares: 0 },
    ]);
    expect(await ownerOf(a.id)).toBeUndefined();
    expect(await ownerOf(b.id)).toBeUndefined();
    expect(await ownerOf(guarded.id)).toBe(f.owner.id);
    expect(await membersOf(a.id)).toEqual([]);
    expect(await db.select().from(messages).where(eq(messages.address, a.address)).all()).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.address, guarded.address)).all()).toHaveLength(1);
    const rows = await audits(f.admin.id, 'mailbox.release');
    expect(rows.map((row) => [row.target, row.detail])).toEqual([
      [a.address, `原所有者 ${f.owner.username} (#${f.owner.id})；永久删除历史邮件 2 封；批量请求 req-release-${sequence}`],
      [b.address, `原所有者 ${f.target.username} (#${f.target.id})；永久删除历史邮件 0 封；批量请求 req-release-${sequence}`],
    ]);
  });

  it('不删历史时邮件随地址回到未认领态', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'keep');
    await f.mail(a.address);
    const result = await data<AdminMailboxBatchResult>(await post('release', f.admin.jwt, { items: [{ address: a.address }] }));
    expect(result.results[0]).toMatchObject({ status: 'done', deletedMessages: 0 });
    expect(await db.select().from(messages).where(eq(messages.address, a.address)).all()).toHaveLength(1);
    expect((await audits(f.admin.id, 'mailbox.release'))[0]!.detail).toContain('保留历史邮件');
  });

  it('读取后有邮箱被过户时整批回滚：409，其他项也没有释放', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'race-a');
    const b = await f.box(f.owner.id, 'race-b');
    await f.mail(a.address);
    const racing = beforeBatch(async () => { await db.update(mailboxes).set({ userId: f.target.id }).where(eq(mailboxes.id, b.id)); });
    await expect(adminReleaseMailboxes(racing, { id: f.admin.id, ip: '' }, { deleteHistory: true, items: [{ address: a.address }, { address: b.address }] }, 'tag'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await ownerOf(a.id)).toBe(f.owner.id);
    expect(await ownerOf(b.id)).toBe(f.target.id);
    expect(await db.select().from(messages).where(eq(messages.address, a.address)).all()).toHaveLength(1);
    expect(await audits(f.admin.id, 'mailbox.release')).toEqual([]);
  });

  it('写入语句数不随项数增长', async () => {
    const f = await fixture();
    const sizes: number[] = [];
    for (const count of [1, 30]) {
      const boxes = await Promise.all(Array.from({ length: count }, (_, i) => f.box(f.owner.id, `n${count}-${i}`)));
      await adminReleaseMailboxes(countingBatch(sizes), { id: f.admin.id, ip: '' },
        { deleteHistory: true, items: boxes.map((box) => ({ address: box.address })) }, 'tag');
    }
    expect(sizes).toHaveLength(2);
    expect(sizes[0]).toBe(sizes[1]);
  });
});

describe('批量过户', () => {
  it('逐项结果：过户并撤销旧共享、已归目标的为 unchanged、所有者不符与不存在的失败；每项一行 mailbox.transfer', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'a');
    const already = await f.box(f.target.id, 'already');
    const stale = await f.box(f.member.id, 'stale');
    await db.insert(mailboxShares).values([
      { mailboxId: a.id, userId: f.member.id, grantedBy: f.owner.id },
      { mailboxId: already.id, userId: f.member.id, grantedBy: f.target.id },
    ]);
    await f.mail(a.address);
    const result = await data<AdminMailboxBatchResult>(await post('transfer', f.admin.jwt, { userId: f.target.id, items: [
      { address: a.address, expectedOwnerId: f.owner.id },
      { address: already.address, expectedOwnerId: f.owner.id },
      { address: stale.address, expectedOwnerId: f.owner.id },
      { address: f.address('missing'), expectedOwnerId: f.owner.id },
    ] }));
    expect(result).toMatchObject({ done: 1, unchanged: 1, failed: 2 });
    expect(result.results.map((item) => [item.status, item.ownerId, item.error?.code ?? null, item.revokedShares ?? null])).toEqual([
      ['done', f.owner.id, null, 1],
      ['unchanged', f.target.id, null, 0],
      ['failed', f.member.id, 'conflict', null],
      ['failed', null, 'not_found', null],
    ]);
    expect(await ownerOf(a.id)).toBe(f.target.id);
    expect(await ownerOf(stale.id)).toBe(f.member.id);
    expect(await membersOf(a.id)).toEqual([]);
    // 已归目标的不清理新主人建立的共享
    expect(await membersOf(already.id)).toEqual([f.member.id]);
    expect(await db.select().from(messages).where(eq(messages.address, a.address)).all()).toHaveLength(1);
    expect((await audits(f.admin.id, 'mailbox.transfer')).map((row) => [row.target, row.detail])).toEqual([[a.address,
      `${f.owner.username} (#${f.owner.id}) → ${f.target.username} (#${f.target.id})；保留全部历史并撤销旧共享；批量请求 req-transfer-${sequence}`]]);
  });

  it('目标为专属配置的普通用户时按其额度逐项累计：超出的项失败，其余照常过户', async () => {
    const f = await fixture();
    await db.update(users).set({ mailboxPolicy: { perUserLimit: 0, domains: [{ domain: DOMAIN, perUserLimit: 2 }] }, mailboxPolicyRevision: 1 })
      .where(eq(users.id, f.target.id));
    await f.box(f.target.id, 'existing');
    const boxes = [await f.box(f.owner.id, 'q1'), await f.box(f.owner.id, 'q2'), await f.box(f.owner.id, 'support', PRIVATE_DOMAIN)];
    const result = await data<AdminMailboxBatchResult>(await post('transfer', f.admin.jwt, { userId: f.target.id,
      items: boxes.map((box) => ({ address: box.address, expectedOwnerId: f.owner.id })) }));
    expect(result.results.map((item) => [item.status, item.error?.code ?? null])).toEqual([
      ['done', null], ['failed', 'forbidden'], ['failed', 'forbidden'],
    ]);
    expect(await ownerOf(boxes[0]!.id)).toBe(f.target.id);
    expect(await ownerOf(boxes[1]!.id)).toBe(f.owner.id);
  });

  it('提交前目标用户权限版本改变或额度被并发占用时整批回滚并返回 409', async () => {
    const f = await fixture();
    await db.update(users).set({ mailboxPolicy: { perUserLimit: 0, domains: [{ domain: DOMAIN, perUserLimit: 5 }] }, mailboxPolicyRevision: 1 })
      .where(eq(users.id, f.target.id));
    const a = await f.box(f.owner.id, 'c1');
    const req = { userId: f.target.id, items: [{ address: a.address, expectedOwnerId: f.owner.id }] };
    const actor = { id: f.admin.id, ip: '' };
    // 第 1 次 batch 是读取，第 2 次是提交
    const quotaRace = beforeBatch(async () => { await f.box(f.target.id, 'concurrent'); }, 2);
    await expect(adminTransferMailboxes(quotaRace, actor, req, 'tag')).rejects.toMatchObject({ code: 'conflict' });
    const policyRace = beforeBatch(async () => { await db.update(users).set({ mailboxPolicyRevision: 2 }).where(eq(users.id, f.target.id)); }, 2);
    await expect(adminTransferMailboxes(policyRace, actor, req, 'tag')).rejects.toMatchObject({ code: 'conflict' });
    expect(await ownerOf(a.id)).toBe(f.owner.id);
    expect(await audits(f.admin.id, 'mailbox.transfer')).toEqual([]);
    // 没有并发修改时同一请求成功
    expect((await adminTransferMailboxes(env, actor, req, 'tag')).done).toBe(1);
  });

  it('目标用户不存在 404、已禁用 400', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'u');
    const items = [{ address: a.address, expectedOwnerId: f.owner.id }];
    expect(await errorCode(await post('transfer', f.admin.jwt, { userId: 999_999, items }), 404)).toBe('not_found');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.target.id));
    expect(await errorCode(await post('transfer', f.admin.jwt, { userId: f.target.id, items }), 400)).toBe('validation_failed');
    expect(await ownerOf(a.id)).toBe(f.owner.id);
  });
});

describe('批量共享与取消共享', () => {
  it('追加共享：不移除已有成员、不加入所有者、都已在名单里的为 unchanged；审计列出本次新增的人', async () => {
    const f = await fixture();
    const other = await f.actor('other');
    const a = await f.box(f.owner.id, 'a');
    const b = await f.box(f.owner.id, 'b');
    const ownedByMember = await f.box(f.member.id, 'mine');
    await db.insert(mailboxShares).values([
      { mailboxId: a.id, userId: other.id, grantedBy: f.owner.id },
      { mailboxId: b.id, userId: f.member.id, grantedBy: f.owner.id },
    ]);
    const result = await data<AdminMailboxBatchResult>(await post('share', f.admin.jwt, { userIds: [f.member.id], items: [
      { address: a.address }, { address: b.address }, { address: ownedByMember.address }, { address: f.address('missing') },
    ] }));
    expect(result.results.map((item) => [item.status, item.addedShares ?? null, item.error?.code ?? null])).toEqual([
      ['done', 1, null], ['unchanged', 0, null], ['unchanged', 0, null], ['failed', null, 'not_found'],
    ]);
    expect(await membersOf(a.id)).toEqual([other.id, f.member.id].sort((x, y) => x - y));
    expect(await membersOf(ownedByMember.id)).toEqual([]);
    const granted = await db.select().from(mailboxShares).where(and(eq(mailboxShares.mailboxId, a.id), eq(mailboxShares.userId, f.member.id))).get();
    expect(granted?.grantedBy).toBe(f.admin.id);
    expect((await audits(f.admin.id, 'mailbox.share')).map((row) => [row.target, row.detail])).toEqual([
      [a.address, `追加共享 ${f.member.username}；批量请求 req-share-${sequence}`],
    ]);
  });

  it('被分享人不存在或已禁用时整批 400；名单会超过上限的项失败', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'cap');
    expect(await errorCode(await post('share', f.admin.jwt, { userIds: [999_999], items: [{ address: a.address }] }), 400)).toBe('validation_failed');
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.target.id));
    expect(await errorCode(await post('share', f.admin.jwt, { userIds: [f.target.id], items: [{ address: a.address }] }), 400)).toBe('validation_failed');
    const fillers = await Promise.all(Array.from({ length: 100 }, (_, i) => f.actor(`filler-${i}`)));
    await env.db.prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by) SELECT ?, value, ? FROM json_each(?)`)
      .bind(a.id, f.owner.id, JSON.stringify(fillers.map((user) => user.id))).run();
    const result = await data<AdminMailboxBatchResult>(await post('share', f.admin.jwt, { userIds: [f.member.id], items: [{ address: a.address }] }));
    expect(result.results[0]).toMatchObject({ status: 'failed', error: { code: 'validation_failed' } });
  });

  it('提交前被分享人被禁用时整批回滚并返回 409', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'race');
    const racing = beforeBatch(async () => { await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.member.id)); }, 2);
    await expect(adminShareMailboxes(racing, { id: f.admin.id, ip: '' }, { userIds: [f.member.id], items: [{ address: a.address }] }, 'tag'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await membersOf(a.id)).toEqual([]);
    expect(await audits(f.admin.id, 'mailbox.share')).toEqual([]);
  });

  it('取消共享：只移除指定成员，都不在名单里的为 unchanged；审计列出实际移除的人', async () => {
    const f = await fixture();
    const other = await f.actor('other');
    const a = await f.box(f.owner.id, 'a');
    const b = await f.box(f.owner.id, 'b');
    await db.insert(mailboxShares).values([
      { mailboxId: a.id, userId: f.member.id, grantedBy: f.owner.id },
      { mailboxId: a.id, userId: other.id, grantedBy: f.owner.id },
      { mailboxId: b.id, userId: other.id, grantedBy: f.owner.id },
    ]);
    const result = await data<AdminMailboxBatchResult>(await post('unshare', f.admin.jwt, { userIds: [f.member.id, f.target.id], items: [
      { address: a.address, expectedOwnerId: f.owner.id }, { address: b.address },
    ] }));
    expect(result.results.map((item) => [item.status, item.revokedShares])).toEqual([['done', 1], ['unchanged', 0]]);
    expect(await membersOf(a.id)).toEqual([other.id]);
    expect(await membersOf(b.id)).toEqual([other.id]);
    expect((await audits(f.admin.id, 'mailbox.unshare')).map((row) => [row.target, row.detail])).toEqual([
      [a.address, `移除共享 ${f.member.username}；批量请求 req-unshare-${sequence}`],
    ]);
  });

  it('取消共享读取后邮箱被过户时整批回滚', async () => {
    const f = await fixture();
    const a = await f.box(f.owner.id, 'moved');
    await db.insert(mailboxShares).values({ mailboxId: a.id, userId: f.member.id, grantedBy: f.owner.id });
    const racing = beforeBatch(async () => { await db.update(mailboxes).set({ userId: f.target.id }).where(eq(mailboxes.id, a.id)); }, 2);
    await expect(adminUnshareMailboxes(racing, { id: f.admin.id, ip: '' }, { userIds: [f.member.id], items: [{ address: a.address }] }, 'tag'))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await membersOf(a.id)).toEqual([f.member.id]);
    expect(await audits(f.admin.id, 'mailbox.unshare')).toEqual([]);
  });
});

describe('查询计划', () => {
  it('批量与审计语句不全表扫描（EXPLAIN）', async () => {
    const f = await fixture();
    await db.update(users).set({ mailboxPolicy: { perUserLimit: 0, domains: [{ domain: DOMAIN, perUserLimit: 5 }] }, mailboxPolicyRevision: 1 })
      .where(eq(users.id, f.target.id));
    const [a, b] = [await f.box(f.owner.id, 'plan-a'), await f.box(f.owner.id, 'plan-b')];
    await db.insert(mailboxShares).values({ mailboxId: a.id, userId: f.member.id, grantedBy: f.owner.id });
    const seen = new Set<string>();
    const recording = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => { seen.add(query); return target.prepare(query); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    const actor = { id: f.admin.id, ip: '' };
    await adminShareMailboxes(recording, actor, { userIds: [f.member.id, f.target.id], items: [{ address: b.address }] }, 'tag');
    await adminUnshareMailboxes(recording, actor, { userIds: [f.member.id], items: [{ address: a.address }] }, 'tag');
    await adminTransferMailboxes(recording, actor, { userId: f.target.id, items: [{ address: a.address, expectedOwnerId: f.owner.id }] }, 'tag');
    await adminReleaseMailboxes(recording, actor, { deleteHistory: true, items: [{ address: b.address }] }, 'tag');
    await userMailReadAuditStatement(recording, actor, f.owner.id, 'GET /plan').run();
    for (const sql of seen) {
      // D1 要求绑定全部参数；EXPLAIN 只看计划，全部绑 NULL
      const numbered = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])));
      const count = numbered + (sql.match(/\?(?!\d)/g) ?? []).length;
      const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...Array(count).fill(null)).all<{ detail: string }>();
      // 存储清理台账的覆盖索引扫描来自 scheduleStorageCleanup，按设计分批处理
      const scans = plan.results.map((row) => row.detail)
        .filter((detail) => detail.startsWith('SCAN') && !/VIRTUAL TABLE|CONSTANT ROW|^SCAN storage_cleanup_jobs/.test(detail));
      expect(scans, sql).toEqual([]);
    }
  });
});
