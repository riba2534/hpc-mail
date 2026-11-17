import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
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
});
