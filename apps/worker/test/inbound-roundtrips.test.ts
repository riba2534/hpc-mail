import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxes, messages, notificationJobs, storageCleanupJobs, users } from '../src/db/schema.js';
import { HTML_TO_TEXT_MAX_CHARS, htmlToText } from '../src/lib/text.js';
import { handleInbound } from '../src/services/inbound.js';
import { purgeMatchingMessages } from '../src/services/message-lifecycle.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { getSettings, updateSettings } from '../src/services/setting.js';
import { processStorageCleanup } from '../src/services/storage-cleanup.js';
// @ts-expect-error Vite 的 ?raw 导入（只用于源码结构断言）
import inboundSource from '../src/services/inbound.ts?raw';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * 包装 env.db / env.r2：记录每次 D1 往返（batch 算一次），按「D1 从空闲转为忙」计串行层数
 * （并行发出的调用算同一层，与墙钟无关）；按顺序记录 D1 与 R2 写入事件、batch 里每条语句的绑定参数，
 * 可注入 D1 batch 或 R2 故障。
 */
function instrumented(options: { failPut?: (key: string) => boolean; failBatch?: boolean } = {}) {
  const real = env.db;
  const sqls: string[] = [];
  const events: string[] = [];
  const batches: { sql: string; params: unknown[] }[][] = [];
  let inFlight = 0;
  let layers = 0;
  const state = { rawPutWhileD1Busy: false, puts: [] as string[] };
  async function timed<T>(sql: string, run: () => Promise<T>): Promise<T> {
    sqls.push(sql);
    if (inFlight++ === 0) layers++;
    events.push(`d1:${layers}`);
    try { return await run(); } finally { inFlight--; }
  }
  const statement = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    __sql: sql, __params: params,
    bind: (...next: unknown[]) => statement(sql, next),
    all: () => timed(sql, () => real.prepare(sql).bind(...params).all()),
    run: () => timed(sql, () => real.prepare(sql).bind(...params).run()),
    raw: (opts?: { columnNames?: boolean }) => timed(sql, () => real.prepare(sql).bind(...params).raw(opts as never)),
    first: (column?: string) => timed(sql, () => real.prepare(sql).bind(...params).first(column as never)),
  }) as unknown as D1PreparedStatement;
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: (list: D1PreparedStatement[]) => {
      const items = list as unknown as { __sql: string; __params: unknown[] }[];
      batches.push(items.map((item) => ({ sql: item.__sql, params: item.__params })));
      return timed(items.map((item) => item.__sql).join(' ;; '), async () => {
        if (options.failBatch) throw new Error('injected D1 batch failure');
        return real.batch(items.map((item) => real.prepare(item.__sql).bind(...item.__params)));
      });
    },
    exec: (query: string) => real.exec(query),
  } as unknown as D1Database;
  const r2 = new Proxy(env.r2, { get(target, property) {
    if (property === 'put') return async (key: string, ...args: unknown[]) => {
      if (key.startsWith('raw/') && inFlight > 0) state.rawPutWhileD1Busy = true;
      state.puts.push(key);
      events.push(`r2:${key.split('/')[0]}`);
      if (options.failPut?.(key)) throw new Error(`injected R2 failure: ${key}`);
      return (target.put as (...a: unknown[]) => Promise<unknown>)(key, ...args);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    env: { ...env, db, r2 }, sqls, events, batches, layers: () => layers, calls: () => sqls.length, state,
    /**
     * handleInbound resolve 时的快照：waitUntil 任务在同一轮微任务里就会发出 D1，
     * 此刻仍在往返中的调用不属于 Ack 前（handler 自己 await 的调用都已完成）。
     */
    ack: () => ({ layers: layers - (inFlight > 0 ? 1 : 0), calls: sqls.length - inFlight }),
  };
}

async function seedOwner(name: string) {
  const [user] = await createDb(env).insert(users)
    .values({ username: name, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
  const address = `${name}@roundtrip.test`;
  await createDb(env).insert(mailboxes).values({ address, domain: 'roundtrip.test', userId: user!.id, displayName: '' });
  return { userId: user!.id, address };
}

function incoming(to: string, raw: string, forward = vi.fn(async () => {})) {
  return { raw: new Response(raw).body!, headers: new Headers(), to, from: 'sender@example.net', forward, setReject: vi.fn() } as unknown as ForwardableEmailMessage;
}

const plainMail = (to: string, subject: string, body: string, id = crypto.randomUUID()) => [
  'From: Sender <sender@example.net>', `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@example.net>`,
  'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');

/** 设置写入会清缓存；先预热，测的是线上常态（isolate 内存缓存命中）下的收件往返 */
async function settingsFor(patch: Parameters<typeof updateSettings>[1]) {
  await updateSettings(env, patch);
  await getSettings(env);
}

describe('收件链路 Ack 前往返', () => {
  it('普通信 Ack 前 2 层串行 D1：去重 batch → 原文写 R2 → 落库；即时投递逐条认领', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    await settingsFor({ code_extract: { enabled: true, aiEnabled: false } });
    const owner = await seedOwner('rt-plain');
    await updateUserNotifyPrefs(env, owner.userId, { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } });
    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, plainMail(owner.address, 'Your login code', 'Your verification code is 482913.')), probe.env as never, ctx);
    const ack = probe.ack();
    expect(ack.layers).toBeLessThanOrEqual(2);
    expect(ack.calls).toBe(2);
    // R2 写入在去重结果出来之后、落库之前（不与去重读重叠）
    expect(probe.events.slice(0, 3)).toEqual(['d1:1', 'r2:raw', 'd1:2']);
    expect(probe.state.rawPutWhileD1Busy).toBe(false);
    await waitOnExecutionContext(ctx);
    // waitUntil：入队一个 batch、过期标记与候选查询一个 batch、逐条认领一次、结果回写一次
    expect(probe.calls() - ack.calls).toBe(4);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    expect(row).toMatchObject({ status: 'received', verificationCode: '482913' });
    const jobs = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).all();
    expect(jobs.map((job) => [job.channel, job.status, job.attempts])).toEqual([['webhook', 'succeeded', 1]]);
  });

  it('原文写 R2 失败时向上抛出，新信不落库、修复中的信保持 pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-raw-fail');
    const raw = plainMail(owner.address, 'rt-raw-fail', 'body that must not be lost');
    const failing = instrumented({ failPut: (key) => key.startsWith('raw/') });
    await expect(handleInbound(incoming(owner.address, raw), failing.env as never, createExecutionContext())).rejects.toThrow('injected R2 failure');
    expect(await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).all()).toHaveLength(0);

    // 附件故障留下 pending 行后，再次投递时原文写入失败：仍然抛出，不能把这一行转为完整状态
    const withAttachment = [
      'From: Sender <sender@example.net>', `To: ${owner.address}`, 'Subject: rt-raw-fail-att', 'Message-ID: <rt-raw-fail-att@example.net>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="rt"', '',
      '--rt', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
      '--rt', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--rt--', ''].join('\r\n');
    await expect(handleInbound(incoming(owner.address, withAttachment), instrumented({ failPut: (key) => key.startsWith('att/') }).env as never,
      createExecutionContext())).rejects.toThrow('injected R2 failure');
    const rowOf = () => createDb(env).select().from(messages).where(eq(messages.subject, 'rt-raw-fail-att')).get();
    expect((await rowOf())?.status).toBe('pending');
    await expect(handleInbound(incoming(owner.address, withAttachment), failing.env as never, createExecutionContext())).rejects.toThrow('injected R2 failure');
    expect((await rowOf())?.status).toBe('pending');

    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, withAttachment), env, ctx);
    await waitOnExecutionContext(ctx);
    const repaired = await rowOf();
    expect(repaired?.status).toBe('received');
    expect(await createDb(env).select().from(attachments).where(eq(attachments.messageId, repaired!.id)).all()).toHaveLength(1);
  });

  it('补投修复按首次收信的归属快照转发，快照里已不是归属人的用户单独补读偏好', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const first = await seedOwner('rt-snapshot-a');
    const [other] = await createDb(env).insert(users)
      .values({ username: 'rt-snapshot-b', passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
    await updateUserNotifyPrefs(env, first.userId, { forward: { enabled: true, addresses: ['rt-snapshot-a@example.net'] } });
    await updateUserNotifyPrefs(env, other!.id, { forward: { enabled: true, addresses: ['rt-snapshot-b@example.net'] } });
    const raw = [
      'From: Sender <sender@example.net>', `To: ${first.address}`, 'Subject: rt-snapshot', 'Message-ID: <rt-snapshot@example.net>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="rt"', '',
      '--rt', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
      '--rt', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--rt--', ''].join('\r\n');
    const forward = vi.fn(async () => {});
    await expect(handleInbound(incoming(first.address, raw, forward), instrumented({ failPut: (key) => key.startsWith('att/') }).env as never,
      createExecutionContext())).rejects.toThrow('injected R2 failure');
    // 首次投递之后地址换了主人；修复投递仍按当时的快照结算
    await createDb(env).update(mailboxes).set({ userId: other!.id }).where(eq(mailboxes.address, first.address));
    const ctx = createExecutionContext();
    await handleInbound(incoming(first.address, raw, forward), env, ctx);
    await waitOnExecutionContext(ctx);
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'rt-snapshot')).get();
    expect(row).toMatchObject({ status: 'received', notifyOwnerIds: [first.userId] });
    expect(forward.mock.calls).toEqual([['rt-snapshot-a@example.net']]);
  });

  it('已完整的重复投递只 1 次 D1 往返即返回，不写 R2、不再转发或通知', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-dup');
    await updateUserNotifyPrefs(env, owner.userId, { forward: { enabled: true, addresses: ['rt-dup-target@example.net'] } });
    const raw = plainMail(owner.address, 'rt-dup', 'same delivery');
    const forward = vi.fn(async () => {});
    const first = createExecutionContext();
    await handleInbound(incoming(owner.address, raw, forward), env, first);
    await waitOnExecutionContext(first);

    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, raw, forward), probe.env as never, ctx);
    expect(probe.ack()).toEqual({ layers: 1, calls: 1 });
    await waitOnExecutionContext(ctx);
    expect(probe.calls()).toBe(1);
    expect(probe.state.puts).toEqual([]);
    expect(forward).toHaveBeenCalledOnce();
    expect(await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).all()).toHaveLength(1);
  });

  it('回收站里的重复投递不写 R2：之后永久删除清理干净，不留无引用的对象', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-dup-purged');
    const raw = plainMail(owner.address, 'rt-dup-purged', 'deleted then redelivered');
    const first = createExecutionContext();
    await handleInbound(incoming(owner.address, raw), env, first);
    await waitOnExecutionContext(first);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    const rawKey = row!.rawR2Key!;
    await createDb(env).update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row!.id));

    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, raw), probe.env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(probe.state.puts).toEqual([]);
    await purgeMatchingMessages(env, eq(messages.id, row!.id), 1);
    await processStorageCleanup(env);
    const refs = await createDb(env).select({ id: messages.id }).from(messages).where(eq(messages.rawR2Key, rawKey)).all();
    const ledger = await createDb(env).select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, rawKey)).all();
    expect({ objectExists: !!(await env.r2.head(rawKey)), refs: refs.length, ledger: ledger.length })
      .toEqual({ objectExists: false, refs: 0, ledger: 0 });
  });

  it('去重 batch 失败时向上抛出且不写任何 R2 对象', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-batch-fail');
    const probe = instrumented({ failBatch: true });
    const big = 'x'.repeat(300 * 1024);
    await expect(handleInbound(incoming(owner.address, plainMail(owner.address, 'rt-batch-fail', big)), probe.env as never,
      createExecutionContext())).rejects.toThrow('injected D1 batch failure');
    expect(probe.state.puts).toEqual([]);
  });

  it('补投修复在上传附件之前提交字段回写：附件再次失败时新写的原文已被这一行引用', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-repair-order');
    const raw = [
      'From: Sender <sender@example.net>', `To: ${owner.address}`, 'Subject: rt-repair-order', 'Message-ID: <rt-repair-order@example.net>',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="rt"', '',
      '--rt', 'Content-Type: text/plain; charset=utf-8', '', 'see attached',
      '--rt', 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--rt--', ''].join('\r\n');
    const failAttachments = () => instrumented({ failPut: (key) => key.startsWith('att/') }).env as never;
    await expect(handleInbound(incoming(owner.address, raw), failAttachments(), createExecutionContext())).rejects.toThrow('injected R2 failure');
    // 模拟早期没有保存原文 key 的 pending 行
    await createDb(env).update(messages).set({ rawR2Key: null }).where(eq(messages.subject, 'rt-repair-order'));
    await expect(handleInbound(incoming(owner.address, raw), failAttachments(), createExecutionContext())).rejects.toThrow('injected R2 failure');
    const row = await createDb(env).select().from(messages).where(eq(messages.subject, 'rt-repair-order')).get();
    expect(row?.status).toBe('pending');
    expect(row?.rawR2Key).toMatch(/^raw\/[0-9a-f]{64}\.eml$/);
    expect(await env.r2.head(row!.rawR2Key!)).not.toBeNull();
  });

  it('去重 batch 每条语句只用一种占位符，绑定参数个数与占位符一一对应', async () => {
    await settingsFor({ code_extract: { enabled: false, aiEnabled: false } });
    const owner = await seedOwner('rt-binds');
    const probe = instrumented();
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, plainMail(owner.address, 'rt-binds', 'bind check')), probe.env as never, ctx);
    await waitOnExecutionContext(ctx);
    const lookup = probe.batches[0]!;
    expect(lookup.map((item) => item.sql).join('\n')).toContain('ingest_key');
    for (const { sql, params } of lookup) {
      const numbered = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
      const anonymous = (sql.match(/\?(?!\d)/g) ?? []).length;
      // 混用时匿名 ? 会占用「已出现的最大编号 + 1」的槽位，新增条件就会静默绑错
      expect(numbered.length > 0 && anonymous > 0, sql).toBe(false);
      expect(params.length, sql).toBe(numbered.length ? Math.max(...numbered) : anonymous);
    }
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    expect(row?.notifyOwnerIds).toEqual([owner.userId]);
  });

  it('原始 .eml 字节不被 handleInbound 内的任何闭包捕获（否则随 waitUntil 后处理一直驻留内存）', () => {
    // workerd 里无法观测堆，用源码结构断言：rawBytes 只出现在 handleInbound 函数体自身的语句里
    expect(closureCaptures('const f = async () => { await put(k, rawBytes); };', 'rawBytes')).toBe(1);
    expect(closureCaptures('items.map((x) => put(x, rawBytes));', 'rawBytes')).toBe(1);
    expect(closureCaptures('function g() { return rawBytes; }', 'rawBytes')).toBe(1);
    expect(closureCaptures('if (a) { await put(k, rawBytes); } const p = Promise.all([put(k, rawBytes), f((x) => x)]);', 'rawBytes')).toBe(0);
    const source = String(inboundSource);
    const start = source.indexOf('export async function handleInbound(');
    const bodyStart = source.indexOf('{', source.indexOf(': Promise<void>', start));
    const body = source.slice(bodyStart + 1, matchingBrace(source, bodyStart));
    expect(stripCommentsAndStrings(body)).toContain('rawBytes');
    expect(closureCaptures(body, 'rawBytes')).toBe(0);
  });

  it('同一封 HTML 信只做一次整段 htmlToText，提码、摘要、AI 兜底与通知正文共用', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).includes('/chat/completions')
      ? Response.json({ choices: [{ message: { content: '{"code":""}' } }] })
      : Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await settingsFor({
      code_extract: { enabled: true, aiEnabled: true },
      ai_model: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-synthetic-roundtrip', model: 'deepseek-flash' },
    });
    const owner = await seedOwner('rt-html');
    await updateUserNotifyPrefs(env, owner.userId, { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } });
    const token = 'RTHTMLTOKEN';
    // 正则提不到码（数字离关键词太远）→ 进入 AI 兜底；锚点让链接提取走自己的标记文本
    const html = `<html><head><style>.x{color:red}</style></head><body><p>${token} Please verify your sign-in.</p>`
      + `${'<p>We noticed a new sign-in to your account from a new device.</p>'.repeat(40)}<p>58204716</p>`
      + '<a href="https://example.net/verify?t=abcdefghijklmnopqrstuvwxyz">Verify</a></body></html>';
    const raw = ['From: Example <no-reply@example.net>', `To: ${owner.address}`, 'Subject: Verify your sign-in', 'Message-ID: <rt-html@example.net>',
      'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
    const slice = vi.spyOn(String.prototype, 'slice');
    const ctx = createExecutionContext();
    await handleInbound(incoming(owner.address, raw), env, ctx);
    await waitOnExecutionContext(ctx);
    // htmlToText 入口对入参整体截取 (0, HTML_TO_TEXT_MAX_CHARS)；只数作用于整份正文（含标记、非链接提取标记文本）的那一次
    const fullConversions = slice.mock.calls.filter((args, index) => {
      const subject = String(slice.mock.contexts[index]);
      return args.length === 2 && args[0] === 0 && args[1] === HTML_TO_TEXT_MAX_CHARS
        && subject.includes(token) && !subject.includes('\u0001');
    }).length;
    slice.mockRestore();
    expect(fullConversions).toBe(1);

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/chat/completions'))).toBe(true);
    const row = await createDb(env).select().from(messages).where(eq(messages.address, owner.address)).get();
    const plain = htmlToText(html);
    expect(row!.preview).toBe(plain.replace(/\s+/g, ' ').trim().slice(0, 160));
    expect(row!.verificationLink).toBe('https://example.net/verify?t=abcdefghijklmnopqrstuvwxyz');
    const [job] = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, row!.id)).all();
    expect((job!.payload as { body: string }).body).toBe(plain.slice(0, 4000));
  });
});

/** 去掉注释与单/双引号字符串（模板字符串保留，其中的花括号成对出现） */
function stripCommentsAndStrings(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function matchingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

const CONTROL_HEADER = /\b(?:if|for|while|switch|catch|with)\s*$/;

/**
 * 数 name 出现在闭包里的次数：从出现位置向外逐层找未闭合的括号；
 * 某层在出现位置之前（该层最后一个 ; 或 , 之后）有 =>，或外层花括号是箭头/函数体，就算被闭包捕获。
 */
function closureCaptures(raw: string, name: string): number {
  const code = stripCommentsAndStrings(raw);
  let count = 0;
  for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
    let end = match.index;
    let captured = false;
    for (;;) {
      let depth = 0;
      let i = end - 1;
      let segment = '';
      for (; i >= 0; i--) {
        const ch = code[i]!;
        if (')]}'.includes(ch)) depth++;
        else if ('([{'.includes(ch)) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0) segment = ch + segment;
      }
      if ((segment.split(/[;,]/).pop() ?? '').includes('=>')) captured = true;
      if (i < 0) break;
      if (code[i] === '{') {
        const before = code.slice(0, i).trimEnd();
        if (before.endsWith('=>')) captured = true;
        else if (before.endsWith(')')) {
          let d = 0;
          let j = before.length - 1;
          for (; j >= 0; j--) {
            if (before[j] === ')') d++;
            else if (before[j] === '(' && --d === 0) break;
          }
          if (!CONTROL_HEADER.test(before.slice(0, j))) captured = true;
        }
      }
      end = i;
    }
    if (captured) count++;
  }
  return count;
}
