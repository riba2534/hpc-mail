import { env } from 'cloudflare:test';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { claudeAddressFacts, mailboxes, messages, users } from '../src/db/schema.js';
import { harvestRecentClaudeFacts, harvestSql } from '../src/services/claude-facts.js';
import { releaseMailbox } from '../src/services/mailbox.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { runScheduled } from '../src/services/scheduled.js';

const db = createDb(env);
const HOUR = 60 * 60 * 1000;
let sequence = 0;

/** 同一文件内用例共享 D1：每个用例用独立域名 */
function domainOf() {
  return `facts-${++sequence}.test`;
}

async function receive(address: string, fromAddress: string, subject: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await db.insert(messages).values({
    address, domain: address.split('@')[1]!, direction: 'inbound', status: 'received', fromAddress, subject, ...extra,
  }).returning().get())!;
}

async function factsOf(domain: string) {
  const rows = await db.select().from(claudeAddressFacts).where(eq(claudeAddressFacts.domain, domain)).all();
  return Object.fromEntries(rows.map((row) => [row.address.split('@')[0]!, row]));
}

describe('Claude 地址事实归纳', () => {
  it('只认官方发件人：欢迎信、收据、订阅确认、封号信与产品邮件算账号，魔法链接、仿冒与站内互投不算', async () => {
    const domain = domainOf();
    const suspendedAt = new Date(Date.now() - 10 * 60 * 1000);
    await receive(`welcome@${domain}`, 'no-reply@email.claude.com', 'Welcome to Claude. Let’s get you set up.');
    await receive(`paid@${domain}`, 'invoice+statements@mail.anthropic.com', 'Your receipt from Anthropic, PBC #2002-6773-4161');
    await receive(`paid@${domain}`, 'no-reply-abc@mail.anthropic.com', 'Your account has been suspended', { createdAt: suspendedAt });
    await receive(`plan@${domain}`, 'No-Reply-XYZ@Mail.Anthropic.com', 'Your Max subscription is confirmed');
    await receive(`drip@${domain}`, 'no-reply@email.claude.com', 'Claude Code is included in your plan');
    await receive(`link@${domain}`, 'no-reply-q1@mail.anthropic.com', 'Your secure link to Claude.ai is here | 2026-10-12');
    await receive(`fake@${domain}`, 'support@anthropic-fake.test', 'Your account has been suspended');
    await receive(`internal@${domain}`, 'no-reply@email.claude.com', 'Welcome to Claude', { sendChannel: 'internal' });

    expect(await harvestRecentClaudeFacts(env, 0)).toBeGreaterThanOrEqual(4);
    const facts = await factsOf(domain);
    expect(Object.keys(facts).sort()).toEqual(['drip', 'paid', 'plan', 'welcome']);
    expect(facts.welcome).toMatchObject({ paid: false, suspended: false, suspendedAt: null });
    expect(facts.paid).toMatchObject({ paid: true, suspended: true });
    expect(facts.paid!.suspendedAt!.getTime()).toBe(suspendedAt.getTime());
    expect(facts.plan).toMatchObject({ paid: true, suspended: false });
    expect(facts.drip).toMatchObject({ paid: false, suspended: false });
  });

  it('官方发件人按整个发件域精确比对：伪造的相似发件人不留事实，Safeguards 的 Intercom 域名照常计入', async () => {
    const domain = domainOf();
    const ban = 'Your account has been suspended';
    await receive(`a@${domain}`, 'anthropic-safeguards@evil.example', ban);
    await receive(`b@${domain}`, 'no-reply@anthropic-safeguards.evil.example', ban);
    await receive(`c@${domain}`, 'x@anthropic.com.evil.example', ban);
    await receive(`d@${domain}`, 'no-reply@mail.anthropic.com.evil.example', ban);
    await receive(`e@${domain}`, 'no-reply@evil-mail.anthropic.com', ban);
    await receive(`f@${domain}`, 'no-reply@sub.email.claude.com', 'Welcome to Claude');
    await receive(`g@${domain}`, '"no-reply@mail.anthropic.com"@evil.example', ban);
    await receive(`ok@${domain}`, 'appeals@anthropic-safeguards.intercom-mail.com', ban);
    await receive(`up@${domain}`, 'No-Reply@Mail.Anthropic.COM', ban);

    await harvestRecentClaudeFacts(env, 0);
    const facts = await factsOf(domain);
    expect(Object.keys(facts).sort()).toEqual(['ok', 'up']);
    expect(facts.ok).toMatchObject({ suspended: true });
    expect(facts.up).toMatchObject({ suspended: true });
  });

  it('重复归纳幂等；标志只增不减，邮件没了统计仍在', async () => {
    const domain = domainOf();
    const ban = await receive(`a@${domain}`, 'no-reply@mail.anthropic.com', 'Your account has been suspended');
    await harvestRecentClaudeFacts(env, 0);
    await harvestRecentClaudeFacts(env, 0);
    await db.delete(messages).where(eq(messages.id, ban.id));
    await receive(`a@${domain}`, 'no-reply@email.claude.com', 'Welcome to Claude Code');
    await harvestRecentClaudeFacts(env, 0);
    const facts = await factsOf(domain);
    expect(facts.a).toMatchObject({ suspended: true, paid: false });
    expect(facts.a!.firstSeenAt.getTime()).toBe(ban.createdAt.getTime());
  });

  it('5 分钟定时任务只扫最近 1 小时，更早的留给每日补扫', async () => {
    const domain = domainOf();
    await receive(`recent@${domain}`, 'no-reply@email.claude.com', 'Welcome to Claude');
    await receive(`old@${domain}`, 'no-reply@email.claude.com', 'Welcome to Claude', { createdAt: new Date(Date.now() - 2 * HOUR) });
    await runScheduled(env, false);
    expect(Object.keys(await factsOf(domain))).toEqual(['recent']);
    await runScheduled(env, true);
    expect(Object.keys(await factsOf(domain)).sort()).toEqual(['old', 'recent']);
  });

  it('永久删除与释放并清空历史：删除前同一批次先归纳，统计不丢', async () => {
    const domain = domainOf();
    const trashed = await receive(`trash@${domain}`, 'no-reply@mail.anthropic.com', 'Your account has been suspended',
      { deletedAt: new Date(), createdAt: new Date(Date.now() - 5 * HOUR) });
    expect(await purgeMatchingMessages(env, sql`${messages.id} = ${trashed.id}`)).toBe(1);
    expect(await db.select().from(messages).where(eq(messages.id, trashed.id)).get()).toBeUndefined();

    const owner = (await db.insert(users).values({ username: `facts-owner-${sequence}`, role: 'admin', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const box = (await db.insert(mailboxes).values({ userId: owner.id, domain, address: `kept@${domain}` }).returning().get())!;
    await receive(`kept@${domain}`, 'invoice+statements@mail.anthropic.com', 'Your receipt from Anthropic, PBC #1',
      { createdAt: new Date(Date.now() - 5 * HOUR) });
    expect((await releaseMailbox(env, owner.id, box.id, true, true)).deletedMessages).toBe(1);

    const facts = await factsOf(domain);
    expect(facts.trash).toMatchObject({ suspended: true });
    expect(facts.kept).toMatchObject({ paid: true, suspended: false });
  });

  it('归纳语句走 created_at 与 purge_token 索引，不全表扫描 messages', async () => {
    const window = await env.db.prepare(`EXPLAIN QUERY PLAN ${harvestSql('created_at >= ?', 'idx_messages_created_id')}`).bind(0).all<{ detail: string }>();
    const windowPlan = window.results.map((row) => row.detail).join(' | ');
    expect(windowPlan).toMatch(/idx_messages_created_id/);
    expect(windowPlan).not.toMatch(/SCAN messages\b/);
    const purge = await env.db.prepare(`EXPLAIN QUERY PLAN ${harvestSql('purge_token = ?', 'idx_messages_purge_token')}`).bind('t').all<{ detail: string }>();
    const purgePlan = purge.results.map((row) => row.detail).join(' | ');
    expect(purgePlan).toMatch(/idx_messages_purge_token/);
    expect(purgePlan).not.toMatch(/SCAN messages\b/);
  });
});
