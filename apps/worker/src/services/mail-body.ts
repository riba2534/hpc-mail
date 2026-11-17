import { MAX_BODY_BYTES } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { mailText, type MailText } from '../lib/text.js';
import type { Env } from '../types.js';
import { bodyKey, getJson, putJson } from './storage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 旧版本的内联上限：正文合计 ≤256KB 时整段写在 D1 的 body_text/body_html，超过才落 R2。
 * 现在只用于收件去重判断旧行是否已存全文（≤ 上限的旧行全文在 D1，新行全文在 R2 或本就是短文本）。
 */
export const D1_BODY_LIMIT = 256 * 1024;

/**
 * D1 的 body_text 最多保留这么多 UTF-8 字节：列表搜索（q）与 R2 读不到时的兜底展示用。
 * 完整 text/html 以 JSON 落 R2（bodyR2Key），body_html 不再写进 D1 热表。
 */
export const BODY_PREVIEW_BYTES = 4 * 1024;

/** R2 正文对象的内容：原始 text/plain 与 text/html 两段，都是完整的 */
export interface StoredBody {
  text: string;
  html: string;
}

export function bodyBytes(text: string, html: string): number {
  return encoder.encode(text).length + encoder.encode(html).length;
}

export function assertSendBodySize(text: string, html: string): void {
  if (bodyBytes(text, html) > MAX_BODY_BYTES) {
    throw new AppError('payload_too_large', '正文合计超过 1MB 上限');
  }
}

/** 按 UTF-8 字节截断，末尾不残留不完整的字符 */
export function previewBody(value: string, limit = BODY_PREVIEW_BYTES): string {
  // 每个 UTF-16 码元最多编码成 3 字节：明显放得下时不必整段编码
  if (value.length * 3 <= limit) return value;
  const bytes = encoder.encode(value.length > limit ? value.slice(0, limit) : value);
  if (bytes.length <= limit) return value.length > limit ? decoder.decode(bytes) : value;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * 留在 D1 的搜索文本：有文本段用文本段，只有 HTML 的邮件用 HTML 转出的文字（这类邮件因此也能被 q 搜到），
 * 截到 BODY_PREVIEW_BYTES。
 */
export function searchableBody(text: string, view: Pick<MailText, 'htmlText'>): string {
  return previewBody(text.trim() ? text : view.htmlText);
}

/** 没有 HTML、纯文本不超过预览上限：D1 里的就是全文，不必写 R2 */
export function bodyFitsInline(text: string, html: string): boolean {
  return html === '' && previewBody(text) === text;
}

/**
 * 正文落库：完整 text/html 先写 R2，成功后 D1 只留搜索文本（body_html 为空串）。
 * 只有不带 HTML 的短文本直接留在 D1、不写 R2。R2 写失败向上抛出，调用方不能落一条丢了正文的行。
 * seed 给出确定的对象名（收件用 ingestKey，重投修复覆盖同一对象）；view 复用调用方已有的 HTML 转换。
 * 不变式：D1 正文被截断或清空的行一定带 bodyR2Key——各版本代码读正文都是「有 bodyR2Key 读 R2，否则读 D1」，
 * 回滚到旧版本也能读全。
 */
export async function storeMailBody(env: Env, text: string, html: string, seed?: string, view: MailText = mailText(text, html)) {
  if (bodyFitsInline(text, html)) {
    return { bodyText: text, bodyHtml: '', bodyR2Key: null as string | null };
  }
  const key = bodyKey(seed);
  await putJson(env, key, { text, html } satisfies StoredBody);
  return { bodyText: searchableBody(text, view), bodyHtml: '', bodyR2Key: key as string | null };
}

/**
 * 读完整正文：有 bodyR2Key 时以 R2 为准（D1 只有搜索文本），没有时 D1 就是全文（短文本，或尚未回填的旧行）。
 * R2 对象缺失时退回 D1 里的内容并记日志；R2 读取出错向上抛出，不把截断的预览当全文返回。
 */
export async function readMailBody(
  env: Env,
  row: { bodyText: string; bodyHtml: string; bodyR2Key: string | null },
): Promise<{ bodyText: string; bodyHtml: string }> {
  if (!row.bodyR2Key) return { bodyText: row.bodyText, bodyHtml: row.bodyHtml };
  const full = await getJson<Partial<Record<keyof StoredBody, unknown>>>(env, row.bodyR2Key);
  if (!full) console.error('正文对象缺失，退回 D1 预览:', row.bodyR2Key);
  return {
    bodyText: typeof full?.text === 'string' ? full.text : row.bodyText,
    bodyHtml: typeof full?.html === 'string' ? full.html : row.bodyHtml,
  };
}
