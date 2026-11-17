import { env } from 'cloudflare:test';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { encodeCursor } from '../src/lib/pagination.js';
import { listMailboxes, resolveNotifyOwnerIds } from '../src/services/mailbox.js';
import { purgeStatements } from '../src/services/message-lifecycle.js';
import {
  countUnread, findNextMessage, getRecentContacts, getThread, listMessages, syncMessages, UNREAD_COUNT_CAP, type Viewer,
} from '../src/services/message.js';

/**
 * D1 没有 STAT4，规划器按固定启发式选索引，与数据量无关；小数据上的计划就是线上计划。
 * 截获服务层经 env.db 发出的每条语句及其绑定参数，逐条取 EXPLAIN QUERY PLAN。
 */
async function capturePlans(run: (e: typeof env) => Promise<unknown>): Promise<{ sql: string; plan: string; rowsRead: number }[]> {
  const statements: { sql: string; params: unknown[] }[] = [];
  const db = new Proxy(env.db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const entry = { sql: query, params: [] as unknown[] };
        statements.push(entry);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { entry.params = args; return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await run({ ...env, db } as typeof env);
  const out: { sql: string; plan: string; rowsRead: number }[] = [];
  for (const statement of statements) {
    if (!/^select\b/i.test(statement.sql.trim())) continue;
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
    // 只读语句，重放一次取 D1 的 rows_read
    const replay = await env.db.prepare(statement.sql).bind(...statement.params).all();
    out.push({ sql: statement.sql, plan: plan.results.map((row) => row.detail).join(' | '), rowsRead: replay.meta.rows_read });
  }
  return out;
}

/** 只看读 messages 的语句 */
const onMessages = <T extends { sql: string }>(plans: T[]) => plans.filter((p) => /from "messages"|FROM messages\b/.test(p.sql));

/**
 * 对 messages 的全表扫描（SCAN messages …）与沿 idx_messages_live 只按 deleted_at 倒扫全站未删除邮件，
 * 都是读取量随全站邮件量增长的计划
 */
function expectNoFullScan(plan: string, label: string) {
  expect(plan, label).not.toMatch(/SCAN messages\b/);
  expect(plan, label).not.toMatch(/idx_messages_live \(deleted_at=\?\)/);
}

const q = (extra: Partial<ListMessagesQuery> = {}) => ({ limit: 30, ...extra }) as ListMessagesQuery;

let sparse: Viewer;
let admin: Viewer;
let sparseBox: string;
let replyTarget: number;
let subjectTarget: number;

beforeAll(async () => {
  const db = createDb(env);
  const [s, a, owner] = await db.insert(users).values([
    { username: 'explain-sparse', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    { username: 'explain-admin', passwordHash: 'x', role: 'admin', authVersionMigrated: true },
    { username: 'explain-owner', passwordHash: 'x', role: 'user', authVersionMigrated: true },
  ]).returning({ id: users.id });
  sparse = { userId: s!.id, role: 'user' };
  admin = { userId: a!.id, role: 'admin' };
  sparseBox = 'sparse@explain.test';
  await db.insert(mailboxes).values([
    { address: sparseBox, domain: 'explain.test', userId: s!.id },
    { address: 'admin1@explain.test', domain: 'explain.test', userId: a!.id },
    { address: 'admin2@explain.test', domain: 'explain.test', userId: a!.id },
    { address: 'owner@explain.test', domain: 'explain.test', userId: owner!.id },
  ]);
  const [shared] = await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, 'owner@explain.test'));
  await db.insert(mailboxShares).values([
    { mailboxId: shared!.id, userId: s!.id, grantedBy: owner!.id },
    { mailboxId: shared!.id, userId: a!.id, grantedBy: owner!.id },
  ]);
  const base = { direction: 'inbound' as const, domain: 'explain.test', fromAddress: 'f@example.net', preview: 'p', status: 'received' };
  const [root] = await db.insert(messages).values({ ...base, address: sparseBox, subject: 'topic', messageId: '<root@explain>' }).returning({ id: messages.id });
  replyTarget = root!.id;
  await db.insert(messages).values({ ...base, address: sparseBox, subject: 'Re: topic', inReplyTo: '<root@explain>' });
  const [loose] = await db.insert(messages).values({ ...base, address: sparseBox, subject: 'Re: loose' }).returning({ id: messages.id });
  subjectTarget = loose!.id;
  await db.insert(messages).values([
    { ...base, address: 'admin1@explain.test', subject: 'a' },
    { ...base, address: 'owner@explain.test', subject: 'shared' },
    { ...base, address: 'nobody@explain.test', subject: 'unclaimed' },
  ]);
});

/** idx_messages_visible 四列全部等值：每个（地址, 方向, 已读）区间按 rowid 即 id 有序，取够 LIMIT 即停 */
const VISIBLE_FULL_PREFIX = 'SEARCH messages USING INDEX idx_messages_visible (address=? AND deleted_at=? AND direction=? AND is_read=?';
const BY_ADDRESS = 'SEARCH messages USING INDEX idx_messages_address_deleted_id (address=?';

describe('执行计划回归：默认视图按地址取数', () => {
  // 没有方向/未读筛选的走 address_deleted_id；带方向或未读筛选的走 visible 并补齐等值前缀
  const views: [string, Partial<ListMessagesQuery>, string][] = [
    ['全部', {}, BY_ADDRESS], ['翻页', { cursor: encodeCursor(1_000_000) }, BY_ADDRESS], ['增量', { afterId: 1 }, BY_ADDRESS],
    ['按地址', { address: 'owner@explain.test' }, BY_ADDRESS],
    ['收件', { direction: 'inbound' }, VISIBLE_FULL_PREFIX], ['已发送', { direction: 'outbound' }, VISIBLE_FULL_PREFIX],
    ['未读', { unread: true }, VISIBLE_FULL_PREFIX], ['收件未读', { direction: 'inbound', unread: true }, VISIBLE_FULL_PREFIX],
    ['收件翻页', { direction: 'inbound', cursor: encodeCursor(1_000_000) }, VISIBLE_FULL_PREFIX],
    ['按地址已发送', { address: 'owner@explain.test', direction: 'outbound' }, VISIBLE_FULL_PREFIX],
  ];

  it.each([['稀疏用户', () => sparse], ['管理员', () => admin], ['管理员 scope=mine', () => ({ ...admin, scope: 'mine' as const })]])(
    '%s：全部/翻页/按地址走 idx_messages_address_deleted_id，收件/已发送/未读走 idx_messages_visible 全等值前缀，不倒扫全站',
    async (_label, who) => {
      for (const [label, query, expected] of views) {
        const [page] = onMessages(await capturePlans((e) => listMessages(e, who(), q(query))));
        expect(page!.plan, label).toContain(expected);
        expectNoFullScan(page!.plan, label);
      }
    },
  );

  it('sync：未读数与首页同计划，首页与列表同一条语句', async () => {
    for (const query of [{}, { direction: 'inbound' as const }]) {
      const plans = onMessages(await capturePlans((e) => syncMessages(e, sparse, q(query))));
      expect(plans).toHaveLength(2);
      expect(plans[0]!.plan).toContain('idx_messages_visible');
      expect(plans[1]!.plan).toContain(query.direction ? VISIBLE_FULL_PREFIX : BY_ADDRESS);
      for (const p of plans) expectNoFullScan(p.plan, p.sql);
      const [listed] = onMessages(await capturePlans((e) => listMessages(e, sparse, q(query))));
      expect(plans[1]!.sql).toBe(listed!.sql);
    }
  });

  it('domain/星标/搜索/回收站/未认领/审计他人邮箱保持原计划（不加 INDEXED BY）', async () => {
    const kept: [string, Viewer, Partial<ListMessagesQuery>][] = [
      ['domain', sparse, { domain: 'explain.test' }], ['星标', sparse, { starred: true }], ['搜索', sparse, { q: 'x' }],
      ['回收站', sparse, { trash: true }], ['未认领', { ...admin, scope: 'unclaimed' }, {}],
      ['审计他人', { ...admin, scope: 'user', targetUserId: sparse.userId }, {}],
    ];
    for (const [label, who, query] of kept) {
      const [page] = onMessages(await capturePlans((e) => listMessages(e, who, q(query))));
      expect(page!.sql, label).not.toContain('INDEXED BY');
    }
  });

  it('联系人按地址取最近 400 封', async () => {
    for (const who of [sparse, admin]) {
      const [contacts] = onMessages(await capturePlans((e) => getRecentContacts(e, who)));
      expect(contacts!.plan).toContain('SEARCH messages USING INDEX idx_messages_address_deleted_id (address=?');
      expectNoFullScan(contacts!.plan, 'contacts');
    }
  });

  it('未读数（/api 封顶与 /v1 精确）沿 idx_messages_visible 按地址计数', async () => {
    for (const who of [sparse, admin]) {
      for (const cap of [UNREAD_COUNT_CAP, undefined]) {
        const [count] = onMessages(await capturePlans((e) => countUnread(e, who.userId, who.role, cap)));
        expect(count!.plan).toContain('SEARCH messages USING COVERING INDEX idx_messages_visible (address=? AND deleted_at=? AND direction=? AND is_read=?)');
        expectNoFullScan(count!.plan, `cap=${cap}`);
      }
    }
  });

  it('线程：候选按 message_id / in_reply_to 索引取，主题回退按地址取', async () => {
    const byHeaders = onMessages(await capturePlans((e) => getThread(e, sparse, replyTarget)));
    expect(byHeaders.map((p) => p.plan).join(' || ')).toMatch(/idx_messages_message_id[\s\S]*idx_messages_in_reply_to/);
    for (const p of byHeaders) expectNoFullScan(p.plan, p.sql);
    const bySubject = onMessages(await capturePlans((e) => getThread(e, sparse, subjectTarget)));
    expect(bySubject.at(-1)!.plan).toContain('idx_messages_address_deleted_id (address=?');
    for (const p of bySubject) expectNoFullScan(p.plan, p.sql);
  });

  it('mailboxes 列表的 messageCount 子查询按地址走索引，canSend 所需的托管域名按唯一索引逐行查', async () => {
    for (const opts of [{ userId: admin.userId }, { all: true }]) {
      const [list] = await capturePlans((e) => listMailboxes(e, opts));
      expect(list!.plan).toMatch(/CORRELATED SCALAR SUBQUERY \d+ \| SEARCH messages USING COVERING INDEX \w+ \(address=\?\)/);
      expect(list!.plan).toMatch(/SEARCH hosted_domains USING INDEX \w+ \(domain=\?\)/);
      expectNoFullScan(list!.plan, JSON.stringify(opts));
    }
  });
});

describe('执行计划回归：主人邮件很多、匹配很少', () => {
  /** 先插少量匹配（id 较小），再插大量不匹配的新邮件：按 id 倒序逐封回表判断要扫过全部新邮件 */
  async function seedOwner(username: string, address: string, few: string, bulk: string) {
    const [user] = await createDb(env).insert(users)
      .values({ username, passwordHash: 'x', role: 'admin', authVersionMigrated: true }).returning({ id: users.id });
    await createDb(env).insert(mailboxes).values({ address, domain: 'heavy.test', userId: user!.id });
    for (const [rows, count] of [[few, 1], [bulk, 2000]] as const) {
      await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO messages (direction, is_read, address, domain, from_address, subject, preview, status)
        SELECT v.direction, v.is_read, ?, 'heavy.test', 'f@example.net', 's', 'p', 'received'
        FROM n, (${rows}) v`).bind(count, address).run();
    }
    return { userId: user!.id, role: 'admin' as const };
  }

  it('收件/未读/已发送只读几十行（改用 address_deleted_id 时要逐封回表，读取量随主人邮件量线性增长）', async () => {
    // reader：2000 封已读收件 + 3 封未读、2 封已发送；sender：2000 封已发送 + 2 封收件
    const reader = await seedOwner('heavy-reader', 'reader@heavy.test',
      "SELECT 'inbound' direction, 0 is_read UNION ALL SELECT 'inbound', 0 UNION ALL SELECT 'inbound', 0 UNION ALL SELECT 'outbound', 1 UNION ALL SELECT 'outbound', 1",
      "SELECT 'inbound' direction, 1 is_read");
    const sender = await seedOwner('heavy-sender', 'sender@heavy.test',
      "SELECT 'inbound' direction, 0 is_read UNION ALL SELECT 'inbound', 1", "SELECT 'outbound' direction, 1 is_read");
    const cases: [Viewer, Partial<ListMessagesQuery>, number][] = [
      [reader, { direction: 'inbound', unread: true }, 3], [reader, { unread: true }, 3], [reader, { direction: 'outbound' }, 2],
      [sender, { direction: 'inbound' }, 2], [sender, { unread: true }, 1],
    ];
    for (const [who, query, expected] of cases) {
      const label = `${who === reader ? 'reader' : 'sender'} ${JSON.stringify(query)}`;
      let page: Awaited<ReturnType<typeof listMessages>> | undefined;
      const [statement] = onMessages(await capturePlans(async (e) => { page = await listMessages(e, who, q(query)); }));
      expect(page!.items.map((item) => item.id), label).toEqual((await legacyPage(who, q(query), null)).ids);
      expect(page!.items, label).toHaveLength(expected);
      expect(statement!.plan, label).toContain(VISIBLE_FULL_PREFIX);
      expect(statement!.rowsRead, label).toBeLessThan(100);
    }
  });
});

describe('执行计划回归：wait 的地址与域名过滤', () => {
  it('指定地址、只给 domain、什么都不给：自己与审计范围都逐地址按 id 取，没有新信时读取量与全站新信数量无关', async () => {
    const db = createDb(env);
    const [user, sharer] = await db.insert(users).values([
      { username: 'wait-plan', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'wait-plan-sharer', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    ]).returning({ id: users.id });
    const [, , , shared] = await db.insert(mailboxes).values([
      { address: 'w1@waitplan.test', domain: 'waitplan.test', userId: user!.id },
      { address: 'w2@waitplan.test', domain: 'waitplan.test', userId: user!.id },
      { address: 'w3@waitplan-other.test', domain: 'waitplan-other.test', userId: user!.id },
      { address: 's1@waitplan.test', domain: 'waitplan.test', userId: sharer!.id },
    ]).returning({ id: mailboxes.id });
    await db.insert(mailboxShares).values({ mailboxId: shared!.id, userId: user!.id, grantedBy: sharer!.id });
    const head = await env.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first<{ id: number }>();
    // afterId 之后全站来了别人的新信，一半落在同一个 catch-all 域的未认领地址上：
    // 沿 idx_messages_live 按 id 扫、或沿 idx_messages_domain 扫该域，每次轮询都要读完它们
    const noise = (address: string, count: number) => env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', ?, substr(?, instr(?, '@') + 1), 'f@example.net', 's', 'p', 'received' FROM n`).bind(count, address, address, address).run();
    await noise('noise@waitplan-noise.test', 1000);
    await noise('stranger@waitplan.test', 1000);
    const owner: Viewer = { userId: user!.id, role: 'user' };
    const audit: Viewer = { ...admin, scope: 'user', targetUserId: user!.id };
    const unclaimed: Viewer = { ...admin, scope: 'unclaimed' };
    const cases: [string, Viewer, { address?: string[]; domain?: string }][] = [
      ['单地址', owner, { address: ['w1@waitplan.test'] }], ['多地址', owner, { address: ['w1@waitplan.test', 'w2@waitplan.test'] }],
      ['未认领多地址', unclaimed, { address: ['quiet1@waitplan-noise.test', 'quiet2@waitplan-noise.test'] }],
      ['只给 domain', owner, { domain: 'waitplan.test' }], ['不给地址与域名', owner, {}],
      ['审计他人只给 domain', audit, { domain: 'waitplan.test' }], ['审计他人不给地址与域名', audit, {}],
    ];
    const measure = async () => {
      const rowsRead: Record<string, number> = {};
      for (const [label, viewer, filter] of cases) {
        let found: Awaited<ReturnType<typeof findNextMessage>> | undefined;
        const [scan] = onMessages(await capturePlans(async (e) => { found = await findNextMessage(e, viewer, { afterId: head!.id, ...filter }); }));
        expect(found, label).toEqual({ message: null, scannedThroughId: head!.id });
        expect(scan!.plan, label).toContain(BY_ADDRESS);
        expectNoFullScan(scan!.plan, label);
        expect(scan!.plan, label).not.toContain('idx_messages_domain');
        expect(scan!.rowsRead, label).toBeLessThan(50);
        rowsRead[label] = scan!.rowsRead;
      }
      return rowsRead;
    };
    const before = await measure();
    await noise('stranger@waitplan.test', 2000);
    expect(await measure()).toEqual(before);

    // domain 并进认领与共享两支地址子查询：mailboxes 上用一元 + 压掉 idx_mailboxes_domain，只读调用者自己的邮箱行，不读全站该域的认领行
    const [ownDomain] = onMessages(await capturePlans((e) => findNextMessage(e, owner, { afterId: head!.id, domain: 'waitplan.test' })));
    expect(ownDomain!.sql.match(/\+"mailboxes"\."domain" = \?/g)).toHaveLength(2);
    expect(ownDomain!.plan).not.toContain('idx_mailboxes_domain');
    // 收窄后其他域的地址不再逐个探查：调用者在别的域有 300 个地址时，只给 domain 比不给少读约 300 行
    const [many] = await db.insert(users).values({ username: 'wait-plan-many', passwordHash: 'x', role: 'user', authVersionMigrated: true })
      .returning({ id: users.id });
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO mailboxes (address, domain, user_id) SELECT 'm' || i || '@waitplan-many.test', 'waitplan-many.test', ? FROM n`).bind(many!.id).run();
    await db.insert(mailboxes).values({ address: 'many@waitplan.test', domain: 'waitplan.test', userId: many!.id });
    const rowsRead = async (filter: { domain?: string }) =>
      onMessages(await capturePlans((e) => findNextMessage(e, { userId: many!.id, role: 'user' }, { afterId: head!.id, ...filter })))[0]!.rowsRead;
    expect(await rowsRead({}) - await rowsRead({ domain: 'waitplan.test' })).toBeGreaterThanOrEqual(300);
    // 未认领范围的地址集合不可枚举，domain 交给规划器走 idx_messages_domain（只读该域的新信）
    const [byDomain] = onMessages(await capturePlans((e) => findNextMessage(e, unclaimed, { afterId: head!.id, domain: 'waitplan-noise.test' })));
    expect(byDomain!.plan).toContain('idx_messages_domain (domain=? AND id>?)');

    // include=body 命中后带同一组条件复核整行，仍按主键取一行
    const [hit] = await db.insert(messages).values({ direction: 'inbound', address: 'w1@waitplan.test', domain: 'waitplan.test',
      fromAddress: 'f@example.net', subject: 'hit', preview: 'p', status: 'received' }).returning({ id: messages.id });
    let found: Awaited<ReturnType<typeof findNextMessage>> | undefined;
    const [, full] = onMessages(await capturePlans(async (e) => { found = await findNextMessage(e, owner, { afterId: hit!.id - 1, domain: 'waitplan.test', include: 'body' }); }));
    expect(found!.message).toMatchObject({ id: hit!.id, bodyText: '' });
    expect(full!.plan).toMatch(/^SEARCH messages USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(full!.rowsRead).toBeLessThan(10);
  });
});

describe('执行计划回归：通知归属', () => {
  it('resolveNotifyOwnerIds 未认领分支只扫启用管理员的部分索引，不扫 users 全表', async () => {
    const [owners] = await capturePlans((e) => resolveNotifyOwnerIds(e, 'nobody@explain.test'));
    expect(owners!.plan).toContain('USING COVERING INDEX idx_users_active_admin');
    expect(owners!.plan).not.toMatch(/SCAN users(?! USING COVERING INDEX idx_users_active_admin)/);
    expect(await resolveNotifyOwnerIds(env, 'nobody@explain.test')).toContain(admin.userId);
    expect(await resolveNotifyOwnerIds(env, sparseBox)).toEqual([sparse.userId]);
  });
});

/**
 * 改前的列表语句（readable 用 OR 形式、交给规划器选索引）作为对照：默认视图改走地址索引后，
 * 每一页的条目、顺序与 nextCursor 都必须与它逐条一致。
 */
async function legacyPage(viewer: Viewer, query: ListMessagesQuery, cursorId: number | null) {
  const owned = 'SELECT address FROM mailboxes WHERE user_id = ?';
  const shared = `SELECT m.address FROM mailbox_shares s JOIN mailboxes m ON m.id = s.mailbox_id
    JOIN users u ON u.id = m.user_id WHERE s.user_id = ? AND u.status = 'active'`;
  const ownedOnly = query.unread || query.direction === 'outbound';
  const conds = [ownedOnly ? `address IN (${owned})`
    : `(address IN (${owned}) OR (direction = 'inbound' AND deleted_at IS NULL AND address IN (${shared})))`, 'deleted_at IS NULL'];
  const params: unknown[] = ownedOnly ? [viewer.userId] : [viewer.userId, viewer.userId];
  if (query.direction) { conds.push('direction = ?'); params.push(query.direction); }
  if (query.address) { conds.push('address = ?'); params.push(query.address); }
  if (query.unread) conds.push('is_read = 0');
  if (cursorId) { conds.push('id < ?'); params.push(cursorId); }
  if (query.afterId) { conds.push('id > ?'); params.push(query.afterId); }
  const rows = await env.db.prepare(`SELECT id FROM messages WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .bind(...params, query.limit + 1).all<{ id: number }>();
  const ids = rows.results.map((row) => row.id);
  const page = ids.slice(0, query.limit);
  return { ids: page, nextCursor: ids.length > query.limit ? encodeCursor(page.at(-1)!) : null };
}

describe('执行计划回归：永久删除清空通知载荷', () => {
  it('按 purge_token 取邮件、按 dedupe_key 前缀范围查任务，不扫 notification_jobs 全表（message_id 无索引）', async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const entry = { sql: query, params: [] as unknown[] };
        statements.push(entry);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { entry.params = args; return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    purgeStatements({ ...env, db } as typeof env, 'explain-purge-token');
    const update = statements.find((statement) => /UPDATE notification_jobs/.test(statement.sql))!;
    const plan = (await env.db.prepare(`EXPLAIN QUERY PLAN ${update.sql}`).bind(...update.params).all<{ detail: string }>())
      .results.map((row) => row.detail).join(' | ');
    expect(plan).toMatch(/idx_messages_purge_token \(purge_token=\?\)/);
    expect(plan).toMatch(/notification_jobs_dedupe_key_unique \(dedupe_key>\? AND dedupe_key<\?\)/);
    expect(plan).not.toMatch(/SCAN (notification_jobs|j)\b/);
  });
});

describe('默认视图改走地址索引：结果与改前逐条一致', () => {
  it('认领/共享（含已删除、外发、所有者禁用）/未认领混合数据，各视图逐页一致；联系人一致', async () => {
    const db = createDb(env);
    const [u, o, x, ad, y] = await db.insert(users).values([
      { username: 'cmp-user', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'cmp-owner', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'cmp-disabled', passwordHash: 'x', role: 'user', status: 'disabled', authVersionMigrated: true },
      { username: 'cmp-admin', passwordHash: 'x', role: 'admin', authVersionMigrated: true },
      { username: 'cmp-other', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    ]).returning({ id: users.id });
    const boxes = await db.insert(mailboxes).values([
      { address: 'u1@cmp.test', domain: 'cmp.test', userId: u!.id },
      { address: 'u2@cmp.test', domain: 'cmp.test', userId: u!.id },
      { address: 'o1@cmp.test', domain: 'cmp.test', userId: o!.id },
      { address: 'x1@cmp.test', domain: 'cmp.test', userId: x!.id },
      { address: 'a1@cmp.test', domain: 'cmp.test', userId: ad!.id },
      { address: 'a2@cmp.test', domain: 'cmp.test', userId: ad!.id },
      { address: 'y1@cmp.test', domain: 'cmp.test', userId: y!.id },
    ]).returning({ id: mailboxes.id, address: mailboxes.address });
    const box = (address: string) => boxes.find((b) => b.address === address)!.id;
    await db.insert(mailboxShares).values([
      { mailboxId: box('o1@cmp.test'), userId: u!.id, grantedBy: o!.id },
      { mailboxId: box('x1@cmp.test'), userId: u!.id, grantedBy: x!.id },
      { mailboxId: box('o1@cmp.test'), userId: ad!.id, grantedBy: o!.id },
      { mailboxId: box('u1@cmp.test'), userId: ad!.id, grantedBy: u!.id },
    ]);
    // 固定种子的伪随机，失败可复现
    let seed = 20261015;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const addresses = ['u1@cmp.test', 'u2@cmp.test', 'o1@cmp.test', 'x1@cmp.test', 'a1@cmp.test', 'a2@cmp.test', 'y1@cmp.test', 'n1@cmp.test'];
    const rows = Array.from({ length: 90 }, () => {
      const outbound = rnd() < 0.3;
      return {
        direction: outbound ? 'outbound' as const : 'inbound' as const, address: addresses[Math.floor(rnd() * addresses.length)]!,
        domain: 'cmp.test', fromAddress: `f${Math.floor(rnd() * 20)}@example.net`, subject: 's', preview: 'p',
        status: outbound ? 'sent' : 'received', isRead: outbound || rnd() < 0.5, deletedAt: rnd() < 0.15 ? new Date() : null,
        recipients: { to: [`to${Math.floor(rnd() * 20)}@example.net`], cc: [], bcc: [] },
      };
    });
    const inserted: number[] = [];
    for (const row of rows) {
      const [m] = await db.insert(messages).values(row).returning({ id: messages.id });
      inserted.push(m!.id);
    }

    const viewers: [string, Viewer][] = [
      ['user', { userId: u!.id, role: 'user' }], ['owner', { userId: o!.id, role: 'user' }],
      ['admin', { userId: ad!.id, role: 'admin' }], ['admin mine', { userId: ad!.id, role: 'admin', scope: 'mine' }],
    ];
    const views: Partial<ListMessagesQuery>[] = [
      {}, { direction: 'inbound' }, { direction: 'outbound' }, { unread: true }, { unread: true, direction: 'inbound' },
      { address: 'u1@cmp.test' }, { address: 'o1@cmp.test' }, { address: 'x1@cmp.test' }, { address: 'y1@cmp.test' },
      { address: 'n1@cmp.test' }, { address: 'o1@cmp.test', direction: 'outbound' }, { afterId: inserted[45]! },
    ];
    let compared = 0;
    for (const [who, viewer] of viewers) {
      for (const view of views) {
        for (const limit of [3, 10, 100]) {
          const query = { ...view, limit } as ListMessagesQuery;
          let cursor: string | undefined;
          for (let pageNo = 0; pageNo < 100; pageNo++) {
            const label = `${who} ${JSON.stringify(query)} page ${pageNo}`;
            const page = await listMessages(env, viewer, { ...query, cursor });
            const expected = await legacyPage(viewer, query, cursor ? Number(atob(cursor)) : null);
            expect({ ids: page.items.map((item) => item.id), nextCursor: page.nextCursor }, label).toEqual(expected);
            compared += expected.ids.length;
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
          }
        }
      }
    }
    // 对照确实覆盖了共享收件，且所有者禁用、已删除、共享地址外发都不可见
    const byId = new Map(inserted.map((id, index) => [id, rows[index]!]));
    const userAll = (await legacyPage(viewers[0]![1], { limit: 100 } as ListMessagesQuery, null)).ids.map((id) => byId.get(id)!);
    expect(userAll.some((row) => row.address === 'o1@cmp.test')).toBe(true);
    expect(userAll.every((row) => row.address !== 'x1@cmp.test' && row.deletedAt === null)).toBe(true);
    expect(userAll.every((row) => row.address !== 'o1@cmp.test' || row.direction === 'inbound')).toBe(true);
    expect(compared).toBeGreaterThan(500);

    // 联系人：与改前「认领地址 + 未删除，最近 400 封」聚合结果一致
    for (const [who, viewer] of viewers) {
      const recent = await env.db.prepare(`SELECT direction, recipients, from_address FROM messages
        WHERE address IN (SELECT address FROM mailboxes WHERE user_id = ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 400`)
        .bind(viewer.userId).all<{ direction: string; recipients: string; from_address: string }>();
      const expected = new Set<string>();
      for (const row of recent.results) {
        if (row.direction === 'outbound') {
          const r = JSON.parse(row.recipients) as { to: string[]; cc: string[] };
          for (const addr of [...r.to, ...r.cc]) if (addr) expected.add(addr);
        } else if (row.from_address) expected.add(row.from_address);
      }
      expect(expected.size, who).toBeGreaterThan(0);
      expect(await getRecentContacts(env, viewer), who).toEqual([...expected].slice(0, 100));
    }
  }, 20_000); // 逐视图逐页回放，CI 慢机上整文件曾到 5 秒以上
});

describe('执行计划回归：列表筛选（since/until/from/to/hasCode/hasAttachments）', () => {
  const since = new Date(Date.now() + 12 * 3_600_000).toISOString();
  const filters: [string, Partial<ListMessagesQuery>][] = [
    ['since', { since: Date.parse(since) }], ['until', { until: Date.now() }], ['from', { from: '@example.net' }],
    ['to', { to: 'x@example.net' }], ['hasCode', { hasCode: true }], ['hasAttachments', { hasAttachments: true }],
    ['组合', { since: Date.parse(since), from: 'f@example.net', hasCode: true, hasAttachments: true }],
  ];

  it('自己的默认视图加筛选后仍按地址取数，不倒扫全站；since 在索引里成为 id 区间，下界经 created_at 索引取', async () => {
    for (const who of [sparse, admin]) {
      for (const [label, filter] of filters) {
        for (const [view, base, expected] of [['全部', {}, BY_ADDRESS], ['收件', { direction: 'inbound' as const }, VISIBLE_FULL_PREFIX]] as const) {
          const plans = onMessages(await capturePlans((e) => listMessages(e, who, q({ ...base, ...filter }))));
          const page = plans[0]!;
          const name = `${who === sparse ? 'sparse' : 'admin'} ${view} ${label}`;
          expect(page.plan, name).toContain(expected);
          expectNoFullScan(page.plan, name);
          if (filter.since !== undefined) {
            expect(page.plan, name).toMatch(view === '全部' ? /idx_messages_address_deleted_id \(address=\? AND deleted_at=\? AND id>\?\)/ : /rowid>\?/);
            expect(page.plan, name).toContain('SEARCH b USING COVERING INDEX idx_messages_created_id (created_at>?)');
          }
          if (filter.hasAttachments) expect(page.plan, name).toMatch(/SEARCH attachments USING (COVERING )?INDEX \w+ \(message_id=\?\)/);
        }
      }
    }
  });

  it('主人邮件很多、窗口内很少：since 收窄后只读几十行（去掉 id 下界要逐封回表判断时间，读满 2000 封）', async () => {
    const db = createDb(env);
    const [user] = await db.insert(users).values({ username: 'since-heavy', passwordHash: 'x', role: 'admin', authVersionMigrated: true })
      .returning({ id: users.id });
    await db.insert(mailboxes).values({ address: 'heavy@since.test', domain: 'since.test', userId: user!.id });
    // 先有 2000 封旧信，之后才来了 3 封窗口内的新信（线上 id 与时间同序）
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', 'heavy@since.test', 'since.test', 'bulk@example.net', 's', 'p', 'received' FROM n`).run();
    const recent = new Date(Date.now() + 24 * 3_600_000);
    for (let i = 0; i < 3; i++) {
      await db.insert(messages).values({ direction: 'inbound', address: 'heavy@since.test', domain: 'since.test',
        fromAddress: 'new@example.net', subject: 's', preview: 'p', status: 'received', createdAt: recent });
    }
    const who: Viewer = { userId: user!.id, role: 'admin' };
    for (const query of [{ since: Date.parse(since) }, { since: Date.parse(since), direction: 'inbound' as const },
      { since: Date.parse(since), from: 'new@example.net' }]) {
      let page: Awaited<ReturnType<typeof listMessages>> | undefined;
      const [statement] = onMessages(await capturePlans(async (e) => { page = await listMessages(e, who, q(query)); }));
      expect(page!.items, JSON.stringify(query)).toHaveLength(3);
      expect(statement!.rowsRead, JSON.stringify(query)).toBeLessThan(100);
    }
  });
});
