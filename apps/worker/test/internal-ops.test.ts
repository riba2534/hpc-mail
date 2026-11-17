import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import PostalMime from 'postal-mime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { messages, users } from '../src/db/schema.js';
import worker from '../src/index.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import {
  CANARY_RATE_SCOPE, CRON_HEARTBEAT_KEY, pickCanaryDomains, verifyCanaryHeader,
} from '../src/services/ops-probe.js';
import { minuteWindow } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';
import { updateSettings } from '../src/services/setting.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

// 契约夹具：按 CI 的算法用测试 jwt_secret 离线算出，
// printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex
const TOKEN = '91b747e4eb7b32f9bc938767c3335fd602b64b3d4cfc3b002d2537faa8a06643';
// printf '%s' 'hpc-canary-v1:<nonce>' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex
const FIXED_NONCE = '00112233445566778899aabbccddeeff';
const FIXED_SIGNATURE = '4350c28134c8f6ab1f9a6e921e69f4485bca8a3917a739da2f44a0b57ac37d1e';

const app = createApp();
afterEach(() => { vi.restoreAllMocks(); });

type TestEnv = typeof env;

/** send_email binding 在测试配置里不存在，注入一个记录投递的替身 */
function probeEnv(fail?: string) {
  const sent: { from: string; to: string; raw: string }[] = [];
  const send = vi.fn(async (mail: { from: string; to: string; raw: string }) => {
    if (fail) throw new Error(fail);
    sent.push({ from: mail.from, to: mail.to, raw: mail.raw });
  });
  return { runtime: { ...env, build_sha: 'sha-test', email: { send } } as unknown as TestEnv, sent, send };
}

async function call(path: string, init: RequestInit & { token?: string | null } = {}, runtime: TestEnv = env) {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set('X-Canary-Token', init.token ?? TOKEN);
  const ctx = createExecutionContext();
  const response = await app.request(`/api/internal${path}`, { ...init, headers }, runtime, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (body: unknown, runtime: TestEnv, token?: string | null) => call('/canary', {
  method: 'POST', token, headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}, runtime);

async function resetCanaryCounter() {
  await env.db.prepare('DELETE FROM rate_counters WHERE scope = ?').bind(CANARY_RATE_SCOPE).run();
}

async function countRows(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

function inboundMail(to: string, header?: string, raw?: string) {
  const text = raw ?? ['From: HPC Mail Canary <canary@alpha.test>', `To: ${to}`, 'Subject: hpc-canary probe',
    ...(header ? [`X-HPC-Canary: ${header}`] : []), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'canary body', ''].join('\r\n');
  return {
    to, from: 'canary@alpha.test', raw: new Response(text).body!,
    headers: new Headers(header ? { 'X-HPC-Canary': header } : {}),
    forward: vi.fn(async () => {}), setReject: vi.fn(),
  };
}

async function deliver(message: ReturnType<typeof inboundMail>, runtime: TestEnv = env) {
  const ctx = createExecutionContext();
  await worker.email(message as unknown as ForwardableEmailMessage, runtime, ctx);
  await waitOnExecutionContext(ctx);
}

async function runCron(cron: string, runtime: TestEnv) {
  const ctx = createExecutionContext();
  await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController, runtime, ctx);
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await updateSettings(env, {
    domains: { list: ['zeta.test', 'alpha.test', 'mid.test'].map(domain => ({ domain, public: false, perUserLimit: 0 })) },
    code_extract: { enabled: false, aiEnabled: false },
  });
  await resetCanaryCounter();
});

describe('内部运维端点令牌', () => {
  it('令牌缺失、错误或截断时与不存在的接口一样返回 404，正确令牌（openssl 算出）可访问', async () => {
    const { runtime, send } = probeEnv();
    const unknown = await app.request('/api/no-such-endpoint', {}, env);
    const unknownBody = await unknown.json() as { error: unknown };
    expect(unknown.status).toBe(404);
    for (const token of [null, '', 'wrong', TOKEN.slice(0, -1), `${TOKEN.slice(0, -1)}0`, TOKEN.toUpperCase()]) {
      for (const response of [
        await call('/health', { token }, runtime),
        await call(`/canary/${FIXED_NONCE}`, { token }, runtime),
        await post({}, runtime, token),
      ]) {
        expect(response.status).toBe(404);
        expect((await response.json() as { error: unknown }).error).toEqual(unknownBody.error);
      }
    }
    expect(send).not.toHaveBeenCalled();
    expect((await call('/health', {}, runtime)).status).toBe(200);
  });

  it('没有 jwt_secret 时任何令牌都不通过', async () => {
    const runtime = { ...env, jwt_secret: '' } as TestEnv;
    expect((await call('/health', {}, runtime)).status).toBe(404);
  });
});

describe('POST /api/internal/canary', () => {
  it('默认按字母序取前两个系统域名，经 send_email 外发带签名的信，不落库、不占外发配额', async () => {
    const { runtime, sent } = probeEnv();
    const messagesBefore = await countRows('SELECT count(*) AS n FROM messages');
    const quotaBefore = await countRows("SELECT count(*) AS n FROM rate_counters WHERE scope = 'out'");
    const response = await post('', runtime);
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { nonce: string; from: string; to: string; build: string; sentAt: string } };
    expect(data).toMatchObject({ from: 'canary@alpha.test', to: 'canary@mid.test', build: 'sha-test' });
    expect(data.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isNaN(Date.parse(data.sentAt))).toBe(false);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'canary@alpha.test', to: 'canary@mid.test' });
    const parsed = await PostalMime.parse(sent[0]!.raw);
    expect(parsed.subject).toBe(`hpc-canary ${data.nonce}`);
    expect(parsed.from?.address).toBe('canary@alpha.test');
    expect(parsed.to?.map(item => item.address)).toEqual(['canary@mid.test']);
    expect(parsed.text).toContain('金丝雀');
    const header = parsed.headers.find(item => item.key === 'x-hpc-canary')!.value;
    expect(header).toMatch(new RegExp(`^${data.nonce}\\.[0-9a-f]{64}$`));
    expect(sent[0]!.raw.split('\r\n').every(line => line.length <= 998)).toBe(true);

    expect(await countRows('SELECT count(*) AS n FROM messages')).toBe(messagesBefore);
    expect(await countRows("SELECT count(*) AS n FROM rate_counters WHERE scope = 'out'")).toBe(quotaBefore);

    // 收件端用同一封原文走 email 入口：签名被认出，GET 轮询到 received 与 build
    expect((await (await call(`/canary/${data.nonce}`, {}, runtime)).json() as { data: unknown }).data).toEqual({ received: false });
    await deliver(inboundMail('canary@mid.test', header, sent[0]!.raw), runtime);
    const polled = await (await call(`/canary/${data.nonce}`, {}, runtime)).json() as { data: { received: boolean; receivedAt: string; build: string } };
    expect(polled.data).toMatchObject({ received: true, build: 'sha-test' });
    expect(Number.isNaN(Date.parse(polled.data.receivedAt))).toBe(false);
    expect(await countRows('SELECT count(*) AS n FROM messages')).toBe(messagesBefore);
  });

  it('指定的域名必须在系统域名列表内，否则 400 且不外发、不占额度', async () => {
    const { runtime, send } = probeEnv();
    for (const body of [{ fromDomain: 'evil.test' }, { toDomain: 'outside.test' }, { fromDomain: 'alpha.test', toDomain: 'hpc.email' }]) {
      const response = await post(body, runtime);
      expect(response.status).toBe(400);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('validation_failed');
    }
    for (const body of ['{not json', '[]', JSON.stringify({ fromDomain: 42 })]) {
      expect((await post(body, runtime)).status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
    expect(await countRows('SELECT count(*) AS n FROM rate_counters WHERE scope = ?', CANARY_RATE_SCOPE)).toBe(0);

    const chosen = await post({ fromDomain: 'ZETA.test', toDomain: 'alpha.test' }, runtime);
    expect((await chosen.json() as { data: { from: string; to: string } }).data).toMatchObject({ from: 'canary@zeta.test', to: 'canary@alpha.test' });
  });

  it('全站每分钟最多 2 次，超出 429', async () => {
    const { runtime, send } = probeEnv();
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 17, 8, 0, 30));
    expect((await post({}, runtime)).status).toBe(200);
    expect((await post({ fromDomain: 'mid.test' }, runtime)).status).toBe(200);
    const limited = await post({}, runtime);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('外发失败返回 502 并带错误信息，不重试', async () => {
    const { runtime, send } = probeEnv('destination rejected by policy');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await post({}, runtime);
    expect(response.status).toBe(502);
    const body = await response.json() as { error: { code: string; message: string }; requestId: string };
    expect(body.error.message).toContain('destination rejected by policy');
    expect(body.requestId).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('域名选择：只有一个系统域名时自发自收，只指定一边时另一边取不同的域名', () => {
    expect(pickCanaryDomains(['solo.test'], {})).toEqual({ fromDomain: 'solo.test', toDomain: 'solo.test' });
    expect(pickCanaryDomains(['b.test', 'a.test', 'c.test'], { fromDomain: 'a.test' })).toEqual({ fromDomain: 'a.test', toDomain: 'b.test' });
    expect(pickCanaryDomains(['b.test', 'a.test', 'c.test'], { toDomain: 'a.test' })).toEqual({ fromDomain: 'b.test', toDomain: 'a.test' });
    expect(() => pickCanaryDomains([], {})).toThrow('尚未配置系统域名');
  });
});

describe('email handler 识别金丝雀', () => {
  it('签名有效：只写 KV，不落库、不转发、不拒收', async () => {
    const [admin] = await createDb(env).insert(users).values({ username: 'canary-admin', passwordHash: 'x', role: 'admin' })
      .returning({ id: users.id });
    await updateUserNotifyPrefs(env, admin!.id, { forward: { enabled: true, addresses: ['ops@example.net'] } });
    const message = inboundMail('canary@mid.test', `${FIXED_NONCE}.${FIXED_SIGNATURE}`);
    await deliver(message, { ...env, build_sha: 'sha-email' } as TestEnv);
    expect(await env.kv.get(`canary:${FIXED_NONCE}`, 'json')).toMatchObject({ build: 'sha-email', to: 'canary@mid.test' });
    expect(await createDb(env).select().from(messages).where(eq(messages.address, 'canary@mid.test')).all()).toHaveLength(0);
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();

    // 对照：同一地址的普通来信照常落库并按管理员偏好转发
    const ordinary = inboundMail('canary@mid.test');
    await deliver(ordinary);
    expect(await createDb(env).select().from(messages).where(eq(messages.address, 'canary@mid.test')).all()).toHaveLength(1);
    expect(ordinary.forward).toHaveBeenCalledWith('ops@example.net');
  });

  it('签名无效、格式不对或 nonce 被改时照常按普通来信落库，不写 KV', async () => {
    const tampered = `ffeeddccbbaa99887766554433221100`;
    const cases = [
      ['bad-sig@alpha.test', `${FIXED_NONCE}.${'0'.repeat(64)}`],
      ['bad-nonce@alpha.test', `${tampered}.${FIXED_SIGNATURE}`],
      ['bad-shape@alpha.test', `${FIXED_NONCE}.${FIXED_SIGNATURE}.extra`],
      ['no-sig@alpha.test', FIXED_NONCE],
    ] as const;
    for (const [address, header] of cases) {
      await deliver(inboundMail(address, header));
      const row = await createDb(env).select().from(messages).where(eq(messages.address, address)).get();
      expect(row?.subject, address).toBe('hpc-canary probe');
    }
    expect(await env.kv.get(`canary:${tampered}`)).toBeNull();
  });

  it('签名校验容忍折行空白；KV 写失败向上抛出交给 SMTP 重投', async () => {
    expect(await verifyCanaryHeader(env, `${FIXED_NONCE}.\r\n ${FIXED_SIGNATURE}`)).toBe(FIXED_NONCE);
    const failing = { ...env, kv: { put: async () => { throw new Error('kv down'); } } } as unknown as TestEnv;
    await expect(worker.email(inboundMail('kv-fail@alpha.test', `${FIXED_NONCE}.${FIXED_SIGNATURE}`) as unknown as ForwardableEmailMessage,
      failing, createExecutionContext())).rejects.toThrow('kv down');
    expect(await createDb(env).select().from(messages).where(eq(messages.address, 'kv-fail@alpha.test')).all()).toHaveLength(0);
  });

  it('GET 轮询的 nonce 格式不对时 400', async () => {
    expect((await call('/canary/not-a-nonce')).status).toBe(400);
  });
});

describe('cron 心跳', () => {
  it('还没有心跳时 health 返回 cron: null', async () => {
    await env.kv.delete(CRON_HEARTBEAT_KEY);
    const response = await call('/health', {}, probeEnv().runtime);
    expect((await response.json() as { data: unknown }).data).toEqual({ build: 'sha-test', cron: null });
  });

  it('scheduled 每次结束写心跳（build、cron、ok），health 原样返回', async () => {
    const { runtime } = probeEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCron('*/5 * * * *', runtime);
    const heartbeat = await env.kv.get<Record<string, unknown>>(CRON_HEARTBEAT_KEY, 'json');
    expect(heartbeat).toMatchObject({ build: 'sha-test', cron: '*/5 * * * *', ok: true, failedSteps: [] });
    expect(Number.isNaN(Date.parse(String(heartbeat!.at)))).toBe(false);
    const health = await (await call('/health', {}, runtime)).json() as { data: unknown };
    expect(health.data).toEqual({ build: 'sha-test', cron: heartbeat });
  });

  it('有步骤失败时心跳 ok=false 并列出失败步骤', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const faulty = { ...env, build_sha: 'sha-faulty', db: new Proxy(env.db, {
      get(target, property) {
        if (property === 'prepare') return (query: string) => {
          if (query.includes('purge_token AS token')) throw new Error('injected failure');
          return target.prepare(query);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) } as TestEnv;
    await runScheduled(faulty, false, '*/5 * * * *');
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-faulty', ok: false, failedSteps: ['purge.recover'] });
  });

  it('心跳写失败只记日志，不影响定时任务', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { ...env, kv: new Proxy(env.kv, {
      get(target, property) {
        if (property === 'put') return async () => { throw new Error('kv down'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) } as TestEnv;
    await expect(runScheduled(failing, false)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('cron 心跳写入失败:', expect.any(Error));
  });

  it('每日维护回收过期的金丝雀限流计数', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const current = minuteWindow(1);
    await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, 1, 0), (?, ?, ?, 1, 0)')
      .bind(CANARY_RATE_SCOPE, 'site', current - 500, CANARY_RATE_SCOPE, 'site', current).run();
    await runCron('0 16 * * *', env);
    const windows = await env.db.prepare('SELECT "window" AS w FROM rate_counters WHERE scope = ?').bind(CANARY_RATE_SCOPE).all<{ w: number }>();
    expect(windows.results.map(row => row.w)).toEqual([current]);
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ cron: '0 16 * * *' });
  });
});
