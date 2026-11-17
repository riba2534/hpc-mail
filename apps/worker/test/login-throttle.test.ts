import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { sha256Hex } from '../src/lib/crypto.js';
import { hashPassword } from '../src/lib/password.js';
import { AppError } from '../src/lib/errors.js';
import { ipBucket, login, loginRetryAfterSeconds } from '../src/services/auth.js';
import { minuteWindow, readCounter } from '../src/services/rate-counter.js';

const app = createApp();

async function seed(username: string, password: string) {
  await createDb(env).insert(users).values({ username, passwordHash: await hashPassword(password), role: 'user', status: 'active',
    authVersionMigrated: true });
}

const attempt = (username: string, password: string, ip: string) =>
  login(env, { username, password }, ip).then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');

async function routeLogin(username: string, password: string, ip: string) {
  const ctx = createExecutionContext();
  const res = await app.request('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ username, password }),
  }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const failCount = async (subject: string) => (await readCounter(env, 'login-fail', subject, minuteWindow(15))).count;

describe('登录防爆破（R11）', () => {
  it('IPv6 按 /64 聚合，IPv4 与无法解析的值原样', () => {
    expect(ipBucket('2001:DB8:0:12::1')).toBe('2001:db8:0:12::/64');
    expect(ipBucket('2001:db8:0:12:ffff:1:2:3')).toBe('2001:db8:0:12::/64');
    expect(ipBucket('2001:0db8:0000:0012:0000:0000:0000:0009')).toBe('2001:db8:0:12::/64');
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('unknown')).toBe('unknown');
    expect(ipBucket('1::2::3')).toBe('1::2::3');
  });

  it('IPv4 映射地址的十六进制写法按 IPv4；回环等 ::/64 内的地址各自成桶（N5）', () => {
    expect(ipBucket('::ffff:102:304')).toBe('1.2.3.4');
    expect(ipBucket('::FFFF:CB00:7109')).toBe('203.0.113.9');
    expect(ipBucket('0:0:0:0:0:ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('::1')).toBe('0:0:0:0:0:0:0:1');
    expect(ipBucket('0:0:0:0:0:0:0:1')).toBe(ipBucket('::1'));
    expect(ipBucket('::')).not.toBe(ipBucket('::1'));
    expect(ipBucket('::1.2.3.4')).not.toBe(ipBucket('::1'));
    expect(ipBucket('::ffff:300.1.1.1')).toBe('::ffff:300.1.1.1');
  });

  it('并发错误口令先占名额再校验：只放行上限内的次数，其余直接 429，计数不超过上限', async () => {
    await seed('throttle-race', 'right-password-1');
    const ip = '198.51.100.21';
    const results = await Promise.all(Array.from({ length: 12 }, () => attempt('throttle-race', 'wrong-password', ip)));
    expect(results.filter((code) => code === 'bad_credentials')).toHaveLength(5);
    expect(results.filter((code) => code === 'rate_limited')).toHaveLength(7);
    expect(await failCount(`i:${await sha256Hex(`ip:${ip}`)}`)).toBe(5);
    // 名额用尽后正确口令同样要等
    expect(await attempt('throttle-race', 'right-password-1', ip)).toBe('rate_limited');
  });

  it('同一 /64 内换地址仍计入同一个 IP 维度', async () => {
    for (let index = 1; index <= 5; index++) {
      expect(await attempt(`throttle-v6-${index}`, 'wrong-password', `2001:db8:aa:bb::${index}`)).toBe('bad_credentials');
    }
    expect(await attempt('throttle-v6-6', 'wrong-password', '2001:db8:aa:bb:1:2:3:4')).toBe('rate_limited');
    expect(await attempt('throttle-v6-6', 'wrong-password', '2001:db8:aa:cc::1')).toBe('bad_credentials');
  });

  it('登录成功只清（用户名|IP）维度，IP 维度之前的失败照算', async () => {
    await seed('throttle-self', 'self-password-1');
    const ip = '198.51.100.33';
    for (let index = 0; index < 3; index++) expect(await attempt(`throttle-victim-${index}`, 'guess', ip)).toBe('bad_credentials');
    expect(await attempt('throttle-self', 'wrong', ip)).toBe('bad_credentials');
    expect(await attempt('throttle-self', 'self-password-1', ip)).toBe('ok');
    // 本人维度已清零、IP 维度仍是 4：成功登录不能给继续撒网腾出名额
    expect(await failCount(`u:${await sha256Hex(`id:throttle-self|${ip}`)}`)).toBe(0);
    expect(await failCount(`i:${await sha256Hex(`ip:${ip}`)}`)).toBe(4);
    expect(await attempt('throttle-victim-8', 'guess', ip)).toBe('bad_credentials');
    expect(await attempt('throttle-victim-9', 'guess', ip)).toBe('rate_limited');
  });

  /** 账号级上限在校验口令之前，几个 IP 就能把管理员定向锁在门外（N3） */
  it('换 IP 打满失败也锁不住账号：其他 IP 的正确口令照常登录', async () => {
    await seed('throttle-account', 'account-password-1');
    for (let index = 1; index <= 6; index++) {
      for (let round = 0; round < 5; round++) expect(await attempt('throttle-account', 'wrong', `203.0.113.${index}`)).toBe('bad_credentials');
      expect(await attempt('throttle-account', 'wrong', `203.0.113.${index}`)).toBe('rate_limited');
    }
    const accepted = await routeLogin('throttle-account', 'account-password-1', '203.0.113.100');
    expect(accepted.status).toBe(200);
  });

  it('IP 维度被打满时 429 带 Retry-After', async () => {
    const ip = '203.0.113.150';
    for (let index = 0; index < 5; index++) expect(await attempt(`throttle-retry-${index}`, 'wrong', ip)).toBe('bad_credentials');
    const limited = await routeLogin('throttle-retry-5', 'wrong', ip);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it('Retry-After 是到当前 15 分钟窗口结束的秒数', () => {
    const start = minuteWindow(15) * 15 * 60_000;
    expect(loginRetryAfterSeconds(start)).toBe(15 * 60);
    expect(loginRetryAfterSeconds(start + 14 * 60_000 + 59_500)).toBe(1);
  });

  it('需要两步验证码的提示不计失败', async () => {
    const username = 'throttle-totp';
    await createDb(env).insert(users).values({ username, passwordHash: await hashPassword('totp-password-1'), role: 'user',
      status: 'active', authVersionMigrated: true, totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabledAt: new Date() });
    for (let index = 0; index < 7; index++) expect(await attempt(username, 'totp-password-1', '198.51.100.44')).toBe('totp_required');
    expect(await failCount(`i:${await sha256Hex('ip:198.51.100.44')}`)).toBe(0);
  });

  /** 口令已对、之后的非口令错误一度不退回占位，几次服务端异常就把本人锁在门外（N6） */
  describe('口令正确后的非猜测失败退回占位', () => {
    const pairCount = async (username: string, ip: string) => failCount(`u:${await sha256Hex(`id:${username}|${ip}`)}`);
    const ipCount = async (ip: string) => failCount(`i:${await sha256Hex(`ip:${ip}`)}`);

    it('两步验证码错误计入失败（与口令错误一样防爆破）', async () => {
      const username = 'throttle-totp-wrong';
      const ip = '198.51.100.51';
      await createDb(env).insert(users).values({ username, passwordHash: await hashPassword('totp-password-2'), role: 'user',
        status: 'active', authVersionMigrated: true, totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabledAt: new Date() });
      const wrong = await login(env, { username, password: 'totp-password-2', totp: '000000' }, ip)
        .then(() => 'ok', (error: { code?: string }) => error.code);
      expect(wrong).toBe('bad_credentials');
      expect(await pairCount(username, ip)).toBe(1);
      expect(await ipCount(ip)).toBe(1);
    });

    it('两步验证校验异常不计失败', async () => {
      const username = 'throttle-totp-broken';
      const ip = '198.51.100.52';
      // 解不出字节的密钥让 HMAC 导入失败，模拟验证码校验阶段的服务端异常
      await createDb(env).insert(users).values({ username, passwordHash: await hashPassword('totp-password-3'), role: 'user',
        status: 'active', authVersionMigrated: true, totpSecret: '!!!!!!!!', totpEnabledAt: new Date() });
      const result = await login(env, { username, password: 'totp-password-3', totp: '123456' }, ip)
        .then(() => 'ok', (error: unknown) => (error instanceof AppError ? error.code : 'error'));
      expect(result).toBe('error');
      expect(await pairCount(username, ip)).toBe(0);
      expect(await ipCount(ip)).toBe(0);
    });

    it('签发令牌异常不计失败', async () => {
      const username = 'throttle-issue-broken';
      const ip = '198.51.100.53';
      await seed(username, 'issue-password-1');
      // 空签名密钥让 JWT 签发抛错
      const result = await login({ ...env, jwt_secret: '' }, { username, password: 'issue-password-1' }, ip)
        .then(() => 'ok', (error: unknown) => (error instanceof AppError ? error.code : 'error'));
      expect(result).toBe('error');
      expect(await pairCount(username, ip)).toBe(0);
      expect(await ipCount(ip)).toBe(0);
    });

    it('停用账号不计失败', async () => {
      const username = 'throttle-disabled';
      const ip = '198.51.100.54';
      await createDb(env).insert(users).values({ username, passwordHash: await hashPassword('disabled-password-1'), role: 'user',
        status: 'disabled', authVersionMigrated: true });
      expect(await attempt(username, 'disabled-password-1', ip)).toBe('user_disabled');
      expect(await pairCount(username, ip)).toBe(0);
      expect(await ipCount(ip)).toBe(0);
    });
  });
});
