import { MAX_BODY_BYTES } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { bodyKey, getJson, putJson } from './storage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const D1_BODY_LIMIT = 256 * 1024;
export const BODY_PREVIEW_BYTES = 64 * 1024;

export function bodyBytes(text: string, html: string): number {
  return encoder.encode(text).length + encoder.encode(html).length;
}

export function assertSendBodySize(text: string, html: string): void {
  if (bodyBytes(text, html) > MAX_BODY_BYTES) {
    throw new AppError('payload_too_large', '正文合计超过 1MB 上限');
  }
}

function previewBody(value: string): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= BODY_PREVIEW_BYTES) return value;
  // 避免预览末尾残留不完整的 UTF-8 字符。
  let end = BODY_PREVIEW_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * 大正文必须先持久化全文，成功后才能用截断预览代替 D1 正文。
 * `bytes` 为调用方已算好的 bodyBytes(text, html)，避免对大正文重复 UTF-8 编码。
 */
export async function storeMailBody(env: Env, text: string, html: string, seed?: string, bytes?: number) {
  if ((bytes ?? bodyBytes(text, html)) <= D1_BODY_LIMIT) {
    return { bodyText: text, bodyHtml: html, bodyR2Key: null as string | null };
  }
  const key = bodyKey(seed);
  await putJson(env, key, { text, html });
  return { bodyText: previewBody(text), bodyHtml: previewBody(html), bodyR2Key: key };
}

/**
 * 完整正文：有 R2 对象读出 {text, html}，否则用 D1 列。与 PR5b（正文移出 D1）的同名函数同签名，
 * 集成时以那边的实现为准。
 */
export async function readMailBody(
  env: Env,
  row: { bodyText: string; bodyHtml: string; bodyR2Key: string | null },
): Promise<{ bodyText: string; bodyHtml: string }> {
  if (!row.bodyR2Key) return { bodyText: row.bodyText, bodyHtml: row.bodyHtml };
  const full = await getJson<{ text?: unknown; html?: unknown }>(env, row.bodyR2Key);
  return {
    bodyText: typeof full?.text === 'string' ? full.text : row.bodyText,
    bodyHtml: typeof full?.html === 'string' ? full.html : row.bodyHtml,
  };
}
