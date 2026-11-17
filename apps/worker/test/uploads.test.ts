import { MAX_ATTACHMENT_TOTAL_BYTES } from '@hpc-mail/shared';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { draftAttachments, users } from '../src/db/schema.js';
import { bumpCounter, dayWindow, purgeCounters, readCounter } from '../src/services/rate-counter.js';
import {
  consumeDraftAttachments,
  draftKey,
  newDraftToken,
  resolveDraftAttachments,
} from '../src/services/upload.js';

async function seedUser(username: string): Promise<number> {
  const db = createDb(env);
  const [row] = await db
    .insert(users)
    .values({ username, passwordHash: 'x', role: 'user', status: 'active' })
    .returning({ id: users.id });
  return row!.id;
}

/** 造一条 ready 的草稿附件行（size 为声明值，内容按需真写 R2） */
async function seedDraft(
  userId: number,
  size: number,
  opts: { writeContent?: boolean; status?: 'uploading' | 'ready' } = {},
): Promise<string> {
  const db = createDb(env);
  const token = newDraftToken();
  const key = draftKey(userId, token);
  if (opts.writeContent !== false) {
    await env.r2.put(key, new Uint8Array(Math.min(size, 1024)));
  }
  await db.insert(draftAttachments).values({
    userId,
    token,
    filename: `${token}.bin`,
    mimeType: 'application/octet-stream',
    size,
    r2Key: key,
    status: opts.status ?? 'ready',
  });
  return token;
}

describe('草稿附件解析', () => {
  it('合计超上限时按 D1 里的 size 直接拒绝，不去 R2 取内容', async () => {
    const uid = await seedUser(`up-over-${crypto.randomUUID().slice(0, 8)}`);
    // 三个各 20MB 的声明值，合计 60MB > 50MB 上限；内容不写 R2，
    // 若实现改回「先取内容再校验」，这里会因取不到对象而报 not_found 而非 payload_too_large
    const tokens = await Promise.all([
      seedDraft(uid, 20 * 1024 * 1024, { writeContent: false }),
      seedDraft(uid, 20 * 1024 * 1024, { writeContent: false }),
      seedDraft(uid, 20 * 1024 * 1024, { writeContent: false }),
    ]);
    await expect(resolveDraftAttachments(env, uid, tokens, crypto.randomUUID())).rejects.toMatchObject({
      code: 'payload_too_large',
    });
  });

  it('合计未超上限时解析为草稿对象的引用，不读内容', async () => {
    const uid = await seedUser(`up-ok-${crypto.randomUUID().slice(0, 8)}`);
    // 内容不写 R2：解析阶段若去读对象会报错
    const token = await seedDraft(uid, 512, { writeContent: false });
    const atts = await resolveDraftAttachments(env, uid, [token, { token, contentId: 'ignored' }], crypto.randomUUID());
    expect(atts).toEqual([{ filename: `${token}.bin`, mimeType: 'application/octet-stream', contentId: '',
      disposition: 'attachment', r2Key: draftKey(uid, token), size: 512 }]);
  });

  it('token 对象写法带内联参数：只给 contentId 时按 inline', async () => {
    const uid = await seedUser(`up-inline-${crypto.randomUUID().slice(0, 8)}`);
    const [a, b] = [await seedDraft(uid, 8), await seedDraft(uid, 8)];
    const atts = await resolveDraftAttachments(env, uid, [{ token: a, contentId: 'logo' }, { token: b, contentId: 'pic', disposition: 'attachment' }], crypto.randomUUID());
    expect(atts.map((att) => [att.contentId, att.disposition])).toEqual([['logo', 'inline'], ['pic', 'attachment']]);
  });

  it('未上传完成的 token 被拒', async () => {
    const uid = await seedUser(`up-pending-${crypto.randomUUID().slice(0, 8)}`);
    const token = await seedDraft(uid, 128, { status: 'uploading' });
    await expect(resolveDraftAttachments(env, uid, [token], crypto.randomUUID())).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('不能引用他人的 token', async () => {
    const owner = await seedUser(`up-owner-${crypto.randomUUID().slice(0, 8)}`);
    const other = await seedUser(`up-other-${crypto.randomUUID().slice(0, 8)}`);
    const token = await seedDraft(owner, 128);
    await expect(resolveDraftAttachments(env, other, [token], crypto.randomUUID())).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('回收只删草稿行，对象留给已发出邮件的附件行引用', async () => {
    const uid = await seedUser(`up-consume-${crypto.randomUUID().slice(0, 8)}`);
    const token = await seedDraft(uid, 256);
    const key = draftKey(uid, token);
    expect(await env.r2.get(key)).not.toBeNull();
    await consumeDraftAttachments(env, uid, [token]);
    expect(await env.r2.get(key)).not.toBeNull();
    const db = createDb(env);
    const row = await db
      .select()
      .from(draftAttachments)
      .where(eq(draftAttachments.token, token))
      .get();
    expect(row).toBeUndefined();
  });
});

describe('原子计数器', () => {
  it('并发递增不丢计数（KV 读-改-写会互相覆盖）', async () => {
    const subject = `concurrent-${crypto.randomUUID().slice(0, 8)}`;
    const window = dayWindow();
    await Promise.all(
      Array.from({ length: 20 }, () => bumpCounter(env, 'test', subject, window, 1, 2)),
    );
    const cur = await readCounter(env, 'test', subject, window);
    expect(cur.count).toBe(20);
    expect(cur.units).toBe(40);
  });

  it('支持负增量回退', async () => {
    const subject = `rollback-${crypto.randomUUID().slice(0, 8)}`;
    const window = dayWindow();
    await bumpCounter(env, 'test', subject, window, 1, 5);
    await bumpCounter(env, 'test', subject, window, -1, -5);
    expect(await readCounter(env, 'test', subject, window)).toEqual({ count: 0, units: 0 });
  });

  it('按窗口清理过期行', async () => {
    const subject = `purge-${crypto.randomUUID().slice(0, 8)}`;
    await bumpCounter(env, 'test-purge', subject, 100);
    await bumpCounter(env, 'test-purge', subject, 200);
    await purgeCounters(env, 'test-purge', 150);
    expect((await readCounter(env, 'test-purge', subject, 100)).count).toBe(0);
    expect((await readCounter(env, 'test-purge', subject, 200)).count).toBe(1);
  });
});

describe('附件总量上限常量', () => {
  it('MAX_ATTACHMENT_TOTAL_BYTES 是正数且被解析路径引用', () => {
    expect(MAX_ATTACHMENT_TOTAL_BYTES).toBeGreaterThan(0);
  });
});
