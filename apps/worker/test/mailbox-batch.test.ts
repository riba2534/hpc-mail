import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS, MAX_BATCH_CLAIM, type BatchClaimMailboxResult, type ClaimMailboxRequest, type Mailbox, type MailboxAvailability, type UserMailboxPolicy,
} from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { claudeAddressFacts, hostedDomainMembers, hostedDomains, mailboxes, messages, users } from '../src/db/schema.js';
import { createApiKey } from '../src/services/api-key.js';
import { planRandomDomains } from '../src/services/claim-plan.js';
import type { AppError } from '../src/lib/errors.js';
import { signToken } from '../src/lib/jwt.js';
import { checkAvailability, checkAvailabilityBatch, claimMailbox, claimMailboxes } from '../src/services/mailbox.js';
import { loadMailboxPolicyUser, mailboxPolicyUserFromResult, mailboxPolicyUserStatement } from '../src/services/mailbox-policy.js';
import { createSession } from '../src/services/session.js';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';
import { updateUser } from '../src/services/user.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);
const openDomain = 'batch.test';
const limitedDomain = 'limited.batch.test';
const privateDomain = 'private.batch.test';
let sequence = 0;

async function fixture(perUserLimit = 0) {
  const prefix = `batch-${++sequence}`;
  await updateSettings(env, {
    domains: { list: [
      { domain: openDomain, public: true, perUserLimit: 0 },
      { domain: limitedDomain, public: true, perUserLimit: 1 },
      { domain: privateDomain, public: false, perUserLimit: 0 },
    ] },
    mailbox_policy: { perUserLimit, reservedLocalParts: ['admin', 'support'] },
    security: { require2fa: false }, api: { enabled: true },
  });
  async function actor(name: string, role: 'admin' | 'user' = 'user') {
    const user = (await db.insert(users).values({ username: `${prefix}-${name}`, role, passwordHash: 'test', authVersionMigrated: true }).returning().get())!;
    const sid = await createSession(env, user.id);
    return { ...user, jwt: await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 }) };
  }
  const admin = await actor('admin', 'admin');
  const user = await actor('user');
  const other = await actor('other');
  const item = (name: string, domain = openDomain): ClaimMailboxRequest => ({ localPart: `${prefix}-${name}`, domain });
  const own = async (ownerId: number, req: ClaimMailboxRequest) =>
    (await db.insert(mailboxes).values({ userId: ownerId, domain: req.domain, address: `${req.localPart}@${req.domain}` }).returning().get())!;
  return { prefix, admin, user, other, item, own };
}

async function request(path: string, token: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(`/api${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const ownedBy = async (userId: number) => (await db.select().from(mailboxes).where(eq(mailboxes.userId, userId))).map((row) => row.address).sort();

/** 统计 D1 往返：每次 batch 与每条单独执行的语句各算一次 */
function counting(hook?: (sql: string) => Promise<void>, onBatch?: (sqls: string[]) => Promise<void>): { env: Env; trips: () => number; queries: () => number } {
  let trips = 0;
  let queries = 0;
  const sqlOf = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => {
          expect(args.length).toBeLessThanOrEqual(100);
          return wrap(target.bind(...args), sql);
        };
        const method = Reflect.get(target, property);
        if (typeof method !== 'function') return method;
        return async (...args: unknown[]) => {
          if (['first', 'all', 'run', 'raw'].includes(String(property))) { trips++; queries++; await hook?.(sql); }
          return method.apply(target, args);
        };
      },
    });
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const wrapped = { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      trips++;
      queries += statements.length;
      await onBatch?.(statements.map((statement) => sqlOf.get(statement) ?? ''));
      return target.batch(statements);
    };
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) } as Env;
  return { env: wrapped, trips: () => trips, queries: () => queries };
}

const INTERRUPTED = { code: 'internal', message: '认领中断，部分地址可能已认领，请以邮箱列表为准' };

describe('批量认领', () => {
  it('按顺序逐个认领：被占用（含本批重复）的跳过并继续，认领结果与单个认领同形', async () => {
    const f = await fixture();
    const taken = f.item('taken');
    await f.own(f.other.id, taken);
    const history = f.item('history');
    for (const subject of ['old 1', 'old 2']) {
      await db.insert(messages).values({ address: `${history.localPart}@${history.domain}`, domain: openDomain, direction: 'inbound', status: 'received', subject });
    }
    const first = f.item('first');
    const result = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items: [first, taken, history, first] }));
    expect(result.claimed.map((box) => box.address)).toEqual([`${first.localPart}@${openDomain}`, `${history.localPart}@${openDomain}`]);
    expect(result.claimed.map((box) => box.messageCount)).toEqual([0, 2]);
    expect(result).toMatchObject({ taken: [taken, first], notAttempted: [], stoppedBy: null });
    // 与 GET /mailboxes（单个认领后读回的同一形状）逐字段一致；canSend 只由列表接口返回
    const listed = await data<Mailbox[]>(await request('/mailboxes', f.user.jwt));
    for (const box of result.claimed) {
      const { canSend, ...entry } = listed.find((item) => item.id === box.id)!;
      expect(canSend).toBe(true);
      expect(box).toEqual(entry);
    }
    const single = await data<Mailbox>(await request('/mailboxes', f.user.jwt, 'POST', f.item('single')), 201);
    expect(Object.keys(result.claimed[0]!).sort()).toEqual(Object.keys(single).sort());
  });

  it('配额中途用尽立即停止：已认领的保留，触发项及其后各项进入 notAttempted', async () => {
    const f = await fixture(2);
    const takenLater = f.item('taken-later');
    await f.own(f.admin.id, takenLater);
    const items = [f.item('a'), f.item('b'), f.item('over'), takenLater];
    const result = await claimMailboxes(env, f.user.id, 'user', items);
    expect(result.claimed.map((box) => box.address)).toEqual([`${f.prefix}-a@${openDomain}`, `${f.prefix}-b@${openDomain}`]);
    expect(result).toMatchObject({ taken: [], notAttempted: items.slice(2), stoppedBy: { code: 'forbidden', message: '认领地址数已达上限（2）' } });
    expect(await ownedBy(f.user.id)).toEqual([`${f.prefix}-a@${openDomain}`, `${f.prefix}-b@${openDomain}`]);
    // 按域上限同样按本批已认领数累计
    const domainItems = [f.item('l1', limitedDomain), f.item('l2', limitedDomain)];
    const limited = await claimMailboxes(env, f.other.id, 'user', domainItems);
    expect(limited).toMatchObject({ notAttempted: [domainItems[1]], stoppedBy: { code: 'forbidden', message: '在该域名下最多认领 1 个地址' } });
    expect(limited.claimed).toHaveLength(1);
  });

  it('专属权限按域额度在批内累计；空白名单与系统域名外的地址停止并给出原因', async () => {
    const f = await fixture();
    const policy: UserMailboxPolicy = { perUserLimit: 0, domains: [{ domain: privateDomain, perUserLimit: 2 }] };
    await updateUser(env, f.admin.id, f.user.id, { mailboxPolicy: policy, expectedMailboxPolicyRevision: 0 });
    const items = [f.item('p1', privateDomain), f.item('p2', privateDomain), f.item('p3', privateDomain)];
    const result = await claimMailboxes(env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(2);
    expect(result).toMatchObject({ notAttempted: [items[2]], stoppedBy: { code: 'forbidden', message: '在该域名下最多认领 2 个地址' } });
    const outside = await claimMailboxes(env, f.other.id, 'user', [f.item('x', privateDomain)]);
    expect(outside.stoppedBy).toEqual({ code: 'forbidden', message: '当前用户无权认领该域名' });
    const unknown = await claimMailboxes(env, f.other.id, 'user', [f.item('ok'), f.item('x', 'unknown.batch.test')]);
    expect(unknown.claimed).toHaveLength(1);
    expect(unknown.stoppedBy).toEqual({ code: 'validation_failed', message: '域名不在系统域名列表内' });
  });

  it('普通用户受保留前缀与额度限制，管理员豁免并可认领私有域', async () => {
    const f = await fixture(1);
    const reserved = { localPart: 'support', domain: privateDomain };
    const items = [{ localPart: 'admin', domain: openDomain }, reserved, f.item('a'), f.item('b')];
    const blocked = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items }));
    expect(blocked).toMatchObject({ claimed: [], taken: [], notAttempted: items, stoppedBy: { code: 'forbidden', message: '前缀 admin 为系统保留，无法认领' } });
    const admin = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.admin.jwt, 'POST', { items }));
    // 'admin@batch.test' 与 'support@private.batch.test' 在共享存储里可能已被别的用例认领，计入 taken 也合法
    expect([...admin.claimed.map((box) => box.address), ...admin.taken.map((req) => `${req.localPart}@${req.domain}`)].sort())
      .toEqual(items.map((req) => `${req.localPart}@${req.domain}`).sort());
    expect(admin).toMatchObject({ notAttempted: [], stoppedBy: null });
  });

  it('写入前域名配置改变：停止为 conflict，之前认领的保留', async () => {
    const f = await fixture();
    let inserts = 0;
    const racing = counting(undefined, async (sqls) => {
      if (sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql)) && ++inserts === 2) {
        await updateSettings(env, { domains: { list: [{ domain: openDomain, public: true, perUserLimit: 0 }] } });
      }
    });
    const items = Array.from({ length: 102 }, (_, index) => f.item(`race${index}`));
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result.claimed.map((box) => box.address)).toEqual(items.slice(0, 100).map((item) => `${item.localPart}@${item.domain}`));
    expect(result).toMatchObject({ taken: [], notAttempted: items.slice(100), stoppedBy: { code: 'conflict', message: '域名配置已改变，请刷新后重试' } });
    expect(await ownedBy(f.user.id)).toHaveLength(100);
  });

  it('并发批量认领不能突破全局额度', async () => {
    const f = await fixture(2);
    const attempts = await Promise.all([0, 1].map((n) => claimMailboxes(env, f.user.id, 'user', [f.item(`${n}-a`), f.item(`${n}-b`)])));
    expect(attempts.reduce((sum, result) => sum + result.claimed.length, 0)).toBe(2);
    expect(await ownedBy(f.user.id)).toHaveLength(2);
    for (const result of attempts.filter((entry) => entry.stoppedBy)) expect(result.stoppedBy!.code).toBe('forbidden');
  });

  it('999 个地址经真实接口检查与认领，读回完整有序结果', async () => {
    const f = await fixture();
    const items = Array.from({ length: 999 }, (_, index) => f.item(`api${index}`));
    const checks = await data<MailboxAvailability[]>(await request('/mailboxes/availability/batch', f.user.jwt, 'POST', { items }));
    expect(checks).toHaveLength(999);
    expect(checks.every((entry) => entry.available)).toBe(true);
    const result = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items }));
    expect(result.claimed.map((box) => box.address)).toEqual(items.map((item) => `${item.localPart}@${item.domain}`));
    expect(result).toMatchObject({ taken: [], notAttempted: [], stoppedBy: null });
    expect(await ownedBy(f.user.id)).toHaveLength(999);
  });

  it('999 个多域地址的实时配额只聚合一次，并使用索引而非逐项扫描邮箱表', async () => {
    const f = await fixture(1000);
    await updateSettings(env, { domains: { list: [
      { domain: openDomain, public: true, perUserLimit: 500 },
      { domain: limitedDomain, public: true, perUserLimit: 499 },
    ] } });
    const items = Array.from({ length: 999 }, (_, index) => f.item(`quota${index}`, index % 2 === 0 ? openDomain : limitedDomain));
    let explained = false;
    const probe = counting(undefined, async (sqls) => {
      if (!explained && sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql))) {
        explained = true;
        const bindings = [JSON.stringify([{ address: 'explain@batch.test', domain: openDomain, perUserLimit: 1000, perDomainLimit: 500,
          ownedDomain: 0, wasTaken: 0, code: null, message: null }]), f.user.id, 0, 0, 'user', 0, 'user'];
        for (const statement of sqls) {
          const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${statement}`).bind(...bindings).all<{ detail: string }>();
          const details = plan.results.map((row) => row.detail);
          expect(details.filter((detail) => detail === 'MATERIALIZE live_owned')).toHaveLength(1);
          // 0025 起 (user_id, domain) 复合索引同样能按 user_id 前缀取数，规划器可能选它
          expect(details.filter((detail) => /SEARCH mailboxes USING (?:COVERING )?INDEX idx_mailboxes_user(?:_domain)? \(user_id=\?\)/.test(detail))).toHaveLength(1);
          expect(details.some((detail) => /SCAN mailboxes\b/.test(detail))).toBe(false);
        }
      }
    });
    const result = await claimMailboxes(probe.env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(999);
    expect(result).toMatchObject({ taken: [], notAttempted: [], stoppedBy: null });
    expect(explained).toBe(true);
    expect(probe.queries()).toBe(25);
  });

  it('重复地址不重复计额度，但达到额度时先判额度再判占用', async () => {
    const f = await fixture(2);
    const first = f.item('first');
    const items = [first, first, f.item('second'), first, f.item('last')];
    const result = await claimMailboxes(env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(2);
    expect(result.taken).toEqual([first]);
    expect(result.notAttempted).toEqual(items.slice(3));
    expect(result.stoppedBy).toEqual({ code: 'forbidden', message: '认领地址数已达上限（2）' });
  });

  it('并发耗尽某域额度后停止，不认领后面的其他域；已占用的地址仍跳过', async () => {
    const f = await fixture();
    const occupied = f.item('occupied');
    await f.own(f.other.id, occupied);
    let raced = false;
    const racing = counting(undefined, async (sqls) => {
      if (!raced && sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql))) {
        raced = true;
        await f.own(f.user.id, f.item('other-claim', limitedDomain));
      }
    });
    const items = [occupied, f.item('free'), f.item('over', limitedDomain), f.item('after')];
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result.taken).toEqual([occupied]);
    expect(result.claimed.map((box) => box.address)).toEqual([`${f.prefix}-free@${openDomain}`]);
    expect(result.notAttempted).toEqual(items.slice(2));
    expect(result.stoppedBy).toEqual({ code: 'forbidden', message: '认领配额已在并发请求中用尽，请刷新后重试' });
    expect(await ownedBy(f.user.id)).toHaveLength(2);
  });

  it.each(['quota', 'domains', 'policy'] as const)('新地址并发被占用同时 %s 守卫失效：先停止，不能记为 taken 后继续', async (change) => {
    const f = await fixture();
    const first = f.item('raced-first', change === 'quota' ? limitedDomain : openDomain);
    const items = [first, f.item('must-not-claim')];
    let raced = false;
    const racing = counting(undefined, async (sqls) => {
      if (!raced && sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql))) {
        raced = true;
        await f.own(f.user.id, first);
        if (change === 'domains') await updateSettings(env, { domains: { list: [{ domain: openDomain, public: true, perUserLimit: 0 }] } });
        if (change === 'policy') await db.update(users).set({ mailboxPolicyRevision: 1 }).where(eq(users.id, f.user.id));
      }
    });
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result).toMatchObject({ claimed: [], taken: [], notAttempted: items, stoppedBy: { code: change === 'quota' ? 'forbidden' : 'conflict' } });
    expect(await ownedBy(f.user.id)).toEqual([`${first.localPart}@${first.domain}`]);
  });

  it('并发新增占用地址的重复项仍复核实时额度，阻止后面的其他域写入', async () => {
    const f = await fixture();
    await updateSettings(env, { domains: { list: [
      { domain: openDomain, public: true, perUserLimit: 0 },
      { domain: limitedDomain, public: true, perUserLimit: 2 },
    ] } });
    const first = f.item('repeated-race', limitedDomain);
    const second = f.item('fills-quota', limitedDomain);
    const items = [first, second, first, f.item('must-not-claim')];
    let raced = false;
    const racing = counting(undefined, async (sqls) => {
      if (!raced && sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql))) {
        raced = true;
        await f.own(f.user.id, first);
      }
    });
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result.claimed.map((box) => box.address)).toEqual([`${second.localPart}@${second.domain}`]);
    expect(result.taken).toEqual([first]);
    expect(result.notAttempted).toEqual(items.slice(2));
    expect(result.stoppedBy).toEqual({ code: 'forbidden', message: '认领配额已在并发请求中用尽，请刷新后重试' });
    expect(await ownedBy(f.user.id)).toEqual([first, second].map((item) => `${item.localPart}@${item.domain}`).sort());
  });

  it.each(['disabled', 'role', 'policy'] as const)('事务前用户 %s 变化，拒绝整个未执行块', async (change) => {
    const f = await fixture();
    let raced = false;
    const racing = counting(undefined, async (sqls) => {
      if (!raced && sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql))) {
        raced = true;
        await db.update(users).set(change === 'disabled' ? { status: 'disabled' } : change === 'role' ? { role: 'admin' } : { mailboxPolicyRevision: 1 }).where(eq(users.id, f.user.id));
      }
    });
    const items = [f.item('first'), f.item('second')];
    const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
    expect(result).toMatchObject({ claimed: [], taken: [], notAttempted: items, stoppedBy: { code: change === 'disabled' ? 'user_disabled' : 'conflict' } });
    expect(await ownedBy(f.user.id)).toEqual([]);
  });

  it('非法请求体返回 400', async () => {
    const f = await fixture();
    const tooMany = Array.from({ length: MAX_BATCH_CLAIM + 1 }, (_, index) => f.item(`n${index}`));
    for (const path of ['/mailboxes/batch', '/mailboxes/availability/batch']) {
      for (const body of [{ items: [] }, { items: tooMany }, { items: [{ localPart: 'Bad Name', domain: openDomain }] }, {}]) {
        expect((await request(path, f.user.jwt, 'POST', body)).status).toBe(400);
      }
    }
    expect(await ownedBy(f.user.id)).toEqual([]);
  });
});

describe('批量可用性', () => {
  it('逐项结果与 GET /availability 一致并保持请求顺序（普通用户与管理员）', async () => {
    const f = await fixture(3);
    const taken = f.item('taken');
    await f.own(f.other.id, taken);
    await f.own(f.user.id, f.item('owned', limitedDomain));
    for (let index = 0; index < 3; index++) await f.own(f.other.id, f.item(`full${index}`, privateDomain));
    const items: ClaimMailboxRequest[] = [
      f.item('free'), taken, { localPart: 'admin', domain: openDomain }, f.item('more', limitedDomain),
      f.item('private', privateDomain), f.item('unknown', 'unknown.batch.test'), f.item('free'),
    ];
    for (const actor of [f.user, f.other, f.admin]) {
      const batch = await data<MailboxAvailability[]>(await request('/mailboxes/availability/batch', actor.jwt, 'POST', { items }));
      const single: MailboxAvailability[] = [];
      for (const req of items) {
        single.push(await data<MailboxAvailability>(await request(`/mailboxes/availability?localPart=${req.localPart}&domain=${req.domain}`, actor.jwt)));
      }
      expect(batch).toEqual(single);
    }
    // 三种身份覆盖到每一种 reason
    const reasons = new Set<string>();
    for (const actor of [f.user, f.other]) {
      for (const result of await checkAvailabilityBatch(env, { userId: actor.id, role: 'user' }, items)) reasons.add(result.reason ?? 'available');
    }
    expect([...reasons].sort()).toEqual(['available', 'domain_limit', 'domain_unavailable', 'quota', 'reserved', 'taken']);
  });
});

describe('认领与可用性的 D1 往返', () => {
  it('999 个批量认领仅 11 次往返、25 条 SQL；单个认领与可用性往返保持不变', async () => {
    const f = await fixture();
    let probe = counting();
    await claimMailbox(probe.env, f.user.id, 'user', f.item('one'));
    expect(probe.trips()).toBe(2);

    probe = counting();
    await checkAvailability(probe.env, { userId: f.user.id, role: 'user' }, `${f.prefix}-two`, openDomain);
    expect(probe.trips()).toBe(1);

    const items = Array.from({ length: MAX_BATCH_CLAIM }, (_, index) => f.item(`many${index}`));
    probe = counting();
    expect(await checkAvailabilityBatch(probe.env, { userId: f.user.id, role: 'user' }, items)).toHaveLength(MAX_BATCH_CLAIM);
    expect(probe.trips()).toBe(1);

    probe = counting();
    const result = await claimMailboxes(probe.env, f.user.id, 'user', items);
    expect(result.claimed).toHaveLength(MAX_BATCH_CLAIM);
    expect(probe.trips()).toBe(11);
    expect(probe.queries()).toBe(25);

    // 并发认领在写入前占满按域额度：守卫拒绝，再读一次判定为并发用尽
    probe = counting(async (sql) => {
      if (/INSERT INTO mailboxes/i.test(sql)) await f.own(f.other.id, f.item('race', limitedDomain));
    });
    await expect(claimMailbox(probe.env, f.other.id, 'user', f.item('late', limitedDomain)))
      .rejects.toMatchObject({ code: 'forbidden', message: '认领配额已在并发请求中用尽，请刷新后重试' });
    expect(probe.trips()).toBe(3);
  });
});

describe('批量认领中断', () => {
  it('已认领若干项后 D1 故障：HTTP 200，保留 claimed，stoppedBy=internal，出错项及其后进入 notAttempted，并记录原始错误', async () => {
    const f = await fixture();
    const failure = new Error('D1_ERROR: transient');
    let inserts = 0;
    const racing = counting(undefined, async (sqls) => {
      if (sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql)) && ++inserts === 2) throw failure;
    });
    const items = Array.from({ length: 102 }, (_, index) => f.item(`failure${index}`));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      const response = await app.request('/api/mailboxes/batch', { method: 'POST',
        headers: { Authorization: `Bearer ${f.user.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }, racing.env, ctx);
      await waitOnExecutionContext(ctx);
      const result = await data<BatchClaimMailboxResult>(response);
      expect(result.claimed.map((box) => box.address)).toEqual(items.slice(0, 100).map((item) => `${item.localPart}@${item.domain}`));
      expect(result).toMatchObject({ taken: [], notAttempted: items.slice(100), stoppedBy: INTERRUPTED });
      expect(logged.mock.calls.some((args) => args.includes(failure))).toBe(true);
    } finally {
      logged.mockRestore();
    }
    expect(await ownedBy(f.user.id)).toHaveLength(100);
  });

  it('守卫未通过后诊断读取失败，同样收进 stoppedBy', async () => {
    const f = await fixture();
    let raced = false;
    // 写入前并发占满按域额度 → 守卫拒绝 → 诊断读取的 batch 失败
    const racing = counting(undefined, async (sqls) => {
      if (sqls.some((sql) => /INSERT INTO mailboxes/i.test(sql)) && !raced) {
        raced = true;
        await f.own(f.user.id, f.item('race', limitedDomain));
      } else if (raced) throw new Error('D1_ERROR: diagnose failed');
    });
    const items = [f.item('x', limitedDomain), f.item('y')];
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await claimMailboxes(racing.env, f.user.id, 'user', items);
      expect(result).toMatchObject({ claimed: [], taken: [], notAttempted: items, stoppedBy: INTERRUPTED });
    } finally {
      logged.mockRestore();
    }
  });

  it('开始逐项处理之前的非业务错误仍抛出（500）', async () => {
    const f = await fixture();
    const failure = new Error('D1_ERROR: unavailable');
    const broken = counting(undefined, async () => { throw failure; });
    await expect(claimMailboxes(broken.env, f.user.id, 'user', [f.item('a')])).rejects.toBe(failure);
    const ctx = createExecutionContext();
    const response = await app.request('/api/mailboxes/batch', { method: 'POST',
      headers: { Authorization: `Bearer ${f.user.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [f.item('a')] }) }, counting(undefined, async (sqls) => {
      // 鉴权 batch 放行，认领读取 batch 失败
      if (sqls.some((sql) => /FROM mailboxes WHERE address IN/.test(sql))) throw failure;
    }).env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(await ownedBy(f.user.id)).toEqual([]);
  });
});

describe('Claude 0 封号认领', () => {
  const denied = { code: 'forbidden', message: '该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领' };
  const suspend = async (domain: string) => {
    await db.insert(claudeAddressFacts).values({ address: `old-suspended@${domain}`, domain, suspended: true, paid: false,
      firstSeenAt: new Date(0) }).onConflictDoNothing();
  };
  async function zeroFixture() {
    const f = await fixture();
    const safe = `${f.prefix}-safe.test`;
    const unsafe = `${f.prefix}-unsafe.test`;
    await updateSettings(env, { domains: { list: [safe, unsafe].map((domain) => ({ domain, public: true, perUserLimit: 0 })) },
      claim_random: { paidSuspendedLimit: 0, suspendedPercent: 0, pendingDays: 7, dailyLimit: 0 } });
    return { ...f, safe, unsafe };
  }

  it('单项与批量 API 可用性/认领均拒绝封号域，零封号域通过；缺省和 uniform 保持普通认领', async () => {
    const f = await zeroFixture();
    await suspend(f.unsafe);
    const safe = { ...f.item('safe', f.safe), strategy: 'claude' as const };
    const unsafe = { ...f.item('unsafe', f.unsafe), strategy: 'claude' as const };
    const checks = await data<MailboxAvailability[]>(await request('/mailboxes/availability/batch', f.user.jwt, 'POST', { items: [safe, unsafe] }));
    expect(checks.map(({ available, reason }) => ({ available, reason }))).toEqual([
      { available: true, reason: undefined }, { available: false, reason: 'claude_suspended' },
    ]);
    for (const actor of [f.user, f.admin]) {
      expect(await data<MailboxAvailability>(await request(`/mailboxes/availability?${new URLSearchParams(unsafe)}`, actor.jwt)))
        .toMatchObject({ available: false, reason: 'claude_suspended' });
      const response = await request('/mailboxes', actor.jwt, 'POST', unsafe);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: denied });
    }
    const later = { ...f.item('later', f.safe), strategy: 'claude' as const };
    const batch = await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items: [safe, unsafe, later] }));
    expect(batch.claimed.map((box) => box.address)).toEqual([`${safe.localPart}@${safe.domain}`]);
    expect(batch).toMatchObject({ taken: [], notAttempted: [unsafe, later], stoppedBy: denied });
    for (const strategy of [undefined, 'uniform'] as const) {
      const item = { ...f.item(`ordinary-${strategy}`, f.unsafe), ...(strategy ? { strategy } : {}) };
      expect(await data<MailboxAvailability>(await request(`/mailboxes/availability?${new URLSearchParams(item)}`, f.user.jwt)))
        .toMatchObject({ available: true });
      await data<Mailbox>(await request('/mailboxes', f.user.jwt, 'POST', item), 201);
    }
  });

  it('v1 API Key 的可用性与实际认领保留 strategy，非法策略在所有请求入口拒绝', async () => {
    const f = await zeroFixture();
    await suspend(f.unsafe);
    const key = await createApiKey(env, f.user.id, { name: 'zero', scopes: ['mailbox.read', 'mailbox.write'], rateLimit: 120, allowedIps: [] });
    const unsafe = { ...f.item('api-key', f.unsafe), strategy: 'claude' };
    const apiRequest = async (prefix: string, token: string, path: string, method = 'GET', body?: unknown) => {
      const ctx = createExecutionContext();
      const response = await app.request(`${prefix}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) }, env, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect(await data<MailboxAvailability>(await apiRequest('/v1', key.key, `/mailboxes/availability?${new URLSearchParams(unsafe)}`)))
      .toMatchObject({ available: false, reason: 'claude_suspended' });
    const rejected = await apiRequest('/v1', key.key, '/mailboxes', 'POST', unsafe);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: denied });
    await data<Mailbox>(await apiRequest('/v1', key.key, '/mailboxes', 'POST', { ...unsafe, domain: f.safe }), 201);
    for (const [prefix, token] of [['/api', f.user.jwt], ['/v1', key.key]] as const) {
      const invalid = { ...unsafe, strategy: 'unknown' };
      expect((await apiRequest(prefix, token, `/mailboxes/availability?${new URLSearchParams(invalid)}`)).status).toBe(400);
      expect((await apiRequest(prefix, token, '/mailboxes', 'POST', invalid)).status).toBe(400);
    }
    for (const path of ['/mailboxes/batch', '/mailboxes/availability/batch']) {
      expect((await request(path, f.user.jwt, 'POST', { items: [{ ...unsafe, strategy: 'unknown' }] })).status).toBe(400);
    }
  });

  it.each(['user', 'admin'] as const)('托管域名的 %s 在单项和批量认领中也受零封号约束', async (role) => {
    const f = await zeroFixture();
    const domain = `${f.prefix}-hosted.test`;
    await db.insert(hostedDomains).values({ domain, userId: f.user.id, status: 'active' });
    await suspend(domain);
    const actor = role === 'admin' ? f.admin : f.user;
    const item = { ...f.item('hosted', domain), strategy: 'claude' as const };
    expect(await checkAvailability(env, { userId: actor.id, role }, item.localPart, domain, item.strategy))
      .toMatchObject({ available: false, reason: 'claude_suspended' });
    await expect(claimMailbox(env, actor.id, role, item)).rejects.toMatchObject(denied);
    expect(await claimMailboxes(env, actor.id, role, [item])).toMatchObject({ claimed: [], notAttempted: [item], stoppedBy: denied });
    expect((await claimMailbox(env, actor.id, role, { ...item, strategy: 'uniform' })).domain).toBe(domain);
  });

  it.each([false, true])('规划/可用性后新增封号，单项 INSERT 原子拒绝并返回准确错误（hosted=%s）', async (hosted) => {
    const f = await zeroFixture();
    const domain = hosted ? `${f.prefix}-hosted-race.test` : f.safe;
    if (hosted) await db.insert(hostedDomains).values({ domain, userId: f.user.id, status: 'active' });
    else expect((await planRandomDomains(env, { userId: f.admin.id, role: 'admin' }, 5, 'claude')).pool).toContain(domain);
    const item = { ...f.item('single-race', domain), strategy: 'claude' as const };
    expect(await checkAvailability(env, { userId: f.admin.id, role: 'admin' }, item.localPart, domain, item.strategy)).toMatchObject({ available: true });
    let injected = false;
    const racing = counting(async (sql) => {
      if (!injected && sql.includes('INSERT INTO mailboxes')) { injected = true; await suspend(domain); }
    });
    await expect(claimMailbox(racing.env, f.admin.id, 'admin', item)).rejects.toMatchObject(denied);
    expect(injected).toBe(true);
    expect(await ownedBy(f.admin.id)).toEqual([]);
  });

  it.each([false, true])('批量事务复核新封号，保留成功前缀且停止后续（hosted=%s）', async (hosted) => {
    const f = await zeroFixture();
    const domain = hosted ? `${f.prefix}-hosted-batch.test` : f.unsafe;
    if (hosted) await db.insert(hostedDomains).values({ domain, userId: f.user.id, status: 'active' });
    const items = [f.item('before', f.safe), f.item('blocked', domain), f.item('after', f.safe)]
      .map((item) => ({ ...item, strategy: 'claude' as const }));
    let injected = false;
    const racing = counting(undefined, async (sqls) => {
      if (!injected && sqls.some((sql) => sql.includes('INSERT INTO mailboxes'))) { injected = true; await suspend(domain); }
    });
    const result = await claimMailboxes(racing.env, f.admin.id, 'admin', items);
    expect(injected).toBe(true);
    expect(result).toMatchObject({ taken: [], notAttempted: items.slice(1), stoppedBy: denied });
    expect(result.claimed.map((box) => box.address)).toEqual([`${items[0]!.localPart}@${f.safe}`]);
    expect(await ownedBy(f.admin.id)).toEqual(result.claimed.map((box) => box.address));
  });

  it.each(['private', 'dedicated', 'foreign-hosted', 'unconfigured'] as const)('无权域名 %s 的单项/批量可用性与认领不暴露封号事实', async (kind) => {
    const f = await zeroFixture();
    const domain = kind === 'foreign-hosted' || kind === 'unconfigured' ? `${f.prefix}-${kind}.test` : f.unsafe;
    if (kind === 'private') await updateSettings(env, { domains: { list: [
      { domain: f.safe, public: true, perUserLimit: 0 }, { domain, public: false, perUserLimit: 0 },
    ] } });
    if (kind === 'dedicated') await updateUser(env, f.admin.id, f.user.id, {
      mailboxPolicy: { perUserLimit: 0, domains: [{ domain: f.safe, perUserLimit: 0 }] }, expectedMailboxPolicyRevision: 0,
    });
    if (kind === 'foreign-hosted') await db.insert(hostedDomains).values({ domain, userId: f.other.id, status: 'active' });
    const item = { ...f.item('private-fact', domain), strategy: 'claude' as const };
    const availability = { address: `${item.localPart}@${domain}`, available: false, reason: 'domain_unavailable' };
    const error = kind === 'unconfigured'
      ? { code: 'validation_failed', message: '域名不在系统域名列表内' }
      : { code: 'forbidden', message: '当前用户无权认领该域名' };
    // 添加封号前后，两个只读和两个写接口的可观察响应完全相同。
    for (const hasFact of [false, true]) {
      if (hasFact) await suspend(domain);
      expect(await data<MailboxAvailability>(await request(`/mailboxes/availability?${new URLSearchParams(item)}`, f.user.jwt))).toEqual(availability);
      expect(await data<MailboxAvailability[]>(await request('/mailboxes/availability/batch', f.user.jwt, 'POST', { items: [item] }))).toEqual([availability]);
      const rejected = await request('/mailboxes', f.user.jwt, 'POST', item);
      expect(rejected.status).toBe(kind === 'unconfigured' ? 400 : 403);
      expect(await rejected.json()).toMatchObject({ error });
      expect(await data<BatchClaimMailboxResult>(await request('/mailboxes/batch', f.user.jwt, 'POST', { items: [item] })))
        .toEqual({ claimed: [], taken: [], notAttempted: [item], stoppedBy: error });
    }
    const key = await createApiKey(env, f.user.id, { name: 'privacy', scopes: ['mailbox.read', 'mailbox.write'], rateLimit: 120, allowedIps: [] });
    for (const method of ['GET', 'POST']) {
      const ctx = createExecutionContext();
      const response = await app.request(method === 'GET' ? `/v1/mailboxes/availability?${new URLSearchParams(item)}` : '/v1/mailboxes', {
        method, headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(item) } : {}),
      }, env, ctx);
      await waitOnExecutionContext(ctx);
      if (method === 'GET') expect(await data<MailboxAvailability>(response)).toEqual(availability);
      else {
        expect(response.status).toBe(kind === 'unconfigured' ? 400 : 403);
        expect(await response.json()).toMatchObject({ error });
      }
    }
    expect(await ownedBy(f.user.id)).toEqual([]);
  });

  it.each(['system', 'dedicated', 'hosted'] as const)('撤权同时新增封号（%s）时单项/批量只报告权限变化', async (kind) => {
    for (const batch of [false, true]) {
      const f = await zeroFixture();
      const domain = kind === 'hosted' ? `${f.prefix}-revoked.test` : f.unsafe;
      let revoke: () => Promise<unknown>;
      if (kind === 'hosted') {
        const hosted = await db.insert(hostedDomains).values({ domain, userId: f.other.id, status: 'active' }).returning().get();
        await db.insert(hostedDomainMembers).values({ domainId: hosted!.id, userId: f.user.id, grantedBy: f.other.id });
        revoke = () => db.delete(hostedDomainMembers).where(eq(hostedDomainMembers.domainId, hosted!.id));
      } else if (kind === 'dedicated') {
        revoke = () => updateUser(env, f.admin.id, f.user.id, {
          mailboxPolicy: { perUserLimit: 0, domains: [{ domain: f.safe, perUserLimit: 0 }] }, expectedMailboxPolicyRevision: 0,
        });
      } else {
        revoke = () => updateSettings(env, { domains: { list: [
          { domain: f.safe, public: true, perUserLimit: 0 }, { domain, public: false, perUserLimit: 0 },
        ] } });
      }
      const item = { ...f.item('revoked-race', domain), strategy: 'claude' as const };
      let injected = false;
      const change = async () => { if (!injected) { injected = true; await revoke(); await suspend(domain); } };
      const racing = batch
        ? counting(undefined, async (sqls) => { if (sqls.some((sql) => sql.includes('INSERT INTO mailboxes'))) await change(); })
        : counting(async (sql) => { if (sql.includes('INSERT INTO mailboxes')) await change(); });
      if (batch) {
        const result = await claimMailboxes(racing.env, f.user.id, 'user', [item]);
        expect(result).toMatchObject({ claimed: [], notAttempted: [item], stoppedBy: { code: 'conflict' } });
        expect(result.stoppedBy!.message).not.toContain('Claude');
      } else {
        await expect(claimMailbox(racing.env, f.user.id, 'user', item)).rejects.toMatchObject({ code: 'conflict', message: expect.not.stringContaining('Claude') });
      }
      expect(injected).toBe(true);
      expect(racing.trips()).toBe(3); // 读取、写入与错误复核；托管权限仍并入复核 batch
      expect(await ownedBy(f.user.id)).toEqual([]);
    }
  });

  it('已占用地址在批量复核时也不能泄露已撤销托管成员权限后的封号事实', async () => {
    const f = await zeroFixture();
    const domain = `${f.prefix}-taken-hosted.test`;
    const hosted = await db.insert(hostedDomains).values({ domain, userId: f.other.id, status: 'active' }).returning().get();
    await db.insert(hostedDomainMembers).values({ domainId: hosted!.id, userId: f.user.id, grantedBy: f.other.id });
    const item = { ...f.item('taken-revoked', domain), strategy: 'claude' as const };
    await f.own(f.other.id, item);
    let injected = false;
    const racing = counting(undefined, async (sqls) => {
      if (!injected && sqls.some((sql) => sql.includes('INSERT INTO mailboxes'))) {
        injected = true;
        await db.delete(hostedDomainMembers).where(eq(hostedDomainMembers.domainId, hosted!.id));
        await suspend(domain);
      }
    });
    expect(await claimMailboxes(racing.env, f.user.id, 'user', [item]))
      .toMatchObject({ claimed: [], taken: [], notAttempted: [item], stoppedBy: { code: 'conflict', message: expect.not.stringContaining('Claude') } });
    expect(injected).toBe(true);
  });

  it('Claude 策略读取仍只需一个 batch，写入保持两次往返', async () => {
    const f = await zeroFixture();
    const items = [f.item('one', f.safe), f.item('two', f.safe)].map((item) => ({ ...item, strategy: 'claude' as const }));
    const read = counting();
    expect(await checkAvailabilityBatch(read.env, { userId: f.user.id, role: 'user' }, items)).toHaveLength(2);
    expect(read.trips()).toBe(1);
    const single = counting();
    await claimMailbox(single.env, f.user.id, 'user', items[0]!);
    expect(single.trips()).toBe(2);
    const batch = counting();
    expect((await claimMailboxes(batch.env, f.user.id, 'user', items)).claimed).toHaveLength(1);
    expect(batch.trips()).toBe(2);
    expect(batch.queries()).toBe(7); // 5 条上下文读取 + 事务 2 条，无额外封号快照
  });

  it('批量封号事实按去重域名物化，EXPLAIN 不随同域地址数量重复读取事实', async () => {
    const f = await zeroFixture();
    const captures: { sql: string; params: unknown[] }[] = [];
    const runtime = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, { get(value, key) {
          if (key === 'bind') return (...params: unknown[]) => { captures.push({ sql, params }); return value.bind(...params); };
          const member = Reflect.get(value, key);
          return typeof member === 'function' ? member.bind(value) : member;
        } });
      };
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    } }) } as Env;
    await claimMailboxes(runtime, f.user.id, 'user', [{ ...f.item('explain', f.safe), strategy: 'claude' }]);
    const captured = captures.find(({ sql }) => sql.startsWith('WITH') && !sql.includes('INSERT INTO mailboxes'))!;
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${captured.sql}`).bind(...captured.params).all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join('\n');
    expect(details).toContain('MATERIALIZE claude_domains');
    expect(details).toContain('MATERIALIZE blocked_domains');
    expect(details).toContain('idx_claude_facts_domain');
    // 只重放物化的事实查询，不执行认领；放入数百条无封号事实比较 1/100 地址的读取量。
    await env.db.prepare(`INSERT INTO claude_address_facts (address, domain, first_seen_at)
      SELECT 'normal' || key || '@' || ?1, ?1, 0 FROM json_each(?2)`)
      .bind(f.safe, JSON.stringify(Array.from({ length: 200 }, (_, n) => n))).run();
    const input = (JSON.parse(captured.params[0] as string) as Record<string, unknown>[])[0]!;
    const factsSql = `${captured.sql.slice(0, captured.sql.indexOf('  numbered AS (')).trimEnd().replace(/,$/, '')}
      SELECT domain FROM blocked_domains`;
    const readFacts = (count: number) => env.db.prepare(factsSql).bind(JSON.stringify(Array.from({ length: count }, () => input)), f.user.id).all();
    const one = await readFacts(1);
    const many = await readFacts(100);
    expect(one.results).toEqual([]);
    expect(many.results).toEqual([]);
    expect(many.meta.rows_read).toBeLessThanOrEqual(one.meta.rows_read + 1000);
  });
});

describe('认领读取与单独读取同一解码', () => {
  it('合批与 loadMailboxPolicyUser 对公共、专属、禁用、缺失用户结果一致', async () => {
    const f = await fixture();
    const policy: UserMailboxPolicy = { perUserLimit: 3, domains: [{ domain: privateDomain, perUserLimit: 1 }] };
    await updateUser(env, f.admin.id, f.other.id, { mailboxPolicy: policy, expectedMailboxPolicyRevision: 0 });
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.admin.id));
    const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: AppError) => ({ code: error.code, message: error.message }));
    for (const id of [f.user.id, f.other.id, f.admin.id, 999_999_999]) {
      const batched = outcome((async () => mailboxPolicyUserFromResult((await env.db.batch([mailboxPolicyUserStatement(env.db, id)]))[0]))());
      expect(await batched).toEqual(await outcome(loadMailboxPolicyUser(createDb(env), id)));
    }
    expect(await loadMailboxPolicyUser(createDb(env), f.other.id)).toEqual({ id: f.other.id, role: 'user', status: 'active', mailboxPolicy: policy, mailboxPolicyRevision: 1 });
    await expect(loadMailboxPolicyUser(createDb(env), f.admin.id)).rejects.toMatchObject({ code: 'user_disabled', message: '用户已被禁用' });
    await expect(loadMailboxPolicyUser(createDb(env), 999_999_999)).rejects.toMatchObject({ code: 'not_found', message: '用户不存在' });
  });

  it('认领设置非法时与 getSettingsFresh 一样回落默认值', async () => {
    const f = await fixture();
    await env.db.prepare(`UPDATE settings SET value = ? WHERE key = 'mailbox_policy'`).bind(JSON.stringify({ perUserLimit: -5, reservedLocalParts: [] })).run();
    expect((await getSettingsFresh(env)).mailbox_policy).toEqual(DEFAULT_SETTINGS.mailbox_policy);
    // 默认保留前缀含 postmaster；fixture 与损坏行都不含
    expect(await checkAvailability(env, { userId: f.user.id, role: 'user' }, 'postmaster', openDomain))
      .toEqual({ address: `postmaster@${openDomain}`, available: false, reason: 'reserved' });
    expect((await claimMailboxes(env, f.user.id, 'user', [{ localPart: 'postmaster', domain: openDomain }])).stoppedBy)
      .toEqual({ code: 'forbidden', message: '前缀 postmaster 为系统保留，无法认领' });
  });
});
