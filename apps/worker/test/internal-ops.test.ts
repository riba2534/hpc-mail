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
  CANARY_RATE_SCOPE, CRON_HEARTBEAT_KEY, canaryHeaderValue, pickCanaryDomains, verifyCanaryHeader,
} from '../src/services/ops-probe.js';
import { minuteWindow } from '../src/services/rate-counter.js';
import { runScheduled } from '../src/services/scheduled.js';
import { invalidateSettingsMemory, updateSettings } from '../src/services/setting.js';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public from: string, public to: string, public raw: string) {}
  },
}));

// 契约夹具：按 CI 的算法用测试 jwt_secret 离线算出，
// printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex
const TOKEN = '91b747e4eb7b32f9bc938767c3335fd602b64b3d4cfc3b002d2537faa8a06643';
// 信头签名覆盖 nonce、收件地址与过期时间（CI 不计算，夹具只用来固定算法）：
// printf '%s' 'hpc-canary-v1:<nonce>:canary@mid.test:<exp>' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex
const FIXED_NONCE = '00112233445566778899aabbccddeeff';
const FIXED_EXP = 4102444800;
const FIXED_HEADER = `${FIXED_NONCE}.${FIXED_EXP}.f623c29a99b0ac6c9eccc145fb71be05ec3bdf8c6d60c85744b290c602a5da93`;

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
    expect(header).toMatch(new RegExp(`^${data.nonce}\\.\\d+\\.[0-9a-f]{64}$`));
    // 有效期是发出后 10 分钟
    const ttl = Number(header.split('.')[1]) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
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
    // 与其他路由同一套 parseBody + zod：非法 JSON 文案一致，类型错误与未知字段都拒绝
    const malformed = await post('{not json', runtime);
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as { error: { message: string } }).error.message).toBe('请求体不是合法 JSON');
    for (const body of ['[]', JSON.stringify({ fromDomain: 42 }), JSON.stringify({ fromDomain: 'alpha.test', extra: 1 })]) {
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
    const message = inboundMail('canary@mid.test', FIXED_HEADER);
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

  // 每个用例用独立 nonce：KV 里没有对应回执，且邮件按普通来信落在投递地址上
  const nonceOf = (index: number) => index.toString(16).padStart(32, 'a');
  const future = () => Math.floor(Date.now() / 1000) + 600;
  async function expectOrdinary(address: string, nonce: string, header: string) {
    const before = await countRows('SELECT count(*) AS n FROM messages WHERE address = ?', address);
    await deliver(inboundMail(address, header));
    expect(await countRows('SELECT count(*) AS n FROM messages WHERE address = ?', address), address).toBe(before + 1);
    expect(await env.kv.get(`canary:${nonce}`), address).toBeNull();
  }

  it('签名无效、格式不对、旧格式或 nonce/exp 被改时照常按普通来信落库，不写 KV', async () => {
    const valid = await canaryHeaderValue(env, nonceOf(1), 'canary@alpha.test', future());
    const [, exp, signature] = valid.split('.');
    await expectOrdinary('canary@alpha.test', nonceOf(1), `${nonceOf(1)}.${exp}.${'0'.repeat(64)}`);
    await expectOrdinary('canary@alpha.test', nonceOf(2), `${nonceOf(2)}.${exp}.${signature}`);
    await expectOrdinary('canary@alpha.test', nonceOf(1), `${nonceOf(1)}.${Number(exp) + 1}.${signature}`);
    await expectOrdinary('canary@alpha.test', nonceOf(1), `${valid}.extra`);
    await expectOrdinary('canary@alpha.test', nonceOf(1), `${nonceOf(1)}.${signature}`);
  });

  it('签名绑定收件地址：截获的信头投给其他 canary@系统域名 不会被丢弃', async () => {
    // FIXED_HEADER 签给 canary@mid.test，改投同为系统域名的 canary@zeta.test（先清掉前面用例的回执）
    await env.kv.delete(`canary:${FIXED_NONCE}`);
    await expectOrdinary('canary@zeta.test', FIXED_NONCE, FIXED_HEADER);
    expect(await verifyCanaryHeader(env, FIXED_HEADER, 'canary@mid.test')).toEqual({ nonce: FIXED_NONCE, exp: FIXED_EXP });
  });

  /** 签名通过但条件不满足：不落库、不转发、不写 KV，只记一行 canary_dropped 日志 */
  async function expectDropped(address: string, nonce: string, header: string, reason: string, runtime: TestEnv = env) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await countRows('SELECT count(*) AS n FROM messages WHERE address = ?', address);
    const message = inboundMail(address, header);
    await deliver(message, runtime);
    expect(await countRows('SELECT count(*) AS n FROM messages WHERE address = ?', address), address).toBe(before);
    expect(await env.kv.get(`canary:${nonce}`), address).toBeNull();
    expect(message.forward).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(args => JSON.parse(String(args[0])))).toEqual([{ event: 'canary_dropped', reason, nonce, to: address }]);
    warn.mockRestore();
  }

  it('签名通过但过期、收件人不是 canary@、收件域不在系统域名列表时静默丢弃', async () => {
    // 典型场景：KV 写失败后 SMTP 重投超过 10 分钟，不能落进 canary@ 邮箱去通知管理员
    const expired = Math.floor(Date.now() / 1000) - 1;
    await expectDropped('canary@alpha.test', nonceOf(3), await canaryHeaderValue(env, nonceOf(3), 'canary@alpha.test', expired), 'expired');
    await expectDropped('probe@alpha.test', nonceOf(4), await canaryHeaderValue(env, nonceOf(4), 'probe@alpha.test', future()), 'not_canary_address');
    await expectDropped('canary@outside.test', nonceOf(5), await canaryHeaderValue(env, nonceOf(5), 'canary@outside.test', future()), 'not_system_domain');
    // 对照：同样构造、条件都满足时记回执
    await deliver(inboundMail('canary@alpha.test', await canaryHeaderValue(env, nonceOf(6), 'canary@alpha.test', future())));
    expect(await env.kv.get(`canary:${nonceOf(6)}`, 'json')).toMatchObject({ to: 'canary@alpha.test' });
  });

  it('读设置失败拿到空域名列表时金丝雀静默丢弃，不进普通收件', async () => {
    invalidateSettingsMemory();
    const broken = { ...env, db: new Proxy(env.db, {
      get(target, property) {
        if (property === 'prepare' || property === 'batch') return () => { throw new Error('d1 down'); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) } as TestEnv;
    await expectDropped('canary@alpha.test', nonceOf(7), await canaryHeaderValue(env, nonceOf(7), 'canary@alpha.test', future()), 'not_system_domain', broken);
  });

  it('签名校验容忍折行空白；KV 写失败向上抛出交给 SMTP 重投', async () => {
    const folded = FIXED_HEADER.replace(/\.(?=[0-9a-f]{64}$)/, '.\r\n ');
    expect(await verifyCanaryHeader(env, folded, 'canary@mid.test')).toEqual({ nonce: FIXED_NONCE, exp: FIXED_EXP });
    const failing = { ...env, kv: { put: async () => { throw new Error('kv down'); } } } as unknown as TestEnv;
    await expect(worker.email(inboundMail('canary@mid.test', FIXED_HEADER) as unknown as ForwardableEmailMessage,
      failing, createExecutionContext())).rejects.toThrow('kv down');
  });

  it('GET 轮询的 nonce 格式不对时 400', async () => {
    expect((await call('/canary/not-a-nonce')).status).toBe(400);
  });
});

describe('cron 心跳', () => {
  /** 记录 KV 读写次数，验证心跳只在新 build 首次运行时写 */
  function kvSpy(runtime: TestEnv, failPut = false) {
    const calls = { get: 0, put: 0 };
    const kv = new Proxy(env.kv, {
      get(target, property) {
        if (property === 'get') return (...args: Parameters<KVNamespace['get']>) => { calls.get++; return target.get(...args); };
        if (property === 'put') return async (...args: Parameters<KVNamespace['put']>) => {
          calls.put++;
          if (failPut) throw new Error('kv down');
          return target.put(...args);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { runtime: { ...runtime, kv } as TestEnv, calls };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('还没有心跳时 health 返回 cron: null', async () => {
    await env.kv.delete(CRON_HEARTBEAT_KEY);
    const response = await call('/health', {}, probeEnv().runtime);
    expect((await response.json() as { data: unknown }).data).toEqual({ build: 'sha-test', cron: null });
  });

  it('新 build 首次运行写心跳（build、cron、ok），health 返回最近写入的心跳', async () => {
    await env.kv.delete(CRON_HEARTBEAT_KEY);
    const { runtime } = probeEnv();
    await runCron('*/5 * * * *', runtime);
    const heartbeat = await env.kv.get<Record<string, unknown>>(CRON_HEARTBEAT_KEY, 'json');
    expect(heartbeat).toMatchObject({ build: 'sha-test', cron: '*/5 * * * *', ok: true, failedSteps: [] });
    expect(Number.isNaN(Date.parse(String(heartbeat!.at)))).toBe(false);
    const health = await (await call('/health', {}, runtime)).json() as { data: unknown };
    expect(health.data).toEqual({ build: 'sha-test', cron: heartbeat });
  });

  it('每次运行只读一次 KV，build 不变不写（at 不刷新），换 build 才写', async () => {
    await env.kv.delete(CRON_HEARTBEAT_KEY);
    const first = kvSpy({ ...env, build_sha: 'sha-one' } as TestEnv);
    await runCron('*/5 * * * *', first.runtime);
    expect(first.calls).toEqual({ get: 1, put: 1 });
    const written = await env.kv.get(CRON_HEARTBEAT_KEY, 'json');

    for (let run = 0; run < 2; run++) {
      const same = kvSpy({ ...env, build_sha: 'sha-one' } as TestEnv);
      await runCron('*/5 * * * *', same.runtime);
      expect(same.calls).toEqual({ get: 1, put: 0 });
    }
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toEqual(written);

    const upgraded = kvSpy({ ...env, build_sha: 'sha-two' } as TestEnv);
    await runCron('*/5 * * * *', upgraded.runtime);
    expect(upgraded.calls).toEqual({ get: 1, put: 1 });
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-two' });
  });

  it('发布切换窗口里旧 build 晚写入后，新 build 下一次运行收敛回新 build', async () => {
    await env.kv.delete(CRON_HEARTBEAT_KEY);
    const next = { ...env, build_sha: 'sha-new' } as TestEnv;
    await runCron('*/5 * * * *', next);
    await runCron('*/5 * * * *', { ...env, build_sha: 'sha-old' } as TestEnv);
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-old' });
    await runCron('*/5 * * * *', next);
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-new' });
  });

  it('有步骤失败时心跳 ok=false 并列出失败步骤', async () => {
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

  it('心跳写失败只记日志，不影响定时任务，下次运行重试', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = kvSpy({ ...env, build_sha: 'sha-retry' } as TestEnv, true);
    await expect(runScheduled(failing.runtime, false)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('cron 心跳写入失败:', expect.any(Error));
    const retry = kvSpy({ ...env, build_sha: 'sha-retry' } as TestEnv);
    await runScheduled(retry.runtime, false);
    expect(retry.calls.put).toBe(1);
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-retry' });
  });

  it('每日维护回收过期的金丝雀限流计数', async () => {
    const current = minuteWindow(1);
    await env.db.prepare('INSERT INTO rate_counters (scope, subject, "window", count, units) VALUES (?, ?, ?, 1, 0), (?, ?, ?, 1, 0)')
      .bind(CANARY_RATE_SCOPE, 'site', current - 500, CANARY_RATE_SCOPE, 'site', current).run();
    await runCron('0 16 * * *', { ...env, build_sha: 'sha-daily' } as TestEnv);
    const windows = await env.db.prepare('SELECT "window" AS w FROM rate_counters WHERE scope = ?').bind(CANARY_RATE_SCOPE).all<{ w: number }>();
    expect(windows.results.map(row => row.w)).toEqual([current]);
    expect(await env.kv.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({ build: 'sha-daily', cron: '0 16 * * *' });
  });
});
