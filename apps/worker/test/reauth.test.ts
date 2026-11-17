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

const outcome = (userId: number, password: string | undefined) =>
  verifyReauthPassword(env, userId, password).then(() => 'ok', (error: { code?: string; status?: number }) => `${error.code}:${error.status}`);

describe('重新验证密码', () => {
  it('缺少密码 403 reauth_required，错误 403 reauth_failed，正确放行且不留失败计数', async () => {
    const id = await seed('reauth-basic', 'correct-horse-1');
    expect(await outcome(id, undefined)).toBe('reauth_required:403');
    expect(await outcome(id, '')).toBe('reauth_required:403');
    expect(await outcome(id, 'wrong-password')).toBe('reauth_failed:403');
    expect((await readCounter(env, REAUTH_FAIL_SCOPE, String(id), minuteWindow(15))).count).toBe(1);
    expect(await outcome(id, 'correct-horse-1')).toBe('ok');
    expect((await readCounter(env, REAUTH_FAIL_SCOPE, String(id), minuteWindow(15))).count).toBe(1);
  });

  it(`15 分钟内失败 ${MAX_REAUTH_FAILURES} 次后连正确密码也 429，计数只按用户`, async () => {
    const id = await seed('reauth-limit', 'correct-horse-2');
    const other = await seed('reauth-other', 'correct-horse-3');
    const results = await Promise.all(Array.from({ length: MAX_REAUTH_FAILURES + 3 }, () => outcome(id, 'wrong-password')));
    expect(results.filter((r) => r === 'reauth_failed:403')).toHaveLength(MAX_REAUTH_FAILURES);
    expect(results.filter((r) => r === 'rate_limited:429')).toHaveLength(3);
    expect(await outcome(id, 'correct-horse-2')).toBe('rate_limited:429');
    expect(await outcome(other, 'correct-horse-3')).toBe('ok');
  });

  it('改密的原密码校验与重新验证共用失败计数：错误 403 reauth_failed、会话不失效，用尽后连正确原密码也 429（A24）', async () => {
    const id = await seed('reauth-change-password', 'correct-horse-4');
    const app = createApp();
    const jwt = await signToken(env.jwt_secret, { sub: id, sid: await createSession(env, id), epoch: 0, uepoch: 0 });
    const change = async (oldPassword: string) => {
      const ctx = createExecutionContext();
      const response = await app.request('/api/auth/password', { method: 'PUT',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword: 'brand-new-password-5' }) }, env, ctx);
      await waitOnExecutionContext(ctx);
      const body = await response.json() as { error?: { code: string } };
      return `${body.error?.code ?? 'ok'}:${response.status}`;
    };
    for (let index = 0; index < MAX_REAUTH_FAILURES - 1; index++) expect(await change('wrong-password')).toBe('reauth_failed:403');
    // 改密与其他重新验证入口同一个计数：第 5 次失败用在 2FA 等入口上，之后改密也被拒
    expect(await outcome(id, 'wrong-password')).toBe('reauth_failed:403');
    expect(await change('correct-horse-4')).toBe('rate_limited:429');
    expect((await readCounter(env, REAUTH_FAIL_SCOPE, String(id), minuteWindow(15))).count).toBe(MAX_REAUTH_FAILURES);
  });
});
