import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LOGIN_ACCOUNT_SCOPE } from '../src/services/auth.js';
import { FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE } from '../src/services/forwarding.js';
import { bumpCounter, dayWindow, minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';

describe('每日维护接入本期新增的清理', () => {
  it('孤儿附件行登记对象清理并删行；中转与账号级登录计数的过期窗口被回收', async () => {
    const orphanKey = `att/999999901/0-orphan-wiring.bin`;
    await env.db.prepare('INSERT INTO attachments (message_id, r2_key, filename) VALUES (999999901, ?, ?)').bind(orphanKey, 'orphan.bin').run();
    const oldDay = dayWindow(new Date(Date.now() - 5 * 86_400_000));
    const oldLogin = minuteWindow(15) - 20;
    await bumpCounter(env, FORWARD_RELAY_SCOPE, 'instance', oldDay);
    await bumpCounter(env, FORWARD_RELAY_USER_SCOPE, '7', oldDay);
    await bumpCounter(env, LOGIN_ACCOUNT_SCOPE, 'wiring', oldLogin);
    await bumpCounter(env, FORWARD_RELAY_SCOPE, 'instance', dayWindow());

    await runScheduled(env, true);

    expect(await env.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?').bind(orphanKey).first<{ n: number }>())
      .toEqual({ n: 0 });
    expect(await env.db.prepare('SELECT COUNT(*) AS n FROM storage_cleanup_jobs WHERE r2_key = ?').bind(orphanKey).first<{ n: number }>())
      .toEqual({ n: 1 });
    expect((await readCounter(env, FORWARD_RELAY_SCOPE, 'instance', oldDay)).count).toBe(0);
    expect((await readCounter(env, FORWARD_RELAY_USER_SCOPE, '7', oldDay)).count).toBe(0);
    expect((await readCounter(env, LOGIN_ACCOUNT_SCOPE, 'wiring', oldLogin)).count).toBe(0);
    expect((await readCounter(env, FORWARD_RELAY_SCOPE, 'instance', dayWindow())).count).toBe(1);
  });
});
