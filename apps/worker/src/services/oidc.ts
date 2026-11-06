import { EncryptJWT, SignJWT, createLocalJWKSet, jwtDecrypt, jwtVerify, type JSONWebKeySet } from 'jose';
import type { LoginResponse } from '@hpc-mail/shared';
import type { Env } from '../types.js';

interface OidcConfig { issuer: string; clientId: string; clientSecret: string; subject: string; userId: number; origin: string }
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export interface OidcState { state: string; nonce: string; verifier: string }

/** Fail closed on partial or malformed configuration. No user is auto-provisioned. */
export function oidcConfig(env: Env): OidcConfig | null {
  try {
    const issuer = env.oidc_issuer ?? '';
    const origin = env.site_origin ?? '';
    const issuerUrl = new URL(issuer);
    const originUrl = new URL(origin);
    const userId = Number(env.oidc_user_id);
    if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash ||
        originUrl.protocol !== 'https:' || origin !== originUrl.origin || !env.oidc_client_id || !env.oidc_client_secret ||
        !env.oidc_subject || !Number.isSafeInteger(userId) || userId < 1) return null;
    return { issuer, origin, userId, clientId: env.oidc_client_id, clientSecret: env.oidc_client_secret, subject: env.oidc_subject };
  } catch { return null; }
}
export const oidcConfigured = (env: Env): boolean => oidcConfig(env) !== null;
export function randomString(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const utf8 = new TextEncoder();
async function key(env: Env, purpose: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(`hpc-oidc:${purpose}:${env.jwt_secret}`)));
}
export async function signState(env: Env, state: OidcState): Promise<string> {
  return new SignJWT({ ...state }).setProtectedHeader({ alg: 'HS256' }).setAudience('hpc-mail-oidc-state')
    .setIssuedAt().setExpirationTime('5m').sign(await key(env, 'state'));
}
export async function verifyState(env: Env, value: string): Promise<OidcState> {
  const { payload } = await jwtVerify(value, await key(env, 'state'), { algorithms: ['HS256'], audience: 'hpc-mail-oidc-state', requiredClaims: ['exp', 'iat'] });
  if (typeof payload.state !== 'string' || typeof payload.nonce !== 'string' || typeof payload.verifier !== 'string') throw new Error('Invalid state');
  return { state: payload.state, nonce: payload.nonce, verifier: payload.verifier };
}
export async function sealHandoff(env: Env, login: LoginResponse): Promise<string> {
  return new EncryptJWT({ login }).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).setAudience('hpc-mail-oidc-handoff')
    .setJti(randomString()).setIssuedAt().setExpirationTime('60s').encrypt(await key(env, 'handoff'));
}
export async function openHandoff(env: Env, value: string): Promise<{ login: LoginResponse; jti: string; window: number }> {
  const { payload } = await jwtDecrypt(value, await key(env, 'handoff'), { audience: 'hpc-mail-oidc-handoff', requiredClaims: ['exp', 'iat', 'jti'] });
  const login = payload.login as LoginResponse | undefined;
  if (!login || typeof login.token !== 'string' || !login.user || typeof login.user.id !== 'number' || typeof payload.jti !== 'string' || typeof payload.iat !== 'number') throw new Error('Invalid handoff');
  return { login, jti: payload.jti, window: Math.floor(payload.iat / 60) };
}
async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('OIDC provider request failed');
  return response.json();
}
function httpsUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing endpoint');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error('Invalid endpoint');
  return value;
}
export async function discover(config: OidcConfig): Promise<Discovery> {
  const doc = await getJson(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) as Record<string, unknown>;
  if (doc.issuer !== config.issuer) throw new Error('Issuer mismatch');
  return { issuer: config.issuer, authorization_endpoint: httpsUrl(doc.authorization_endpoint), token_endpoint: httpsUrl(doc.token_endpoint), jwks_uri: httpsUrl(doc.jwks_uri) };
}
export async function authorizationUrl(config: OidcConfig, state: OidcState): Promise<string> {
  const metadata = await discover(config);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(state.verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const url = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: `${config.origin}/api/auth/oidc/callback`, scope: 'openid', state: state.state, nonce: state.nonce, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(name, value);
  return url.toString();
}
export async function verifyAuthorization(config: OidcConfig, state: OidcState, code: string): Promise<void> {
  const metadata = await discover(config);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: `${config.origin}/api/auth/oidc/callback`, code_verifier: state.verifier });
  const basic = btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`);
  const tokens = await getJson(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body }) as Record<string, unknown>;
  if (typeof tokens.id_token !== 'string') throw new Error('Missing ID token');
  const jwks = await getJson(metadata.jwks_uri) as JSONWebKeySet;
  const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
    algorithms: ['RS256', 'ES256', 'PS256', 'EdDSA'], issuer: config.issuer, audience: config.clientId, requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'], maxTokenAge: '10m',
  });
  if (payload.nonce !== state.nonce || payload.sub !== config.subject ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) ||
      (payload.azp !== undefined && payload.azp !== config.clientId)) throw new Error('OIDC identity mismatch');
}
