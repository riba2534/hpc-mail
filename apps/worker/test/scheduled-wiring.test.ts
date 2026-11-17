import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORWARD_RELAY_SCOPE, FORWARD_RELAY_USER_SCOPE } from '../src/services/forwarding.js';
import { bumpCounter, dayWindow, minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';
import { cfWindow, clearZoneCatalogCache, SYSTEM_DOMAIN_CF_SCOPE } from '../src/services/zone-catalog.js';
import { cfRuntime, fakeCloudflare } from './support/fake-cloudflare.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('每日维护接入本期新增的清理', () => {
  it('孤儿附件行登记对象清理并删行；中转与登录失败计数的过期窗口被回收', async () => {
    const orphanKey = `att/999999901/0-orphan-wiring.bin`;
    await env.db.prepare('INSERT INTO attachments (message_id, r2_key, filename) VALUES (999999901, ?, ?)').bind(orphanKey, 'orphan.bin').run();
    const oldDay = dayWindow(new Date(Date.now() - 5 * 86_400_000));
    const oldLogin = minuteWindow(15) - 20;
    await bumpCounter(env, FORWARD_RELAY_SCOPE, 'instance', oldDay);
    await bumpCounter(env, FORWARD_RELAY_USER_SCOPE, '7', oldDay);
    await bumpCounter(env, 'login-fail', 'wiring', oldLogin);
    await bumpCounter(env, FORWARD_RELAY_SCOPE, 'instance', dayWindow());

    await runScheduled(env, true);

    expect(await env.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?').bind(orphanKey).first<{ n: number }>())
      .toEqual({ n: 0 });
    expect(await env.db.prepare('SELECT COUNT(*) AS n FROM storage_cleanup_jobs WHERE r2_key = ?').bind(orphanKey).first<{ n: number }>())
      .toEqual({ n: 1 });
    expect((await readCounter(env, FORWARD_RELAY_SCOPE, 'instance', oldDay)).count).toBe(0);
    expect((await readCounter(env, FORWARD_RELAY_USER_SCOPE, '7', oldDay)).count).toBe(0);
    expect((await readCounter(env, 'login-fail', 'wiring', oldLogin)).count).toBe(0);
    expect((await readCounter(env, FORWARD_RELAY_SCOPE, 'instance', dayWindow())).count).toBe(1);
  });

  it('还没发送的草稿仍引用的对象不被清理台账删除', async () => {
    const key = 'draft/424242/wiring-token';
    await env.r2.put(key, 'draft-bytes');
    await env.db.prepare(`INSERT INTO draft_attachments (user_id, token, filename, size, r2_key, status)
      VALUES (424242, 'wiring-token', 'a.txt', 11, ?, 'ready')`).bind(key).run();
    await env.db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) VALUES (?)').bind(key).run();
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(key)).not.toBeNull();
    await env.db.prepare('DELETE FROM draft_attachments WHERE r2_key = ?').bind(key).run();
    await env.db.prepare('INSERT OR IGNORE INTO storage_cleanup_jobs (r2_key) VALUES (?)').bind(key).run();
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(key)).toBeNull();
  });
});

describe('系统域名接入的定时步骤', () => {
  it('5 分钟任务处理到期的接入任务；每日维护按 5 分钟窗口回收过期的 system_domain_cf 计数', async () => {
    clearZoneCatalogCache();
    const cf = fakeCloudflare({ zones: [{ name: 'wiring-onboarding.test', status: 'pending' }] });
    const zone = cf.zoneByName('wiring-onboarding.test')!;
    const due = Date.now() - 1;
    const { id } = (await env.db.prepare(`INSERT INTO system_domain_onboarding (domain, mode, state, account_id, zone_id, zone_origin, created_by, next_check_at)
      VALUES ('wiring-onboarding.test', 'existing_zone', 'awaiting_ns', 'acct-test', ?, 'linked', 1, ?) RETURNING id`).bind(zone.id, due).first<{ id: number }>())!;
    await runScheduled(cfRuntime(env), false);
    const row = await env.db.prepare('SELECT state, zone_status, next_check_at FROM system_domain_onboarding WHERE id = ?').bind(id)
      .first<{ state: string; zone_status: string; next_check_at: number }>();
    expect(row).toMatchObject({ state: 'awaiting_ns', zone_status: 'pending' });
    expect(row!.next_check_at).toBeGreaterThan(Date.now());
    expect(cf.calls).toContain(`GET /zones/${zone.id}`);

    const old = cfWindow() - 30;
    await bumpCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', old);
    await bumpCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow(), 0);
    const current = (await readCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow())).count;
    await runScheduled(env, true);
    expect((await readCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', old)).count).toBe(0);
    expect((await readCounter(env, SYSTEM_DOMAIN_CF_SCOPE, 'all', cfWindow())).count).toBe(current);
  });
});
