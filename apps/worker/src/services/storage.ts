import { bytesToHex } from '../lib/crypto.js';
import type { Env } from '../types.js';

/** 正文溢出：完整 JSON 落 R2 */
export function bodyKey(seed?: string): string {
  return `body/${seed ?? crypto.randomUUID()}.json`;
}

export function attachmentKey(
  messageId: number,
  seq: number,
  hash16: string,
  ext: string,
): string {
  return `att/${messageId}/${seq}_${hash16}${ext}`;
}

export async function sha256Hex16(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

export function getExt(filename: string | undefined | null): string {
  const name = String(filename || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export async function putJson(env: Env, key: string, obj: unknown): Promise<void> {
  await env.r2.put(key, JSON.stringify(obj), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const obj = await env.r2.get(key);
  if (!obj) return null;
  return (await obj.json()) as T;
}

export async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await env.r2.put(key, body, { httpMetadata: { contentType } });
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.r2.get(key);
}
