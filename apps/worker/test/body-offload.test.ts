import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { eq, inArray } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { deliveryObjectLeases, mailboxes, messages, notificationJobs, storageCleanupJobs, users } from '../src/db/schema.js';
import { htmlToText } from '../src/lib/text.js';
import {
  BODY_OFFLOAD_PROGRESS_KEY, BODY_OFFLOAD_SCAN_ROWS, BODY_OFFLOAD_SCAN_SQL, offloadMailBodies, type BodyOffloadProgress,
} from '../src/services/body-offload.js';
import { handleInbound } from '../src/services/inbound.js';
import { BODY_PREVIEW_BYTES, previewBody } from '../src/services/mail-body.js';
import { releaseMailbox } from '../src/services/mailbox.js';
import {
  deleteMessages, findNextMessage, getMessageContent, getMessageDetail, listMessages, purgeMessages, type Viewer,
} from '../src/services/message.js';
import { repairUnqueuedNotifications } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { sendMail } from '../src/services/outbound.js';
import { runScheduled } from '../src/services/scheduled.js';
import { updateSettings } from '../src/services/setting.js';
import { expireDeliveryObjectLeases, processStorageCleanup } from '../src/services/storage-cleanup.js';
import type { Env } from '../src/types.js';
import { collectBackground } from './support/background.js';

/** sendMail 等登记的后台任务在每个用例结束前等完，拆环境时不能还有任务在写日志 */
const background = collectBackground();

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

const db = createDb(env);
const HOUR = 60 * 60_000;
const DOMAIN = 'offload.test';
const encoder = new TextEncoder();
let sequence = 0;

beforeAll(async () => {
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
  });
});

async function owner(prefix: string) {
  const name = `${prefix}-${++sequence}`;
  const user = (await db.insert(users).values({ username: name, passwordHash: 'x', role: 'user', status: 'active' }).returning().get())!;
  const address = `${name}@${DOMAIN}`;
  const box = (await db.insert(mailboxes).values({ userId: user.id, address, domain: DOMAIN }).returning().get())!;
  return { viewer: { userId: user.id, role: 'user' } as Viewer, address, mailboxId: box.id, localPart: name };
}

function mime(to: string, subject: string, parts: { text?: string; html?: string }): string {
  const head = [`From: Sender <sender@example.net>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${subject}@example.net>`, 'MIME-Version: 1.0'];
  if (parts.text !== undefined && parts.html !== undefined) {
    return [...head, 'Content-Type: multipart/alternative; boundary="b1"', '',
      '--b1', 'Content-Type: text/plain; charset=UTF-8', '', parts.text,
      '--b1', 'Content-Type: text/html; charset=UTF-8', '', parts.html, '--b1--', ''].join('\r\n');
  }
  const html = parts.html !== undefined;
  return [...head, `Content-Type: text/${html ? 'html' : 'plain'}; charset=UTF-8`, '', html ? parts.html! : parts.text!].join('\r\n');
}

async function receive(to: string, raw: string) {
  const ctx = createExecutionContext();
  await handleInbound({ to, from: 'sender@example.net', headers: new Headers(), raw: new Response(raw).body!,
    forward: vi.fn(async () => {}), setReject: vi.fn() } as never, env, ctx);
  await waitOnExecutionContext(ctx);
  const parsed = await PostalMime.parse(raw);
  const row = (await db.select().from(messages).where(eq(messages.address, to)).all()).at(-1)!;
  return { row, parsed };
}

const rowOf = async (id: number) => (await db.select().from(messages).where(eq(messages.id, id)).get())!;
const r2Json = async (key: string) => JSON.parse(await (await env.r2.get(key))!.text()) as { text: string; html: string };
const list = (viewer: Viewer, extra: Partial<ListMessagesQuery>) => listMessages(env, viewer, { limit: 30, ...extra } as ListMessagesQuery);
const bytes = (value: string) => encoder.encode(value).length;
const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>paragraph ${i} of a long newsletter body</p>`).join('');

/** 旧版本写入的行：默认 2 小时前收到（已过 1 小时的稳定期） */
async function legacy(values: Partial<typeof messages.$inferInsert> & { address: string }) {
  return (await db.insert(messages).values({
    direction: 'inbound', domain: DOMAIN, status: 'received', subject: 'legacy', createdAt: new Date(Date.now() - 2 * HOUR), ...values,
  }).returning().get())!;
}

/** 回填测试共用一个 D1：每个用例把游标放到当前最大 id，只处理自己造的行 */
async function resetProgress() {
  const max = await env.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first<{ id: number }>();
  await env.db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(BODY_OFFLOAD_PROGRESS_KEY, JSON.stringify({ cursor: max!.id, moved: 0, shrunk: 0, failed: [], failedTotal: 0, caughtUp: false, updatedAt: 0 }))
    .run();
}

async function progress(): Promise<BodyOffloadProgress> {
  const row = await env.db.prepare('SELECT value FROM settings WHERE key = ?').bind(BODY_OFFLOAD_PROGRESS_KEY).first<{ value: string }>();
  return JSON.parse(row!.value) as BodyOffloadProgress;
}

/** R2 包一层，按对象名注入故障 */
function withR2(hooks: { put?: (key: string) => Promise<void> | void; afterPut?: (key: string) => Promise<void> | void; get?: (key: string) => R2ObjectBody | null | undefined }): Env {
  const r2 = new Proxy(env.r2, {
    get(target, property) {
      if (property === 'put') return async (key: string, ...rest: unknown[]) => {
        await hooks.put?.(key);
        const result = await (target.put as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
        await hooks.afterPut?.(key);
        return result;
      };
      if (property === 'get') return async (key: string) => {
        const replaced = hooks.get?.(key);
        return replaced === undefined ? target.get(key) : replaced;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...env, r2 } as Env;
}

const ledger = async (key: string) => (await db.select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, key)).all()).length;

describe('新写入：正文全文在 R2，D1 只留搜索文本', () => {
  it('纯 HTML 收件：D1 不存 HTML、存 HTML 转出的文字（可被搜索）；详情、翻译读取与 wait include=body 都从 R2 读全文', async () => {
    const o = await owner('html-only');
    const html = `<div><h1>SEARCHMARK welcome</h1>${filler(200)}<p>HTMLTAILMARK</p></div>`;
    const { row, parsed } = await receive(o.address, mime(o.address, `html-only-${sequence}`, { html }));
    expect(row.bodyHtml).toBe('');
    expect(row.bodyR2Key).toBe(`body/${row.ingestKey}.json`);
    expect(row.bodyText.startsWith('SEARCHMARK welcome')).toBe(true);
    expect(bytes(row.bodyText)).toBeLessThanOrEqual(BODY_PREVIEW_BYTES);
    expect(await r2Json(row.bodyR2Key!)).toEqual({ text: '', html: parsed.html });

    const detail = await getMessageDetail(env, o.viewer, row.id);
    expect(detail.bodyHtml).toBe(parsed.html);
    expect(detail.bodyText).toBe('');
    expect((await getMessageContent(env, o.viewer, row.id)).bodyHtml).toBe(parsed.html);
    const waited = await findNextMessage(env, o.viewer, { afterId: row.id - 1, address: [o.address], include: 'body' });
    expect(waited.message && 'bodyHtml' in waited.message ? waited.message.bodyHtml : null).toBe(parsed.html);

    expect((await list(o.viewer, { q: 'searchmark' })).items.map((item) => item.id)).toEqual([row.id]);
    // D1 只留开头 BODY_PREVIEW_BYTES：更靠后的文字不在搜索范围
    expect((await list(o.viewer, { q: 'htmltailmark' })).items).toHaveLength(0);
  });

  it('不带 HTML 的短文本全文留在 D1，不写 R2', async () => {
    const o = await owner('short-text');
    const { row, parsed } = await receive(o.address, mime(o.address, `short-text-${sequence}`, { text: 'Your code is 123456' }));
    expect(parsed.text!.trim()).toBe('Your code is 123456');
    expect(row).toMatchObject({ bodyText: parsed.text, bodyHtml: '', bodyR2Key: null });
    expect(await env.r2.head(`body/${row.ingestKey}.json`)).toBeNull();
    expect((await getMessageDetail(env, o.viewer, row.id)).bodyText).toBe(parsed.text);
  });

  it('长纯文本：D1 按 UTF-8 字节截到上限、不留半个字符，详情仍是全文', async () => {
    const o = await owner('long-text');
    const text = `HEADMARK ${'中文🙂'.repeat(2000)} TEXTTAILMARK`;
    const { row, parsed } = await receive(o.address, mime(o.address, `long-text-${sequence}`, { text }));
    expect(row.bodyR2Key).not.toBeNull();
    expect(bytes(row.bodyText)).toBeLessThanOrEqual(BODY_PREVIEW_BYTES);
    expect(bytes(row.bodyText)).toBeGreaterThan(BODY_PREVIEW_BYTES - 4);
    expect(row.bodyText).not.toContain('�');
    expect(parsed.text!.startsWith(row.bodyText)).toBe(true);
    expect((await getMessageDetail(env, o.viewer, row.id)).bodyText).toBe(parsed.text);
    expect((await list(o.viewer, { q: 'headmark' })).items).toHaveLength(1);
  });

  it('文本与 HTML 都有时 D1 留文本段', async () => {
    const o = await owner('both-parts');
    const { row, parsed } = await receive(o.address, mime(o.address, `both-parts-${sequence}`, { text: 'Plain part BOTHMARK', html: '<p>Html part</p>' }));
    expect(row.bodyText.trim()).toBe('Plain part BOTHMARK');
    expect(row.bodyHtml).toBe('');
    expect(await r2Json(row.bodyR2Key!)).toEqual({ text: parsed.text, html: parsed.html });
  });

  it('站内发信：发件行与站内副本各自持有 R2 正文，D1 不存 HTML', async () => {
    const sender = await owner('send-html');
    const recipient = await owner('recv-html');
    const html = `<p>Hello SENDMARK</p>${filler(20)}`;
    await sendMail(env, background.ctx, sender.viewer, {
      from: { localPart: sender.localPart, domain: DOMAIN }, to: [recipient.address], cc: [], bcc: [],
      subject: `send-html-${sequence}`, text: 'Hello SENDMARK', html,
    }, [], 'https://hpc.email');
    const rows = await db.select().from(messages).where(eq(messages.subject, `send-html-${sequence}`)).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.bodyR2Key)).size).toBe(2);
    for (const row of rows) {
      expect(row.bodyHtml).toBe('');
      expect(row.bodyText).toBe('Hello SENDMARK');
      expect(await r2Json(row.bodyR2Key!)).toEqual({ text: 'Hello SENDMARK', html });
    }
    const copy = rows.find((row) => row.direction === 'inbound')!;
    expect((await getMessageDetail(env, recipient.viewer, copy.id)).bodyHtml).toBe(html);
  });

  it('previewBody 按字节截断的边界', () => {
    expect(previewBody('a'.repeat(BODY_PREVIEW_BYTES))).toBe('a'.repeat(BODY_PREVIEW_BYTES));
    expect(previewBody('a'.repeat(BODY_PREVIEW_BYTES + 1))).toBe('a'.repeat(BODY_PREVIEW_BYTES));
    expect(previewBody('🙂'.repeat(1025))).toBe('🙂'.repeat(1024));
    expect(previewBody('中'.repeat(1366))).toBe('中'.repeat(1365));
    expect(previewBody(`${'a'.repeat(BODY_PREVIEW_BYTES - 1)}🙂`)).toBe('a'.repeat(BODY_PREVIEW_BYTES - 1));
  });
});

describe('读取两种存储形态', () => {
  it('旧行内联全文照常读；旧的 R2 大正文读 R2；R2 对象缺失时退回 D1 预览', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = await owner('read-forms');
    const inline = await legacy({ address: o.address, bodyText: 'old text', bodyHtml: '<p>old html</p>' });
    const full = { text: 'T'.repeat(300 * 1024), html: `<p>${'H'.repeat(300 * 1024)}</p>` };
    await env.r2.put('body/read-forms-big.json', JSON.stringify(full));
    const big = await legacy({ address: o.address, bodyText: previewBody(full.text, 64 * 1024), bodyHtml: previewBody(full.html, 64 * 1024), bodyR2Key: 'body/read-forms-big.json' });
    const lost = await legacy({ address: o.address, bodyText: 'search text only', bodyHtml: '', bodyR2Key: 'body/read-forms-missing.json' });

    expect(await getMessageDetail(env, o.viewer, inline.id)).toMatchObject({ bodyText: 'old text', bodyHtml: '<p>old html</p>' });
    expect(await getMessageDetail(env, o.viewer, big.id)).toMatchObject({ bodyText: full.text, bodyHtml: full.html });
    expect(await getMessageDetail(env, o.viewer, lost.id)).toMatchObject({ bodyText: 'search text only', bodyHtml: '' });
    vi.restoreAllMocks();
  });

  it('通知补录从 R2 读全文，不用 D1 的搜索文本', async () => {
    const o = await owner('notify-r2');
    await updateUserNotifyPrefs(env, o.viewer.userId, { pushdeer: { enabled: true, endpoint: '', pushkey: 'PDU_SYNTHETIC_TEST' } });
    await env.r2.put('body/notify-r2.json', JSON.stringify({ text: '', html: '<p>Full R2 body for notify</p>' }));
    const row = await legacy({ address: o.address, notifyOwnerIds: [o.viewer.userId], bodyText: 'D1 search text', bodyR2Key: 'body/notify-r2.json', createdAt: new Date() });
    await repairUnqueuedNotifications(env);
    const jobs = await db.select().from(notificationJobs).where(eq(notificationJobs.messageId, row.id)).all();
    expect(jobs).toHaveLength(1);
    expect((jobs[0]!.payload as { body: string }).body).toBe('Full R2 body for notify');
  });
});

describe('历史正文回填', () => {
  it('内联旧行搬到 R2 并回读校验，已在 R2 的旧行只缩小 D1，新形态不动；详情前后一致，纯 HTML 旧行回填后能被搜到', async () => {
    await resetProgress();
    const o = await owner('backfill');
    const html = `<p>LEGACYHTMLMARK</p>${filler(100)}`;
    const a = await legacy({ address: o.address, ingestKey: `ingest-a-${sequence}`, bodyText: '', bodyHtml: html });
    const b = await legacy({ address: o.address, direction: 'outbound', bodyText: 'text b', bodyHtml: '<p>b</p>' });
    const full = { text: `${'长'.repeat(40 * 1024)}`, html: `<p>${'x'.repeat(100 * 1024)}</p>` };
    await env.r2.put(`body/legacy-c-${sequence}.json`, JSON.stringify(full));
    const c = await legacy({ address: o.address, bodyText: previewBody(full.text, 64 * 1024), bodyHtml: previewBody(full.html, 64 * 1024), bodyR2Key: `body/legacy-c-${sequence}.json` });
    const d = await legacy({ address: o.address, bodyText: 'short' });
    const e = await legacy({ address: o.address, bodyText: 's'.repeat(3000), bodyR2Key: 'body/new-format-e.json' });
    const before = await Promise.all([a, b, c].map((row) => getMessageDetail(env, o.viewer, row.id)));
    expect((await list(o.viewer, { q: 'legacyhtmlmark' })).items).toHaveLength(0);

    expect(await offloadMailBodies(env)).toBe(3);

    const [a2, b2, c2, d2, e2] = [await rowOf(a.id), await rowOf(b.id), await rowOf(c.id), await rowOf(d.id), await rowOf(e.id)];
    expect(a2).toMatchObject({ bodyR2Key: `body/ingest-a-${sequence}.json`, bodyHtml: '', bodyText: previewBody(htmlToText(html)) });
    expect(await r2Json(a2.bodyR2Key!)).toEqual({ text: '', html });
    expect(b2).toMatchObject({ bodyR2Key: `body/msg-${b.id}.json`, bodyHtml: '', bodyText: 'text b' });
    expect(await r2Json(b2.bodyR2Key!)).toEqual({ text: 'text b', html: '<p>b</p>' });
    expect(c2).toMatchObject({ bodyR2Key: c.bodyR2Key, bodyHtml: '', bodyText: previewBody(full.text) });
    expect(await r2Json(c.bodyR2Key!)).toEqual(full);
    expect(d2).toEqual(d);
    expect(e2).toEqual(e);
    expect(await Promise.all([a, b, c].map((row) => getMessageDetail(env, o.viewer, row.id)))).toEqual(before);
    expect((await list(o.viewer, { q: 'legacyhtmlmark' })).items.map((item) => item.id)).toEqual([a.id]);

    const state = await progress();
    expect(state).toMatchObject({ cursor: e.id, moved: 2, shrunk: 1, failed: [], failedTotal: 0, caughtUp: true });
    expect(await db.select().from(deliveryObjectLeases).where(inArray(deliveryObjectLeases.r2Key, [a2.bodyR2Key!, b2.bodyR2Key!])).all()).toEqual([]);
    expect(await ledger(a2.bodyR2Key!) + await ledger(b2.bodyR2Key!)).toBe(0);
    // 已追上：再跑不改任何东西，也不重写进度
    expect(await offloadMailBodies(env)).toBe(0);
    expect((await progress()).updatedAt).toBe(state.updatedAt);
  });

  it('分批推进：每次最多检查 BODY_OFFLOAD_SCAN_ROWS 行、下次从游标继续；1 小时内的新行等过了稳定期再处理', async () => {
    await resetProgress();
    const o = await owner('batches');
    const rows = [];
    for (let i = 0; i < BODY_OFFLOAD_SCAN_ROWS + 5; i++) rows.push(await legacy({ address: o.address, bodyHtml: `<p>batch ${i}</p>` }));
    const fresh = await legacy({ address: o.address, bodyHtml: '<p>fresh</p>', createdAt: new Date() });

    expect(await offloadMailBodies(env)).toBe(BODY_OFFLOAD_SCAN_ROWS);
    expect(await progress()).toMatchObject({ cursor: rows[BODY_OFFLOAD_SCAN_ROWS - 1]!.id, caughtUp: false });
    expect((await rowOf(rows[BODY_OFFLOAD_SCAN_ROWS]!.id)).bodyHtml).toBe(`<p>batch ${BODY_OFFLOAD_SCAN_ROWS}</p>`);

    expect(await offloadMailBodies(env)).toBe(5);
    expect(await progress()).toMatchObject({ cursor: rows.at(-1)!.id, moved: BODY_OFFLOAD_SCAN_ROWS + 5, caughtUp: true });
    expect((await rowOf(fresh.id)).bodyHtml).toBe('<p>fresh</p>');

    expect(await offloadMailBodies(env, Date.now() + 2 * HOUR)).toBe(1);
    expect(await rowOf(fresh.id)).toMatchObject({ bodyHtml: '', bodyR2Key: `body/msg-${fresh.id}.json` });
  });

  it('单行写 R2 失败只记录并跳过，其余行照常；到期后自动重试', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resetProgress();
    const o = await owner('skip');
    const [x, y, z] = [await legacy({ address: o.address, bodyHtml: '<p>x</p>' }),
      await legacy({ address: o.address, bodyHtml: '<p>y</p>' }), await legacy({ address: o.address, bodyHtml: '<p>z</p>' })];
    const faulty = withR2({ put: (key) => { if (key === `body/msg-${y.id}.json`) throw new Error('R2 unavailable'); } });

    expect(await offloadMailBodies(faulty)).toBe(2);
    expect(await rowOf(y.id)).toMatchObject({ bodyHtml: '<p>y</p>', bodyR2Key: null });
    expect((await getMessageDetail(env, o.viewer, y.id)).bodyHtml).toBe('<p>y</p>');
    expect((await rowOf(x.id)).bodyR2Key).not.toBeNull();
    expect((await rowOf(z.id)).bodyR2Key).not.toBeNull();
    const state = await progress();
    expect(state).toMatchObject({ cursor: z.id, moved: 2, failedTotal: 1 });
    expect(state.failed).toMatchObject([{ id: y.id, attempts: 1, error: 'R2 unavailable' }]);

    // 还没到重试时间：不动
    expect(await offloadMailBodies(env)).toBe(0);
    expect(await offloadMailBodies(env, Date.now() + 7 * HOUR)).toBe(1);
    expect(await rowOf(y.id)).toMatchObject({ bodyHtml: '', bodyR2Key: `body/msg-${y.id}.json` });
    expect(await progress()).toMatchObject({ failed: [], failedTotal: 1, moved: 3 });
    vi.restoreAllMocks();
  });

  it('回读内容不一致时不清空 D1，刚写入的对象登记清理并被回收', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resetProgress();
    const o = await owner('readback');
    const row = await legacy({ address: o.address, bodyHtml: '<p>readback</p>' });
    const key = `body/msg-${row.id}.json`;
    const corrupted = { text: async () => 'corrupted' } as unknown as R2ObjectBody;
    expect(await offloadMailBodies(withR2({ get: (name) => (name === key ? corrupted : undefined) }))).toBe(0);
    expect(await rowOf(row.id)).toMatchObject({ bodyHtml: '<p>readback</p>', bodyR2Key: null });
    expect((await progress()).failed).toMatchObject([{ id: row.id, error: 'R2 回读内容与 D1 正文不一致' }]);
    expect(await ledger(key)).toBe(1);
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(key)).toBeNull();
    vi.restoreAllMocks();
  });

  it('已在 R2 的旧行：对象缺失或与 D1 预览对不上时保留 D1 预览', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resetProgress();
    const o = await owner('shrink-guard');
    const missing = await legacy({ address: o.address, bodyText: 'm'.repeat(5000), bodyHtml: '<p>m</p>', bodyR2Key: `body/missing-${sequence}.json` });
    await env.r2.put(`body/other-${sequence}.json`, JSON.stringify({ text: 'different', html: '<p>different</p>' }));
    const mismatch = await legacy({ address: o.address, bodyText: 'n'.repeat(5000), bodyHtml: '<p>n</p>', bodyR2Key: `body/other-${sequence}.json` });

    expect(await offloadMailBodies(env)).toBe(0);
    expect(await rowOf(missing.id)).toEqual(missing);
    expect(await rowOf(mismatch.id)).toEqual(mismatch);
    expect((await progress()).failed.map((item) => item.id)).toEqual([missing.id, mismatch.id]);
    vi.restoreAllMocks();
  });

  it('搬迁期间该行被永久删除：对象登记清理并回收，失败记录在重试时移出', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resetProgress();
    const o = await owner('purged');
    const row = await legacy({ address: o.address, bodyHtml: '<p>purged</p>', deletedAt: new Date() });
    const key = `body/msg-${row.id}.json`;
    const racing = withR2({ afterPut: async (name) => { if (name === key) await purgeMessages(env, o.viewer, [row.id]); } });

    expect(await offloadMailBodies(racing)).toBe(0);
    expect(await db.select().from(messages).where(eq(messages.id, row.id)).get()).toBeUndefined();
    expect((await progress()).failed).toMatchObject([{ id: row.id, error: '回填期间该行被删除或改写' }]);
    expect(await ledger(key)).toBe(1);
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(key)).toBeNull();

    expect(await offloadMailBodies(env, Date.now() + 7 * HOUR)).toBe(0);
    expect((await progress()).failed).toEqual([]);
    vi.restoreAllMocks();
  });

  it('搬迁期间正文被改写：长度对不上不覆盖，重试时按新内容搬迁', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await resetProgress();
    const o = await owner('rewritten');
    const row = await legacy({ address: o.address, bodyHtml: '<p>before</p>' });
    const key = `body/msg-${row.id}.json`;
    const racing = withR2({ afterPut: async (name) => {
      if (name === key) await db.update(messages).set({ bodyHtml: '<p>rewritten after read</p>' }).where(eq(messages.id, row.id));
    } });

    expect(await offloadMailBodies(racing)).toBe(0);
    expect(await rowOf(row.id)).toMatchObject({ bodyHtml: '<p>rewritten after read</p>', bodyR2Key: null });
    expect(await offloadMailBodies(env, Date.now() + 7 * HOUR)).toBe(1);
    expect(await rowOf(row.id)).toMatchObject({ bodyHtml: '', bodyR2Key: key });
    await processStorageCleanup(env, 1000);
    expect(await r2Json(key)).toEqual({ text: '', html: '<p>rewritten after read</p>' });
    expect((await getMessageDetail(env, o.viewer, row.id)).bodyHtml).toBe('<p>rewritten after read</p>');
    vi.restoreAllMocks();
  });

  it('提交前中断：行与游标不变；下一次续跑完成；中断留下的对象在租约到期后按引用回收', async () => {
    await resetProgress();
    const o = await owner('interrupted');
    const kept = await legacy({ address: o.address, bodyHtml: '<p>kept</p>', deletedAt: new Date() });
    const dropped = await legacy({ address: o.address, bodyHtml: '<p>dropped</p>', deletedAt: new Date() });
    const start = (await progress()).cursor;
    // 最后那个改行 + 写进度的事务失败（取行、登记租约的 batch 都只有两条语句）
    const broken = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (statements.length > 2) throw new Error('D1 unavailable');
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;

    await expect(offloadMailBodies(broken)).rejects.toThrow('D1 unavailable');
    expect(await rowOf(kept.id)).toMatchObject({ bodyHtml: '<p>kept</p>', bodyR2Key: null });
    expect((await progress()).cursor).toBe(start);
    const keys = [`body/msg-${kept.id}.json`, `body/msg-${dropped.id}.json`];
    expect((await db.select().from(deliveryObjectLeases).where(inArray(deliveryObjectLeases.r2Key, keys)).all())).toHaveLength(2);

    await purgeMessages(env, o.viewer, [dropped.id]);
    expect(await offloadMailBodies(env)).toBe(1);
    expect(await rowOf(kept.id)).toMatchObject({ bodyHtml: '', bodyR2Key: keys[0] });

    await db.update(deliveryObjectLeases).set({ expiresAt: new Date(0) }).where(inArray(deliveryObjectLeases.r2Key, keys));
    await expireDeliveryObjectLeases(env);
    await processStorageCleanup(env, 1000);
    expect(await env.r2.head(keys[1]!)).toBeNull();
    expect(await r2Json(keys[0]!)).toEqual({ text: '', html: '<p>kept</p>' });
  });

  it('5 分钟定时任务接入回填', async () => {
    await resetProgress();
    const o = await owner('cron');
    const row = await legacy({ address: o.address, bodyHtml: '<p>cron</p>' });
    await runScheduled(env, false);
    expect(await rowOf(row.id)).toMatchObject({ bodyHtml: '', bodyR2Key: `body/msg-${row.id}.json` });
  });

  it('回填的读写都走主键或部分索引，不扫 messages 全表', async () => {
    await resetProgress();
    const o = await owner('plans');
    await legacy({ address: o.address, bodyHtml: '<p>plan</p>' });
    const statements: { sql: string; params: unknown[] }[] = [];
    const capturing = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const entry = { sql: query, params: [] as unknown[] };
        statements.push(entry);
        const statement = target.prepare(query);
        return new Proxy(statement, { get(stmt, key) {
          if (key === 'bind') return (...args: unknown[]) => { entry.params = args; return stmt.bind(...args); };
          const value = Reflect.get(stmt, key);
          return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) } as Env;
    expect(await offloadMailBodies(capturing)).toBe(1);
    const onMessages = statements.filter((item) => /\bmessages\b/.test(item.sql));
    expect(onMessages.length).toBeGreaterThanOrEqual(3);
    for (const item of onMessages) {
      const plan = (await env.db.prepare(`EXPLAIN QUERY PLAN ${item.sql}`).bind(...item.params).all<{ detail: string }>())
        .results.map((row) => row.detail).join(' | ');
      expect(plan, item.sql).not.toMatch(/SCAN messages\b/);
    }
    const scan = await env.db.prepare(`EXPLAIN QUERY PLAN ${BODY_OFFLOAD_SCAN_SQL}`).bind(0, BODY_OFFLOAD_SCAN_ROWS).all<{ detail: string }>();
    expect(scan.results.map((row) => row.detail).join(' | ')).toMatch(/SEARCH messages USING INTEGER PRIMARY KEY \(rowid>\?\)/);
  });
});

describe('删除连带删除 R2 正文', () => {
  it('永久删除、释放并清空历史、保留期清理都删除新形态的正文对象；回填后的行同样', async () => {
    const purged = await owner('del-purge');
    const { row: purgedRow } = await receive(purged.address, mime(purged.address, `del-purge-${sequence}`, { html: '<p>purge me</p>' }));
    await deleteMessages(env, purged.viewer, [purgedRow.id]);
    await purgeMessages(env, purged.viewer, [purgedRow.id]);
    expect(await env.r2.head(purgedRow.bodyR2Key!)).toBeNull();
    expect(await env.r2.head(purgedRow.rawR2Key!)).toBeNull();

    const released = await owner('del-release');
    const { row: releasedRow } = await receive(released.address, mime(released.address, `del-release-${sequence}`, { html: '<p>release me</p>' }));
    await resetProgress();
    const backfilled = await legacy({ address: released.address, bodyHtml: '<p>backfilled</p>' });
    expect(await offloadMailBodies(env)).toBe(1);
    const backfilledKey = (await rowOf(backfilled.id)).bodyR2Key!;
    expect(await env.r2.head(backfilledKey)).not.toBeNull();
    await releaseMailbox(env, released.viewer.userId, released.mailboxId, false, true);
    expect(await env.r2.head(releasedRow.bodyR2Key!)).toBeNull();
    expect(await env.r2.head(backfilledKey)).toBeNull();

    const unclaimed = `nobody-${++sequence}@${DOMAIN}`;
    const { row: oldRow } = await receive(unclaimed, mime(unclaimed, `del-retention-${sequence}`, { html: '<p>expired</p>' }));
    await db.update(messages).set({ createdAt: new Date(Date.now() - 3 * 24 * HOUR) }).where(eq(messages.id, oldRow.id));
    await updateSettings(env, { retention: { unclaimedDays: 1, allMessagesDays: 0 } });
    try {
      await runScheduled(env, true);
    } finally {
      await updateSettings(env, { retention: { unclaimedDays: 0, allMessagesDays: 0 } });
    }
    expect(await db.select().from(messages).where(eq(messages.id, oldRow.id)).get()).toBeUndefined();
    expect(await env.r2.head(oldRow.bodyR2Key!)).toBeNull();
  });
});
