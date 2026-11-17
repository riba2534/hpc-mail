import type { Context } from 'hono';
import type { AppContext } from '../types.js';
import { AppError, type AppErrorHints } from './errors.js';

/** 按流读出 UTF-8 文本，累计字节超过 maxBytes 立即取消读取并抛 tooLarge()，不会先把整段读进内存 */
export async function readTextWithin(stream: ReadableStream<Uint8Array> | null, maxBytes: number, tooLarge: () => Error): Promise<string> {
  if (!stream) return '';
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

/**
 * 有上限地读取请求体：超过 maxBytes 返回 413 payload_too_large。只看 Content-Length 挡不住 chunked 请求（没有这个头），
 * 整个请求体会先被读进内存再解析。读到的文本放进 Hono 的请求体缓存，之后的 c.req.json()（parseBody）直接复用，不再读流。
 */
export async function readBodyWithLimit(c: Context<AppContext>, maxBytes: number, message: string, hints: AppErrorHints = {}): Promise<string> {
  const tooLarge = () => new AppError('payload_too_large', message, hints);
  if (Number(c.req.header('Content-Length')) > maxBytes) throw tooLarge();
  const text = await readTextWithin(c.req.raw.body, maxBytes, tooLarge);
  // Hono 按类型缓存请求体的 Promise（json() 由缓存的 text 解析）；类型声明写成了 Body 的方法签名
  (c.req.bodyCache as Record<string, Promise<unknown>>).text = Promise.resolve(text);
  return text;
}
