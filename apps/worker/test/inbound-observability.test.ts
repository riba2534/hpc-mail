import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, deliveryObjectLeases, hostedDomains, mailboxes, messages, storageCleanupJobs, users } from '../src/db/schema.js';
import { handleInbound } from '../src/services/inbound.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { updateSettings } from '../src/services/setting.js';
import { ORPHAN_ATTACHMENTS_SQL, processStorageCleanup, purgeOrphanAttachments } from '../src/services/storage-cleanup.js';
import type { Env } from '../src/types.js';

const db = createDb(env);
afterEach(() => { vi.restoreAllMocks(); });

interface InboundLog {
  event: 'inbound';
  result: string;
  stage?: string;
  errorClass?: string;
  domain: string;
  rawSize: number;
  bodySize: number;
  attachments: number;
  attachmentBytes: number;
  attachmentsDropped: boolean;
  rawR2: boolean;
  bodyR2: boolean;
  messageId: number | null;
  ms: Record<string, number>;
}

/** 截获 console.log 里的收件日志行（原文保留，用来检查不含地址与内容） */
function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const inbound = () => lines.filter((line) => line.startsWith('{"event":"inbound"'));
  return { lines: inbound, last: (): InboundLog => JSON.parse(inbound().at(-1)!) as InboundLog };
}

async function seedOwner(name: string, domain = 'obs.test') {
  const [user] = await db.insert(users).values({ username: name, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
  const address = `${name}@${domain}`;
  await db.insert(mailboxes).values({ address, domain, userId: user!.id, displayName: '' });
  return { userId: user!.id, address };
}

function incoming(to: string, raw: string) {
  return { raw: new Response(raw).body!, headers: new Headers(), to, from: 'sender@example.net', forward: vi.fn(async () => {}),
    setReject: vi.fn() } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> };
}

async function deliver(message: ForwardableEmailMessage, target: Env = env) {
  const ctx = createExecutionContext();
  try { await handleInbound(message, target, ctx); }
  finally { await waitOnExecutionContext(ctx); }
}

const plain = (to: string, subject: string, body: string, id = crypto.randomUUID()) => [
  'From: Secret Sender <secret-sender@example.net>', `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.net>`,
  'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

const withAttachments = (to: string, subject: string, count: number) => [
  'From: Secret Sender <secret-sender@example.net>', `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${subject}@example.net>`,
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="obs"', '',
  '--obs', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
  ...Array.from({ length: count }, (_, index) => [
    '--obs', `Content-Type: application/pdf; name="file-${index}.pdf"`, `Content-Disposition: attachment; filename="file-${index}.pdf"`,
    'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK']).flat(),
  '--obs--', ''].join('\r\n');

/** 失败注入：key 命中时先执行 hook 或直接抛错，再写入 */
function r2With(options: { fail?: (key: string) => boolean; before?: (key: string) => Promise<void> }): Env {
  const r2 = new Proxy(env.r2, { get(target, property) {
    if (property === 'put') return async (key: string, ...args: unknown[]) => {
      if (options.fail?.(key)) throw new Error(`injected R2 failure: ${key}`);
      await options.before?.(key);
      return (target.put as (...a: unknown[]) => Promise<unknown>)(key, ...args);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...env, r2 } as Env;
}

describe('收件结构化日志（R33）', () => {
  it('新信与重复投递各输出一行：只有域名、大小与耗时，不含地址、主题与正文', async () => {
    await updateSettings(env, { code_extract: { enabled: true, aiEnabled: false } });
    const logs = captureLogs();
    const owner = await seedOwner('obs-new');
    const raw = plain(owner.address, 'Confidential subject line', 'Private body text with code 482913');
    await deliver(incoming(owner.address, raw));
    expect(logs.lines()).toHaveLength(1);
    const first = logs.last();
    const row = await db.select().from(messages).where(eq(messages.address, owner.address)).get();
    expect(first).toMatchObject({
      event: 'inbound', result: 'new', domain: 'obs.test', rawSize: new TextEncoder().encode(raw).length,
      attachments: 0, attachmentBytes: 0, attachmentsDropped: false, rawR2: true, bodyR2: false, messageId: row!.id,
    });
    expect(first.stage).toBeUndefined();
    expect(first.ms).toMatchObject({ parse: expect.any(Number), lookup: expect.any(Number), store: expect.any(Number),
      db: expect.any(Number), total: expect.any(Number) });

    await deliver(incoming(owner.address, raw));
    expect(logs.last()).toMatchObject({ result: 'duplicate', rawR2: false, messageId: null });
    for (const line of logs.lines()) {
      for (const secret of ['obs-new', 'secret-sender', 'Confidential', 'Private body', '482913']) expect(line).not.toContain(secret);
    }
  });

  it('附件超过数量上限记 degraded，附件故障抛错时记 error 与断在哪一步，重投修复记 repair', async () => {
    const logs = captureLogs();
    const owner = await seedOwner('obs-degraded');
    await deliver(incoming(owner.address, withAttachments(owner.address, 'obs-degraded', 11)));
    expect(logs.last()).toMatchObject({ result: 'degraded', attachments: 10, attachmentsDropped: true, attachmentBytes: 90 });

    const repaired = await seedOwner('obs-repair');
    const raw = withAttachments(repaired.address, 'obs-repair', 1);
    await expect(deliver(incoming(repaired.address, raw), r2With({ fail: (key) => key.startsWith('att/') }))).rejects.toThrow('injected');
    expect(logs.last()).toMatchObject({ result: 'error', stage: 'attachments', errorClass: 'Error', rawR2: true });
    await deliver(incoming(repaired.address, raw));
    expect(logs.last()).toMatchObject({ result: 'repair', attachments: 1 });
    expect((await db.select().from(messages).where(eq(messages.subject, 'obs-repair')).get())?.status).toBe('received');

    const failing = await seedOwner('obs-store-fail');
    await expect(deliver(incoming(failing.address, plain(failing.address, 'obs-store-fail', 'x')), r2With({ fail: (key) => key.startsWith('raw/') })))
      .rejects.toThrow('injected');
    expect(logs.last()).toMatchObject({ result: 'error', stage: 'store', rawR2: false, messageId: null });
  });

  it('托管域名停用时拒收记 rejected，不写 R2', async () => {
    const logs = captureLogs();
    const [owner] = await db.insert(users).values({ username: 'obs-hosted', passwordHash: 'x', role: 'user' }).returning({ id: users.id });
    await db.insert(hostedDomains).values({ domain: 'obs-hosted.test', userId: owner!.id, status: 'suspended' });
    const message = incoming('anyone@obs-hosted.test', plain('anyone@obs-hosted.test', 'obs rejected', 'x'));
    await deliver(message);
    expect(message.setReject).toHaveBeenCalledOnce();
    expect(logs.last()).toMatchObject({ result: 'rejected', domain: 'obs-hosted.test', rawR2: false });
    expect(logs.lines().at(-1)).not.toContain('anyone@');
  });

  it('MIME 嵌套超过解析上限按解析失败落最小记录，记 parse_failed', async () => {
    const logs = captureLogs();
    const owner = await seedOwner('obs-nested');
    // 50 层：低于 postal-mime 缺省的 256 层，只有显式设置的上限才会拒绝解析
    const depth = 50;
    const parts: string[] = [];
    for (let level = 0; level < depth; level++) parts.push(`Content-Type: multipart/mixed; boundary="n${level}"`, '', `--n${level}`);
    parts.push('Content-Type: text/plain', '', 'deep body');
    for (let level = depth - 1; level >= 0; level--) parts.push(`--n${level}--`);
    const raw = ['From: sender@example.net', `To: ${owner.address}`, 'Subject: obs nested', 'MIME-Version: 1.0', ...parts, ''].join('\r\n');
    await deliver(incoming(owner.address, raw));
    expect(logs.last()).toMatchObject({ result: 'parse_failed', rawR2: true });
    expect((await db.select().from(messages).where(eq(messages.address, owner.address)).get())?.subject).toBe('(邮件解析失败)');
  });
});

describe('孤儿附件（R34）', () => {
  it('附件上传期间邮件被永久删除：不留附件行，这次写入的对象登记清理后被删除', async () => {
    const logs = captureLogs();
    const owner = await seedOwner('obs-purged');
    let purged = false;
    const racing = r2With({ before: async (key) => {
      if (!key.startsWith('att/') || purged) return;
      purged = true;
      await purgeMatchingMessages(env, eq(messages.subject, 'obs-purged'), 10);
    } });
    await deliver(incoming(owner.address, withAttachments(owner.address, 'obs-purged', 2)), racing);
    expect(purged).toBe(true);
    const id = logs.last().messageId!;
    expect(await db.select().from(messages).where(eq(messages.id, id)).all()).toHaveLength(0);
    expect(await db.select().from(attachments).where(eq(attachments.messageId, id)).all()).toHaveLength(0);
    const keys = (await db.select().from(storageCleanupJobs).all()).map((row) => row.r2Key);
    const written = keys.filter((key) => key.startsWith(`att/${id}/`));
    expect(written).toHaveLength(2);
    await processStorageCleanup(env, 1000);
    for (const key of written) expect(await env.r2.head(key)).toBeNull();
  });

  it('每日扫描回收孤儿附件行：登记清理并删行，跳过仍在投递租约里的对象，共享对象保留', async () => {
    const [live] = await db.insert(messages).values({ direction: 'inbound', address: 'obs-live@obs.test', domain: 'obs.test', status: 'received' })
      .returning({ id: messages.id });
    const keys = { shared: 'obs-orphan/shared', plain: 'obs-orphan/plain', leased: 'obs-orphan/leased', expired: 'obs-orphan/expired' };
    for (const key of Object.values(keys)) await env.r2.put(key, 'bytes');
    const gone = 990_000_001;
    await db.insert(attachments).values([
      { messageId: live!.id, r2Key: keys.shared },
      { messageId: gone, r2Key: keys.shared },
      { messageId: gone, r2Key: keys.plain },
      { messageId: gone, r2Key: keys.leased },
      { messageId: gone, r2Key: keys.expired },
    ]);
    await db.insert(deliveryObjectLeases).values([
      { r2Key: keys.leased, token: 'obs-active', expiresAt: new Date(Date.now() + 3_600_000) },
      { r2Key: keys.expired, token: 'obs-expired', expiresAt: new Date(Date.now() - 1000) },
    ]);
    expect(await purgeOrphanAttachments(env)).toBe(3);
    const remaining = await db.select().from(attachments).where(inArray(attachments.r2Key, Object.values(keys))).all();
    expect(remaining.map((row) => [row.messageId, row.r2Key]).sort()).toEqual([[live!.id, keys.shared], [gone, keys.leased]].sort());
    const jobs = (await db.select().from(storageCleanupJobs).where(inArray(storageCleanupJobs.r2Key, Object.values(keys))).all()).map((row) => row.r2Key);
    expect(jobs.sort()).toEqual([keys.expired, keys.plain, keys.shared].sort());
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(keys.plain)).toBeNull();
    expect(await env.r2.head(keys.expired)).toBeNull();
    expect(await env.r2.head(keys.shared)).not.toBeNull();
    expect(await env.r2.head(keys.leased)).not.toBeNull();
  });

  it('孤儿多于一批时沿 id 分批推进', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => ({ messageId: 990_100_000 + index, r2Key: `obs-batch/${index}` }));
    for (let start = 0; start < rows.length; start += 12) await db.insert(attachments).values(rows.slice(start, start + 12));
    expect(await purgeOrphanAttachments(env)).toBe(205);
    expect(await purgeOrphanAttachments(env)).toBe(0);
  });

  it('扫描按主键区间取附件，邮件与租约按主键/唯一索引查找，不扫描整表', async () => {
    const plan = await env.db.prepare(`EXPLAIN QUERY PLAN ${ORPHAN_ATTACHMENTS_SQL}`).bind(0, Date.now(), 200).all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/SEARCH attachments USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    expect(detail).toMatch(/SEARCH messages USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    expect(detail).toContain('sqlite_autoindex_delivery_object_leases_1');
    expect(detail).not.toMatch(/SCAN (messages|delivery_object_leases)\b/);
    expect(detail).not.toMatch(/USE TEMP B-TREE/);
  });
});
