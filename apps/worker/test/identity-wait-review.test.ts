import type { MessageDetail, SendIdentities, SendIdentityBlockReason } from '@hpc-mail/shared';
import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { schemas, type Schema } from '../src/routes/openapi-common.js';
import { listSendIdentities } from '../src/services/identities.js';
import { findNextMessage, type Viewer } from '../src/services/message.js';
import { sendMail } from '../src/services/outbound.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';
import { collectBackground } from './support/background.js';

/** sendMail 等登记的后台任务在每个用例结束前等完，拆环境时不能还有任务在写日志 */
const background = collectBackground();

const db = createDb(env);

async function user(username: string, role: 'admin' | 'user' = 'user') {
  const [row] = await db.insert(users).values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true })
    .returning({ id: users.id });
  return row!.id;
}
async function own(userId: number, address: string) {
  return (await db.insert(mailboxes).values({ address, domain: address.split('@')[1]!, userId }).returning().get())!;
}
async function inbound(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await db.insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@outside.example', subject: 's', preview: 'p',
    status: 'received', ...extra,
  }).returning({ id: messages.id }).get())!.id;
}
const head = async () => (await env.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first<{ id: number }>())!.id;

describe('N9 发件身份按管理员实际放行规则计算', () => {
  it('管理员：共享来的邮箱按域名状态可发；domains 列系统、发信就绪的托管、仍有存量邮箱的旧域名，与发信放行逐项一致', async () => {
    await updateSettings(env, {
      domains: { list: [{ domain: 'x3-sys.example', public: true, perUserLimit: 0 }, { domain: 'x3-sys2.example', public: false, perUserLimit: 0 }] },
      code_extract: { enabled: false, aiEnabled: false },
    });
    const admin = await user('x3-id-admin', 'admin');
    const owner = await user('x3-id-owner');
    const reader = await user('x3-id-reader');
    await db.insert(hostedDomains).values([
      { domain: 'x3-ready.example', userId: owner, status: 'active', sendingStatus: 'ready' },
      { domain: 'x3-provisioning.example', userId: owner, status: 'provisioning', sendingStatus: 'ready' },
      { domain: 'x3-nobox.example', userId: owner, status: 'active', sendingStatus: 'ready' },
      { domain: 'x3-waiting.example', userId: owner, status: 'active', sendingStatus: '' },
      { domain: 'x3-paused.example', userId: owner, status: 'suspended', sendingStatus: 'ready' },
      { domain: 'x3-moved.example', userId: owner, status: 'moved', sendingStatus: 'ready' },
    ]);
    const mine = await own(admin, 'admin@x3-sys2.example');
    const shared = await Promise.all(['p@x3-paused.example', 'r@x3-ready.example', 's@x3-sys.example', 'w@x3-waiting.example']
      .map((address) => own(owner, address)));
    await own(owner, 'm@x3-moved.example');
    await own(owner, 'old@x3-legacy.example');
    await own(owner, 'p2@x3-provisioning.example');
    for (const target of [admin, reader]) {
      await db.insert(mailboxShares).values(shared.map((box) => ({ mailboxId: box.id, userId: target, grantedBy: owner })));
    }

    const identity = (box: (typeof shared)[number], kind: 'owned' | 'shared', reason: SendIdentityBlockReason | null) =>
      ({ kind, mailboxId: box.id, address: box.address, domain: box.domain, displayName: '', canSend: reason === null, reason });
    const [paused, ready, sys, waiting] = shared as [typeof mine, typeof mine, typeof mine, typeof mine];
    const listed = await listSendIdentities(env, { userId: admin, role: 'admin' });
    expect(listed).toEqual({
      identities: [
        identity(mine, 'owned', null),
        identity(paused, 'shared', 'hosted_domain_unavailable'), identity(ready, 'shared', null),
        identity(sys, 'shared', null), identity(waiting, 'shared', 'hosted_sending_not_ready'),
      ],
      domains: [
        { domain: 'x3-sys.example', kind: 'system', anyLocalPart: true }, { domain: 'x3-sys2.example', kind: 'system', anyLocalPart: true },
        { domain: 'x3-nobox.example', kind: 'hosted', anyLocalPart: true }, { domain: 'x3-provisioning.example', kind: 'hosted', anyLocalPart: true },
        { domain: 'x3-ready.example', kind: 'hosted', anyLocalPart: true },
        { domain: 'x3-legacy.example', kind: 'legacy', anyLocalPart: true },
      ],
    } satisfies SendIdentities);
    // OpenAPI 描述的 kind 取值与实际返回一致
    const domainItem = ((schemas.SendIdentities!.properties as Record<string, Schema>).domains!.items as Schema).properties as Record<string, Schema>;
    expect(domainItem.kind!.enum).toEqual(['system', 'hosted', 'legacy']);

    // 普通用户不变：共享来的恒只读，没有 domains
    expect(await listSendIdentities(env, { userId: reader, role: 'user' })).toEqual({
      identities: [paused, ready, sys, waiting].map((box) => identity(box, 'shared', 'shared_readonly')),
      domains: [],
    });

    // 与实际发信逐项对照：列出可发的都能发，不能发的（含未列出的域名）都被拒
    const send = (from: { mailboxId: number } | { localPart: string; domain: string }) => sendMail(env as Env, background.ctx,
      { userId: admin, role: 'admin' }, { from, to: ['sink@x3-sys.example'], cc: [], bcc: [], subject: 'x3 identity probe', text: 't' } as never,
      [], 'https://hpc.email');
    for (const item of listed.identities) {
      const result = send({ mailboxId: item.mailboxId });
      if (item.canSend) await expect(result, item.address).resolves.toMatchObject({ address: item.address });
      else await expect(result, item.address).rejects.toMatchObject({ code: 'validation_failed' });
    }
    for (const { domain } of listed.domains) {
      await expect(send({ localPart: 'probe', domain }), domain).resolves.toMatchObject({ address: `probe@${domain}` });
    }
    for (const domain of ['x3-waiting.example', 'x3-paused.example', 'x3-moved.example', 'x3-unknown.example']) {
      await expect(send({ localPart: 'probe', domain }), domain).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
});

describe('N10 wait 只带 domain 时按可见地址取数', () => {
  it('自己认领与共享给我的该域地址都在范围内；等待期间新认领的地址照样返回；审计他人只看其认领；未认领范围不变', async () => {
    const me = await user('x3-wait-me');
    const other = await user('x3-wait-other');
    const admin = await user('x3-wait-admin', 'admin');
    await own(me, 'mine@x3-wait.example');
    await own(me, 'elsewhere@x3-wait-other.example');
    const sharedBox = await own(other, 'shared@x3-wait.example');
    await own(other, 'private@x3-wait.example');
    await db.insert(mailboxShares).values({ mailboxId: sharedBox.id, userId: me, grantedBy: other });

    const base = await head();
    const stranger = await inbound('stranger@x3-wait.example');
    await inbound('private@x3-wait.example');
    await inbound('elsewhere@x3-wait-other.example');
    const sharedHit = await inbound('shared@x3-wait.example');
    const mineHit = await inbound('mine@x3-wait.example');
    const viewer: Viewer = { userId: me, role: 'user' };
    const wait = (who: Viewer, afterId: number) => findNextMessage(env, who, { afterId, domain: 'x3-wait.example' });

    expect(await wait(viewer, base)).toMatchObject({ message: { id: sharedHit, address: 'shared@x3-wait.example' }, scannedThroughId: sharedHit });
    expect(await wait(viewer, sharedHit)).toMatchObject({ message: { id: mineHit }, scannedThroughId: mineHit });
    expect(await wait(viewer, mineHit)).toEqual({ message: null, scannedThroughId: mineHit });
    // 托管域名的来信会在收件时自动认领给所有者：地址集合每次轮询现算，不是等待开始时的快照
    await own(me, 'late@x3-wait.example');
    const late = await inbound('late@x3-wait.example');
    expect(await wait(viewer, mineHit)).toMatchObject({ message: { id: late }, scannedThroughId: late });

    // 审计他人只看其认领（不含共享给他的）；未认领范围照旧按域名
    const audit: Viewer = { userId: admin, role: 'admin', scope: 'user', targetUserId: me };
    expect(await wait(audit, base)).toMatchObject({ message: { id: mineHit } });
    expect(await wait({ userId: admin, role: 'admin', scope: 'unclaimed' }, base)).toMatchObject({ message: { id: stranger } });
  });
});

/** 在 findNextMessage 命中之后、按 id 读整行（第一个 batch）之前插入一次并发改动 */
function racing(change: () => Promise<unknown>): Env {
  // 第一次 batch 是扫描新信（可见地址分流的两条语句同一 batch），第二次是命中后读整行：变化插在两者之间
  let batches = 0;
  const raced = new Proxy(env.db, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 2) await change();
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...env, db: raced } as Env;
}

describe('N13 include=body 读整行时复核删除与可见性', () => {
  it('命中后被移入回收站或撤销共享：不再以详情返回，游标越过它；带过滤时继续返回下一封', async () => {
    const me = await user('x3-body-me');
    const other = await user('x3-body-other');
    await own(me, 'body@x3-body.example');
    const sharedBox = await own(other, 'shared@x3-body.example');
    await db.insert(mailboxShares).values({ mailboxId: sharedBox.id, userId: me, grantedBy: other });
    const viewer: Viewer = { userId: me, role: 'user' };
    const trash = (id: number) => () => db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, id));

    const base = await head();
    const deleted = await inbound('body@x3-body.example', { subject: 'race one', bodyText: 'gone' });
    const next = await inbound('body@x3-body.example', { subject: 'race two', bodyText: 'kept' });
    expect(await findNextMessage(racing(trash(deleted)), viewer, { afterId: base, include: 'body' }))
      .toEqual({ message: null, scannedThroughId: deleted });
    const following = await findNextMessage(env, viewer, { afterId: deleted, include: 'body' });
    expect(following).toMatchObject({ message: { id: next, bodyText: 'kept' }, scannedThroughId: next });

    // 带过滤一次检查多封：被删的那封跳过，同一轮返回下一封的详情
    const filteredBase = await head();
    const raced = await inbound('body@x3-body.example', { subject: 'code race', bodyText: 'gone' });
    const kept = await inbound('body@x3-body.example', { subject: 'code kept', bodyText: 'kept' });
    const found = await findNextMessage(racing(trash(raced)), viewer, { afterId: filteredBase, include: 'body', subjectContains: 'code' });
    expect(found).toMatchObject({ message: { id: kept, bodyText: 'kept' }, scannedThroughId: kept });
    expect((found.message as MessageDetail).attachments).toEqual([]);

    // 命中与读取之间撤销了共享
    const sharedBase = await head();
    const sharedHit = await inbound('shared@x3-body.example', { bodyText: 'shared body' });
    const revoke = () => db.delete(mailboxShares).where(and(eq(mailboxShares.mailboxId, sharedBox.id), eq(mailboxShares.userId, me)));
    expect(await findNextMessage(racing(revoke), viewer, { afterId: sharedBase, include: 'body' }))
      .toEqual({ message: null, scannedThroughId: sharedHit });
  });
});
