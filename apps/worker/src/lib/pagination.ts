import type { Page } from '@hpc-mail/shared';
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

/**
 * 首页指纹：对首页序列化结果（条目 + nextCursor）取 SHA-256。
 * 条目里任何对用户可见的字段（已读、星标、验证码、状态等）或翻页游标变化都会改变它；
 * 只用于比较是否相等，不承载含义。
 */
export function pageHead(page: Page<unknown>): Promise<string> {
  return sha256Hex(JSON.stringify([page.items, page.nextCursor]));
}
