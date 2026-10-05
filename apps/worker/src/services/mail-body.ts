import { MAX_BODY_BYTES } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { bodyKey, putJson } from './storage.js';

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

/** 大正文必须先持久化全文，成功后才能用截断预览代替 D1 正文。 */
export async function storeMailBody(env: Env, text: string, html: string, seed?: string) {
  if (bodyBytes(text, html) <= D1_BODY_LIMIT) {
    return { bodyText: text, bodyHtml: html, bodyR2Key: null as string | null };
  }
  const key = bodyKey(seed);
  await putJson(env, key, { text, html });
  return { bodyText: previewBody(text), bodyHtml: previewBody(html), bodyR2Key: key };
}
