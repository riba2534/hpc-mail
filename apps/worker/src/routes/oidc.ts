import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { clientIp, execCtx, ok } from '../lib/http.js';
import { loginOidcUser } from '../services/auth.js';
import { authorizationUrl, oidcConfig, openHandoff, randomString, sealHandoff, signState, verifyAuthorization, verifyState } from '../services/oidc.js';
import { bumpCounter, minuteWindow } from '../services/rate-counter.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();
const stateCookie = '__Secure-hpc-oidc-state';
const handoffCookie = '__Secure-hpc-oidc-handoff';
const path = '/api/auth/oidc';
const options = { path, secure: true, httpOnly: true, sameSite: 'Lax' as const };

async function limit(env: AppContext['Bindings'], ip: string): Promise<void> {
  if ((await bumpCounter(env, 'oidc-login', await sha256Hex(`ip:${ip.toLowerCase()}`), minuteWindow(1))).count > 30) throw new AppError('rate_limited', '请求过于频繁');
}

app.get('/start', async (c) => {
  const config = oidcConfig(c.env);
  if (!config || new URL(c.req.url).origin !== config.origin) throw new AppError('not_found', '未启用单点登录');
  await limit(c.env, clientIp(c));
  const state = { state: randomString(), nonce: randomString(), verifier: randomString() };
  const url = await authorizationUrl(config, state);
  setCookie(c, stateCookie, await signState(c.env, state), { ...options, maxAge: 300 });
  c.header('Cache-Control', 'no-store');
  return c.redirect(url, 302);
});

app.get('/callback', async (c) => {
  const config = oidcConfig(c.env);
  const cookie = getCookie(c, stateCookie);
  deleteCookie(c, stateCookie, options);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  if (!config || new URL(c.req.url).origin !== config.origin) throw new AppError('not_found', '未启用单点登录');
  await limit(c.env, clientIp(c));
  try {
    if (!cookie || cookie.length > 4096) throw new Error('Missing state');
    const state = await verifyState(c.env, cookie);
    const code = c.req.query('code');
    if (!code || code.length > 4096 || c.req.query('state') !== state.state || c.req.query('error')) throw new Error('Invalid callback');
    await verifyAuthorization(config, state, code);
    const login = await loginOidcUser(c.env, config.userId, clientIp(c), execCtx(c));
    setCookie(c, handoffCookie, await sealHandoff(c.env, login), { ...options, maxAge: 60 });
    return c.redirect(`${config.origin}/login?oidc=success`, 302);
  } catch {
    deleteCookie(c, handoffCookie, options);
    return c.redirect(`${config.origin}/login?oidc=error`, 302);
  }
});

app.post('/exchange', async (c) => {
  const config = oidcConfig(c.env);
  const value = getCookie(c, handoffCookie);
  deleteCookie(c, handoffCookie, options);
  c.header('Cache-Control', 'no-store');
  if (!config || new URL(c.req.url).origin !== config.origin || c.req.header('Origin') !== config.origin || !value || value.length > 4096) throw new AppError('bad_credentials', '单点登录失败');
  try {
    const handoff = await openHandoff(c.env, value);
    // D1 atomic counter makes handoff consumption one-use even across isolates.
    if ((await bumpCounter(c.env, 'oidc-handoff', await sha256Hex(handoff.jti), handoff.window)).count !== 1) throw new Error('Handoff already consumed');
    return ok(c, handoff.login);
  }
  catch { throw new AppError('bad_credentials', '单点登录失败'); }
});

export default app;
