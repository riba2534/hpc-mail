import type { Context } from 'hono';
import type { ConditionalDetail } from '../services/message.js';
import type { AppContext } from '../types.js';
import { ok } from './http.js';

/**
 * If-None-Match 的弱比较（RFC 9110 §13.1.2）：去掉 W/ 前缀后比较不透明标签；`*` 匹配任何现存表示。
 * 头可以是逗号分隔的多个标签，任一匹配即为命中。
 */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = opaque(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === target);
}

/**
 * 详情的条件响应：总是带 ETag；命中 If-None-Match 返回 304、无正文。
 * private, no-cache：浏览器可以存但每次都要带 If-None-Match 回源确认，邮件变化（已读、星标、删除、
 * 补码）后不会读到旧内容；共享缓存不得存。
 */
export function conditionalDetailResponse(c: Context<AppContext>, result: ConditionalDetail): Response {
  c.header('ETag', result.etag);
  c.header('Cache-Control', 'private, no-cache');
  if (result.notModified) return c.body(null, 304);
  return ok(c, result.detail);
}
