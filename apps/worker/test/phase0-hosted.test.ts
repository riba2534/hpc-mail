import { env } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { idempotencyRecords, messages, rateCounters, users } from '../src/db/schema.js';
import { HOSTED_CHECK_RATE_SCOPE, HOSTED_CREATE_RATE_SCOPE } from '../src/services/hosted-domain.js';
import { minuteWindow } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';

const db = createDb(env);
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

/** 跑一次定时任务，返回汇总日志里的步骤名 */
async function scheduledSteps(maintenance: boolean): Promise<string[]> {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
  await runScheduled(env, maintenance);
  vi.restoreAllMocks();
  const summary = JSON.parse(logs.find((line) => line.includes('"event":"scheduled"'))!) as { maintenance: boolean; steps: { step: string }[] };
  expect(summary.maintenance).toBe(maintenance);
  return summary.steps.map((entry) => entry.step);
}

describe('定时任务分工', () => {
  it('每日维护只跑维护步骤，5 分钟任务不跑维护步骤（16:00 两个 cron 同时触发时不重复）', async () => {
    const daily = await scheduledSteps(true);
    expect(daily).toEqual(expect.arrayContaining(['claude_facts.catchup', 'idempotency.cleanup', 'counters', 'retention', 'trash',
      'attachments.orphans']));
    for (const regular of ['notification.repair', 'notification.process', 'purge.recover', 'outbound.stale', 'claude_facts.harvest',
      'storage.leases', 'storage.links', 'storage.cleanup', 'hosted_domains.sync']) {
      expect(daily).not.toContain(regular);
    }

    const every5 = await scheduledSteps(false);
    expect(every5).toEqual(['notification.repair', 'notification.process', 'purge.recover', 'outbound.stale', 'claude_facts.harvest',
      'storage.leases', 'storage.links', 'storage.cleanup', 'hosted_domains.sync']);
  });
});

describe('每日维护的清理规则', () => {
  it('幂等记录：已完成 2 天、失败 7 天、pending 但发件行已终态的按最后更新 2 天后删除，其余保留', async () => {
    const user = (await db.insert(users).values({ username: 'phase0-idem', passwordHash: 'x', authVersionMigrated: true }).returning().get())!;
    const outbound = async (status: string) => (await db.insert(messages).values({
      address: 'sender@phase0.test', domain: 'phase0.test', direction: 'outbound', status, subject: status,
    }).returning().get())!.id;
    const record = async (key: string, status: 'pending' | 'completed' | 'failed', ageMs: number, messageId: number | null = null,
      updatedAgeMs = ageMs) => {
      await db.insert(idempotencyRecords).values({
        actorType: 'user', actorId: user.id, key, requestHash: 'h', status, messageId,
        createdAt: new Date(Date.now() - ageMs), updatedAt: new Date(Date.now() - updatedAgeMs),
      });
    };
    await record('completed-old', 'completed', 3 * DAY);
    await record('completed-new', 'completed', DAY);
    await record('failed-old', 'failed', 8 * DAY);
    await record('failed-new', 'failed', 6 * DAY);
    await record('failed-bound-old', 'failed', 8 * DAY, await outbound('failed'));
    await record('pending-sent', 'pending', 3 * DAY, await outbound('sent'));
    await record('pending-delivered', 'pending', 3 * DAY, await outbound('delivered'));
    await record('pending-failed', 'pending', 3 * DAY, await outbound('failed'));
    // 发件行已终态但记录未过保留期：同 Key 重试仍要被拦下，不能删
    await record('pending-recent-sent', 'pending', 60 * 60 * 1000, await outbound('sent'));
    await record('pending-recently-bound', 'pending', 3 * DAY, await outbound('delivered'), 60 * 60 * 1000);
    await record('pending-still-sending', 'pending', 3 * DAY, await outbound('pending'));
    await record('pending-unbound', 'pending', 3 * DAY);
    await record('pending-missing-row', 'pending', 3 * DAY, 987654321);

    await runScheduled(env, true);
    const kept = (await db.select({ key: idempotencyRecords.key }).from(idempotencyRecords)
      .where(eq(idempotencyRecords.actorId, user.id)).all()).map((row) => row.key).sort();
    expect(kept).toEqual(['completed-new', 'failed-new', 'pending-missing-row', 'pending-recent-sent',
      'pending-recently-bound', 'pending-still-sending', 'pending-unbound']);
  });

  it.each(['api-reject', HOSTED_CREATE_RATE_SCOPE, HOSTED_CHECK_RATE_SCOPE])('分钟级计数 %s 随其他分钟级计数一起回收', async (scope) => {
    const now = minuteWindow(1);
    await db.insert(rateCounters).values([
      { scope, subject: 'phase0-subject', window: now - 200, count: 3 },
      { scope, subject: 'phase0-subject', window: now, count: 1 },
    ]);
    await runScheduled(env, true);
    const windows = (await db.select({ window: rateCounters.window }).from(rateCounters)
      .where(and(eq(rateCounters.scope, scope), eq(rateCounters.subject, 'phase0-subject'))).all()).map((row) => row.window);
    expect(windows).toEqual([now]);
  });
});
