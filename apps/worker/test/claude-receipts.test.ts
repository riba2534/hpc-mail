import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { ClaudeAddressFacts, ClaudeDomainFacts } from '@hpc-mail/shared';
import { inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { claudeAddressFacts, claudeReceipts, mailboxes, messages, users } from '../src/db/schema.js';
import { createApiKey } from '../src/services/api-key.js';
import {
  CLAUDE_DOMAIN_BANS_SQL, CLAUDE_DOMAIN_COUNTS_SQL, CLAUDE_MAIL_STATS_SQL, CLAUDE_RECEIPTS_LOOKUP_SQL, lookupClaudeAddresses, lookupClaudeDomains,
} from '../src/services/admin-lookup.js';
import {
  backfillClaudeReceipts, harvestRecentClaudeReceipts, parseClaudeReceipt, RECEIPT_BACKFILL_PROGRESS_KEY, RECEIPT_BACKFILL_SCAN_SQL,
  RECEIPT_LEGACY_AUTH_CUTOFF_MS, RECEIPT_PURGE_SQL, RECEIPT_WINDOW_SQL, type ReceiptBackfillProgress,
} from '../src/services/claude-receipts.js';
import { releaseMailbox } from '../src/services/mailbox.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { runScheduled } from '../src/services/scheduled.js';
import { updateSettings } from '../src/services/setting.js';
import { receiveSigned, signedBy } from './support/claude-mail.js';

const app = createApp();
const db = createDb(env);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INVOICE = 'invoice+statements@mail.anthropic.com';
let sequence = 0;

afterEach(() => {
  vi.restoreAllMocks();
});

/** 线上收据正文的形状（数字为测试值） */
const SAMPLE = 'Receipt from Anthropic, PBC $100.00 Paid on November 17, 2026 with - 4242 (invoice illustration [https://example.invalid/i.png]) '
  + 'Receipt #2002-6773-4161 Nov 17–Dec 17, 2026 Claude Max Qty 1 $100.00 Total $100.00 Amount paid $100.00 Download receipt (https://example.invalid/r)';
/** 旧格式：套餐写作 Max plan - 20x，没有 Amount paid 一行，卡组织名在破折号前 */
const LEGACY = 'Receipt from Anthropic, PBC $200.00 Paid on May 3, 2026 with Visa - 1234 Receipt #1111-2222 May 3–Jun 3, 2026 Max plan - 20x Qty 1 $200.00';

/** 同一文件内用例共享 D1：每个用例用独立域名 */
function domainOf() {
  return `receipts-${++sequence}.test`;
}

/** 默认是通过认证、To 头即收件地址的官方收据 */
const receive = (address: string, extra: Partial<typeof messages.$inferInsert> = {}) =>
  receiveSigned(address, extra.fromAddress ?? INVOICE, 'Your receipt from Anthropic, PBC #2002-6773-4161', { bodyText: SAMPLE, ...extra });

async function receiptsOf(messageIds: number[]) {
  const rows = await db.select().from(claudeReceipts).where(inArray(claudeReceipts.messageId, messageIds)).all();
  return new Map(rows.map((row) => [row.messageId, row]));
}

async function setProgress(progress: Partial<ReceiptBackfillProgress> | null) {
  await env.db.prepare('DELETE FROM settings WHERE key = ?').bind(RECEIPT_BACKFILL_PROGRESS_KEY).run();
  if (progress) {
    await env.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind(RECEIPT_BACKFILL_PROGRESS_KEY, JSON.stringify({ cursor: 0, recorded: 0, caughtUp: false, updatedAt: 0, ...progress })).run();
  }
}

async function progress(): Promise<ReceiptBackfillProgress> {
  const row = await env.db.prepare('SELECT value FROM settings WHERE key = ?').bind(RECEIPT_BACKFILL_PROGRESS_KEY).first<{ value: string }>();
  return JSON.parse(row!.value) as ReceiptBackfillProgress;
}

async function planOf(query: string, ...params: unknown[]): Promise<string> {
  const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...params).all<{ detail: string }>();
  return plan.results.map((row) => row.detail).join(' | ');
}

describe('收据解析', () => {
  it('线上样例：取 Amount paid 的金额、$ 推断 USD、with - 后的卡尾号', () => {
    expect(parseClaudeReceipt(SAMPLE)).toEqual({ amountCents: 10_000, currency: 'USD', cardLast4: '4242' });
  });

  it('实付与抬头金额不同时以 Amount paid 为准；千位分隔与其他币种', () => {
    expect(parseClaudeReceipt('Receipt from Anthropic, PBC $200.00 Paid on May 3 with - 9999 Total $200.00 Amount paid $93.33').amountCents).toBe(9333);
    expect(parseClaudeReceipt('Amount paid $1,234.50 with - 0007')).toEqual({ amountCents: 123_450, currency: 'USD', cardLast4: '0007' });
    expect(parseClaudeReceipt('Amount paid €18.00')).toEqual({ amountCents: 1800, currency: 'EUR', cardLast4: null });
    expect(parseClaudeReceipt('Amount paid $100')).toMatchObject({ amountCents: 10_000 });
  });

  it('旧格式（Max plan - 20x、没有 Amount paid）取抬头金额，卡组织名在破折号前也能取到尾号', () => {
    expect(parseClaudeReceipt(LEGACY)).toEqual({ amountCents: 20_000, currency: 'USD', cardLast4: '1234' });
  });

  it('没有卡尾号、金额或尾号不是 4 位时对应字段为 null', () => {
    expect(parseClaudeReceipt('Receipt from Anthropic, PBC $100.00 Paid on November 17, 2026 Receipt #1')).toEqual({ amountCents: 10_000, currency: 'USD', cardLast4: null });
    expect(parseClaudeReceipt('Thanks for your purchase with - 12345')).toEqual({ amountCents: null, currency: null, cardLast4: null });
    expect(parseClaudeReceipt('')).toEqual({ amountCents: null, currency: null, cardLast4: null });
  });
});

describe('收据采集', () => {
  it('最近窗口：记下金额、币种、卡尾号与主题；重复采集与定时任务都不重复记录', async () => {
    const domain = domainOf();
    const mail = await receive(`a@${domain}`);
    const legacy = await receive(`b@${domain}`, { bodyText: LEGACY, subject: 'Your receipt from Anthropic, PBC #1111-2222' });
    expect(await harvestRecentClaudeReceipts(env)).toBeGreaterThanOrEqual(2);
    const recorded = await receiptsOf([mail.id, legacy.id]);
    expect(recorded.get(mail.id)).toMatchObject({ address: `a@${domain}`, domain, amountCents: 10_000, currency: 'USD', cardLast4: '4242',
      subject: mail.subject, receivedAt: mail.createdAt });
    expect(recorded.get(legacy.id)).toMatchObject({ amountCents: 20_000, cardLast4: '1234' });

    expect(await harvestRecentClaudeReceipts(env)).toBe(0);
    await runScheduled(env, false);
    const count = await env.db.prepare('SELECT COUNT(*) AS n FROM claude_receipts WHERE domain = ?').bind(domain).first<{ n: number }>();
    expect(count).toEqual({ n: 2 });
  });

  it('信任口径同地址事实：DKIM 不通过或不对齐、To 头不是收件地址、仿冒发件域、站内互投与非收据主题都不采', async () => {
    const domain = domainOf();
    const ok = await receive(`ok@${domain}`);
    const parent = await receive(`parent@${domain}`, { auth: signedBy(INVOICE, { dkimDomain: 'anthropic.com' }) });
    const rejected = await Promise.all([
      receive(`fail@${domain}`, { auth: signedBy(INVOICE, { dkim: 'fail' }) }),
      receive(`esp@${domain}`, { auth: signedBy(INVOICE, { dkimDomain: 'sendgrid.net' }) }),
      receive(`dup@${domain}`, { auth: signedBy(INVOICE, { aligned: false }) }),
      receive(`replay@${domain}`, { recipients: { to: [`victim@${domain}.other`], cc: [], bcc: [] } }),
      receive(`fake@${domain}`, { fromAddress: 'invoice@anthropic-billing.example' }),
      receive(`internal@${domain}`, { sendChannel: 'internal' }),
      receive(`welcome@${domain}`, { subject: 'Welcome to Claude' }),
      // 收到时没有认证结果（截止时间之后）
      receive(`noauth@${domain}`, { auth: null }),
    ]);
    await harvestRecentClaudeReceipts(env);
    const recorded = await receiptsOf([ok.id, parent.id, ...rejected.map((mail) => mail.id)]);
    expect([...recorded.keys()].sort((a, b) => a - b)).toEqual([ok.id, parent.id]);
  });

  it('没有认证结果的历史收据：0028 上线（2026-11-17T16:00Z）之前收到的按旧口径回填，之后收到的不采', async () => {
    const domain = domainOf();
    const before = await receive(`before@${domain}`, { auth: null, createdAt: new Date(RECEIPT_LEGACY_AUTH_CUTOFF_MS - 1) });
    const at = await receive(`at@${domain}`, { auth: null, createdAt: new Date(RECEIPT_LEGACY_AUTH_CUTOFF_MS) });
    const spoofed = await receive(`spoof@${domain}`, { auth: null, createdAt: new Date(RECEIPT_LEGACY_AUTH_CUTOFF_MS - DAY),
      fromAddress: 'invoice@mail.anthropic.com.evil.example' });
    await setProgress({ cursor: before.id - 1 });
    await backfillClaudeReceipts(env);
    const recorded = await receiptsOf([before.id, at.id, spoofed.id]);
    expect([...recorded.keys()]).toEqual([before.id]);
    expect(recorded.get(before.id)).toMatchObject({ amountCents: 10_000, cardLast4: '4242' });
    expect(new Date(Date.UTC(2026, 10, 17, 16)).getTime()).toBe(RECEIPT_LEGACY_AUTH_CUTOFF_MS);
  });

  it('历史回填按 id 游标分批：只扫 1 小时前的行，追上后标记 caughtUp，之后从游标继续跟随新行', async () => {
    const domain = domainOf();
    const old = (days: number) => ({ createdAt: new Date(Date.now() - days * DAY) });
    const first = await receive(`r1@${domain}`, old(30));
    await receive(`other@${domain}`, { ...old(29), subject: 'Your Max subscription is confirmed' });
    const second = await receive(`r2@${domain}`, old(28));
    const recent = await receive(`r3@${domain}`);
    await setProgress({ cursor: first.id - 1 });

    expect(await backfillClaudeReceipts(env, Date.now(), 2)).toBe(1);
    expect(await progress()).toMatchObject({ cursor: first.id + 1, caughtUp: false, recorded: 1 });
    expect(await backfillClaudeReceipts(env, Date.now(), 2)).toBe(1);
    // 碰到 1 小时内的行即停：游标不越过它，留给最近窗口采集
    expect(await progress()).toMatchObject({ cursor: second.id, caughtUp: true, recorded: 2 });
    const before = await progress();
    expect(await backfillClaudeReceipts(env, Date.now(), 2)).toBe(0);
    expect(await progress()).toEqual(before);
    expect([...(await receiptsOf([first.id, second.id, recent.id])).keys()].sort((a, b) => a - b)).toEqual([first.id, second.id]);

    // 两小时后（定时任务中断、最近窗口没采到）由回填补上
    await backfillClaudeReceipts(env, Date.now() + 2 * HOUR, 2);
    expect((await receiptsOf([recent.id])).get(recent.id)).toMatchObject({ amountCents: 10_000 });
    expect((await progress()).cursor).toBeGreaterThanOrEqual(recent.id);
  });

  it('D1 正文里找不到金额且全文在 R2 时读全文；只有 HTML 时用转换出的文本', async () => {
    const domain = domainOf();
    await env.r2.put('body/receipt-text.json', JSON.stringify({ text: SAMPLE, html: '' }));
    await env.r2.put('body/receipt-html.json', JSON.stringify({ text: '', html: '<p>Receipt from Anthropic, PBC</p><p>Amount paid <b>$200.00</b></p>' }));
    const text = await receive(`text@${domain}`, { bodyText: 'Receipt from Anthropic', bodyR2Key: 'body/receipt-text.json' });
    const html = await receive(`html@${domain}`, { bodyText: '', bodyR2Key: 'body/receipt-html.json' });
    const missing = await receive(`missing@${domain}`, { bodyText: 'Paid with - 5555', bodyR2Key: 'body/receipt-missing.json' });
    await harvestRecentClaudeReceipts(env);
    const recorded = await receiptsOf([text.id, html.id, missing.id]);
    expect(recorded.get(text.id)).toMatchObject({ amountCents: 10_000, cardLast4: '4242' });
    expect(recorded.get(html.id)).toMatchObject({ amountCents: 20_000, currency: 'USD' });
    // R2 对象缺失时按 D1 正文记录，不卡住
    expect(recorded.get(missing.id)).toMatchObject({ amountCents: null, cardLast4: '5555' });

    // 已记录的收据不再取回、不再读 R2
    let reads = 0;
    const r2 = new Proxy(env.r2, { get(target, property) {
      if (property === 'get') return (key: string) => { reads++; return target.get(key); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await harvestRecentClaudeReceipts({ ...env, r2 } as typeof env)).toBe(0);
    expect(reads).toBe(0);
  });

  it('永久删除与释放并清空历史：删除前同一批次留存收据（SQL 解析金额与卡尾号），已记录的保持原记录', async () => {
    const domain = domainOf();
    const trashed = await receive(`trash@${domain}`, { deletedAt: new Date(), createdAt: new Date(Date.now() - 5 * HOUR),
      bodyText: 'Receipt from Anthropic, PBC $1,234.50 Paid on May 3 with - 9876 Total $1,234.50 Amount paid $1,234.50 Download' });
    const noCard = await receive(`nocard@${domain}`, { deletedAt: new Date(), bodyText: LEGACY.replace(' with Visa - 1234', '') });
    const untrusted = await receive(`fail@${domain}`, { deletedAt: new Date(), auth: signedBy(INVOICE, { dkim: 'fail' }) });
    const euro = await receive(`euro@${domain}`, { deletedAt: new Date(), bodyText: 'Amount paid €18.00 with - 4321' });
    await harvestRecentClaudeReceipts(env);
    expect((await receiptsOf([euro.id])).get(euro.id)).toMatchObject({ currency: 'EUR' });
    await env.db.prepare('DELETE FROM claude_receipts WHERE message_id IN (?, ?, ?)').bind(trashed.id, noCard.id, untrusted.id).run();

    const ids = [trashed.id, noCard.id, untrusted.id, euro.id];
    expect(await purgeMatchingMessages(env, inArray(messages.id, ids))).toBe(4);
    expect(await db.select().from(messages).where(inArray(messages.id, ids)).all()).toEqual([]);

    const owner = (await db.insert(users).values({ username: `receipts-owner-${sequence}`, role: 'admin', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const box = (await db.insert(mailboxes).values({ userId: owner.id, domain, address: `kept@${domain}` }).returning().get())!;
    const kept = await receive(`kept@${domain}`, { createdAt: new Date(Date.now() - 5 * HOUR), bodyText: 'Receipt from Anthropic, PBC $200.00 with - 1111' });
    expect((await releaseMailbox(env, owner.id, box.id, true, true)).deletedMessages).toBe(1);

    const recorded = await receiptsOf([...ids, kept.id]);
    expect(recorded.get(trashed.id)).toMatchObject({ address: `trash@${domain}`, amountCents: 123_450, currency: 'USD', cardLast4: '9876',
      receivedAt: trashed.createdAt });
    expect(recorded.get(noCard.id)).toMatchObject({ amountCents: 20_000, cardLast4: null });
    expect(recorded.has(untrusted.id)).toBe(false);
    expect(recorded.get(euro.id)).toMatchObject({ amountCents: 1800, currency: 'EUR', cardLast4: '4321' });
    expect(recorded.get(kept.id)).toMatchObject({ amountCents: 20_000, cardLast4: '1111' });
  });

  it('定时任务里收据步骤失败只记日志，其他步骤照常执行', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.db.prepare('ALTER TABLE claude_receipts RENAME TO claude_receipts_off').run();
    try {
      await runScheduled(env, false);
    } finally {
      await env.db.prepare('ALTER TABLE claude_receipts_off RENAME TO claude_receipts').run();
    }
    const summary = JSON.parse(logs.find((line) => line.includes('"event":"scheduled"'))!) as { steps: { step: string; failed?: true }[] };
    const failed = summary.steps.filter((entry) => entry.failed).map((entry) => entry.step);
    expect(failed).toEqual(expect.arrayContaining(['claude_receipts.harvest']));
    expect(failed.every((name) => name.startsWith('claude_receipts.'))).toBe(true);
    expect(summary.steps.map((entry) => entry.step)).toEqual(expect.arrayContaining(['claude_facts.harvest', 'storage.cleanup', 'webhooks.process']));
  });

  it('采集语句走 created_at、主键与 purge_token 索引，不全表扫描 messages', async () => {
    const window = await planOf(RECEIPT_WINDOW_SQL, 0, 50);
    expect(window).toMatch(/idx_messages_created_id/);
    expect(window).not.toMatch(/SCAN messages\b/);
    const scan = await planOf(RECEIPT_BACKFILL_SCAN_SQL, 0, 1000);
    expect(scan).toMatch(/SEARCH messages USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    // 只有收据按主键回表取正文
    expect(scan).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\) LEFT-JOIN/);
    expect(scan).not.toMatch(/SCAN messages\b/);
    const purge = await planOf(RECEIPT_PURGE_SQL, 't');
    expect(purge).toMatch(/idx_messages_purge_token/);
    expect(purge).not.toMatch(/SCAN messages\b/);
  });
});

describe('/v1/admin/claude 查询', () => {
  async function adminKey(): Promise<string> {
    await updateSettings(env, { api: { enabled: true } });
    const admin = (await db.insert(users).values({ username: `receipts-admin-${++sequence}`, role: 'admin', passwordHash: 'x', authVersionMigrated: true })
      .returning().get())!;
    return (await createApiKey(env, admin.id, { name: 'ops', scopes: ['mail.read', 'admin'], allowedIps: [], rateLimit: 600 })).key;
  }

  async function get<T>(key: string, path: string, status = 200): Promise<T> {
    const ctx = createExecutionContext();
    const response = await app.request(path, { headers: { Authorization: `Bearer ${key}` } }, env, ctx);
    await waitOnExecutionContext(ctx);
    const body = await response.json() as { data: T };
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body.data;
  }

  async function fact(address: string, values: Partial<typeof claudeAddressFacts.$inferInsert> = {}) {
    await db.insert(claudeAddressFacts).values({ address, domain: address.split('@')[1]!, firstSeenAt: new Date(Date.now() - 10 * DAY), ...values });
  }

  it('domains：按请求顺序返回每个域名，没有事实的计数为 0，封号地址按封号时间排序', async () => {
    const key = await adminKey();
    const [a, b, empty] = [domainOf(), domainOf(), domainOf()];
    await fact(`x@${a}`, { paid: true });
    await fact(`y@${a}`, { paid: true, suspended: true, suspendedAt: new Date(Date.UTC(2026, 10, 10)) });
    await fact(`z@${a}`, { suspended: true, suspendedAt: new Date(Date.UTC(2026, 10, 2)) });
    await fact(`w@${b}`);
    const result = await get<ClaudeDomainFacts[]>(key, `/v1/admin/claude/domains?domains=${empty}, ${b.toUpperCase()},${a},${empty}`);
    expect(result).toEqual([
      { domain: empty, addresses: 0, paid: 0, suspended: 0, suspendedAddresses: [] },
      { domain: b, addresses: 1, paid: 0, suspended: 0, suspendedAddresses: [] },
      { domain: a, addresses: 3, paid: 2, suspended: 2, suspendedAddresses: [
        { address: `z@${a}`, suspendedAt: '2026-11-02T00:00:00.000Z' }, { address: `y@${a}`, suspendedAt: '2026-11-10T00:00:00.000Z' }] },
    ]);
    // 重复参数与逗号分隔等价（与其他 /v1/admin 查询一致），不丢后面的值
    expect(await get<ClaudeDomainFacts[]>(key, `/v1/admin/claude/domains?domains=${empty}&domains=${b.toUpperCase()}&domains=${a},${empty}`)).toEqual(result);
    const [fromRepeated] = await get<ClaudeAddressFacts[]>(key, `/v1/admin/claude/addresses?addresses=nobody@${empty}&addresses=w@${b}`).then((rows) => rows.slice(1));
    expect(fromRepeated?.address).toBe(`w@${b}`);
    expect((await get<unknown>(key, '/v1/admin/claude/domains', 400))).toBeUndefined();
    const tooMany = Array.from({ length: 201 }, (_, index) => `d${index}.test`).join(',');
    await get(key, `/v1/admin/claude/domains?domains=${tooMany}`, 400);
  });

  it('addresses：Anthropic 来信含回收站，登录链接单独计数；收据升序，tier 取最近一张能识别金额的；查不到的 known=false', async () => {
    const key = await adminKey();
    const domain = domainOf();
    const alice = `alice@${domain}`;
    const base = Date.now();
    const t = (days: number) => new Date(base - days * DAY);
    await receive(alice, { fromAddress: 'no-reply@email.claude.com', subject: 'Welcome to Claude. Let’s get you set up.', createdAt: t(9), bodyText: '' });
    await receive(alice, { fromAddress: 'no-reply-1@mail.anthropic.com', subject: 'Secure link to log in to Claude.ai | 2026-11-01', createdAt: t(8), bodyText: '' });
    await receive(alice, { fromAddress: 'no-reply-2@mail.anthropic.com', subject: 'Your secure link to Claude is here | 2026-11-02', createdAt: t(7),
      bodyText: '', deletedAt: new Date() });
    await receive(alice, { fromAddress: 'news@claude.com', subject: 'Product update', createdAt: t(6), bodyText: '' });
    await receive(alice, { fromAddress: 'no-reply@email.anthropic.com', subject: 'Your Max 20x plan is now Ultra', createdAt: t(1), bodyText: '' });
    // 不算 Anthropic 来信：相似域名、多个 @ 的畸形地址、外发与站内互投
    await receive(alice, { fromAddress: 'x@anthropic.com.evil.example', subject: 'Secure link to log in to Claude', bodyText: '' });
    await receive(alice, { fromAddress: 'x@evil.example@mail.anthropic.com', subject: 'Secure link to log in to Claude', bodyText: '' });
    await receive(alice, { fromAddress: 'x@notanthropic.com', subject: 'Secure link to log in to Claude', bodyText: '' });
    await receive(alice, { fromAddress: 'no-reply@mail.anthropic.com', direction: 'outbound', subject: 'x', bodyText: '' });
    await receive(alice, { fromAddress: 'no-reply@mail.anthropic.com', sendChannel: 'internal', subject: 'x', bodyText: '' });
    await fact(alice, { paid: true, firstSeenAt: t(9) });
    // 收据：5x、20x、最近一张金额识别不到
    const insertReceipt = (messageId: number, days: number, amountCents: number | null) => db.insert(claudeReceipts).values({
      messageId, address: alice, domain, receivedAt: t(days), subject: `Your receipt from Anthropic #${messageId}`, amountCents,
      currency: amountCents === null ? null : 'USD', cardLast4: amountCents === null ? null : '4242' });
    await insertReceipt(900_000_000 + sequence * 10 + 1, 5, 20_000);
    await insertReceipt(900_000_000 + sequence * 10 + 2, 30, 10_000);
    await insertReceipt(900_000_000 + sequence * 10 + 3, 2, null);

    const [first, unknown] = await get<ClaudeAddressFacts[]>(key, `/v1/admin/claude/addresses?addresses=${alice.toUpperCase()},nobody@${domain}`);
    expect(first).toMatchObject({ address: alice, domain, known: true, paid: true, suspended: false, suspendedAt: null,
      anthropicMails: 5, loginLinkMails: 2, lastAnthropicMailAt: t(1).toISOString(), firstSeenAt: t(30).toISOString(), tier: '20x' });
    expect(first!.receipts.map((receipt) => [receipt.amountCents, receipt.tier])).toEqual([[10_000, '5x'], [20_000, '20x'], [null, null]]);
    // 收据对应的邮件不存在（测试里直接写入的行）：messageId 为 null
    expect(first!.receipts.every((receipt) => receipt.messageId === null)).toBe(true);
    expect(unknown).toEqual({ address: `nobody@${domain}`, domain, known: false, firstSeenAt: null, paid: false, suspended: false, suspendedAt: null,
      anthropicMails: 0, lastAnthropicMailAt: null, loginLinkMails: 0, receipts: [], tier: null });
  });

  it('addresses：邮件还在时带 messageId，永久删除后收据仍在、messageId 为 null；封号事实照常返回', async () => {
    const key = await adminKey();
    const domain = domainOf();
    const address = `bob@${domain}`;
    const mail = await receive(address);
    await harvestRecentClaudeReceipts(env);
    await fact(address, { paid: true, suspended: true, suspendedAt: new Date(Date.UTC(2026, 10, 12)) });
    const [live] = await get<ClaudeAddressFacts[]>(key, `/v1/admin/claude/addresses?addresses=${address}`);
    expect(live!.receipts).toEqual([{ messageId: mail.id, receivedAt: mail.createdAt.toISOString(), subject: mail.subject, amountCents: 10_000,
      currency: 'USD', tier: '5x', cardLast4: '4242' }]);
    expect(live).toMatchObject({ anthropicMails: 1, suspended: true, suspendedAt: '2026-11-12T00:00:00.000Z', tier: '5x' });

    await purgeMatchingMessages(env, sql`${messages.id} = ${mail.id}`);
    const [after] = await get<ClaudeAddressFacts[]>(key, `/v1/admin/claude/addresses?addresses=${address}`);
    expect(after).toMatchObject({ known: true, anthropicMails: 0, lastAnthropicMailAt: null, tier: '5x' });
    expect(after!.receipts).toEqual([{ ...live!.receipts[0], messageId: null }]);
  });

  it('两个查询各一次 D1 batch，按索引读取，不全表扫描', async () => {
    // 每条预备的语句都进了同一次 batch：另发的单条查询会多出 prepare
    const calls = { prepared: 0, batches: [] as number[] };
    const counted = new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return (statements: D1PreparedStatement[]) => { calls.batches.push(statements.length); return target.batch(statements); };
      if (property === 'prepare') return (query: string) => { calls.prepared++; return target.prepare(query); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await lookupClaudeDomains({ ...env, db: counted } as typeof env, ['a.test', 'b.test']);
    expect(calls).toEqual({ prepared: 2, batches: [2] });
    await lookupClaudeAddresses({ ...env, db: counted } as typeof env, ['x@a.test', 'y@b.test']);
    expect(calls).toEqual({ prepared: 5, batches: [2, 3] });

    const list = JSON.stringify(['x@a.test', 'y@b.test']);
    const stats = await planOf(CLAUDE_MAIL_STATS_SQL, list);
    expect(stats).toMatch(/SEARCH m USING INDEX idx_messages_\w+ \(address=\?/);
    expect(stats).not.toMatch(/SCAN m\b/);
    const receipts = await planOf(CLAUDE_RECEIPTS_LOOKUP_SQL, list);
    expect(receipts).toMatch(/idx_claude_receipts_address \(address=\?\)/);
    expect(receipts).toMatch(/SEARCH m USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(receipts).not.toMatch(/SCAN (r|m|claude_receipts)\b/);
    for (const query of [CLAUDE_DOMAIN_COUNTS_SQL, CLAUDE_DOMAIN_BANS_SQL]) {
      const plan = await planOf(query, JSON.stringify(['a.test']));
      expect(plan).toMatch(/idx_claude_facts_domain \(domain=\?\)/);
      expect(plan).not.toMatch(/SCAN claude_address_facts\b/);
    }
    // 管理员 Key 之外的调用者由 admin/index.ts 统一拦下（这里只确认路由挂在其后）
    const ctx = createExecutionContext();
    const response = await app.request('/v1/admin/claude/domains?domains=a.test', {}, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });
});
