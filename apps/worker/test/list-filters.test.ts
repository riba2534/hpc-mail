import { env } from 'cloudflare:test';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { listMessagesQuerySchema } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { listMessages, syncMessages, type Viewer } from '../src/services/message.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 10, 12);

/** 查询参数按真实请求的形状经 shared schema 解析（since/until 转毫秒、from/to 转小写） */
const q = (raw: Record<string, string>) => listMessagesQuerySchema.parse({ limit: '100', ...raw }) as ListMessagesQuery;

async function allIds(viewer: Viewer, raw: Record<string, string>, limit = 100): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await listMessages(env, viewer, { ...q({ ...raw, limit: String(limit) }), cursor });
    ids.push(...result.items.map((item) => item.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return ids;
}

async function seedUser(username: string, addresses: string[], role: 'user' | 'admin' = 'user') {
  const db = createDb(env);
  const [user] = await db.insert(users).values({ username, passwordHash: 'x', role, authVersionMigrated: true }).returning({ id: users.id });
  if (addresses.length) {
    await db.insert(mailboxes).values(addresses.map((address) => ({ address, domain: address.split('@')[1]!, userId: user!.id })));
  }
  return { userId: user!.id, role } satisfies Viewer;
}

type Row = Partial<typeof messages.$inferInsert> & { address: string };
async function insert(rows: Row[]): Promise<number[]> {
  const db = createDb(env);
  const ids: number[] = [];
  for (const row of rows) {
    const [m] = await db.insert(messages).values({
      direction: 'inbound', domain: row.address.split('@')[1]!, fromAddress: 'someone@example.net', subject: 's', preview: 'p',
      status: row.direction === 'outbound' ? 'sent' : 'received', ...row,
    }).returning({ id: messages.id });
    ids.push(m!.id);
  }
  return ids;
}

describe('列表筛选：逐个条件的匹配口径', () => {
  it('since 含边界、until 不含；日期按 UTC 零点；只返回窗口内的邮件', async () => {
    const owner = await seedUser('lf-time', ['t@lf-time.test']);
    const [a, b, c, d] = await insert([
      { address: 't@lf-time.test', createdAt: new Date(T0 - 2 * HOUR) },
      { address: 't@lf-time.test', createdAt: new Date(T0) },
      { address: 't@lf-time.test', createdAt: new Date(T0 + HOUR) },
      { address: 't@lf-time.test', createdAt: new Date(T0 + 2 * HOUR) },
    ]);
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(await allIds(owner, { since: iso(T0) })).toEqual([d, c, b]);
    expect(await allIds(owner, { until: iso(T0 + 2 * HOUR) })).toEqual([c, b, a]);
    expect(await allIds(owner, { since: iso(T0), until: iso(T0 + 2 * HOUR) })).toEqual([c, b]);
    expect(await allIds(owner, { since: '2026-11-10', until: '2026-11-11' })).toEqual([d, c, b, a]);
    expect(await allIds(owner, { since: '2026-11-11' })).toEqual([]);
    // 带时区偏移：+08:00 的 20:00 即 UTC 12:00
    expect(await allIds(owner, { since: '2026-11-10T20:00:00+08:00', until: '2026-11-10T21:00:00+08:00' })).toEqual([b]);
  });

  it('from：完整地址精确匹配（大小写不敏感），@域名只匹配该域、不含子域', async () => {
    const owner = await seedUser('lf-from', ['f@lf-from.test']);
    const [exact, upper, , sub] = await insert([
      { address: 'f@lf-from.test', fromAddress: 'alice@corp.example' },
      { address: 'f@lf-from.test', fromAddress: 'Bob@Corp.Example' },
      { address: 'f@lf-from.test', fromAddress: 'alice@other.example' },
      { address: 'f@lf-from.test', fromAddress: 'carol@mail.corp.example' },
    ]);
    expect(await allIds(owner, { from: 'ALICE@corp.example' })).toEqual([exact]);
    expect(await allIds(owner, { from: '@corp.example' })).toEqual([upper, exact]);
    expect(await allIds(owner, { from: '@mail.corp.example' })).toEqual([sub]);
    expect(await allIds(owner, { from: 'alice@corp.example.cn' })).toEqual([]);
  });

  it('to：外发看 To/Cc/Bcc，收件看收件地址与原信 To/Cc；@域名不含子域、不误配前缀', async () => {
    const owner = await seedUser('lf-to', ['me@lf-to.test', 'alias@lf-to.test']);
    const [outTo, outCc, outBcc, inDirect, inList, outPrefix, inOther] = await insert([
      { address: 'me@lf-to.test', direction: 'outbound', recipients: { to: ['bob@x.example'], cc: [], bcc: [] } },
      { address: 'me@lf-to.test', direction: 'outbound', recipients: { to: ['zed@y.example'], cc: ['bob@x.example'], bcc: [] } },
      { address: 'me@lf-to.test', direction: 'outbound', recipients: { to: ['zed@y.example'], cc: [], bcc: ['ann@x.example'] } },
      { address: 'alias@lf-to.test', recipients: { to: ['alias@lf-to.test'], cc: [], bcc: [] } },
      { address: 'me@lf-to.test', recipients: { to: ['list@x.example'], cc: [], bcc: [] } },
      { address: 'me@lf-to.test', direction: 'outbound', recipients: { to: ['xbob@x.example', 'bob@x.example.cn'], cc: [], bcc: [] } },
      { address: 'me@lf-to.test', recipients: { to: ['me@lf-to.test'], cc: [], bcc: [] } },
    ]);
    expect(await allIds(owner, { to: 'bob@x.example' })).toEqual([outCc, outTo]);
    expect(await allIds(owner, { to: 'ANN@x.example' })).toEqual([outBcc]);
    expect(await allIds(owner, { to: 'alias@lf-to.test' })).toEqual([inDirect]);
    // xbob@x.example 属于 x.example；bob@x.example.cn 不属于（不误配为后缀）
    expect(await allIds(owner, { to: '@x.example' })).toEqual([outPrefix, inList, outBcc, outCc, outTo]);
    expect(await allIds(owner, { to: '@x.example.cn' })).toEqual([outPrefix]);
    expect(await allIds(owner, { to: 'me@lf-to.test' })).toEqual([inOther, inList]);
    // 外发的 address 是发件地址，不能当成收件人
    expect(await allIds(owner, { to: 'me@lf-to.test', direction: 'outbound' })).toEqual([]);
  });

  it('hasCode 只看收件时识别出的码；hasAttachments 不把正文内联图算附件；0/false 等于不传', async () => {
    const owner = await seedUser('lf-flags', ['g@lf-flags.test']);
    const [coded, plain, withFile, inlineOnly] = await insert([
      { address: 'g@lf-flags.test', verificationCode: '123456' },
      { address: 'g@lf-flags.test' },
      { address: 'g@lf-flags.test' },
      { address: 'g@lf-flags.test' },
    ]);
    await createDb(env).insert(attachments).values([
      { messageId: withFile!, r2Key: 'att/lf/1', filename: 'a.pdf', disposition: 'attachment' },
      { messageId: withFile!, r2Key: 'att/lf/2', filename: 'logo.png', disposition: 'inline', contentId: 'logo' },
      { messageId: inlineOnly!, r2Key: 'att/lf/3', filename: 'logo.png', disposition: 'inline', contentId: 'logo' },
    ]);
    expect(await allIds(owner, { hasCode: '1' })).toEqual([coded]);
    expect(await allIds(owner, { hasAttachments: 'true' })).toEqual([withFile]);
    const page = await listMessages(env, owner, q({ hasAttachments: '1' }));
    expect(page.items[0]!.hasAttachments).toBe(true);
    expect(await allIds(owner, { hasCode: '0', hasAttachments: 'false' })).toEqual([inlineOnly, withFile, plain, coded]);
  });

  it('多个条件是「与」；与 direction/address/unread 组合；小页连续翻页不漏不重', async () => {
    const owner = await seedUser('lf-combo', ['c1@lf-combo.test', 'c2@lf-combo.test']);
    const rows: Row[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({
        address: i % 2 ? 'c1@lf-combo.test' : 'c2@lf-combo.test', fromAddress: i % 3 ? 'noise@n.example' : 'svc@code.example',
        verificationCode: i % 4 ? '' : `C${i}`, isRead: i % 5 === 0, createdAt: new Date(T0 + i * 60_000),
      });
    }
    const ids = await insert(rows);
    const expected = ids.filter((_, i) => i % 3 === 0 && i % 4 === 0 && i >= 10).reverse();
    const raw = { from: '@code.example', hasCode: '1', since: new Date(T0 + 10 * 60_000).toISOString() };
    expect(await allIds(owner, raw, 1)).toEqual(expected);
    expect(await allIds(owner, { ...raw, address: 'c2@lf-combo.test' }, 2))
      .toEqual(ids.filter((_, i) => i % 3 === 0 && i % 4 === 0 && i >= 10 && i % 2 === 0).reverse());
    expect(await allIds(owner, { ...raw, unread: '1' }, 2)).toEqual(ids.filter((_, i) => i % 12 === 0 && i >= 10 && i % 5 !== 0).reverse());
    expect(await allIds(owner, { ...raw, direction: 'outbound' })).toEqual([]);
  });
});

describe('列表筛选：since 的 id 下界是精确的', () => {
  it('created_at 与 id 不同序（先后颠倒可达数小时，另有更早插入的「现在」邮件）时，结果与朴素条件逐条一致', async () => {
    const owner = await seedUser('lf-skew', ['s@lf-skew.test']);
    // 固定种子：id 递增，created_at 在 T0 + i 分钟附近抖动 ±3 小时
    let seed = 20261117;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const rows: Row[] = Array.from({ length: 120 }, (_, i) => ({
      address: 's@lf-skew.test', createdAt: new Date(T0 + i * 60_000 + Math.round((rnd() - 0.5) * 6 * HOUR)),
    }));
    await insert(rows);
    for (const [since, until] of [[T0 + 30 * 60_000, T0 + 70 * 60_000], [T0 - HOUR, T0 + 5 * 60_000], [T0 + 100 * 60_000, T0 + 4 * HOUR]] as const) {
      const naive = await env.db.prepare(`SELECT id FROM messages WHERE address = 's@lf-skew.test' AND deleted_at IS NULL
        AND created_at >= ? AND created_at < ? ORDER BY id DESC`).bind(since, until).all<{ id: number }>();
      const raw = { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
      expect(naive.results.length, JSON.stringify(raw)).toBeGreaterThan(0);
      expect(await allIds(owner, raw, 7), JSON.stringify(raw)).toEqual(naive.results.map((row) => row.id));
    }
  });
});

describe('列表筛选：可见范围不因筛选扩大', () => {
  it('共享收件、管理员 unclaimed/user 下同样生效；看不到别人的邮件', async () => {
    const owner = await seedUser('lf-owner', ['o@lf-scope.test']);
    const reader = await seedUser('lf-reader', ['r@lf-scope.test']);
    const admin = await seedUser('lf-admin', [], 'admin');
    const db = createDb(env);
    const [box] = await db.select({ id: mailboxes.id }).from(mailboxes).where((await import('drizzle-orm')).eq(mailboxes.address, 'o@lf-scope.test'));
    await db.insert(mailboxShares).values({ mailboxId: box!.id, userId: reader.userId, grantedBy: owner.userId });
    const [sharedIn, ownerOut, readerIn, unclaimed] = await insert([
      { address: 'o@lf-scope.test', fromAddress: 'svc@scope.example' },
      { address: 'o@lf-scope.test', direction: 'outbound', fromAddress: 'o@lf-scope.test', recipients: { to: ['svc@scope.example'], cc: [], bcc: [] } },
      { address: 'r@lf-scope.test', fromAddress: 'svc@scope.example' },
      { address: 'nobody@lf-scope.test', fromAddress: 'svc@scope.example' },
    ]);
    expect(await allIds(reader, { from: '@scope.example' })).toEqual([readerIn, sharedIn]);
    expect(await allIds(reader, { to: 'svc@scope.example' })).toEqual([]);
    expect(await allIds(owner, { to: 'svc@scope.example' })).toEqual([ownerOut]);
    expect(await allIds({ ...admin, scope: 'unclaimed' }, { from: '@scope.example' })).toEqual([unclaimed]);
    expect(await allIds({ ...admin, scope: 'user', targetUserId: owner.userId }, { from: '@scope.example' })).toEqual([sharedIn]);
    expect(await allIds(admin, { from: '@scope.example' })).toEqual([]);
  });

  it('/api sync 与列表同一筛选：head 随筛选变化', async () => {
    const owner = await seedUser('lf-sync', ['y@lf-sync.test']);
    await insert([{ address: 'y@lf-sync.test', verificationCode: '111111' }, { address: 'y@lf-sync.test' }]);
    const all = await syncMessages(env, owner, q({}));
    const coded = await syncMessages(env, owner, q({ hasCode: '1' }));
    expect(coded.head).not.toBe(all.head);
  });
});
