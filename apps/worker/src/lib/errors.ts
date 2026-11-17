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

/** 任意抛出值的可读文本：Error 取 message，其余转字符串 */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
