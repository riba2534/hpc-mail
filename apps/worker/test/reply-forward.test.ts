import type { ApiScope, CreatedApiKey, MessageSummary } from '@hpc-mail/shared';
import { API_SCOPES } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { readMailBody } from '../src/services/mail-body.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { TEST_PASSWORD, testPasswordHash } from './key-helpers.js';

const app = createApp();
const db = createDb(env);
const DOMAIN = 'rf.example';

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function post(token: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}
async function result<T>(response: Response, status: number): Promise<T> {
  const body = await response.json() as { data?: T; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return (body.data ?? body.error) as T;
}
type ErrorBody = { code: string; message: string; fix?: string; docs?: string };

async function actor(username: string, scopes: ApiScope[] = [...API_SCOPES]) {
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 200, dailyRecipients: 500 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username, role: 'user', passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  const key = (await result<CreatedApiKey>(await request('/api/api-keys', post(jwt, { name: 'k', scopes: scopes.filter((scope) => scope !== 'admin'), rateLimit: 600, password: TEST_PASSWORD })), 201)).key;
  return { id: user!.id, jwt, key };
}
async function own(userId: number, local: string) {
  return (await db.insert(mailboxes).values({ address: `${local}@${DOMAIN}`, domain: DOMAIN, userId }).returning().get())!;
}
async function source(values: Partial<typeof messages.$inferInsert> & { address: string }) {
  return (await db.insert(messages).values({
    direction: 'inbound', domain: DOMAIN, fromAddress: `boss@${DOMAIN}`, fromName: 'Boss', subject: 'Quarterly plan',
    preview: 'p', status: 'received', messageId: `<${crypto.randomUUID()}@outside.example>`, references: '<root@outside.example>',
    bodyText: 'line one\nline two', bodyHtml: '<html><head><style>p{}</style></head><body><p>Hello <b>team</b></p><script>alert(1)</script></body></html>',
    createdAt: new Date('2026-11-01T08:30:00Z'), ...values,
  }).returning().get())!;
}
/** 发件行与完整正文（正文在 R2，D1 只留搜索文本） */
const row = async (id: number) => {
  const found = (await db.select().from(messages).where(eq(messages.id, id)).get())!;
  return { ...found, ...(await readMailBody(env, found)) };
};
const copyFor = async (address: string, messageId: string) => db.select().from(messages)
  .where(and(eq(messages.address, address), eq(messages.messageId, messageId), eq(messages.direction, 'inbound'))).get();

/** 每个用例一组互不相干的用户与地址（同一测试文件共享 D1） */
async function world(prefix: string) {
  const alice = await actor(`${prefix}-alice`);
  const bob = await actor(`${prefix}-bob`);
  const mine = await own(alice.id, `${prefix}-alice`);
  const alias = await own(alice.id, `${prefix}-alias`);
  const peer = await own(bob.id, `${prefix}-peer`);
  await own(bob.id, `${prefix}-boss`);
  return { alice, bob, mine, alias, peer, boss: `${prefix}-boss@${DOMAIN}` };
}

describe('POST /v1/messages/:id/reply', () => {
  it('回给原发件人，主题加 Re:，线程头写进发件行与站内副本，正文后附引用', async () => {
    const w = await world('rf1');
    const src = await source({ address: w.mine.address, fromAddress: w.boss, recipients: { to: [w.mine.address], cc: [], bcc: [] } });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'Thanks!' })), 201);
    expect(sent).toMatchObject({ address: w.mine.address, subject: 'Re: Quarterly plan', status: 'delivered' });
    const out = await row(sent.id);
    expect(out.recipients).toEqual({ to: [w.boss], cc: [], bcc: [] });
    expect(out.inReplyTo).toBe(src.messageId);
    expect(out.references).toBe(`<root@outside.example> ${src.messageId}`);
    expect(out.bodyText).toBe(['Thanks!', '', '----- 原始邮件 -----', '发件人：Boss <' + w.boss + '>', '时间：2026-11-01 08:30 UTC',
      '主题：Quarterly plan', '', '> line one', '> line two'].join('\n'));
    expect(out.bodyHtml).toBe('');
    expect((await copyFor(w.boss, out.messageId!))?.inReplyTo).toBe(src.messageId);
  });

  it('replyAll 抄送其他收件人，去掉自己与自己认领的地址，不带原密送；Reply-To 优先', async () => {
    const w = await world('rf2');
    const src = await source({
      address: w.mine.address, fromAddress: w.boss, replyTo: [w.peer.address],
      recipients: { to: [w.mine.address, `rf2-x@${DOMAIN}`], cc: [w.alias.address.toUpperCase(), `rf2-y@${DOMAIN}`], bcc: [`rf2-z@${DOMAIN}`] },
    });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'All', replyAll: true, quote: false })), 201);
    expect((await row(sent.id)).recipients).toEqual({ to: [w.peer.address], cc: [`rf2-x@${DOMAIN}`, `rf2-y@${DOMAIN}`], bcc: [] });
    expect((await row(sent.id)).bodyText).toBe('All');
  });

  it('回复自己发出的信：回给原收件人；只给 html 时引用原 HTML 的 body，去掉脚本，不生成只有引用的纯文本', async () => {
    const w = await world('rf3');
    const src = await source({
      direction: 'outbound', address: w.mine.address, fromAddress: w.mine.address, status: 'sent',
      recipients: { to: [w.peer.address], cc: [w.alias.address], bcc: [] },
    });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { html: '<p>Follow-up</p>', replyAll: true })), 201);
    const out = await row(sent.id);
    expect(out.recipients).toEqual({ to: [w.peer.address], cc: [], bcc: [] });
    expect(out.bodyText).toBe('');
    expect(out.bodyHtml).toContain('<p>Follow-up</p>');
    expect(out.bodyHtml).toContain('<blockquote');
    expect(out.bodyHtml).toContain('<p>Hello <b>team</b></p>');
    expect(out.bodyHtml).not.toMatch(/<script|<style|<head/);
  });

  it('原文过长时截断引用并注明，不报错', async () => {
    const w = await world('rf4');
    const src = await source({ address: w.mine.address, fromAddress: w.boss, bodyText: 'x'.repeat(1100 * 1024), bodyHtml: '' });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'ok' })), 201);
    const res = await request(`/v1/messages/${sent.id}`, { headers: { Authorization: `Bearer ${w.alice.key}` } });
    const detail = await result<{ bodyText: string }>(res, 200);
    expect(detail.bodyText.startsWith('ok\n')).toBe(true);
    expect(detail.bodyText.endsWith('（原文过长，已截断）')).toBe(true);
    expect(new TextEncoder().encode(detail.bodyText).byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('共享来的邮件不给 from 返回 from_required；指定自己的地址即可回复', async () => {
    const w = await world('rf5');
    await db.insert(mailboxShares).values({ mailboxId: w.peer.id, userId: w.alice.id, grantedBy: w.bob.id });
    const src = await source({ address: w.peer.address, fromAddress: w.boss });
    const error = await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'hi' })), 400);
    expect(error).toMatchObject({ code: 'from_required', fix: expect.stringContaining('GET /v1/identities') });
    expect(error.docs).toContain('/references/errors.md#from_required');
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`,
      post(w.alice.key, { text: 'hi', from: `Alice <${w.mine.address}>`, replyAll: true })), 201);
    expect(sent.address).toBe(w.mine.address);
    // 显式 from 用别人的地址仍是 403
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`,
      post(w.alice.key, { text: 'hi', from: { mailboxId: w.peer.id } })), 403)).code).toBe('forbidden');
  });

  it('需要 mail.send 与 mail.read；来源不可见为 source_unavailable；未知字段 400', async () => {
    const w = await world('rf6');
    const src = await source({ address: w.mine.address, fromAddress: w.boss });
    const sendOnly = await result<CreatedApiKey>(await request('/api/api-keys', post(w.alice.jwt, { name: 's', scopes: ['mail.send'], rateLimit: 600, password: TEST_PASSWORD })), 201);
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(sendOnly.key, { text: 'x' })), 403)).code).toBe('forbidden');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/forward`, post(sendOnly.key, { to: [w.boss] })), 403)).code).toBe('forbidden');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(w.bob.key, { text: 'x' })), 404)).code).toBe('source_unavailable');
    const unknown = await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'x', to: [w.boss], subject: 's' })), 400);
    expect(unknown).toMatchObject({ code: 'validation_failed', message: expect.stringContaining('不接受字段：to, subject') });
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`,
      post(w.alice.key, { text: 'x', headers: { 'In-Reply-To': '<a@b>' } })), 400)).message).toContain('In-Reply-To');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, {})), 400)).message).toContain('正文不能为空');
  });

  it('幂等：同 Key 重放返回同一结果（来源被删后也是），换内容 409', async () => {
    const w = await world('rf7');
    const src = await source({ address: w.mine.address, fromAddress: w.boss });
    const headers = { 'Idempotency-Key': 'rf7-key' };
    const first = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'once' }, headers)), 201);
    await db.delete(messages).where(eq(messages.id, src.id));
    const again = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'once' }, headers)), 201);
    expect(again.id).toBe(first.id);
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'twice' }, headers)), 409)).code)
      .toBe('idempotency_mismatch');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/forward`, post(w.alice.key, { to: [w.boss] }, headers)), 409)).code)
      .toBe('idempotency_mismatch');
    expect((await db.select().from(messages).where(eq(messages.subject, 'Re: Quarterly plan')).all())
      .filter((item) => item.address === w.mine.address)).toHaveLength(1);
  });
});

describe('POST /v1/messages/:id/forward', () => {
  it('主题加 Fwd:，note 在前附原文与头部，原附件带上；原 HTML 一并转发', async () => {
    const w = await world('rf8');
    const src = await source({ address: w.mine.address, fromAddress: w.boss, recipients: { to: [w.mine.address], cc: [w.alias.address], bcc: [] } });
    await env.r2.put(`att/${src.id}/0`, new TextEncoder().encode('PDFDATA'));
    await db.insert(attachments).values({ messageId: src.id, r2Key: `att/${src.id}/0`, filename: 'plan.pdf', mimeType: 'application/pdf', size: 7 });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/forward`,
      post(w.alice.key, { to: [`Peer <${w.peer.address}>`], note: 'FYI' })), 201);
    expect(sent).toMatchObject({ subject: 'Fwd: Quarterly plan', hasAttachments: true, address: w.mine.address });
    const out = await row(sent.id);
    expect(out.inReplyTo).toBeNull();
    expect(out.bodyText).toBe(['FYI', '', '---------- 转发的邮件 ----------', `发件人：Boss <${w.boss}>`, '时间：2026-11-01 08:30 UTC',
      '主题：Quarterly plan', `收件人：${w.mine.address}`, `抄送：${w.alias.address}`, '', 'line one\nline two'].join('\n'));
    expect(out.bodyHtml).toMatch(/^FYI<br><br><div>---------- 转发的邮件 ----------<br>/);
    expect(out.bodyHtml).toContain('<p>Hello <b>team</b></p>');
    const copy = (await copyFor(w.peer.address, out.messageId!))!;
    expect(await db.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.messageId, copy.id)).all())
      .toEqual([{ filename: 'plan.pdf' }]);
  });

  it('removes tracking resources and opaque links even when the source has no attachments', async () => {
    const w = await world('rfprivacy');
    const click = 'https://mail.example/ls/click?upn=test';
    const src = await source({
      address: w.mine.address,
      bodyText: 'Read: ' + click,
      bodyHtml: '<img src="https://mail.example/wf/open"><a href="' + click + '">Login</a>',
    });
    const sent = await result<MessageSummary>(await request('/v1/messages/' + src.id + '/forward',
      post(w.alice.key, { to: [w.peer.address] })), 201);
    const out = await row(sent.id);
    expect(out.bodyText).toContain('追踪链接已移除');
    expect(out.bodyHtml).toContain('<a>Login</a>');
    expect(out.bodyHtml + out.bodyText).not.toContain('mail.example');
  });

  it('includeOriginal=false 只发 note；两者都没有时 400；附件对象丢失为 source_unavailable', async () => {
    const w = await world('rf9');
    const src = await source({ address: w.mine.address, fromAddress: w.boss, subject: 'Fwd: already' });
    const sent = await result<MessageSummary>(await request(`/v1/messages/${src.id}/forward`,
      post(w.alice.key, { to: [w.peer.address], note: 'just this', includeOriginal: false })), 201);
    expect(sent.subject).toBe('Fwd: already');
    expect((await row(sent.id)).bodyText).toBe('just this');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/forward`,
      post(w.alice.key, { to: [w.peer.address], includeOriginal: false })), 400)).message).toContain('note');
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/forward`, post(w.alice.key, { note: 'x' })), 400)).message)
      .toContain('至少需要一个收件人');
    await db.insert(attachments).values({ messageId: src.id, r2Key: `att/${src.id}/missing`, filename: 'gone.bin', mimeType: 'application/octet-stream', size: 3 });
    expect((await result<ErrorBody>(await request(`/v1/messages/${src.id}/forward`, post(w.alice.key, { to: [w.peer.address] })), 404)).code)
      .toBe('source_unavailable');
  });
});

describe('修复轮：回复/转发的主题上限与收件人上限', () => {
  const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('A9：原信主题很长时 Re:/Fwd: 加前缀后按 UTF-8 字节截到主题上限，不切坏字符', async () => {
    const w = await world('rf10');
    const ascii = await source({ address: w.mine.address, fromAddress: w.boss, subject: 'x'.repeat(2048) });
    const reply = await result<MessageSummary>(await request(`/v1/messages/${ascii.id}/reply`, post(w.alice.key, { text: 'ok', quote: false })), 201);
    expect(reply.subject.startsWith('Re: xxx')).toBe(true);
    expect(utf8(reply.subject)).toBeLessThanOrEqual(998);
    for (const op of ['reply', 'forward'] as const) {
      // 4 字节的 emoji：按码元截断会留下半个代理对，按字符数截断会超出字节上限
      const emoji = await source({ address: w.mine.address, fromAddress: w.boss, subject: `${'中'.repeat(3)}${'😀'.repeat(400)}` });
      const sent = await result<MessageSummary>(await request(`/v1/messages/${emoji.id}/${op}`,
        post(w.alice.key, op === 'reply' ? { text: 'ok', quote: false } : { to: [w.peer.address], note: 'fyi', includeOriginal: false })), 201);
      expect(sent.subject.startsWith(op === 'reply' ? 'Re: 中中中😀' : 'Fwd: 中中中😀')).toBe(true);
      expect(utf8(sent.subject)).toBeLessThanOrEqual(998);
      expect(utf8(sent.subject)).toBeGreaterThan(990);
      expect(sent.subject).not.toMatch(loneSurrogate);
      expect(sent.subject.endsWith('😀')).toBe(true);
    }
  });

  it('A22：回复算出的收件人超过单封上限时 400，与直接发信一致', async () => {
    const w = await world('rf11');
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}@outside.example`);
    const flood = await source({ address: w.mine.address, fromAddress: w.boss, replyTo: many('rt', 101) });
    const tooMany = await result<ErrorBody>(await request(`/v1/messages/${flood.id}/reply`, post(w.alice.key, { text: 'x', quote: false })), 400);
    expect(tooMany).toMatchObject({ code: 'validation_failed', message: '收件人合计不能超过 100 个', fix: expect.stringContaining('POST /v1/messages') });
    // 回复全部：To 60 个加 Cc 50 个，去重后超过上限
    const all = await source({ address: w.mine.address, fromAddress: w.boss,
      recipients: { to: [w.mine.address, ...many('to', 59)], cc: many('cc', 50), bcc: [] } });
    expect((await result<ErrorBody>(await request(`/v1/messages/${all.id}/reply`,
      post(w.alice.key, { text: 'x', quote: false, replyAll: true })), 400)).message).toBe('收件人合计不能超过 100 个');
    // 不回复全部时只回给发件人，不受影响
    const single = await result<MessageSummary>(await request(`/v1/messages/${all.id}/reply`, post(w.alice.key, { text: 'x', quote: false })), 201);
    expect((await row(single.id)).recipients).toEqual({ to: [w.boss], cc: [], bcc: [] });
    expect(await db.select().from(messages).where(eq(messages.inReplyTo, flood.messageId!)).all()).toEqual([]);
  });
});

describe('修复轮二：原信主题里的换行', () => {
  it("A9'：原信主题含 CR/LF/TAB（解码后的折行残留）时折叠成单个空格再加前缀，回复与转发都能发出", async () => {
    const w = await world('rf12');
    const src = await source({ address: w.mine.address, fromAddress: w.boss, subject: 'hello\r\n world\tagain\n\nend' });
    const reply = await result<MessageSummary>(await request(`/v1/messages/${src.id}/reply`, post(w.alice.key, { text: 'ok', quote: false })), 201);
    expect(reply.subject).toBe('Re: hello world again end');
    const forward = await result<MessageSummary>(await request(`/v1/messages/${src.id}/forward`,
      post(w.alice.key, { to: [w.peer.address], note: 'fyi', includeOriginal: false })), 201);
    expect(forward.subject).toBe('Fwd: hello world again end');
  });
});
