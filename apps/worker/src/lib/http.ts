import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from './errors.js';
import type { AppContext, ExecCtx } from '../types.js';

/** 结构化 schema 类型（zod safeParse 的鸭子类型，避免 worker 直接依赖 zod） */
export interface SafeParser<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ message?: string }> } };
}

/** 统一成功信封 { data } */
export function ok<T>(c: Context<AppContext>, data: T, status: ContentfulStatusCode = 200) {
  return c.json({ data }, status);
}

/** Hono 在没有 ExecutionContext 时访问 executionCtx 会抛错；单测等场景返回 null */
export function execCtx(c: Context<AppContext>): ExecCtx | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

/** 取客户端 IP（部署在 Cloudflare 后，仅信任 CF-Connecting-IP） */
export function clientIp(c: Context<AppContext>): string {
  const value = c.req.header('CF-Connecting-IP') || '';
  return (value.split(',')[0] ?? '').trim() || 'unknown';
}

/** 解析路径参数中的正整数 id，非法抛 not_found */
export function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('not_found', '资源不存在');
  return id;
}

/** 显式布尔查询不能因拼写或客户端类型差异静默退回 false。 */
export function parseBooleanFlag(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new AppError('validation_failed', '开关参数需为 1/0 或 true/false');
}

/** safeParse JSON body，失败抛 validation_failed */
export async function parseBody<T>(c: Context<AppContext>, schema: SafeParser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('validation_failed', '请求体不是合法 JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError('validation_failed', result.error.issues[0]?.message ?? '参数校验失败');
  }
  return result.data;
}

/** safeParse query，失败抛 validation_failed */
export function parseQuery<T>(c: Context<AppContext>, schema: SafeParser<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new AppError('validation_failed', result.error.issues[0]?.message ?? '参数校验失败');
  }
  return result.data;
}
