import { createExecutionContext, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxes, messages, notificationJobs, users } from '../src/db/schema.js';
import { relayMarker } from '../src/services/forwarding.js';
import { handleInbound } from '../src/services/inbound.js';
import {
  headersFromRaw, INBOUND_PENDING_STALE_MS, MAX_INBOUND_REPAIR_ATTEMPTS, repairPendingInbound, STALE_INBOUND_SQL,
} from '../src/services/inbound-repair.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { runScheduled } from '../src/services/scheduled.js';
import type { Env } from '../src/types.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DOMAIN = 'repair.test';

async function seedOwner(name: string, prefs: { webhook?: boolean; forward?: boolean } = {}) {
  const db = createDb(env);
  const [user] = await db.insert(users)
    .values({ username: name, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
  const address = `${name}@${DOMAIN}`;
  await db.insert(mailboxes).values({ address, domain: DOMAIN, userId: user!.id, displayName: '' });
  await updateUserNotifyPrefs(env, user!.id, {
    ...(prefs.webhook ? { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } } : {}),
    ...(prefs.forward ? { forward: { enabled: true, addresses: [`${name}-copy@example.net`] } } : {}),
  });
  return { userId: user!.id, address };
}

/** 带一个附件的入站原文；extraHeaders 追加在头部 */
const mimeWithAttachment = (to: string, subject: string, extraHeaders: string[] = []) => [
  'From: Sender <sender@example.net>', `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${crypto.randomUUID()}@example.net>`,
  ...extraHeaders, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="repair-b"', '',
  '--repair-b', 'Content-Type: text/plain; charset=UTF-8', '', `body of ${subject}`,
  '--repair-b', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"',
  'Content-Transfer-Encoding: base64', '', 'aW52b2ljZS1ieXRlcw==',
  '--repair-b--', '',
].join('\r\n');

const incoming = (to: string, raw: string) => ({
  raw: new Response(raw).body!, headers: new Headers(), to, from: 'sender@example.net',
  forward: vi.fn(async () => {}), setReject: vi.fn(),
}) as unknown as ForwardableEmailMessage;

/** R2 写入按前缀注入故障的 env */
function failingAttachments(prefix = 'att/'): Env {
  const r2 = new Proxy(env.r2, { get(target, property) {
    if (property === 'put') return (key: string, ...args: unknown[]) => {
      if (key.startsWith(prefix)) throw new Error('attachment R2 unavailable');
      return (target.put as (...a: unknown[]) => Promise<unknown>)(key, ...args);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...env, r2 } as Env;
}

/** 首次投递附件写 R2 失败，留下一行 pending，并把它推到自愈门槛之前 */
async function pendingDelivery(address: string, subject: string, extraHeaders: string[] = []) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const raw = mimeWithAttachment(address, subject, extraHeaders);
  await expect(handleInbound(incoming(address, raw), failingAttachments(), createExecutionContext())).rejects.toThrow('attachment R2 unavailable');
  const row = await createDb(env).select().from(messages).where(eq(messages.subject, subject)).get();
  expect(row?.status).toBe('pending');
  await age(row!.id);
  return row!;
}

async function age(id: number, ms = INBOUND_PENDING_STALE_MS + 60_000) {
  await createDb(env).update(messages).set({ createdAt: new Date(Date.now() - ms) }).where(eq(messages.id, id));
}

const rowOf = (id: number) => createDb(env).select().from(messages).where(eq(messages.id, id)).get();
const jobsOf = (id: number) => createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, id)).all();
const rowsWithSubject = (subject: string) => createDb(env).select({ id: messages.id }).from(messages).where(eq(messages.subject, subject)).all();

/** 本文件的用例共享 D1：先把其他用例残留的候选行清掉，避免互相占用每轮名额 */
async function clearPending() {
  await env.db.prepare(`UPDATE messages SET status = 'degraded' WHERE direction = 'inbound' AND status = 'pending'`).run();
}

describe('入站 pending 自愈', () => {
  it('附件保存失败的 pending 行超过 15 分钟后用 R2 原文补齐附件、完成通知与转发；再跑不重复处理', async () => {
    await clearPending();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const owner = await seedOwner('repair-ok', { webhook: true, forward: true });
    const pending = await pendingDelivery(owner.address, 'repair-ok-subject');
    expect(await jobsOf(pending.id)).toHaveLength(0);

    expect(await repairPendingInbound(env)).toBe(1);
    const repaired = await rowOf(pending.id);
    expect(repaired).toMatchObject({ status: 'received', errorDetail: '' });
    expect(await createDb(env).select().from(attachments).where(eq(attachments.messageId, pending.id)).all()).toHaveLength(1);
    const jobs = await jobsOf(pending.id);
    expect(jobs.filter((job) => job.channel === 'webhook')).toHaveLength(1);
    // 定时任务没有原生 forward()：转发降级为中转（测试环境无 send_email，记为失败），但确实只尝试了一次
    expect(jobs.filter((job) => job.channel === 'forward')).toHaveLength(1);
    expect(await rowsWithSubject('repair-ok-subject')).toHaveLength(1);

    expect(await repairPendingInbound(env)).toBe(0);
    expect(await jobsOf(pending.id)).toHaveLength(jobs.length);
  });

  it('未到 15 分钟的 pending 不动', async () => {
    await clearPending();
    const owner = await seedOwner('repair-fresh');
    const pending = await pendingDelivery(owner.address, 'repair-fresh-subject');
    await age(pending.id, INBOUND_PENDING_STALE_MS - 60_000);
    expect(await repairPendingInbound(env)).toBe(0);
    expect((await rowOf(pending.id))?.status).toBe('pending');
    await clearPending();
  });

  it('原文缺失直接标 degraded 并写明原因，之后能被通知补录（不转发）', async () => {
    await clearPending();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const owner = await seedOwner('repair-noraw');
    const pending = await pendingDelivery(owner.address, 'repair-noraw-subject');
    await env.r2.delete(pending.rawR2Key!);
    expect(await repairPendingInbound(env)).toBe(1);
    const row = await rowOf(pending.id);
    expect(row?.status).toBe('degraded');
    expect(row?.errorDetail).toContain('原始邮件未存档');
    // 保留「保存失败」：发件方之后用相同字节重投仍走修复路径
    expect(row?.errorDetail).toContain('保存失败');
  });

  it('存档原文与记录的幂等键不一致：不重走收件、不插新行，标 degraded', async () => {
    await clearPending();
    const owner = await seedOwner('repair-mismatch');
    const pending = await pendingDelivery(owner.address, 'repair-mismatch-subject');
    await createDb(env).update(messages).set({ ingestKey: 'not-the-digest-of-this-raw' }).where(eq(messages.id, pending.id));
    expect(await repairPendingInbound(env)).toBe(1);
    expect((await rowOf(pending.id))?.errorDetail).toContain('存档原文与记录不一致');
    expect((await rowOf(pending.id))?.status).toBe('degraded');
    expect(await rowsWithSubject('repair-mismatch-subject')).toHaveLength(1);
  });

  it('持续失败逐次累计，失败过的排在新行之后，第 6 次标 degraded', async () => {
    await clearPending();
    const owner = await seedOwner('repair-poison');
    const poison = await pendingDelivery(owner.address, 'repair-poison-subject');
    const broken = failingAttachments();

    expect(await repairPendingInbound(broken, Date.now(), 1)).toBe(1);
    expect(await rowOf(poison.id)).toMatchObject({ status: 'pending', inboundRepairAttempts: 1 });
    expect((await rowOf(poison.id))?.errorDetail).toContain('第 1 次');

    // 更新的一行（未失败过）优先于失败过的旧行
    const fresh = await pendingDelivery(owner.address, 'repair-poison-fresh');
    await age(fresh.id, INBOUND_PENDING_STALE_MS + 30_000);
    expect(await repairPendingInbound(env, Date.now(), 1)).toBe(1);
    expect((await rowOf(fresh.id))?.status).toBe('received');
    expect((await rowOf(poison.id))?.inboundRepairAttempts).toBe(1);

    for (let attempt = 2; attempt <= MAX_INBOUND_REPAIR_ATTEMPTS; attempt++) {
      expect(await repairPendingInbound(broken, Date.now(), 1)).toBe(1);
      expect((await rowOf(poison.id))?.inboundRepairAttempts).toBe(attempt);
    }
    const gaveUp = await rowOf(poison.id);
    expect(gaveUp?.status).toBe('degraded');
    expect(gaveUp?.errorDetail).toContain(`${MAX_INBOUND_REPAIR_ATTEMPTS} 次仍未成功`);
    expect(await repairPendingInbound(broken)).toBe(0);
  });

  it('原文带本站中转防环标记时，自愈不触发转发', async () => {
    await clearPending();
    const owner = await seedOwner('repair-relay', { forward: true });
    const pending = await pendingDelivery(owner.address, 'repair-relay-subject', [`X-HPC-Mail-Relay: ${await relayMarker(env)}`]);
    expect(await repairPendingInbound(env)).toBe(1);
    expect((await rowOf(pending.id))?.status).toBe('received');
    expect((await jobsOf(pending.id)).filter((job) => job.channel === 'forward')).toHaveLength(0);
  });

  it('托管域名已停用时收件被拒：标 degraded 并写明原因', async () => {
    await clearPending();
    const owner = await seedOwner('repair-hosted');
    const domain = 'repair-suspended.test';
    const address = `repair-hosted@${domain}`;
    await env.db.prepare(`INSERT INTO hosted_domains (domain, user_id, status, name_servers, original_name_servers, updated_at)
      VALUES (?, ?, 'active', '[]', '[]', ?)`).bind(domain, owner.userId, Date.now()).run();
    await createDb(env).insert(mailboxes).values({ address, domain, userId: owner.userId, displayName: '' });
    const pending = await pendingDelivery(address, 'repair-hosted-subject');
    await env.db.prepare(`UPDATE hosted_domains SET status = 'suspended' WHERE domain = ?`).bind(domain).run();
    expect(await repairPendingInbound(env)).toBe(1);
    const row = await rowOf(pending.id);
    expect(row?.status).toBe('degraded');
    expect(row?.errorDetail).toContain('收件被拒');
  });

  it('接入每 5 分钟的定时任务', async () => {
    await clearPending();
    const owner = await seedOwner('repair-cron');
    const pending = await pendingDelivery(owner.address, 'repair-cron-subject');
    await runScheduled(env, false);
    expect((await rowOf(pending.id))?.status).toBe('received');
  });

  it('原文头部解析：折行展开、重复字段合并、非法行跳过', () => {
    const headers = headersFromRaw(new TextEncoder().encode(
      'X-HPC-Mail-Relay: abc\r\nSubject: long\r\n continued\r\nReceived: a\r\nReceived: b\r\nbad line\r\n\r\nX-Body: no\r\n'));
    expect(headers.get('x-hpc-mail-relay')).toBe('abc');
    expect(headers.get('subject')).toBe('long continued');
    expect(headers.get('received')).toBe('a, b');
    expect(headers.has('x-body')).toBe(false);
  });

  it('候选查询命中 idx_messages_inbound_pending 部分索引', async () => {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${STALE_INBOUND_SQL}`).bind(Date.now(), 5).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join('\n');
    expect(details).toContain('idx_messages_inbound_pending');
  });
});
