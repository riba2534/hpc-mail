import { ERROR_STATUS, type ApiErrorDetails, type ErrorCode } from '@hpc-mail/shared';

/** 错误信封的可选补充：fix 给调用方（尤其 Agent）的改正建议；docs 站内文档路径（如 /references/errors.md#x）；details 结构化信息 */
export interface AppErrorHints {
  fix?: string;
  docs?: string;
  details?: ApiErrorDetails;
}

/** 业务错误：code 决定响应错误码与默认 HTTP 状态；个别场景（如上游投递失败 502）可显式指定状态 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hints: AppErrorHints;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, hints: AppErrorHints = {}, status: number = ERROR_STATUS[code]) {
    super(message ?? code);
    this.code = code;
    this.hints = hints;
    this.status = status;
    this.name = 'AppError';
  }
}

/** 缺少 API scope 的 403 文案：一个 scope 时要求带上它，多个时有其一即可（OpenAPI 的示例用同一份） */
export function missingScopeHints(scopes: readonly string[]): { message: string; fix: string; docs: string } {
  const list = scopes.join(' 或 ');
  return {
    message: `需要 API scope: ${list}`,
    fix: scopes.length === 1
      ? `这把 Key 缺少 scope ${list}：在网页「API Key」页面给它加上，或换用带该 scope 的 Key（GET /v1/me 可查看当前 scopes）`
      : `这把 Key 需要 ${list} 其中之一：在网页「API Key」页面加上，或换用带其中一个 scope 的 Key（GET /v1/me 可查看当前 scopes）`,
    docs: '/references/errors.md#forbidden-scope',
  };
}
