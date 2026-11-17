import { type CreatedApiKey, type MessageSummary } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, draftAttachments, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { TEST_PASSWORD, testPasswordHash, USER_SCOPES } from './key-helpers.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import {
  fetchUrlAttachments, isForbiddenAddress, parseIPv6,
} from '../src/services/url-attachment.js';
import type { Env } from '../src/types.js';

const app = createApp();
const db = createDb(env);

async function call(runtime: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const json = (token: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function data<T>(response: Response, status = 201): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function failure(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string; fix?: string; docs?: string; details?: { url?: string } } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function account(name: string) {
  await updateSettings(env, {
    domains: { list: [{ domain: 'hpc.email', public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username: name, role: 'user', passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  await db.insert(mailboxes).values({ address: `${name}@hpc.email`, domain: 'hpc.email', userId: user!.id });
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = await data<CreatedApiKey>(await call(env, '/api/api-keys', json(jwt, { name: `${name}-key`, scopes: USER_SCOPES, rateLimit: 600, password: TEST_PASSWORD })));
  return { id: user!.id, key: key.key, address: `${name}@hpc.email` };
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/**
 * 模拟外网：DoH 按 dns 表回答 A/AAAA，其余 URL 交给 routes。记录每次请求（含 redirect 选项）。
 * 没有登记的主机解析失败。
 */
function internet(dns: Record<string, { A?: string[]; AAAA?: string[] }>, routes: Record<string, Handler>) {
  const calls: { url: string; redirect?: RequestInit['redirect'] }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, redirect: init?.redirect });
    if (url.hostname === 'cloudflare-dns.com') {
      const host = url.searchParams.get('name')!;
      const type = url.searchParams.get('type');
      const entry = dns[host];
      if (!entry) return Response.json({ Status: 3 });
      const list = type === '1' ? entry.A ?? [] : entry.AAAA ?? [];
      return Response.json({ Status: 0, Answer: list.map((data) => ({ type: type === '1' ? 1 : 28, data })) });
    }
    const handler = routes[url.href];
    if (!handler) return new Response('no route', { status: 404 });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, contentCalls: () => calls.filter((c) => !c.url.startsWith('https://cloudflare-dns.com/')) };
}

afterEach(() => vi.unstubAllGlobals());

const PUBLIC = { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1::1'] };
const bytes = (text: string) => new TextEncoder().encode(text);
const file = (text: string, headers: Record<string, string> = {}) => () =>
  new Response(bytes(text), { headers: { 'Content-Length': String(bytes(text).byteLength), ...headers } });

async function inboundAttachments(address: string, messageId: string) {
  const [copy] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.address, address), eq(messages.messageId, messageId), eq(messages.direction, 'inbound')));
  return db.select().from(attachments).where(eq(attachments.messageId, copy!.id));
}

describe('IP 判定', () => {
  it.each([
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '192.0.0.8', '203.0.113.9',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    '::127.0.0.1', '64:ff9b::a00:1', '2002:0a00:0001::', '2001:db8::1', '2001::1', '2001:2::1', '[::1]', 'not-an-ip',
  ])('拒绝 %s', (ip) => expect(isForbiddenAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34', '::ffff:8.8.8.8', '64:ff9b::808:808',
    '2002:0808:0808::1', '2606:4700::1111', '2a00:1450:4001::1', '[2606:4700::1111]'])('放行 %s', (ip) => expect(isForbiddenAddress(ip)).toBe(false));

  it('IPv6 文本解析：压缩、末尾点分 IPv4、非法写法', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('2001:db8::8:800:200c:417a')).toEqual([0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
    for (const bad of ['1::2::3', '12345::', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.256']) expect(parseIPv6(bad), bad).toBeNull();
  });
});

describe('URL 附件：直接发信', () => {
  it('拉取、转存并随邮件投递；文件名与类型取自响应；手动重定向；发送后转存的附件被回收', async () => {
    const me = await account('urlatt-ok');
    const net = internet({ 'files.example.com': PUBLIC, 'cdn.example.com': PUBLIC }, {
      'https://files.example.com/r/42': () => new Response(null, { status: 302, headers: { Location: 'https://cdn.example.com/blob/report%20v2.pdf?sig=1' } }),
      'https://cdn.example.com/blob/report%20v2.pdf?sig=1': file('%PDF-1.7 report', { 'Content-Type': 'application/pdf; charset=binary' }),
      'https://files.example.com/logo': file('PNGDATA', { 'Content-Type': 'image/png', 'Content-Disposition': 'inline; filename*=UTF-8\'\'%E5%9B%BE%E6%A0%87.png' }),
    });
    const sent = await data<MessageSummary>(await call(env, '/v1/messages', json(me.key, {
      from: me.address, to: ['urlatt-peer@hpc.email'], subject: 'url', html: '<img src="cid:logo">',
      attachments: [{ url: 'https://files.example.com/r/42' }, { url: 'https://files.example.com/logo', contentId: 'logo' },
        { filename: 'note.txt', contentType: 'text/plain', content: btoa('hi') }],
    })));
    expect(sent.status).toBe('delivered');
    expect(net.contentCalls().every((c) => c.redirect === 'manual')).toBe(true);
    const row = await db.select({ messageId: messages.messageId }).from(messages).where(eq(messages.id, sent.id)).get();
    const atts = await inboundAttachments('urlatt-peer@hpc.email', row!.messageId!);
    expect(atts.map((a) => [a.filename, a.mimeType, a.size, a.disposition, a.contentId])).toEqual([
      ['report v2.pdf', 'application/pdf', 15, 'attachment', ''],
      ['图标.png', 'image/png', 7, 'inline', 'logo'],
      ['note.txt', 'text/plain', 2, 'attachment', ''],
    ]);
    expect(await (await env.r2.get(atts[0]!.r2Key))!.text()).toBe('%PDF-1.7 report');
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
  });

  it('同一 Idempotency-Key 重放不再拉取', async () => {
    const me = await account('urlatt-idem');
    const net = internet({ 'files.example.com': PUBLIC }, { 'https://files.example.com/a.txt': file('aaa') });
    const body = { from: me.address, to: ['urlatt-peer2@hpc.email'], subject: 'idem', text: 't', attachments: [{ url: 'https://files.example.com/a.txt' }] };
    const first = await data<MessageSummary>(await call(env, '/v1/messages', json(me.key, body, { 'Idempotency-Key': 'url-idem-1' })));
    const fetchedOnce = net.contentCalls().length;
    const again = await data<MessageSummary>(await call(env, '/v1/messages', json(me.key, body, { 'Idempotency-Key': 'url-idem-1' })));
    expect(again.id).toBe(first.id);
    expect(net.contentCalls()).toHaveLength(fetchedOnce);
  });

  it.each([
    ['https://127.0.0.1/a', '内网'], ['https://[::1]/a', '内网'], ['https://169.254.169.254/latest/meta-data', '内网'],
    ['https://10.1.2.3/a', '内网'], ['https://[::ffff:7f00:1]/a', '内网'], ['https://0x7f.1/a', '内网'],
    ['https://localhost/a', '内网主机名'], ['https://metadata.google.internal/a', '内网主机名'], ['https://printer.local/a', '内网主机名'],
    ['https://intranet/a', '内网主机名'], ['https://files.example.com:8443/a', '443'],
    ['https://mail.example/x', '本站'], ['https://cdn.mail.example/x', '本站'], ['https://MAIL.EXAMPLE./x', '本站'],
  ])('拒绝 %s（不发起内容请求）', async (url, reason) => {
    const me = await account(`urlatt-deny-${Math.random().toString(36).slice(2, 8)}`);
    const net = internet({ 'files.example.com': PUBLIC, 'mail.example': PUBLIC }, {});
    const error = await failure(await call({ ...env, site_origin: 'https://mail.example' } as Env, '/v1/messages', json(me.key, {
      from: me.address, to: ['x@hpc.email'], subject: 's', text: 't', attachments: [{ url }],
    })), 400);
    expect(error.code).toBe('attachment_url_forbidden');
    expect(error.message).toContain(reason);
    expect(error.details!.url).toBeTruthy();
    expect(error.fix).toContain('/uploads');
    expect(error.docs).toContain('/references/errors.md#attachment_url_forbidden');
    expect(net.contentCalls()).toEqual([]);
  });

  it('DNS 解析到内网（A 或 AAAA）拒绝；解析不到或 DoH 不可用算拉取失败', async () => {
    const me = await account('urlatt-dns');
    internet({ 'evil.example': { A: ['93.184.216.34', '10.0.0.5'] }, 'evil6.example': { AAAA: ['::ffff:127.0.0.1'] }, 'void.example': {} }, {});
    const send = (url: string) => call(env, '/v1/messages', json(me.key, { from: me.address, to: ['x@hpc.email'], subject: 's', text: 't', attachments: [{ url }] }));
    expect((await failure(await send('https://evil.example/a'), 400)).code).toBe('attachment_url_forbidden');
    expect((await failure(await send('https://evil6.example/a'), 400)).message).toContain('解析到内网');
    const none = await failure(await send('https://void.example/a'), 422);
    expect(none).toMatchObject({ code: 'attachment_url_fetch_failed', details: { url: 'https://void.example/a' } });
    expect((await failure(await send('https://unknown.example/a'), 422)).message).toContain('解析不到');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    expect((await failure(await send('https://files.example.com/a'), 422)).message).toContain('DNS 解析失败');
  });

  it('重定向到内网、http 或本站时拒绝（details.url 是跳转目标）；最多跟随 3 次', async () => {
    const me = await account('urlatt-redirect');
    const hop = (to: string) => () => new Response(null, { status: 301, headers: { Location: to } });
    internet({ 'files.example.com': PUBLIC, 'internal.example': { A: ['192.168.0.10'] } }, {
      'https://files.example.com/meta': hop('https://169.254.169.254/latest/meta-data/'),
      'https://files.example.com/plain': hop('http://files.example.com/x'),
      'https://files.example.com/inner': hop('https://internal.example/x'),
      'https://files.example.com/1': hop('/2'), 'https://files.example.com/2': hop('/3'), 'https://files.example.com/3': hop('/4'),
      'https://files.example.com/4': hop('/5'), 'https://files.example.com/5': file('five'),
      'https://files.example.com/a': hop('/b'), 'https://files.example.com/b': hop('/c'), 'https://files.example.com/c': hop('/5'),
      'https://files.example.com/nowhere': () => new Response(null, { status: 302 }),
    });
    const send = (url: string) => call(env, '/v1/messages', json(me.key, { from: me.address, to: ['urlatt-peer3@hpc.email'], subject: 's', text: 't', attachments: [{ url }] }));
    expect(await failure(await send('https://files.example.com/meta'), 400)).toMatchObject({ code: 'attachment_url_forbidden', details: { url: 'https://169.254.169.254/latest/meta-data/' } });
    expect((await failure(await send('https://files.example.com/plain'), 400)).message).toContain('https');
    expect(await failure(await send('https://files.example.com/inner'), 400)).toMatchObject({ details: { url: 'https://internal.example/x' } });
    expect((await failure(await send('https://files.example.com/1'), 422)).message).toContain('重定向超过 3 次');
    expect((await failure(await send('https://files.example.com/nowhere'), 422)).message).toContain('没有给出跳转地址');
    await data<MessageSummary>(await send('https://files.example.com/a'));
  });

  it('非 2xx、空内容、Content-Length 与实际不符都是拉取失败；已转存的同批附件被释放', async () => {
    const me = await account('urlatt-fail');
    internet({ 'files.example.com': PUBLIC }, {
      'https://files.example.com/ok': file('fine'),
      'https://files.example.com/missing': () => new Response('secret error page', { status: 404 }),
      'https://files.example.com/empty': () => new Response(new Uint8Array(0), { headers: { 'Content-Length': '0' } }),
      'https://files.example.com/liar': () => new Response(bytes('much longer than declared'), { headers: { 'Content-Length': '4' } }),
    });
    const send = (urls: string[]) => call(env, '/v1/messages', json(me.key, {
      from: me.address, to: ['x@hpc.email'], subject: 's', text: 't', attachments: urls.map((url) => ({ url })),
    }));
    const missing = await failure(await send(['https://files.example.com/ok', 'https://files.example.com/missing']), 422);
    expect(missing.message).toContain('HTTP 404');
    expect(missing.message).not.toContain('secret');
    expect((await failure(await send(['https://files.example.com/empty']), 422)).message).toContain('内容为空');
    expect((await failure(await send(['https://files.example.com/liar']), 422)).code).toBe('attachment_url_fetch_failed');
    // 失败请求里已转存的附件不留给用户：行已删除，对象登记了清理
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
    const jobs = await env.db.prepare(`SELECT COUNT(*) AS n FROM storage_cleanup_jobs WHERE r2_key LIKE ?`).bind(`draft/${me.id}/%`).first<{ n: number }>();
    expect(jobs!.n).toBeGreaterThanOrEqual(2);
  });

  it('发送本身失败（发件人无权）时释放已拉取的附件', async () => {
    const me = await account('urlatt-sendfail');
    internet({ 'files.example.com': PUBLIC }, { 'https://files.example.com/ok': file('fine') });
    const error = await failure(await call(env, '/v1/messages', json(me.key, {
      from: 'someone-else@hpc.email', to: ['x@hpc.email'], subject: 's', text: 't', attachments: [{ url: 'https://files.example.com/ok' }],
    })), 403);
    expect(error.code).toBe('forbidden');
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
  });

  it('超过单个上限（按 Content-Length 预判，不读正文）返回 413', async () => {
    const me = await account('urlatt-big');
    const read = vi.fn();
    internet({ 'files.example.com': PUBLIC }, {
      'https://files.example.com/huge': () => new Response(new ReadableStream({ pull: read }), { headers: { 'Content-Length': String(51 * 1024 * 1024) } }),
    });
    const error = await failure(await call(env, '/v1/messages', json(me.key, {
      from: me.address, to: ['x@hpc.email'], subject: 's', text: 't', attachments: [{ url: 'https://files.example.com/huge' }],
    })), 413);
    expect(error).toMatchObject({ code: 'payload_too_large', details: { url: 'https://files.example.com/huge' } });
  });
});

describe('URL 附件：拉取函数的边界', () => {
  const opts = { selfHosts: ['mail.example'], budgetBytes: 50 * 1024 * 1024 };

  it('没有 Content-Length 时最多读 10MiB；超过即中止', async () => {
    const me = await account('urlatt-chunked');
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    internet({ 'files.example.com': PUBLIC }, {
      'https://files.example.com/stream': () => new Response(new ReadableStream({
        pull(controller) { sent++; if (sent > 11) controller.close(); else controller.enqueue(chunk); },
      })),
      'https://files.example.com/small': () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes('abc')); controller.enqueue(bytes('def')); controller.close(); },
      }), { headers: { 'Content-Type': 'text/plain' } }),
    });
    await expect(fetchUrlAttachments(env, me.id, [{ url: 'https://files.example.com/stream' }], opts)).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(sent).toBeLessThanOrEqual(12);
    const [small] = await fetchUrlAttachments(env, me.id, [{ url: 'https://files.example.com/small' }], opts);
    expect(small).toMatchObject({ size: 6, mimeType: 'text/plain', filename: 'small' });
    expect(await (await env.r2.get(small!.r2Key))!.text()).toBe('abcdef');
    const row = await db.select().from(draftAttachments).where(eq(draftAttachments.token, small!.token)).get();
    expect(row).toMatchObject({ status: 'ready', draftId: null, size: 6 });
  });

  it('预算按前面已占用的扣减；draftId 写进引用；超时算拉取失败', async () => {
    const me = await account('urlatt-budget');
    internet({ 'files.example.com': PUBLIC, 'slow.example': PUBLIC }, {
      'https://files.example.com/600': file('x'.repeat(600)),
      'https://slow.example/never': (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    });
    await expect(fetchUrlAttachments(env, me.id, [{ url: 'https://files.example.com/600' }, { url: 'https://files.example.com/600' }],
      { ...opts, budgetBytes: 1000 })).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.userId, me.id))).toEqual([]);
    const [pinned] = await fetchUrlAttachments(env, me.id, [{ url: 'https://files.example.com/600', filename: 'a.bin', contentType: 'application/x-test' }],
      { ...opts, draftId: 777 });
    expect(await db.select().from(draftAttachments).where(eq(draftAttachments.token, pinned!.token)).get())
      .toMatchObject({ draftId: 777, filename: 'a.bin', mimeType: 'application/x-test' });
    const slow = fetchUrlAttachments(env, me.id, [{ url: 'https://slow.example/never' }], { ...opts, timeoutMs: 50 });
    await expect(slow).rejects.toMatchObject({ code: 'attachment_url_fetch_failed', message: expect.stringContaining('秒未完成') });
  });
});
