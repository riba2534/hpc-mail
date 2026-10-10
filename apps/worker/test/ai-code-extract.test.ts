import type { Settings } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, users } from '../src/db/schema.js';
import { extractCodeByAi, wantsAiCode } from '../src/services/code-extract.js';
import { handleInbound } from '../src/services/inbound.js';
import { dayWindow, readCounter } from '../src/services/rate-counter.js';
import { updateSettings } from '../src/services/setting.js';
import type { ExecCtx } from '../src/types.js';

const API_KEY = 'sk-synthetic-code-test-key';
const model: Settings['ai_model'] = { baseUrl: 'https://api.deepseek.com', apiKey: API_KEY, model: 'deepseek-flash' };
const unconfigured: Settings['ai_model'] = { baseUrl: '', apiKey: '', model: '' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

type FetchArgs = [input: string | URL | Request, init?: RequestInit];
const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });
function provider(code: string) {
  const fetchMock = vi.fn(async (..._args: FetchArgs) => reply(JSON.stringify({ code })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 正则找不到（码离关键词太远、"verify" 不是正则关键词），只能靠模型 */
const farCode = {
  subject: 'Verify your sign-in',
  text: `Hello,\n\n${'We noticed a new sign-in to your Example account from a new device. '.repeat(3)}\n\n58204716\n\nThanks`,
  html: '',
};

describe('AI 兜底提码 extractCodeByAi', () => {
  it('未配置模型时不调用', async () => {
    const fetchMock = provider('58204716');
    expect(await extractCodeByAi(unconfigured, farCode)).toBe('');
    expect(await extractCodeByAi({ ...model, apiKey: '' }, farCode)).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有验证码相关词、或只让点链接时不调用', async () => {
    const fetchMock = provider('482913');
    const newsletter = { subject: 'Weekly newsletter', text: 'Top stories this week. Order #48291355 shipped.', html: '' };
    expect(wantsAiCode(newsletter)).toBe(false);
    expect(await extractCodeByAi(model, newsletter)).toBe('');
    // URL 里的 code= 不算关键词
    expect(wantsAiCode({ subject: 'Hello', text: 'See https://example.test/a?code=1 and 482913', html: '' })).toBe(false);
    const linkOnly = { subject: 'Anthropic one-time link', text: 'Please click the link below: https://example.test/verify/VGHH62D', html: '' };
    expect(await extractCodeByAi(model, linkOnly)).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
    for (const subject of ['您的验证码', 'Bestätigungscode', 'Tu código', 'Код подтверждения', '認証コード', 'Your OTP', '2FA required']) {
      expect(wantsAiCode({ subject, text: '', html: '' }), subject).toBe(true);
    }
  });

  it('DeepSeek 返回码且在原文中出现时采用，请求关闭思考并只看正文前 6000 字符', async () => {
    const fetchMock = provider('58204716');
    const long = { ...farCode, text: `${farCode.text}\n${'filler '.repeat(2000)}` };
    expect(await extractCodeByAi(model, long)).toBe('58204716');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.deepseek.com/chat/completions');
    expect(init!.redirect).toBe('manual');
    expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init!.body)) as { model: string; thinking?: unknown; response_format: unknown; max_tokens: number; messages: { content: string }[] };
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 64 });
    expect(body.messages[1]!.content.length).toBeLessThanOrEqual('Subject: Verify your sign-in\n\n'.length + 6000);
  });

  it('原文里不存在、只在 URL 中、或格式不对的码一律丢弃', async () => {
    provider('99999999');
    expect(await extractCodeByAi(model, farCode)).toBe('');
    provider('A1B2C3');
    expect(await extractCodeByAi(model, { subject: 'Account security code', text: 'Open https://example.test/session/A1B2C3 to continue.', html: '' })).toBe('');
    provider('this is not a code');
    expect(await extractCodeByAi(model, farCode)).toBe('');
    vi.stubGlobal('fetch', vi.fn(async () => reply('not json')));
    expect(await extractCodeByAi(model, farCode)).toBe('');
  });

  it.each([401, 429, 500, 302])('HTTP %i 返回空串，日志只有状态与耗时', async (status) => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"secret detail"}', { status })));
    expect(await extractCodeByAi(model, farCode)).toBe('');
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: 'ai.provider', purpose: 'code', status, ms: expect.any(Number) });
    expect(logs[0]).not.toContain('58204716');
    expect(logs[0]).not.toContain(API_KEY);
    expect(logs[0]).not.toContain('secret detail');
  });

  it('原文里用空格或连字符分隔的码也能通过回验，但字符必须按顺序出自原文', async () => {
    provider('58204716');
    const spaced = { subject: 'Sign-in attempt', text: 'Type the digits below to sign in.\n\n5 8 2 0 4 7 1 6\n\nThe one-time passcode expires soon.', html: '' };
    expect(await extractCodeByAi(model, spaced)).toBe('58204716');
    provider('482913');
    expect(await extractCodeByAi(model, { subject: 'Your verification code', text: 'Code: 482-913', html: '' })).toBe('482913');
    // 夹在更长数字串里、或顺序不符时仍丢弃
    expect(await extractCodeByAi(model, { subject: 'Your verification code', text: 'Order 9482-9131 shipped', html: '' })).toBe('');
    expect(await extractCodeByAi(model, { subject: 'Your verification code', text: 'Code: 4 8 2 9 3 1', html: '' })).toBe('');
  });

  it('10 秒超时返回空串并中止请求', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const fetchMock = vi.fn((..._args: FetchArgs) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const pending = extractCodeByAi(model, farCode);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe('');
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});

describe('收件链路的 AI 兜底', () => {
  async function seedOwner(address: string) {
    const [user] = await createDb(env).insert(users)
      .values({ username: `aic-${crypto.randomUUID().slice(0, 8)}`, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
    await createDb(env).insert(mailboxes).values({ address, domain: address.split('@')[1]!, userId: user!.id, displayName: '' });
  }
  async function receive(to: string, subject: string, body: string) {
    const raw = [`From: Example <no-reply@example.com>`, `To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0', '', body, ''].join('\r\n');
    const ctx = createExecutionContext() as unknown as ExecCtx;
    await handleInbound({ raw: new Response(raw).body!, headers: new Headers(), to, from: 'no-reply@example.com', forward: vi.fn(), setReject: vi.fn() } as unknown as ForwardableEmailMessage, env, ctx);
    await waitOnExecutionContext(ctx as never);
    return (await createDb(env).select().from(messages).where(eq(messages.address, to)).get())!;
  }
  const aiUsage = async (domain: string) => (await readCounter(env, 'ai-extract', domain, dayWindow())).count;

  it('正则提不到时用 ai_model 补码写库；未配置模型或无关键词时不调用、不占每域额度', async () => {
    await updateSettings(env, { code_extract: { enabled: true, aiEnabled: true }, ai_model: model });
    const fetchMock = provider('58204716');
    const hit = `aic-hit@aic-${crypto.randomUUID().slice(0, 6)}.test`;
    await seedOwner(hit);
    expect((await receive(hit, farCode.subject, farCode.text)).verificationCode).toBe('58204716');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await aiUsage(hit.split('@')[1]!)).toBe(1);

    const plain = `aic-plain@aic-${crypto.randomUUID().slice(0, 6)}.test`;
    await seedOwner(plain);
    expect((await receive(plain, 'Weekly newsletter', 'Top stories this week.')).verificationCode).toBe('');
    expect(await aiUsage(plain.split('@')[1]!)).toBe(0);

    await updateSettings(env, { ai_model: unconfigured });
    const off = `aic-off@aic-${crypto.randomUUID().slice(0, 6)}.test`;
    await seedOwner(off);
    expect((await receive(off, farCode.subject, farCode.text)).verificationCode).toBe('');
    expect(await aiUsage(off.split('@')[1]!)).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
