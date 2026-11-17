import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { HostedDomain, Mailbox, MailboxShareGrant, Page } from '@hpc-mail/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import type { Schema } from '../src/routes/openapi-common.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import { createDb } from '../src/db/client.js';
import { hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { encodeCursor } from '../src/lib/pagination.js';
import { createApiKey } from '../src/services/api-key.js';
import { listAllHostedDomains } from '../src/services/hosted-domain.js';
import { listMailboxes } from '../src/services/mailbox.js';
import { listMailboxShares } from '../src/services/mailbox-share.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { grantLegacyAdminScope } from './key-helpers.js';

const app = createApp();
const db = createDb(env);

interface Actor { id: number; username: string; jwt: string; key: string }

let admin: Actor;
let alice: Actor;
let bob: Actor;
/** 各表的全部 id，按倒序（与列表顺序一致） */
let boxIds: number[];
let hostedIds: number[];
/** 共享了 3 个人的邮箱：分页的 LIMIT 必须按邮箱而不是 JOIN 后的行计 */
let crowdedBoxId: number;

async function actor(username: string, role: 'admin' | 'user'): Promise<Actor> {
  const user = (await db.insert(users).values({ username, role, passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  const key = await createApiKey(env, user.id, { name: 'pagination', scopes: ['mailbox.read'], rateLimit: 1000, allowedIps: [] });
  // 管理员沿用存量 Key 的形态（迁移 0022 自动加上 admin scope），才有 all=1 的全站视图
  if (role === 'admin') await grantLegacyAdminScope(env, key.id);
  return { id: user.id, username, jwt, key: key.key };
}

beforeAll(async () => {
  await updateSettings(env, { security: { require2fa: false }, api: { enabled: true } });
  admin = await actor('pager-admin', 'admin');
  alice = await actor('pager-alice', 'user');
  bob = await actor('pager-bob', 'user');
  const extra = await Promise.all(['pager-g1', 'pager-g2', 'pager-g3'].map((name) => actor(name, 'user')));
  // 交错插入，id 顺序与所有者、域名无关；下划线地址用来验证 q 按字面匹配
  const rows = [
    { address: 'a1@one.test', domain: 'one.test', userId: alice.id },
    { address: 'b1@one.test', domain: 'one.test', userId: bob.id },
    { address: 'a_2@two.test', domain: 'two.test', userId: alice.id },
    { address: 'b2@two.test', domain: 'two.test', userId: bob.id },
    { address: 'a3@one.test', domain: 'one.test', userId: alice.id },
    { address: 'x9@two.test', domain: 'two.test', userId: admin.id },
    { address: 'b3@one.test', domain: 'one.test', userId: bob.id },
  ];
  const inserted = await db.insert(mailboxes).values(rows).returning({ id: mailboxes.id, address: mailboxes.address });
  boxIds = inserted.map((row) => row.id).sort((a, b) => b - a);
  crowdedBoxId = inserted.find((row) => row.address === 'b1@one.test')!.id;
  await db.insert(mailboxShares).values([
    ...extra.map((grantee) => ({ mailboxId: crowdedBoxId, userId: grantee.id, grantedBy: bob.id })),
    { mailboxId: inserted.find((row) => row.address === 'a3@one.test')!.id, userId: bob.id, grantedBy: alice.id },
  ]);
  await db.insert(messages).values([1, 2, 3].map((n) => ({
    address: 'a1@one.test', domain: 'one.test', direction: 'inbound' as const, fromAddress: 'f@example.net', subject: `s${n}`, status: 'received' as const,
  })));
  // 较早的邮箱有大量邮件：只有为全部行计算 messageCount 时才会读到它们
  await env.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
    INSERT INTO messages (direction, address, domain, from_address, subject, status)
    SELECT 'inbound', 'b1@one.test', 'one.test', 'f@example.net', 's', 'received' FROM n`).run();
  const hosted = await db.insert(hostedDomains).values([
    { domain: 'h1.test', userId: alice.id, status: 'active' },
    { domain: 'h2.test', userId: bob.id, status: 'pending' },
    { domain: 'h3.test', userId: alice.id, status: 'pending' },
    { domain: 'h4.test', userId: bob.id, status: 'active' },
    { domain: 'h5.test', userId: alice.id, status: 'suspended' },
  ]).returning({ id: hostedDomains.id });
  hostedIds = hosted.map((row) => row.id).sort((a, b) => b - a);
});

async function call(path: string, token: string) {
  const ctx = createExecutionContext();
  const response = await app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function data<T>(path: string, token: string): Promise<T> {
  const response = await call(path, token);
  const body = await response.json() as { data: T };
  expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(200);
  return body.data;
}

/** 从首页开始按 nextCursor 翻到底，返回每页条目 */
async function walk<T>(path: string, token: string): Promise<T[][]> {
  const pages: T[][] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page: Page<T> = await data<Page<T>>(`${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`, token);
    expect(page).toEqual({ items: expect.any(Array), nextCursor: page.nextCursor });
    pages.push(page.items);
    cursor = page.nextCursor;
    expect(pages.length).toBeLessThan(50);
  } while (cursor);
  return pages;
}

const ids = <T extends { id: number }>(items: T[]) => items.map((item) => item.id);

describe('GET /api/mailboxes 与 /v1/mailboxes 的可选分页', () => {
  it('不带 cursor 与 limit 时返回与旧版相同的完整数组', async () => {
    const all = await data<Mailbox[]>('/api/mailboxes?all=1', admin.jwt);
    expect(Array.isArray(all)).toBe(true);
    expect(ids(all)).toEqual(boxIds);
    const a1 = all.find((box) => box.address === 'a1@one.test')!;
    expect(Object.keys(a1).sort()).toEqual(['address', 'canSend', 'createdAt', 'displayName', 'domain', 'id', 'messageCount', 'ownerUsername', 'userId']);
    expect(a1).toMatchObject({ ownerUsername: alice.username, messageCount: 3, canSend: true });

    const mine = await data<Mailbox[]>('/api/mailboxes', alice.jwt);
    expect(mine.map((box) => box.address)).toEqual(['a3@one.test', 'a_2@two.test', 'a1@one.test']);
    expect(mine[0]).not.toHaveProperty('ownerUsername');
    // 分页参数之外的未知参数不影响旧调用
    expect(await data<Mailbox[]>('/api/mailboxes?all=1&foo=bar', admin.jwt)).toEqual(all);
  });

  it('分页翻到底不重不漏，顺序与数组模式一致；/v1 与 /api 返回相同', async () => {
    const all = await data<Mailbox[]>('/api/mailboxes?all=1', admin.jwt);
    for (const limit of [1, 2, 3, 7, 200]) {
      const pages = await walk<Mailbox>(`/api/mailboxes?all=1&limit=${limit}`, admin.jwt);
      expect(pages.flat()).toEqual(all);
      expect(pages.every((page) => page.length <= limit)).toBe(true);
      expect(pages.length).toBe(Math.max(1, Math.ceil(all.length / limit)));
      expect(await walk<Mailbox>(`/v1/mailboxes?all=1&limit=${limit}`, admin.key)).toEqual(pages);
    }
    expect(await data<Mailbox[]>('/v1/mailboxes?all=1', admin.key)).toEqual(all);
    // 本人列表同样支持；只给 cursor 时默认 50 条
    const mine = await data<Page<Mailbox>>('/api/mailboxes?cursor=', alice.jwt);
    expect(mine).toEqual({ items: await data<Mailbox[]>('/api/mailboxes', alice.jwt), nextCursor: null });
    expect(await data<Page<Mailbox>>('/v1/mailboxes?cursor=&limit=', alice.key)).toEqual(mine);
  });

  it('q 按地址或所有者用户名子串字面匹配，domain 精确匹配，可组合，两种模式一致', async () => {
    const cases: [string, string[]][] = [
      ['q=A_', ['a_2@two.test']],
      ['q=_', ['a_2@two.test']],
      ['q=PAGER-BOB', ['b3@one.test', 'b2@two.test', 'b1@one.test']],
      ['domain=two.test', ['x9@two.test', 'b2@two.test', 'a_2@two.test']],
      ['q=pager-alice&domain=one.test', ['a3@one.test', 'a1@one.test']],
      ['q=b&domain=two.test', ['b2@two.test']],
      ['q=%25', []],
    ];
    for (const [filter, expected] of cases) {
      expect((await data<Mailbox[]>(`/api/mailboxes?all=1&${filter}`, admin.jwt)).map((box) => box.address), filter).toEqual(expected);
      const pages = await walk<Mailbox>(`/v1/mailboxes?all=1&${filter}&limit=1`, admin.key);
      expect(pages.flat().map((box) => box.address), filter).toEqual(expected);
    }
    expect((await data<Mailbox[]>('/api/mailboxes?q=a3', alice.jwt)).map((box) => box.address)).toEqual(['a3@one.test']);
    expect(await data<Mailbox[]>('/api/mailboxes?q=b3', alice.jwt)).toEqual([]);
  });

  it('无效 cursor 或 limit 返回 400；非管理员 all=1 仍是 403', async () => {
    for (const query of ['cursor=bad', `cursor=${btoa('0')}`, 'limit=0', 'limit=201', 'limit=1.5', 'domain=bad']) {
      for (const [prefix, token] of [['/api', admin.jwt], ['/v1', admin.key]] as const) {
        const response = await call(`${prefix}/mailboxes?all=1&${query}`, token);
        expect(response.status, `${prefix} ${query}`).toBe(400);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
      }
    }
    for (const [prefix, token] of [['/api', alice.jwt], ['/v1', alice.key]] as const) {
      for (const query of ['', '&limit=10', `&cursor=${encodeCursor(boxIds[0]!)}`]) {
        expect((await call(`${prefix}/mailboxes?all=1${query}`, token)).status, `${prefix} ${query}`).toBe(403);
      }
    }
  });
});

describe('GET /api/admin/mailbox-shares 的可选分页', () => {
  it('不带分页参数时返回旧版数组（按地址排序）', async () => {
    const legacy = await data<MailboxShareGrant[]>('/api/admin/mailbox-shares', admin.jwt);
    expect(legacy).toEqual(await listMailboxShares(env, admin.id, true));
    expect(legacy.map((grant) => grant.address)).toEqual([...legacy.map((grant) => grant.address)].sort());
    expect(legacy).toHaveLength(boxIds.length);
  });

  it('按邮箱分页：LIMIT 作用在邮箱上，每项是完整的共享名单，翻到底不重不漏', async () => {
    const legacy = await data<MailboxShareGrant[]>('/api/admin/mailbox-shares', admin.jwt);
    const byId = new Map(legacy.map((grant) => [grant.mailboxId, grant]));
    for (const limit of [1, 2, 5]) {
      const pages = await walk<MailboxShareGrant>(`/api/admin/mailbox-shares?limit=${limit}`, admin.jwt);
      expect(pages.flat().map((grant) => grant.mailboxId)).toEqual(boxIds);
      expect(pages.every((page) => page.length <= limit)).toBe(true);
      for (const grant of pages.flat()) expect(grant).toEqual(byId.get(grant.mailboxId));
    }
    const crowded = byId.get(crowdedBoxId)!;
    expect(crowded.grantees.map((grantee) => grantee.username)).toEqual(['pager-g1', 'pager-g2', 'pager-g3']);
    // 3 个被分享人的邮箱单独成一页，仍带下一页游标
    const at = boxIds.indexOf(crowdedBoxId);
    const page = await data<Page<MailboxShareGrant>>(`/api/admin/mailbox-shares?limit=1&cursor=${encodeCursor(boxIds[at - 1]!)}`, admin.jwt);
    expect(page.items).toEqual([crowded]);
    expect(page.nextCursor).toBe(encodeCursor(crowdedBoxId));
  });

  it('q 过滤两种模式一致；mailboxId 保持 0/1 项数组；无效参数 400；普通用户 403', async () => {
    const legacy = await data<MailboxShareGrant[]>('/api/admin/mailbox-shares?q=pager-bob', admin.jwt);
    expect(legacy.map((grant) => grant.address)).toEqual(['b1@one.test', 'b2@two.test', 'b3@one.test']);
    const pages = await walk<MailboxShareGrant>('/api/admin/mailbox-shares?q=pager-bob&limit=2', admin.jwt);
    expect(pages.flat().map((grant) => grant.address)).toEqual(['b3@one.test', 'b2@two.test', 'b1@one.test']);
    expect((await data<MailboxShareGrant[]>('/api/admin/mailbox-shares?q=_', admin.jwt)).map((grant) => grant.address)).toEqual(['a_2@two.test']);

    const one = await data<MailboxShareGrant[]>(`/api/admin/mailbox-shares?mailboxId=${crowdedBoxId}&limit=5`, admin.jwt);
    expect(one).toHaveLength(1);
    expect(one[0]!.grantees).toHaveLength(3);
    expect(await data<MailboxShareGrant[]>('/api/admin/mailbox-shares?mailboxId=999999', admin.jwt)).toEqual([]);
    for (const query of ['mailboxId=0', 'mailboxId=', 'cursor=bad', 'limit=201']) {
      expect((await call(`/api/admin/mailbox-shares?${query}`, admin.jwt)).status, query).toBe(400);
    }
    expect((await call('/api/admin/mailbox-shares?limit=10', alice.jwt)).status).toBe(403);
  });
});

describe('GET /api/admin/hosted-domains 的可选分页', () => {
  it('数组模式不变；分页按 id 倒序翻到底不重不漏，status 与 q 两种模式一致', async () => {
    const legacy = await data<HostedDomain[]>('/api/admin/hosted-domains', admin.jwt);
    expect(ids(legacy)).toEqual(hostedIds);
    for (const limit of [1, 2, 5]) {
      expect((await walk<HostedDomain>(`/api/admin/hosted-domains?limit=${limit}`, admin.jwt)).flat()).toEqual(legacy);
    }
    for (const [filter, expected] of [
      ['status=pending', ['h3.test', 'h2.test']],
      ['q=PAGER-ALICE', ['h5.test', 'h3.test', 'h1.test']],
      ['status=pending&q=pager-alice', ['h3.test']],
      ['q=h4', ['h4.test']],
    ] as const) {
      expect((await data<HostedDomain[]>(`/api/admin/hosted-domains?${filter}`, admin.jwt)).map((item) => item.domain), filter).toEqual(expected);
      expect((await walk<HostedDomain>(`/api/admin/hosted-domains?${filter}&limit=1`, admin.jwt)).flat().map((item) => item.domain), filter)
        .toEqual(expected);
    }
    expect((await call('/api/admin/hosted-domains?cursor=bad', admin.jwt)).status).toBe(400);
    expect((await call('/api/admin/hosted-domains?limit=10', alice.jwt)).status).toBe(403);
  });

  it('服务层：没有分页请求时仍是 1000 条上限的数组', async () => {
    const viewer = { id: admin.id, username: admin.username, role: 'admin' as const };
    expect(ids(await listAllHostedDomains(env, viewer, {}) as HostedDomain[])).toEqual(hostedIds);
    expect(await listMailboxes(env, { all: true })).toEqual(await data<Mailbox[]>('/api/mailboxes?all=1', admin.jwt));
  });
});

/**
 * 截获服务层经 env.db 发出的 SELECT 及其绑定参数，逐条取 EXPLAIN QUERY PLAN，并重放一次取 D1 的 rows_read。
 * D1 没有 STAT4，小数据上的计划就是线上计划（同 explain-regression.test.ts）。
 */
async function capturePlans(run: (e: typeof env) => Promise<unknown>): Promise<{ sql: string; plan: string; rowsRead: number }[]> {
  const statements: { sql: string; params: unknown[] }[] = [];
  const traced = new Proxy(env.db, {
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
  await run({ ...env, db: traced } as typeof env);
  const out: { sql: string; plan: string; rowsRead: number }[] = [];
  for (const statement of statements) {
    if (!/^select\b/i.test(statement.sql.trim()) || !/from "(mailboxes|hosted_domains)"/.test(statement.sql)) continue;
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.params).all<{ detail: string }>();
    const replay = await env.db.prepare(statement.sql).bind(...statement.params).all();
    out.push({ sql: statement.sql, plan: plan.results.map((row) => row.detail).join(' | '), rowsRead: replay.meta.rows_read });
  }
  return out;
}

describe('执行计划回归：分页查询按主键倒序取够即停', () => {
  it('邮箱分页沿主键或带 rowid 的索引倒序读取，没有排序步骤，messageCount 只为本页行计算', async () => {
    const cursor = boxIds[1]!;
    for (const [label, opts] of [
      ['全站', { all: true }],
      ['全站 + domain', { all: true, domain: 'one.test' }],
      ['全站 + q', { all: true, q: 'pager-bob' }],
      ['本人', { userId: bob.id }],
    ] as const) {
      for (const cursorId of [null, cursor]) {
        const [list] = await capturePlans((e) => listMailboxes(e, opts, { cursorId, limit: 1 }));
        expect(list!.plan, label).not.toContain('TEMP B-TREE');
        expect(list!.plan, label).toMatch(/^(SCAN mailboxes|SEARCH mailboxes USING (INTEGER PRIMARY KEY \(rowid<\?\)|INDEX idx_mailboxes_\w+ \(\w+=\?( AND rowid<\?)?\)))/);
        expect(list!.plan, label).toMatch(/CORRELATED SCALAR SUBQUERY \d+ \| SEARCH messages USING COVERING INDEX \w+ \(address=\?\)/);
        expect(list!.sql, label).toMatch(/limit \?$/);
      }
    }
    // 全站首页 3 行都没有大量邮件；数组模式要为 b1 数完 300 封
    const [paged] = await capturePlans((e) => listMailboxes(e, { all: true }, { cursorId: null, limit: 2 }));
    const [legacy] = await capturePlans((e) => listMailboxes(e, { all: true }));
    expect(paged!.rowsRead).toBeLessThan(30);
    expect(legacy!.rowsRead).toBeGreaterThan(300);
    expect(legacy!.sql).not.toMatch(/limit/i);
  });

  it('共享分页先在 mailboxes 上限定一页 id 再 JOIN 被分享人，只在同一邮箱内按用户名排序', async () => {
    const at = boxIds.indexOf(crowdedBoxId);
    for (const [label, opts, cursorId] of [
      ['首页', {}, null],
      ['游标', {}, boxIds[at - 1]!],
      ['q', { q: 'pager-bob' }, null],
    ] as const) {
      const [list] = await capturePlans((e) => listMailboxShares(e, admin.id, true, opts, { cursorId, limit: 1 }));
      expect(list!.sql, label).toMatch(/"mailboxes"\."id" in \(select "id" from "mailboxes" (where .* )?order by "mailboxes"\."id" desc limit \?\) order by "mailboxes"\."id" desc/);
      expect(list!.plan, label).toMatch(/^SEARCH mailboxes USING INTEGER PRIMARY KEY \(rowid=\?\) \| LIST SUBQUERY \d+ \| (SCAN mailboxes|SEARCH mailboxes USING INTEGER PRIMARY KEY \(rowid<\?\))/);
      expect(list!.plan, label).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    }
    // 3 个被分享人的邮箱单独一页：外层只读这一只邮箱及其共享
    const [crowded] = await capturePlans((e) => listMailboxShares(e, admin.id, true, {}, { cursorId: boxIds[at - 1]!, limit: 1 }));
    expect(crowded!.rowsRead).toBeLessThan(20);
  });

  it('托管域名分页（含 status 筛选）沿主键倒序读取，没有排序步骤', async () => {
    const viewer = { id: admin.id, username: admin.username, role: 'admin' as const };
    for (const status of [undefined, 'pending'] as const) {
      for (const cursorId of [null, hostedIds[1]!]) {
        const [list] = await capturePlans((e) => listAllHostedDomains(e, viewer, { status }, { cursorId, limit: 1 }));
        expect(list!.plan, `${status} ${cursorId}`).toMatch(/^(SCAN hosted_domains|SEARCH hosted_domains USING INTEGER PRIMARY KEY \(rowid<\?\))/);
        expect(list!.plan, `${status} ${cursorId}`).not.toContain('TEMP B-TREE');
      }
    }
  });
});

describe('OpenAPI 写明可选分页', () => {
  const api = buildSessionOpenApiSpec('https://mail.example');
  const v1 = buildOpenApiSpec('https://mail.example');
  const operations = [
    ['/api/mailboxes', api.paths['/mailboxes']!.get!],
    ['/v1/mailboxes', v1.paths['/mailboxes']!.get!],
    ['/api/admin/mailbox-shares', api.paths['/admin/mailbox-shares']!.get!],
    ['/api/admin/hosted-domains', api.paths['/admin/hosted-domains']!.get!],
  ] as const;

  it('四个列表都声明 cursor/limit 参数，响应为数组或 Page 二选一并写明触发条件', () => {
    for (const [label, operation] of operations) {
      const params = operation.parameters as { name: string; description: string; schema: Schema }[];
      const limit = params.find((param) => param.name === 'limit')!;
      expect(limit.schema, label).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
      expect(params.find((param) => param.name === 'cursor')!.description, label).toMatch(/Presence of cursor or limit[\s\S]*400 validation_failed/);
      const responses = operation.responses as Record<string, { content: Record<string, { schema: { properties: { data: Schema } } }> }>;
      const variants = responses['200']!.content['application/json']!.schema.properties.data.oneOf as Schema[];
      expect(variants.map((variant) => variant.type), label).toEqual(['array', 'object']);
      expect((variants[1]!.required as string[]), label).toEqual(['items', 'nextCursor']);
      expect(variants.map((variant) => variant.title).join(' | '), label).toMatch(/neither cursor nor limit[\s\S]*cursor or limit present/);
    }
    for (const [label, operation] of operations.slice(0, 2)) {
      expect((operation.parameters as { name: string }[]).map((param) => param.name), label).toEqual(['all', 'q', 'domain', 'cursor', 'limit']);
    }
    expect(api.paths['/admin/hosted-domains']!.get!.description).toContain('capped at 1000');
    expect(api.paths['/admin/mailbox-shares']!.get!.description).toContain('limit counts mailboxes');
  });
});
