import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import type { Env } from '../src/types.js';

const app = createApp();
const origin = 'https://mail.example.test';
const issuer = 'https://id.example.test';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function request(environment: Env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(`${origin}${path}`, init, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const cookie = (response: Response, name: string) => {
  const header = response.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${name}=([^;]+)`));
  if (!match?.[1]) throw new Error(`Missing cookie ${name}`);
  return `${name}=${match[1]}`;
};
async function setup() {
  const [user] = await createDb(env).insert(users).values({ username: `oidc-${crypto.randomUUID().slice(0, 8)}`, passwordHash: 'test', role: 'admin', status: 'active', authVersionMigrated: true }).returning();
  const conf: Env = { ...env, site_origin: origin, oidc_issuer: issuer, oidc_client_id: 'client', oidc_client_secret: 'secret', oidc_subject: 'trusted-subject', oidc_user_id: String(user!.id) };
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'key1', alg: 'RS256', use: 'sig' };
  let nonce = '';
  let challenge = '';
  let claims: Record<string, unknown> = {};
  let wrongKey = false;
  const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url === `${issuer}/jwks`) return Response.json({ keys: wrongKey ? [] : [jwk] });
    if (url === `${issuer}/token`) {
      const params = new URLSearchParams(String(init?.body));
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(params.get('code_verifier')!)));
      const encoded = btoa(String.fromCharCode(...hash)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      expect(encoded).toBe(challenge);
      expect(params.get('redirect_uri')).toBe(`${origin}/api/auth/oidc/callback`);
      const jwt = await new SignJWT({ nonce, iss: issuer, aud: 'client', sub: 'trusted-subject', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'key1' }).setIssuedAt().setExpirationTime('5m').sign(privateKey);
      return Response.json({ id_token: jwt });
    }
    throw new Error(`Unexpected provider request ${url}`);
  });
  vi.stubGlobal('fetch', provider);
  const start = async () => {
    const response = await request(conf, '/api/auth/oidc/start');
    expect(response.status).toBe(302);
    const u = new URL(response.headers.get('location')!);
    nonce = u.searchParams.get('nonce')!;
    challenge = u.searchParams.get('code_challenge')!;
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    return { state: u.searchParams.get('state')!, cookie: cookie(response, '__Secure-hpc-oidc-state') };
  };
  return { conf, user: user!, start, setClaims: (v: Record<string, unknown>) => { claims = v; }, removeKey: () => { wrongKey = true; } };
}

describe('OIDC login', () => {
  it('is disabled unless all settings are configured', async () => {
    expect((await request(env, '/api/auth/oidc/start')).status).toBe(404);
    const config = await (await request(env, '/api/config')).json() as { data: { oidcEnabled: boolean } };
    expect(config.data.oidcEnabled).toBe(false);
  });

  it('checks PKCE and identity, then exchanges an HTTP-only handoff for a normal session', async () => {
    const { conf, user, start } = await setup();
    const attempt = await start();
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=success`);
    const audit = await env.db.prepare('SELECT last_login_at FROM users WHERE id = ?').bind(user.id).first<{ last_login_at: number | null }>();
    expect(audit?.last_login_at).toBeTypeOf('number');
    const setCookie = callback.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    const handoff = cookie(callback, '__Secure-hpc-oidc-handoff');
    expect((await request(conf, '/api/auth/oidc/exchange', { method: 'POST', headers: { Cookie: handoff, Origin: 'https://evil.test' } })).status).toBe(401);
    const exchange = await request(conf, '/api/auth/oidc/exchange', { method: 'POST', headers: { Cookie: handoff, Origin: origin } });
    const body = await exchange.json() as { data: { token: string; user: { id: number } } };
    expect(body.data.user.id).toBe(user.id);
    expect((await request(conf, '/api/auth/me', { headers: { Authorization: `Bearer ${body.data.token}` } })).status).toBe(200);
    expect((await request(conf, '/api/auth/oidc/exchange', { method: 'POST', headers: { Cookie: handoff, Origin: origin } })).status).toBe(401);
  });

  it('rejects a callback with a mismatched state before contacting the token endpoint', async () => {
    const { conf, start } = await setup();
    const attempt = await start();
    const callback = await request(conf, '/api/auth/oidc/callback?state=wrong&code=once', { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
    expect(callback.headers.get('set-cookie')).not.toContain('__Secure-hpc-oidc-handoff=ey');
  });

  it('rejects a tampered browser state cookie', async () => {
    const { conf, start } = await setup();
    const attempt = await start();
    const tampered = attempt.cookie.replace(/\.([^.])([^.]+)$/, (_, first: string, rest: string) => `.${first === 'A' ? 'B' : 'A'}${rest}`);
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: tampered } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
  });

  it.each([{ nonce: 'wrong' }, { sub: 'untrusted-subject' }, { aud: 'other-client' }, { iss: 'https://attacker.test' }, { azp: 'other-client' }])('rejects invalid token claims %o', async (claims) => {
    const { conf, start, setClaims } = await setup();
    const attempt = await start();
    setClaims(claims);
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
  });

  it('rejects a disabled local account', async () => {
    const { conf, user, start } = await setup();
    await env.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
    const attempt = await start();
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
  });

  it('rejects a token whose signing key is not trusted by the issuer', async () => {
    const { conf, start, removeKey } = await setup();
    const attempt = await start();
    removeKey();
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
  });

  it('does not bypass the local TOTP setting', async () => {
    const { conf, user, start } = await setup();
    await env.db.prepare('UPDATE users SET totp_enabled_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
    const attempt = await start();
    const callback = await request(conf, `/api/auth/oidc/callback?state=${attempt.state}&code=once`, { headers: { Cookie: attempt.cookie } });
    expect(callback.headers.get('location')).toBe(`${origin}/login?oidc=error`);
  });
});
