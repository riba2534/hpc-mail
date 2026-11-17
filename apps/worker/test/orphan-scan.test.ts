import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORPHAN_SCAN_CURSOR_KEY, ORPHAN_SCAN_IDS, purgeOrphanAttachments } from '../src/services/storage-cleanup.js';

/** 按 id 写孤儿附件行（邮件 id 不存在）：from..to 连续 */
async function seedOrphans(from: number, to: number) {
  await env.db.prepare(`WITH RECURSIVE s(x) AS (SELECT ?1 UNION ALL SELECT x + 1 FROM s WHERE x < ?2)
    INSERT INTO attachments (id, message_id, r2_key, filename) SELECT x, 980000000 + x, 'orphan-scan/' || x, 'o.bin' FROM s`)
    .bind(from, to).run();
}

const cursor = async () => env.kv.get(ORPHAN_SCAN_CURSOR_KEY);
const remaining = async (from: number, to: number) =>
  (await env.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id BETWEEN ?1 AND ?2').bind(from, to).first<{ n: number }>())!.n;

/** 孤儿扫描曾每天从 0 扫全表两遍（C9）：现在每天只扫检查点之后的一段 id，到表尾回到开头 */
describe('孤儿附件增量扫描', () => {
  it('每天扫检查点之后的一段，下次接着往后，扫到表尾回到开头', async () => {
    const base = 5_000_000;
    await seedOrphans(base + 1, base + 3);
    await seedOrphans(base + ORPHAN_SCAN_IDS + 1, base + ORPHAN_SCAN_IDS + 2);
    await env.kv.put(ORPHAN_SCAN_CURSOR_KEY, String(base));

    expect(await purgeOrphanAttachments(env)).toBe(3);
    expect(await remaining(base + ORPHAN_SCAN_IDS + 1, base + ORPHAN_SCAN_IDS + 2)).toBe(2);
    expect(await cursor()).toBe(String(base + ORPHAN_SCAN_IDS));

    expect(await purgeOrphanAttachments(env)).toBe(2);
    expect(await cursor()).toBe('0');
  });

  it('区间内孤儿超过当天批数上限时，下次从删到的位置接着扫', async () => {
    const base = 6_000_000;
    await seedOrphans(base + 1, base + 2_010);
    await env.kv.put(ORPHAN_SCAN_CURSOR_KEY, String(base));

    expect(await purgeOrphanAttachments(env)).toBe(2_000);
    expect(await cursor()).toBe(String(base + 2_000));
    expect(await purgeOrphanAttachments(env)).toBe(10);
    expect(await remaining(base + 1, base + 2_010)).toBe(0);
  });
});
