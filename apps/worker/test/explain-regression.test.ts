import { env } from 'cloudflare:test';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxShares, mailboxes, messages, stars, users } from '../src/db/schema.js';
import { encodeCursor } from '../src/lib/pagination.js';
import { syncDueHostedDomains } from '../src/services/hosted-domain.js';
import { listMailboxes, resolveNotifyOwnerIds } from '../src/services/mailbox.js';
import { purgeStatements } from '../src/services/message-lifecycle.js';
import { DUE_DRAFTS_CLAIM_SQL, STALE_DRAFTS_SQL } from '../src/services/drafts.js';
import { CLEANUP_JOBS_SQL } from '../src/services/storage-cleanup.js';
import { anyOnboardingSql, hostedTakenSql, onboardingActiveSql } from '../src/services/domain-occupancy.js';
import { syncDueOnboarding } from '../src/services/system-domain.js';
import { occupancyFacts } from '../src/services/zone-catalog.js';
import {
  countUnread, findNextMessage, getRecentContacts, getThread, listMessages, markAllRead, syncMessages, UNREAD_COUNT_CAP, type Viewer,
} from '../src/services/message.js';

/**
 * D1 没有 STAT4，规划器按固定启发式选索引，与数据量无关；小数据上的计划就是线上计划。
 * 截获服务层经 env.db 发出的每条语句及其绑定参数，逐条取 EXPLAIN QUERY PLAN；
 * 只读语句再重放一次，取 D1 的 rows_read 与结果行数（分流的两条语句据此看是哪一条在读邮件）。
 */
async function capturePlans(run: (e: typeof env) => Promise<unknown>): Promise<{ sql: string; plan: string; rowsRead: number; rows: number }[]> {
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
  const out: { sql: string; plan: string; rowsRead: number; rows: number }[] = [];
  for (const statement of statements) {
    const read = /^select\b/i.test(statement.sql.trim());
    if (!read && !/^update\b/i.test(statement.sql.trim())) continue;
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
    const replay = read ? await env.db.prepare(statement.sql).bind(...statement.params).all() : undefined;
    out.push({
      sql: statement.sql, plan: plan.results.map((row) => row.detail).join(' | '),
      rowsRead: replay?.meta.rows_read ?? 0, rows: replay?.results.length ?? 0,
    });
  }
  return out;
}

/** 只看读写 messages 的语句 */
const onMessages = <T extends { sql: string }>(plans: T[]) => plans.filter((p) => /from "messages"|FROM messages\b|^update "messages"/.test(p.sql));

/**
 * 读取量随全站邮件量增长的计划：messages 全表扫描、沿 idx_messages_live 只按 deleted_at（可带 id 区间）扫全站
 * 未删除邮件、沿 idx_messages_domain 扫整个 catch-all 域。覆盖索引与普通索引两种写法都算。
 * wait 分流判定里带 LIMIT 的计数用别名 wait_new，不在此列。
 */
const SITE_WIDE_PLANS = [
  /\bSCAN messages\b/,
  /SEARCH messages USING (?:COVERING )?INDEX idx_messages_live \(deleted_at=\?(?: AND id[<>]=?\?)?\)/,
  /SEARCH messages USING (?:COVERING )?INDEX idx_messages_domain \(domain=\?/,
];
function expectNoFullScan(plan: string, label: string) {
  for (const pattern of SITE_WIDE_PLANS) expect(plan, label).not.toMatch(pattern);
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

/** idx_messages_visible 四列全部等值：每个（地址, 方向, 已读）区间按 rowid 即 id 有序，取够 LIMIT 即停。只取 id 时是覆盖索引 */
const VISIBLE_FULL_PREFIX = /SEARCH messages USING (?:COVERING )?INDEX idx_messages_visible \(address=\? AND deleted_at=\? AND direction=\? AND is_read=\?/;
const BY_ADDRESS = /SEARCH messages USING (?:COVERING )?INDEX idx_messages_address_deleted_id \(address=\?/;

describe('执行计划回归：默认视图按地址取数', () => {
  // 没有方向/未读筛选的走 address_deleted_id；带方向或未读筛选的走 visible 并补齐等值前缀
  const views: [string, Partial<ListMessagesQuery>, RegExp][] = [
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
        const pages = onMessages(await capturePlans((e) => listMessages(e, who(), q(query))));
        expect(pages, label).toHaveLength(1);
        expect(pages[0]!.plan, label).toMatch(expected);
        expectNoFullScan(pages[0]!.plan, label);
      }
    },
  );

  it('列表页内层只取 id（收件/未读/已发送在覆盖索引里判断完），外层按主键回表，附件与星标标记随行取回', async () => {
    for (const [label, query, expected] of views) {
      const [page] = onMessages(await capturePlans((e) => listMessages(e, sparse, q(query))));
      expect(page!.plan, label).toMatch(/^SEARCH messages USING INTEGER PRIMARY KEY \(rowid=\?\) \| LIST SUBQUERY/);
      if (expected === VISIBLE_FULL_PREFIX) expect(page!.plan, label).toContain('USING COVERING INDEX idx_messages_visible');
      expect(page!.plan, label).toMatch(/CORRELATED SCALAR SUBQUERY \d+ \| SEARCH flag_att USING INDEX idx_attachments_message \(message_id=\?\)/);
      expect(page!.plan, label).toMatch(/CORRELATED SCALAR SUBQUERY \d+ \| SEARCH flag_star USING COVERING INDEX \w+ \(user_id=\? AND message_id=\?\)/);
    }
  });

  it('sync：未读数与首页同计划，首页与列表同一条语句', async () => {
    for (const query of [{}, { direction: 'inbound' as const }, { domain: 'explain.test' }, { q: 'topic' }]) {
      const plans = onMessages(await capturePlans((e) => syncMessages(e, sparse, q(query))));
      expect(plans[0]!.plan).toContain('idx_messages_visible');
      expectNoFullScan(plans[0]!.plan, 'unread');
      const listed = onMessages(await capturePlans((e) => listMessages(e, sparse, q(query))));
      expect(plans.slice(1).map((p) => p.sql)).toEqual(listed.map((p) => p.sql));
      if (!('domain' in query) && !('q' in query)) {
        expect(plans).toHaveLength(2);
        expect(plans[1]!.plan).toMatch(query.direction ? VISIBLE_FULL_PREFIX : BY_ADDRESS);
        expectNoFullScan(plans[1]!.plan, JSON.stringify(query));
      }
    }
  });

  it('星标/回收站/未认领保持原计划（一条语句，不加 INDEXED BY）', async () => {
    const kept: [string, Viewer, Partial<ListMessagesQuery>][] = [
      ['星标', sparse, { starred: true }], ['星标 domain', sparse, { starred: true, domain: 'explain.test' }],
      ['回收站', sparse, { trash: true }], ['回收站 domain', sparse, { trash: true, domain: 'explain.test' }],
      ['未认领', { ...admin, scope: 'unclaimed' }, {}], ['未认领搜索', { ...admin, scope: 'unclaimed' }, { q: 'x' }],
      ['审计他人星标', { ...admin, scope: 'user', targetUserId: sparse.userId }, { starred: true }],
    ];
    for (const [label, who, query] of kept) {
      const pages = onMessages(await capturePlans((e) => listMessages(e, who, q(query))));
      expect(pages, label).toHaveLength(1);
      expect(pages[0]!.sql, label).not.toContain('INDEXED BY');
    }
    // 未认领没有地址集合，domain 交给规划器走 idx_messages_domain
    const [unclaimedDomain] = onMessages(await capturePlans((e) => listMessages(e, { ...admin, scope: 'unclaimed' }, q({ domain: 'explain.test' }))));
    expect(unclaimedDomain!.plan).toMatch(/USING (?:COVERING )?INDEX idx_messages_domain \(domain=\?\)/);
  });

  it('domain/搜索/审计他人按可见地址数分流：两条语句同一 batch，domain 下推进 idx_mailboxes_user_domain，不在 messages 上判断', async () => {
    const audit: Viewer = { ...admin, scope: 'user', targetUserId: sparse.userId };
    const split: [string, Viewer, Partial<ListMessagesQuery>, RegExp][] = [
      ['domain', sparse, { domain: 'explain.test' }, BY_ADDRESS], ['domain 收件', sparse, { domain: 'explain.test', direction: 'inbound' }, VISIBLE_FULL_PREFIX],
      ['domain 未读', sparse, { domain: 'explain.test', unread: true }, VISIBLE_FULL_PREFIX], ['搜索', sparse, { q: 'topic' }, BY_ADDRESS],
      ['搜索已发送', sparse, { q: 'topic', direction: 'outbound' }, VISIBLE_FULL_PREFIX], ['domain 翻页', sparse, { domain: 'explain.test', cursor: encodeCursor(1_000_000) }, BY_ADDRESS],
      ['审计他人', audit, {}, BY_ADDRESS], ['审计他人收件', audit, { direction: 'inbound' }, VISIBLE_FULL_PREFIX],
      ['审计他人 domain', audit, { domain: 'explain.test' }, BY_ADDRESS], ['管理员 domain', admin, { domain: 'explain.test' }, BY_ADDRESS],
    ];
    for (const [label, who, query, expected] of split) {
      const plans = onMessages(await capturePlans((e) => listMessages(e, who, q(query))));
      expect(plans, label).toHaveLength(2);
      const [byAddress, planner] = plans;
      // 地址少：逐地址那条读邮件；原计划那条 id 上界被压成 0，只做一次空查找
      expect(byAddress!.sql, label).toContain('INDEXED BY');
      expect(byAddress!.plan, label).toMatch(expected);
      expectNoFullScan(byAddress!.plan, label);
      expect(planner!.sql, label).not.toContain('INDEXED BY');
      expect(planner!.plan, label).toMatch(/SEARCH messages USING (?:COVERING )?INDEX idx_messages_live \(deleted_at=\? AND id<\?\)/);
      expect(planner!.rows, label).toBe(0);
      expect(planner!.rowsRead, label).toBeLessThan(20);
      if (query.domain) {
        for (const p of plans) {
          expect(p.plan, label).toMatch(/idx_mailboxes_user_domain \(user_id=\? AND domain=\?\)/);
          expect(p.sql, label).not.toMatch(/"messages"\."domain" = \?/);
        }
      }
    }
  });

  it('全部已读沿 idx_messages_visible 按地址取，domain 下推进 idx_mailboxes_user_domain', async () => {
    for (const filters of [{}, { domain: 'explain.test' }, { q: 'topic' }, { address: sparseBox }]) {
      const label = JSON.stringify(filters);
      const [update] = onMessages(await capturePlans((e) => markAllRead(e, sparse, filters)));
      expect(update!.sql, label).toMatch(/^update "messages"/);
      expect(update!.plan, label).toMatch(VISIBLE_FULL_PREFIX);
      expectNoFullScan(update!.plan, label);
      if ('domain' in filters) {
        expect(update!.plan, label).toMatch(/idx_mailboxes_user_domain \(user_id=\? AND domain=\?\)/);
        expect(update!.sql, label).not.toMatch(/"messages"\."domain" = \?/);
      }
    }
  });

  it('联系人按地址取最近 400 封', async () => {
    for (const who of [sparse, admin]) {
      const [contacts] = onMessages(await capturePlans((e) => getRecentContacts(e, who)));
      expect(contacts!.plan).toMatch(BY_ADDRESS);
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
      expect(statement!.plan, label).toMatch(VISIBLE_FULL_PREFIX);
      expect(statement!.rowsRead, label).toBeLessThan(100);
    }
  });
});

describe('执行计划回归：wait 的地址与域名过滤', () => {
  it('指定地址、只给 domain、什么都不给：游标落后时自己与审计范围都逐地址取，读取量与全站新信数量无关', async () => {
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
    const total = (plans: { rowsRead: number }[]) => plans.reduce((sum, p) => sum + p.rowsRead, 0);
    // 指定地址：一条语句逐地址按 id 取（多地址的 IN 若改沿 idx_messages_live 按 id 扫，每次轮询都要读完全站新信）
    const byAddress: [string, Viewer, string[]][] = [
      ['单地址', owner, ['w1@waitplan.test']], ['多地址', owner, ['w1@waitplan.test', 'w2@waitplan.test']],
      ['未认领多地址', unclaimed, ['quiet1@waitplan-noise.test', 'quiet2@waitplan-noise.test']],
    ];
    // 不指定地址：afterId 之后全站新信多于 50 封，逐地址那条走 idx_messages_visible（id > afterId 是区间下界），原计划那条被压空
    const byVisible: [string, Viewer, { domain?: string }][] = [
      ['只给 domain', owner, { domain: 'waitplan.test' }], ['不给地址与域名', owner, {}],
      ['审计他人只给 domain', audit, { domain: 'waitplan.test' }], ['审计他人不给地址与域名', audit, {}],
    ];
    const measure = async () => {
      const rowsRead: Record<string, number> = {};
      for (const [label, viewer, address] of byAddress) {
        let found: Awaited<ReturnType<typeof findNextMessage>> | undefined;
        const plans = onMessages(await capturePlans(async (e) => { found = await findNextMessage(e, viewer, { afterId: head!.id, address }); }));
        expect(found, label).toEqual({ message: null, scannedThroughId: head!.id });
        expect(plans, label).toHaveLength(1);
        expect(plans[0]!.plan, label).toMatch(BY_ADDRESS);
        expectNoFullScan(plans[0]!.plan, label);
        expect(plans[0]!.rowsRead, label).toBeLessThan(50);
        rowsRead[label] = plans[0]!.rowsRead;
      }
      for (const [label, viewer, filter] of byVisible) {
        let found: Awaited<ReturnType<typeof findNextMessage>> | undefined;
        const plans = onMessages(await capturePlans(async (e) => { found = await findNextMessage(e, viewer, { afterId: head!.id, ...filter }); }));
        expect(found, label).toEqual({ message: null, scannedThroughId: head!.id });
        expect(plans, label).toHaveLength(2);
        expect(plans[0]!.sql, label).toContain('INDEXED BY idx_messages_visible');
        expect(plans[0]!.plan, label).toMatch(/idx_messages_visible \(address=\? AND deleted_at=\? AND direction=\? AND is_read=\? AND rowid>\?\)/);
        expectNoFullScan(plans[0]!.plan, label);
        for (const p of plans) expect(p.plan, label).not.toContain('idx_messages_domain');
        // 原计划那条沿 idx_messages_live 从 afterId 往后，区间下界被压成最大值，不读邮件
        expect(plans[1]!.rows, label).toBe(0);
        // 分流判定 3 次（各最多读 51 行新信）+ 几个地址的空区间查找；原计划要读完 afterId 之后的 2000 封
        expect(total(plans), label).toBeLessThan(250);
        rowsRead[label] = total(plans);
      }
      return rowsRead;
    };
    const before = await measure();
    await noise('stranger@waitplan.test', 2000);
    expect(await measure()).toEqual(before);

    // domain 并进认领与共享两支地址子查询：认领支走 idx_mailboxes_user_domain，共享支用一元 + 压掉 idx_mailboxes_domain，
    // 都只读调用者自己的邮箱行，不读全站该域的认领行；messages 上不再判断 domain
    const ownDomain = onMessages(await capturePlans((e) => findNextMessage(e, owner, { afterId: head!.id, domain: 'waitplan.test' })));
    for (const p of ownDomain) {
      expect(p.sql).toMatch(/\+"mailboxes"\."domain" = \?/);
      expect(p.sql).not.toMatch(/"messages"\."domain" = \?/);
      expect(p.plan).toMatch(/idx_mailboxes_user_domain \(user_id=\? AND domain=\?\)/);
      expect(p.plan).not.toContain('idx_mailboxes_domain');
    }
    // 收窄后其他域的地址不再逐个探查：调用者在别的域有 300 个地址时，只给 domain 比不给少读约 300 行
    const [many] = await db.insert(users).values({ username: 'wait-plan-many', passwordHash: 'x', role: 'user', authVersionMigrated: true })
      .returning({ id: users.id });
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO mailboxes (address, domain, user_id) SELECT 'm' || i || '@waitplan-many.test', 'waitplan-many.test', ? FROM n`).bind(many!.id).run();
    await db.insert(mailboxes).values({ address: 'many@waitplan.test', domain: 'waitplan.test', userId: many!.id });
    const rowsRead = async (filter: { domain?: string }) =>
      total(onMessages(await capturePlans((e) => findNextMessage(e, { userId: many!.id, role: 'user' }, { afterId: head!.id, ...filter }))));
    expect(await rowsRead({}) - await rowsRead({ domain: 'waitplan.test' })).toBeGreaterThanOrEqual(300);
    // 未认领范围的地址集合不可枚举，domain 交给规划器走 idx_messages_domain（只读该域的新信）
    const [byDomain] = onMessages(await capturePlans((e) => findNextMessage(e, unclaimed, { afterId: head!.id, domain: 'waitplan-noise.test' })));
    expect(byDomain!.plan).toMatch(/idx_messages_domain \(domain=\? AND id>\?\)/);

    // include=body 命中后带同一组条件复核整行，仍按主键取一行
    const [hit] = await db.insert(messages).values({ direction: 'inbound', address: 'w1@waitplan.test', domain: 'waitplan.test',
      fromAddress: 'f@example.net', subject: 'hit', preview: 'p', status: 'received' }).returning({ id: messages.id });
    let found: Awaited<ReturnType<typeof findNextMessage>> | undefined;
    const withBody = onMessages(await capturePlans(async (e) => { found = await findNextMessage(e, owner, { afterId: hit!.id - 1, domain: 'waitplan.test', include: 'body' }); }));
    expect(found!.message).toMatchObject({ id: hit!.id, bodyText: '' });
    const full = withBody.at(-1)!;
    expect(full.plan).toMatch(/^SEARCH messages USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(full.rowsRead).toBeLessThan(10);
  });

  it('不指定地址：游标跟得上时沿用原计划，只读新信那几行；落后时地址再多也逐地址取', async () => {
    const db = createDb(env);
    const [quiet, heavy] = await db.insert(users).values([
      { username: 'wait-quiet', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'wait-heavy', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    ]).returning({ id: users.id });
    await db.insert(mailboxes).values([
      { address: 'q1@waitquiet.test', domain: 'waitquiet.test', userId: quiet!.id },
      { address: 'q2@waitquiet.test', domain: 'waitquiet.test', userId: quiet!.id },
    ]);
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
      INSERT INTO mailboxes (address, domain, user_id) SELECT 'h' || i || '@waitheavy.test', 'waitheavy.test', ? FROM n`).bind(heavy!.id).run();
    const stale = (await env.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first<{ id: number }>())!.id;
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', 'noise' || (i % 7) || '@waitquiet-noise.test', 'waitquiet-noise.test', 'f@example.net', 's', 'p', 'received' FROM n`).run();
    await db.insert(messages).values({ direction: 'inbound', address: 'h7@waitheavy.test', domain: 'waitheavy.test', fromAddress: 'f@example.net', subject: 's', preview: 'p', status: 'received' });
    const fresh = (await env.db.prepare('SELECT MAX(id) AS id FROM messages').first<{ id: number }>())!.id;
    const quietViewer: Viewer = { userId: quiet!.id, role: 'user' };
    const heavyViewer: Viewer = { userId: heavy!.id, role: 'user' };
    const total = (plans: { rowsRead: number }[]) => plans.reduce((sum, p) => sum + p.rowsRead, 0);

    // 空邮箱基线（afterId=0 或落后 1000 封别人的新信）：原计划每轮都要扫完这些新信
    const legacy = await env.db.prepare(`SELECT id FROM messages WHERE address IN (SELECT address FROM mailboxes WHERE user_id = ?)
      AND direction = 'inbound' AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT 1`).bind(quiet!.id, stale).all();
    expect(legacy.meta.rows_read).toBeGreaterThan(1000);
    for (const afterId of [stale, 0]) {
      const plans = onMessages(await capturePlans((e) => findNextMessage(e, quietViewer, { afterId })));
      expect(plans.map((p) => p.rows)).toEqual([0, 0]);
      expect(total(plans), `afterId=${afterId}`).toBeLessThan(200);
    }

    // 游标跟得上：afterId 之后没有几封新信，原计划只读一两行，分流判定也只读到这几行
    const caughtUp = onMessages(await capturePlans((e) => findNextMessage(e, heavyViewer, { afterId: fresh })));
    expect(caughtUp.map((p) => p.rows)).toEqual([0, 0]);
    expect(total(caughtUp)).toBeLessThan(20);
    const nearHead = onMessages(await capturePlans((e) => findNextMessage(e, heavyViewer, { afterId: fresh - 1 })));
    expect(nearHead.map((p) => p.rows)).toEqual([0, 1]);

    // 落后时 60 个地址也逐地址取：每个地址探两次（已读/未读），不随全站新信增长
    let hit: Awaited<ReturnType<typeof findNextMessage>> | undefined;
    const heavyPlans = onMessages(await capturePlans(async (e) => { hit = await findNextMessage(e, heavyViewer, { afterId: stale }); }));
    expect(hit!.message?.address).toBe('h7@waitheavy.test');
    expect(heavyPlans.map((p) => p.rows)).toEqual([1, 0]);
    expect(total(heavyPlans)).toBeLessThan(500);
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
 * 改前的列表语句（readable 用 OR 形式、domain 在 messages 上判断、交给规划器选索引）作为对照：
 * 改走地址索引、domain 下推、按地址数分流后，每一页的条目、顺序与 nextCursor 都必须与它逐条一致。
 * 审计他人邮箱只看该用户认领的地址。
 */
async function legacyPage(viewer: Viewer, query: ListMessagesQuery, cursorId: number | null) {
  const owned = 'SELECT address FROM mailboxes WHERE user_id = ?';
  const shared = `SELECT m.address FROM mailbox_shares s JOIN mailboxes m ON m.id = s.mailbox_id
    JOIN users u ON u.id = m.user_id WHERE s.user_id = ? AND u.status = 'active'`;
  const audit = viewer.scope === 'user';
  const ownerId = audit ? viewer.targetUserId! : viewer.userId;
  const ownedOnly = audit || query.unread || query.direction === 'outbound';
  const conds = [ownedOnly ? `address IN (${owned})`
    : `(address IN (${owned}) OR (direction = 'inbound' AND deleted_at IS NULL AND address IN (${shared})))`, 'deleted_at IS NULL'];
  const params: unknown[] = ownedOnly ? [ownerId] : [ownerId, ownerId];
  if (query.direction) { conds.push('direction = ?'); params.push(query.direction); }
  if (query.domain) { conds.push('domain = ?'); params.push(query.domain); }
  if (query.address) { conds.push('address = ?'); params.push(query.address); }
  if (query.unread) conds.push('is_read = 0');
  if (query.q) {
    conds.push(`(${['subject', 'from_address', 'from_name', 'body_text', 'recipients'].map((c) => `instr(lower(${c}), ?) > 0`).join(' OR ')})`);
    params.push(...Array<string>(5).fill(query.q.toLowerCase()));
  }
  if (cursorId) { conds.push('id < ?'); params.push(cursorId); }
  if (query.afterId) { conds.push('id > ?'); params.push(query.afterId); }
  const rows = await env.db.prepare(`SELECT id FROM messages WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .bind(...params, query.limit + 1).all<{ id: number }>();
  const ids = rows.results.map((row) => row.id);
  const page = ids.slice(0, query.limit);
  return { ids: page, nextCursor: ids.length > query.limit ? encodeCursor(page.at(-1)!) : null, rowsRead: rows.meta.rows_read };
}

describe('执行计划回归：domain/搜索视图按地址数分流', () => {
  it('稀疏用户逐地址取（读取量与全站邮件量无关），地址多的用户沿用原计划，分流判定只多读几十行', async () => {
    const db = createDb(env);
    const [sp, hv] = await db.insert(users).values([
      { username: 'r29-sparse', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'r29-heavy', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    ]).returning({ id: users.id });
    await db.insert(mailboxes).values([
      { address: 'sp1@r29.test', domain: 'r29.test', userId: sp!.id }, { address: 'sp2@r29.test', domain: 'r29.test', userId: sp!.id },
      { address: 'hv1@r29.test', domain: 'r29.test', userId: hv!.id }, { address: 'hv2@r29.test', domain: 'r29.test', userId: hv!.id },
    ]);
    // 重度用户另有 60 个地址（超过分流上限 50），都在 r29heavy.test
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
      INSERT INTO mailboxes (address, domain, user_id) SELECT 'h' || i || '@r29heavy.test', 'r29heavy.test', ? FROM n`).bind(hv!.id).run();
    const base = { direction: 'inbound' as const, domain: 'r29.test', fromAddress: 'f@example.net', preview: 'p', status: 'received' };
    // 两人在 r29.test 的邮件都很早；之后全站来了 2000 封别人的信，最后是重度用户 r29heavy.test 的 300 封
    await db.insert(messages).values([
      { ...base, address: 'sp1@r29.test', subject: 'needle r29' }, { ...base, address: 'sp2@r29.test', subject: 'plain' },
      { ...base, address: 'hv1@r29.test', subject: 'old r29' }, { ...base, address: 'hv2@r29.test', subject: 'old' },
    ]);
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', 'noise' || (i % 13) || '@r29.test', 'r29.test', 'f@example.net', 'noise', 'p', 'received' FROM n`).run();
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO messages (direction, address, domain, from_address, subject, preview, status)
      SELECT 'inbound', 'h' || (1 + i % 60) || '@r29heavy.test', 'r29heavy.test', 'f@example.net', 'dense r29', 'p', 'received' FROM n`).run();
    const sparseViewer: Viewer = { userId: sp!.id, role: 'user' };
    const heavyViewer: Viewer = { userId: hv!.id, role: 'user' };
    const total = (plans: { rowsRead: number }[]) => plans.reduce((sum, p) => sum + p.rowsRead, 0);

    // 地址少（含重度用户只在该域有 2 个地址）：逐地址那条读邮件，原计划要倒扫全站 2000 多封
    const few: [string, Viewer, Partial<ListMessagesQuery>][] = [
      ['稀疏 domain', sparseViewer, { domain: 'r29.test' }], ['稀疏搜索', sparseViewer, { q: 'needle' }],
      ['稀疏 domain 收件', sparseViewer, { domain: 'r29.test', direction: 'inbound' }], ['重度 2 个地址的域', heavyViewer, { domain: 'r29.test' }],
    ];
    for (const [label, who, query] of few) {
      let page: Awaited<ReturnType<typeof listMessages>> | undefined;
      const plans = onMessages(await capturePlans(async (e) => { page = await listMessages(e, who, q(query)); }));
      const legacy = await legacyPage(who, q(query), null);
      expect(page!.items.map((item) => item.id), label).toEqual(legacy.ids);
      expect(plans.map((p) => p.rows > 0), label).toEqual([true, false]);
      expect(legacy.rowsRead, label).toBeGreaterThan(2000);
      expect(total(plans), label).toBeLessThan(150);
    }

    // 地址多且邮件密：原计划凑满一页只要读几十行，逐地址每个地址都要探几次；分流判定读满 51 行即停
    for (const query of [{ domain: 'r29heavy.test' }, { q: 'dense' }, { q: 'dense', direction: 'inbound' as const }]) {
      const label = JSON.stringify(query);
      let page: Awaited<ReturnType<typeof listMessages>> | undefined;
      const plans = onMessages(await capturePlans(async (e) => { page = await listMessages(e, heavyViewer, q(query)); }));
      const legacy = await legacyPage(heavyViewer, q(query), null);
      expect(page!.items.map((item) => item.id), label).toEqual(legacy.ids);
      expect(plans.map((p) => p.rows), label).toEqual([0, 31]);
      expect(total(plans), label).toBeLessThan(legacy.rowsRead + 250);
    }
  });
});

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

describe('列表改走地址索引、domain 下推与分流：结果与改前逐条一致', () => {
  it('认领/共享（含已删除、外发、所有者禁用）/未认领混合数据，各视图（含 domain/搜索/审计他人与地址多的用户）逐页一致，附件星标标记一致；联系人一致', async () => {
    const db = createDb(env);
    const [u, o, x, ad, y] = await db.insert(users).values([
      { username: 'cmp-user', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'cmp-owner', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'cmp-disabled', passwordHash: 'x', role: 'user', status: 'disabled', authVersionMigrated: true },
      { username: 'cmp-admin', passwordHash: 'x', role: 'admin', authVersionMigrated: true },
      { username: 'cmp-other', passwordHash: 'x', role: 'user', authVersionMigrated: true },
      { username: 'cmp-many', passwordHash: 'x', role: 'user', authVersionMigrated: true },
    ]).returning({ id: users.id });
    const many = (await db.select({ id: users.id }).from(users).where(eq(users.username, 'cmp-many')))[0]!.id;
    const boxes = await db.insert(mailboxes).values([
      { address: 'u1@cmp.test', domain: 'cmp.test', userId: u!.id },
      { address: 'u2@cmp.test', domain: 'cmp.test', userId: u!.id },
      { address: 'o1@cmp.test', domain: 'cmp.test', userId: o!.id },
      { address: 'x1@cmp.test', domain: 'cmp.test', userId: x!.id },
      { address: 'a1@cmp.test', domain: 'cmp.test', userId: ad!.id },
      { address: 'a2@cmp.test', domain: 'cmp.test', userId: ad!.id },
      { address: 'y1@cmp.test', domain: 'cmp.test', userId: y!.id },
      { address: 'u3@cmp2.test', domain: 'cmp2.test', userId: u!.id },
      { address: 'o2@cmp2.test', domain: 'cmp2.test', userId: o!.id },
      { address: 'a3@cmp2.test', domain: 'cmp2.test', userId: ad!.id },
    ]).returning({ id: mailboxes.id, address: mailboxes.address });
    // 地址多（超过分流上限）的用户：domain/搜索/被审计时走原计划那条
    await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 55)
      INSERT INTO mailboxes (address, domain, user_id) SELECT 'm' || i || '@' || CASE WHEN i % 2 THEN 'cmp.test' ELSE 'cmp2.test' END,
        CASE WHEN i % 2 THEN 'cmp.test' ELSE 'cmp2.test' END, ? FROM n`).bind(many).run();
    const box = (address: string) => boxes.find((b) => b.address === address)!.id;
    await db.insert(mailboxShares).values([
      { mailboxId: box('o1@cmp.test'), userId: u!.id, grantedBy: o!.id },
      { mailboxId: box('x1@cmp.test'), userId: u!.id, grantedBy: x!.id },
      { mailboxId: box('o1@cmp.test'), userId: ad!.id, grantedBy: o!.id },
      { mailboxId: box('u1@cmp.test'), userId: ad!.id, grantedBy: u!.id },
      { mailboxId: box('o2@cmp2.test'), userId: u!.id, grantedBy: o!.id },
    ]);
    // 固定种子的伪随机，失败可复现
    let seed = 20261015;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const addresses = ['u1@cmp.test', 'u2@cmp.test', 'o1@cmp.test', 'x1@cmp.test', 'a1@cmp.test', 'a2@cmp.test', 'y1@cmp.test', 'n1@cmp.test',
      'u3@cmp2.test', 'o2@cmp2.test', 'a3@cmp2.test', 'n2@cmp2.test', 'm1@cmp.test', 'm2@cmp2.test', 'm3@cmp.test'];
    const subjects = ['s', 'Hello world', 'Re: hello', 'code 1234'];
    const rows = Array.from({ length: 120 }, () => {
      const outbound = rnd() < 0.3;
      const address = addresses[Math.floor(rnd() * addresses.length)]!;
      return {
        direction: outbound ? 'outbound' as const : 'inbound' as const, address,
        domain: address.split('@')[1]!, fromAddress: `f${Math.floor(rnd() * 20)}@example.net`,
        subject: subjects[Math.floor(rnd() * subjects.length)]!, preview: 'p',
        status: outbound ? 'sent' : 'received', isRead: outbound || rnd() < 0.5, deletedAt: rnd() < 0.15 ? new Date() : null,
        recipients: { to: [`to${Math.floor(rnd() * 20)}@example.net`], cc: [], bcc: [] },
      };
    });
    const inserted: number[] = [];
    for (const row of rows) {
      const [m] = await db.insert(messages).values(row).returning({ id: messages.id });
      inserted.push(m!.id);
    }
    // 附件（带 Content-ID 的 inline 内嵌图不算附件）与各自的星标
    const attached = new Set<number>();
    const starredBy = new Map<number, Set<number>>([[u!.id, new Set()], [o!.id, new Set()], [ad!.id, new Set()], [many, new Set()]]);
    for (const [index, id] of inserted.entries()) {
      const pick = rnd();
      if (pick < 0.15) {
        await db.insert(attachments).values({ messageId: id, r2Key: `att/${id}/a` });
        attached.add(id);
      } else if (pick < 0.25) {
        await db.insert(attachments).values({ messageId: id, r2Key: `att/${id}/logo`, disposition: 'inline', contentId: 'logo' });
      }
      const starrer = [u!.id, o!.id, ad!.id, many][index % 4]!;
      if (rnd() < 0.3) {
        await db.insert(stars).values({ userId: starrer, messageId: id });
        starredBy.get(starrer)!.add(id);
      }
    }

    const viewers: [string, Viewer][] = [
      ['user', { userId: u!.id, role: 'user' }], ['owner', { userId: o!.id, role: 'user' }],
      ['admin', { userId: ad!.id, role: 'admin' }], ['admin mine', { userId: ad!.id, role: 'admin', scope: 'mine' }],
      ['many', { userId: many, role: 'user' }], ['audit user', { userId: ad!.id, role: 'admin', scope: 'user', targetUserId: u!.id }],
      ['audit many', { userId: ad!.id, role: 'admin', scope: 'user', targetUserId: many }],
    ];
    const views: Partial<ListMessagesQuery>[] = [
      {}, { direction: 'inbound' }, { direction: 'outbound' }, { unread: true }, { unread: true, direction: 'inbound' },
      { address: 'u1@cmp.test' }, { address: 'o1@cmp.test' }, { address: 'x1@cmp.test' }, { address: 'y1@cmp.test' },
      { address: 'n1@cmp.test' }, { address: 'o1@cmp.test', direction: 'outbound' }, { afterId: inserted[45]! },
      { domain: 'cmp.test' }, { domain: 'cmp2.test' }, { domain: 'cmp2.test', direction: 'inbound' }, { domain: 'cmp.test', unread: true },
      { domain: 'other.test' }, { domain: 'cmp2.test', address: 'u3@cmp2.test' }, { domain: 'cmp.test', address: 'u3@cmp2.test' },
      { q: 'hello' }, { q: 'F1' }, { q: 'hello', unread: true }, { q: 'to1', direction: 'outbound' }, { domain: 'cmp2.test', q: 'f1' },
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
            const { ids, nextCursor } = await legacyPage(viewer, query, cursor ? Number(atob(cursor)) : null);
            expect({ ids: page.items.map((item) => item.id), nextCursor: page.nextCursor }, label).toEqual({ ids, nextCursor });
            const starredSet = starredBy.get(viewer.userId)!;
            expect(page.items.map((item) => [item.id, item.hasAttachments, item.isStarred]), label)
              .toEqual(ids.map((id) => [id, attached.has(id), starredSet.has(id)]));
            compared += ids.length;
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
    for (const [who, viewer] of viewers.slice(0, 4)) {
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
          expect(page.plan, name).toMatch(expected);
          expectNoFullScan(page.plan, name);
          if (filter.since !== undefined) {
            expect(page.plan, name).toMatch(view === '全部' ? /idx_messages_address_deleted_id \(address=\? AND deleted_at=\? AND id>\?\)/ : /rowid>\?/);
            expect(page.plan, name).toContain('SEARCH b USING COVERING INDEX idx_messages_created_id (created_at>?)');
          }
          if (filter.hasAttachments) expect(page.plan, name).toMatch(/SEARCH filter_att (EXISTS )?USING (COVERING )?INDEX idx_attachments_message \(message_id=\?\)/);
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

describe('执行计划回归：草稿派发与对象清理', () => {
  const plan = async (query: string, params: unknown[]) =>
    (await env.db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...params).all<{ detail: string }>()).results.map((row) => row.detail).join(' | ');

  it('每分钟的到期认领与租约到期查询只走草稿表的部分索引，不扫全表', async () => {
    const claim = await plan(DUE_DRAFTS_CLAIM_SQL, [1, 1, 1, 20]);
    expect(claim).toContain('idx_drafts_due (send_at<?)');
    expect(claim).not.toMatch(/SCAN drafts\b(?! USING)/);
    const stale = await plan(STALE_DRAFTS_SQL, [1, 20]);
    expect(stale).toContain('idx_drafts_sending (claimed_at<?)');
    // 草稿列表按 (user_id, id) 倒序翻页
    const list = await plan('SELECT id FROM drafts WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 31', [1, 100]);
    expect(list).toContain('idx_drafts_user (user_id=? AND id<?)');
  });

  it('对象清理判断草稿正文引用时走 idx_drafts_body_r2', async () => {
    const cleanup = await plan(CLEANUP_JOBS_SQL, [Date.now(), 100]);
    expect(cleanup).toMatch(/SEARCH drafts USING COVERING INDEX idx_drafts_body_r2 \(body_r2_key=\?\)/);
  });
});

describe('执行计划回归：系统域名接入', () => {
  const planOf = async (sql: string, ...params: unknown[]) =>
    (await env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>()).results.map((row) => row.detail).join(' | ');

  it('同名互斥按域名走部分唯一索引与托管唯一索引（表达式与索引的 WHERE 一致）', async () => {
    expect(await planOf(`SELECT ${onboardingActiveSql('?1')}`, 'x.test')).toMatch(/uniq_system_onboarding_active_domain \(domain=\?\)/);
    expect(await planOf(`SELECT ${anyOnboardingSql('?1')}`, '["x.test"]')).toMatch(/uniq_system_onboarding_active_domain \(domain=\?\)/);
    expect(await planOf(`SELECT ${hostedTakenSql('?1')}`, 'x.test')).toMatch(/hosted_domains_domain_unique \(domain=\?\)/);
    const facts = await capturePlans((e) => occupancyFacts(e, 'x.test', 1));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.plan).toMatch(/uniq_system_onboarding_active_domain \(domain=\?\)/);
    expect(facts[0]!.plan).toMatch(/hosted_domains_domain_unique \(domain=\?\)/);
  });

  it('定时任务按 (state, next_check_at) 索引取到期任务', async () => {
    const plans = await capturePlans((e) => syncDueOnboarding({ ...e, cf_api_token: 't', cf_account_id: 'a' }));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan).toMatch(/idx_system_onboarding_due \(state=\? AND next_check_at<\?\)/);
    expect(plans[0]!.plan).not.toMatch(/SCAN system_domain_onboarding\b/);
  });
});

describe('执行计划回归：托管域名巡检领取', () => {
  it('到期领取的子查询每个分支按 status 走 idx_hosted_domains_status，参照候选按 status 倒序取', async () => {
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
    // 没有到期域名也会发出领取语句；凭据只用来通过功能开关，不会调用 Cloudflare
    await syncDueHostedDomains({ ...env, db, cf_api_token: 'test-token', cf_account_id: 'acct-explain' } as typeof env);
    const plan = async (pattern: RegExp) => {
      const statement = statements.find((entry) => pattern.test(entry.sql))!;
      const rows = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
      return rows.results.map((row) => row.detail).join(' | ');
    };
    const claim = await plan(/^update "hosted_domains" set "sync_lease_until"/i);
    expect(claim).toContain('MULTI-INDEX OR');
    expect(claim.match(/SEARCH hosted_domains USING INDEX idx_hosted_domains_status \(status=\?\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(claim).not.toMatch(/SCAN hosted_domains(?! USING)/);
    const probes = await plan(/^select "zone_id" from "hosted_domains"/i);
    expect(probes).toContain('idx_hosted_domains_status (status=?)');
    expect(probes).not.toContain('TEMP B-TREE');
  });
});
