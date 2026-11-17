import type { TwoFactorDisabled, TwoFactorEnabled, TwoFactorSetup, UserSearchResults } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { invites, users } from '../src/db/schema.js';
import { hmacSha256Base64, hmacSha256Hex, signAttachment, verifyAttachmentSig } from '../src/lib/crypto.js';
import { signToken, verifyToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';
import { generateCode, generateTotpSecret } from '../src/lib/totp.js';
import { login, register } from '../src/services/auth.js';
import { isOwnRelay, relayMarker } from '../src/services/forwarding.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
const db = createDb(env);
const PASSWORD = 'account-security-1';
let seq = 0;

async function request(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const post = (path: string, token: string, body: unknown = {}) => request(path, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
const codeOf = async (response: Response) => ({ status: response.status, code: (await response.json() as { error?: { code: string } }).error?.code });

async function account(name: string, extra: Partial<typeof users.$inferInsert> = {}) {
  await updateSettings(env, { security: { require2fa: false }, register_mode: 'open' });
  const [user] = await db.insert(users).values({ username: `sec-${name}-${++seq}`, passwordHash: await hashPassword(PASSWORD),
    role: 'user', status: 'active', authVersionMigrated: true, ...extra }).returning();
  const sid = await createSession(env, user!.id);
  return { ...user!, jwt: await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: user!.authVersion }) };
}
const currentStep = () => Math.floor(Date.now() / 30_000);
const me = (token: string) => request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });

describe('TOTP 防重放', () => {
  it('同一个验证码只能登录一次，已用时间步记在 users.totp_last_step', async () => {
    const secret = generateTotpSecret();
    const user = await account('replay', { totpSecret: secret, totpEnabledAt: new Date() });
    const code = await generateCode(secret, currentStep());
    const attempt = (ip: string) => login(env, { username: user.username, password: PASSWORD, totp: code }, ip)
      .then(() => 'ok', (error: { code?: string }) => error.code);
    expect(await attempt('192.0.2.10')).toBe('ok');
    expect(await attempt('192.0.2.11')).toBe('bad_credentials');
    expect((await db.select().from(users).where(eq(users.id, user.id)).get())!.totpLastStep).toBe(currentStep());
    // 更早时间步的码同样拒绝
    expect(await login(env, { username: user.username, password: PASSWORD, totp: await generateCode(secret, currentStep() - 1) }, '192.0.2.12')
      .then(() => 'ok', (error: { code?: string }) => error.code)).toBe('bad_credentials');
  });
});

describe('开关两步验证需要密码并让其他会话失效', () => {
  it('登记要当前密码；启用返回新令牌，旧令牌失效，启用用过的码不能再登录', async () => {
    const user = await account('enable');
    expect(await codeOf(await post('/api/auth/2fa/setup', user.jwt))).toEqual({ status: 400, code: 'validation_failed' });
    expect(await codeOf(await post('/api/auth/2fa/setup', user.jwt, { password: 'wrong-password' }))).toEqual({ status: 403, code: 'reauth_failed' });
    const setup = await data<TwoFactorSetup>(await post('/api/auth/2fa/setup', user.jwt, { password: PASSWORD }));
    // 验证码错误是 400，不是会让网页清掉会话的 401
    expect(await codeOf(await post('/api/auth/2fa/enable', user.jwt, { code: '000000' === await generateCode(setup.secret, currentStep()) ? '111111' : '000000' })))
      .toEqual({ status: 400, code: 'validation_failed' });
    const code = await generateCode(setup.secret, currentStep());
    const enabled = await data<TwoFactorEnabled>(await post('/api/auth/2fa/enable', user.jwt, { code }), 201);
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect((await me(user.jwt)).status).toBe(401);
    expect((await me(enabled.token)).status).toBe(200);
    expect(await login(env, { username: user.username, password: PASSWORD, totp: code }, '192.0.2.20')
      .then(() => 'ok', (error: { code?: string }) => error.code)).toBe('bad_credentials');
  });

  it('关闭只接受当前密码，成功后其他会话失效并返回新令牌', async () => {
    const secret = generateTotpSecret();
    const user = await account('disable', { totpSecret: secret, totpEnabledAt: new Date() });
    const other = await signToken(env.jwt_secret, { sub: user.id, sid: await createSession(env, user.id), epoch: 0, uepoch: user.authVersion });
    expect((await post('/api/auth/2fa/disable', user.jwt, { code: await generateCode(secret, currentStep()) })).status).toBe(400);
    expect(await codeOf(await post('/api/auth/2fa/disable', user.jwt, { password: 'wrong-password' }))).toEqual({ status: 403, code: 'reauth_failed' });
    const result = await data<TwoFactorDisabled>(await post('/api/auth/2fa/disable', user.jwt, { password: PASSWORD }));
    expect(result.success).toBe(true);
    expect((await me(other)).status).toBe(401);
    expect((await me(user.jwt)).status).toBe(401);
    expect((await me(result.token)).status).toBe(200);
    expect((await db.select().from(users).where(eq(users.id, user.id)).get())!.totpEnabledAt).toBeNull();
  });
});

describe('关闭用户名与管理员身份枚举', () => {
  it('共享候选搜索不返回角色，管理员的用户搜索仍返回', async () => {
    const user = await account('search-user');
    const [adminRow] = await db.insert(users).values({ username: `sec-search-admin-${++seq}`, passwordHash: 'x', role: 'admin',
      status: 'active', authVersionMigrated: true }).returning();
    const adminJwt = await signToken(env.jwt_secret, { sub: adminRow!.id, sid: await createSession(env, adminRow!.id), epoch: 0, uepoch: 0 });
    const shared = await data<UserSearchResults>(await request('/api/mailboxes/share-users?q=sec-search', { headers: { Authorization: `Bearer ${user.jwt}` } }));
    expect(shared.items.length).toBeGreaterThan(0);
    for (const item of shared.items) expect(item).not.toHaveProperty('role');
    const admin = await data<UserSearchResults>(await request('/api/admin/users/search?q=sec-search', { headers: { Authorization: `Bearer ${adminJwt}` } }));
    expect(admin.items.find((item) => item.id === adminRow!.id)?.role).toBe('admin');
  });

  it('邀请注册先校验邀请码：无效邀请码对已存在的用户名也只报邀请码无效', async () => {
    const existing = await account('invite-existing');
    await updateSettings(env, { register_mode: 'invite' });
    const attempt = (username: string, inviteCode: string) => register(env, { username, password: 'register-pass-1', inviteCode }, `198.51.100.${++seq % 200}`)
      .then(() => 'ok', (error: { code?: string }) => error.code);
    expect(await attempt(existing.username, 'no-such-invite')).toBe('invite_invalid');
    await db.insert(invites).values({ code: `sec-invite-${seq}`, maxUses: 5 });
    expect(await attempt(existing.username, `sec-invite-${seq}`)).toBe('conflict');
    await updateSettings(env, { register_mode: 'open' });
  });
});

describe('jwt_secret 派生子密钥', () => {
  const secret = 'subkey-test-secret';

  async function legacyToken(payload: Record<string, unknown>): Promise<string> {
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
    const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return `${data}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))))}`;
  }

  it('会话令牌用子密钥签名，过渡期仍接受旧密钥签发的令牌', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 1, sid: 's', epoch: 0, uepoch: 0, iat: now, exp: now + 60 };
    const legacy = await legacyToken(claims);
    expect(await verifyToken(secret, legacy)).toMatchObject({ sub: 1 });
    const fresh = await signToken(secret, { sub: 1, sid: 's', epoch: 0, uepoch: 0 }, 60);
    expect(await verifyToken(secret, fresh)).toMatchObject({ sub: 1 });
    // 同样的头与声明，新令牌的签名不再等于直接用 jwt_secret 算出的签名
    expect(fresh.split('.')[2]).not.toBe((await legacyToken(JSON.parse(atob(fresh.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>)).split('.')[2]);
    expect(await verifyToken('another-secret', fresh)).toBeNull();
  });

  it('附件签名用子密钥，已发出的旧签名链接在有效期内仍可下载', async () => {
    const signed = await signAttachment(secret, 7, 90 * 86400);
    expect(signed.sig).not.toBe(await hmacSha256Hex(secret, `att:7.${signed.exp}`));
    expect(await verifyAttachmentSig(secret, 7, signed.exp, signed.sig)).toBe(true);
    expect(await verifyAttachmentSig(secret, 7, signed.exp, await hmacSha256Hex(secret, `att:7.${signed.exp}`))).toBe(true);
    expect(await verifyAttachmentSig(secret, 8, signed.exp, signed.sig)).toBe(false);
  });

  it('中转防环头用子密钥，改用前发出的旧头仍识别为本站中转', async () => {
    const runtime = { ...env, jwt_secret: secret };
    const marker = await relayMarker(runtime);
    const legacy = await hmacSha256Base64(new TextEncoder().encode(secret), 'hpc-mail-relay:v1');
    expect(marker).not.toBe(legacy);
    expect(await isOwnRelay(runtime, marker)).toBe(true);
    expect(await isOwnRelay(runtime, legacy)).toBe(true);
    expect(await isOwnRelay(runtime, 'forged')).toBe(false);
    expect(await isOwnRelay(runtime, null)).toBe(false);
  });
});
