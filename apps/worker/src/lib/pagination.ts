import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Page } from '@hpc-mail/shared';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';

/** 游标 = base64(id)，仅编码自增主键 */
export function encodeCursor(id: number): string {
  return btoa(String(id));
}

/**
 * 没传（或空串）返回 null 表示首页。传了却解不出正整数 id 时报 400：
 * 静默当首页会让截断或拼错游标的脚本反复拿到第一页，翻页死循环且收不到任何错误。
 */
export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  let id = Number.NaN;
  try { id = Number(atob(cursor)); } catch { /* 非 base64 与解出非数字同样处理 */ }
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('validation_failed', 'cursor 无效：请原样传回上一页响应的 nextCursor，首页不带 cursor');
  }
  return id;
}

/** 查询参数 limit 的每页条数：整数夹到 1–MAX_PAGE_SIZE，缺省或不是整数时用 DEFAULT_PAGE_SIZE */
export function pageLimit(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isInteger(value) ? Math.min(MAX_PAGE_SIZE, Math.max(1, value)) : DEFAULT_PAGE_SIZE;
}

/** 分页模式的请求：游标解出的 id（首页为 null）与每页条数 */
export interface PageRequest {
  cursorId: number | null;
  limit: number;
}

/** 可选分页查询（shared withOptionalPage 的解析结果）：数组模式返回 null；无效游标 400 */
export function pageRequestOf(query: { paged: boolean; cursor?: string; limit: number }): PageRequest | null {
  return query.paged ? { cursorId: decodeCursor(query.cursor), limit: query.limit } : null;
}

/** 查询的 LIMIT：分页模式多取一条；数组模式为 -1 即不限（drizzle 不生成 LIMIT 子句，SQLite 的负数 LIMIT 也不设上限） */
export const fetchLimit = (page: PageRequest | null): number => (page ? page.limit + 1 : -1);

/**
 * 按 id 倒序、多取一条（limit + 1）的结果切成一页：多出的那条只用来判断是否还有下一页，
 * 下一页从本页最后一条的 id 之后继续。
 */
export function toPage<T>(items: T[], limit: number, idOf: (item: T) => number): Page<T> {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { items: page, nextCursor: hasMore ? encodeCursor(idOf(page[page.length - 1]!)) : null };
}

/**
 * 首页指纹：对首页序列化结果（条目 + nextCursor）取 SHA-256。
 * 条目里任何对用户可见的字段（已读、星标、验证码、状态等）或翻页游标变化都会改变它；
 * 只用于比较是否相等，不承载含义。
 */
export function pageHead(page: Page<unknown>): Promise<string> {
  return sha256Hex(JSON.stringify([page.items, page.nextCursor]));
}
