import { ERROR_CODES, type IssueErrorParams } from '@hpc-mail/shared';
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
    | { success: false; error: { issues: Array<{ message?: string; params?: unknown }> } };
}

/**
 * 校验失败转错误：取第一条 issue；它带 IssueErrorParams（shared schema 的自定义 issue）时，
 * 用其中的错误码与 fix/docs/details，否则为 validation_failed。
 */
function issueError(issue: { message?: string; params?: unknown } | undefined): AppError {
  const params = (issue?.params ?? {}) as IssueErrorParams;
  const code = params.errorCode && (ERROR_CODES as readonly string[]).includes(params.errorCode)
    ? params.errorCode : 'validation_failed';
  return new AppError(code, issue?.message ?? '参数校验失败', { fix: params.fix, docs: params.docs, details: params.details });
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

/** Authorization: Bearer 后的令牌；缺失或格式不对时为空串 */
export function bearerToken(c: { req: { header: (name: string) => string | undefined } }): string {
  return (c.req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

/** 后台任务：有 ctx 放进 waitUntil，不阻塞响应；没有时（定时任务、单测直调）同步等待。失败只记日志，不抛给调用方 */
export async function runDetached(ctx: ExecCtx | null | undefined, label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = task().catch((error: unknown) => console.error(`${label}失败:`, error));
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}

/** 取客户端 IP（部署在 Cloudflare 后，仅信任 CF-Connecting-IP） */
export function clientIp(c: Context<AppContext>): string {
  const value = c.req.header('CF-Connecting-IP') || '';
  return (value.split(',')[0] ?? '').trim() || 'unknown';
}

function secretTarget(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim();
  }
}

/**
 * 提交掩码表示沿用已存密钥，而密钥只能继续发往原来的接口：比较协议、主机、端口与路径（忽略末尾斜杠），
 * 同源换路径也算换了接口（多租户网关常用路径区分账户）。无法解析的地址按原字符串比较。
 */
export function sameSecretTarget(a: string, b: string): boolean {
  return secretTarget(a) === secretTarget(b);
}

/** 路由标签：数字 id 段归一为 :id，日志与审计里的路径不随 id 变成高基数 */
export function routeLabel(pathname: string): string {
  return pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
}

/** 解析路径参数中的正整数 id，非法抛 not_found */
export function parseId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('not_found', '资源不存在');
  return id;
}

/** 托管域名 DNS 记录 ID：Cloudflare 记录 ID 为 32 位十六进制，格式不对按记录不存在处理 */
export function parseRecordId(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{32}$/.test(value)) throw new AppError('not_found', '解析记录不存在');
  return value;
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
  if (!result.success) throw issueError(result.error.issues[0]);
  return result.data;
}

/** safeParse 任意值（批量请求的单项等），失败按与 parseBody 相同的规则抛错 */
export function parseValue<T>(schema: SafeParser<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw issueError(result.error.issues[0]);
  return result.data;
}

/** safeParse query，失败抛 validation_failed */
export function parseQuery<T>(c: Context<AppContext>, schema: SafeParser<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw issueError(result.error.issues[0]);
  return result.data;
}
