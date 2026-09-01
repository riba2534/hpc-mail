import { bytesToHex } from '../lib/crypto.js';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { chunk } from '../lib/d1.js';
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

export interface MessageObjectTarget {
  id: number;
  bodyR2Key: string | null;
  rawR2Key: string | null;
}

/**
 * 删除消息关联的 R2 对象。附件允许多封站内副本共享同一 r2Key：仅最后一个引用被删除时
 * 才真正删除对象。任何 R2 删除失败都会向上抛出，让调用方保留 D1 引用以便重试。
 */
export async function deleteMessageObjects(
  env: Env,
  db: Db,
  targets: MessageObjectTarget[],
): Promise<void> {
  if (targets.length === 0) return;
  const targetIds = targets.map((target) => target.id);
  const targetIdSet = new Set(targetIds);
  const targetAttachments: { messageId: number; r2Key: string }[] = [];
  for (const ids of chunk(targetIds)) {
    targetAttachments.push(
      ...(await db
        .select({ messageId: attachments.messageId, r2Key: attachments.r2Key })
        .from(attachments)
        .where(inArray(attachments.messageId, ids))
        .all()),
    );
  }

  const candidateKeys = [...new Set(targetAttachments.map((row) => row.r2Key))];
  const referencedOutside = new Set<string>();
  for (const keys of chunk(candidateKeys)) {
    const refs = await db
      .select({ messageId: attachments.messageId, r2Key: attachments.r2Key })
      .from(attachments)
      .where(inArray(attachments.r2Key, keys))
      .all();
    for (const ref of refs) {
      if (!targetIdSet.has(ref.messageId)) referencedOutside.add(ref.r2Key);
    }
  }

  const objectKeys = [
    ...candidateKeys.filter((key) => !referencedOutside.has(key)),
    ...targets.flatMap((target) => [target.bodyR2Key, target.rawR2Key]).filter((key): key is string => !!key),
  ];
  for (const keys of chunk([...new Set(objectKeys)], 500)) {
    if (keys.length) await env.r2.delete(keys);
  }
}
