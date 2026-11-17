import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';
import { createSession } from '../src/services/session.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';
import { MAX_REAUTH_FAILURES, REAUTH_FAIL_SCOPE, verifyReauthPassword } from '../src/services/reauth.js';

async function seed(username: string, password: string): Promise<number> {
  const [row] = await createDb(env).insert(users).values({ username, passwordHash: await hashPassword(password), role: 'user',
    status: 'active', authVersionMigrated: true }).returning({ id: users.id });
  return row!.id;
}

const outcome = (sessionId: string, userId: number, password: string | undefined) =>
  verifyReauthPassword(env, { userId, sessionId }, password).then(() => 'ok', (error: { code?: string; status?: number }) => `${error.code}:${error.status}`);
const failures = async (sessionId: string) => (await readCounter(env, REAUTH_FAIL_SCOPE, sessionId, minuteWindow(15))).count;

/** 以某个会话调用接口（改密、2FA setup），返回 code:status */
async function sessionCall(id: number, sid: string, path: string, method: string, body: unknown) {
  const app = createApp();
  const jwt = await signToken(env.jwt_secret, { sub: id, sid, epoch: 0, uepoch: 0 });
  const ctx = createExecutionContext();
  const response = await app.request(path, { method, headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }, env, ctx);
  await waitOnExecutionContext(ctx);
  const parsed = await response.json() as { error?: { code: string } };
  return `${parsed.error?.code ?? 'ok'}:${response.status}`;
}

describe('重新验证密码', () => {
  it('缺少密码 403 reauth_required，错误 403 reauth_failed，正确放行且不留失败计数', async () => {
    const id = await seed('reauth-basic', 'correct-horse-1');
    const sid = 'reauth-basic-session';
    expect(await outcome(sid, id, undefined)).toBe('reauth_required:403');
    expect(await outcome(sid, id, '')).toBe('reauth_required:403');
    expect(await outcome(sid, id, 'wrong-password')).toBe('reauth_failed:403');
    expect(await failures(sid)).toBe(1);
    expect(await outcome(sid, id, 'correct-horse-1')).toBe('ok');
    expect(await failures(sid)).toBe(1);
  });

  it(`同一会话 15 分钟内失败 ${MAX_REAUTH_FAILURES} 次后连正确密码也 429；计数按会话，同一用户的其他会话不受影响`, async () => {
    const id = await seed('reauth-limit', 'correct-horse-2');
    const results = await Promise.all(Array.from({ length: MAX_REAUTH_FAILURES + 3 }, () => outcome('reauth-limit-a', id, 'wrong-password')));
    expect(results.filter((r) => r === 'reauth_failed:403')).toHaveLength(MAX_REAUTH_FAILURES);
    expect(results.filter((r) => r === 'rate_limited:429')).toHaveLength(3);
    expect(await outcome('reauth-limit-a', id, 'correct-horse-2')).toBe('rate_limited:429');
    expect(await outcome('reauth-limit-b', id, 'correct-horse-2')).toBe('ok');
  });

  it('改密与其他入口共用本会话的失败计数；失窃会话用尽额度后，受害者在自己的会话里仍能改密（A24）', async () => {
    const id = await seed('reauth-change-password', 'correct-horse-4');
    const attacker = await createSession(env, id);
    const victim = await createSession(env, id);
    const change = (sid: string, oldPassword: string) =>
      sessionCall(id, sid, '/api/auth/password', 'PUT', { oldPassword, newPassword: 'brand-new-password-5' });
    for (let index = 0; index < MAX_REAUTH_FAILURES - 1; index++) expect(await change(attacker, 'wrong-password')).toBe('reauth_failed:403');
    // 第 5 次失败用在 2FA 入口上：同一个会话计数，之后这个会话改密也被拒
    expect(await sessionCall(id, attacker, '/api/auth/2fa/setup', 'POST', { password: 'wrong-password' })).toBe('reauth_failed:403');
    expect(await change(attacker, 'correct-horse-4')).toBe('rate_limited:429');
    expect(await failures(attacker)).toBe(MAX_REAUTH_FAILURES);
    // 受害者自己的会话不受影响：用正确原密码改密成功，攻击者的会话随之失效
    expect(await change(victim, 'correct-horse-4')).toBe('ok:200');
    expect(await sessionCall(id, attacker, '/api/auth/2fa/setup', 'POST', { password: 'brand-new-password-5' })).toBe('unauthorized:401');
  });
});
