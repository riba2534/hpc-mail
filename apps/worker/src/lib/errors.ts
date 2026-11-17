import { ERROR_STATUS, type ApiErrorDetails, type ErrorCode } from '@hpc-mail/shared';

/** 错误信封的可选补充：fix 给调用方（尤其 Agent）的改正建议；docs 站内文档路径（如 /references/errors.md#x）；details 结构化信息 */
export interface AppErrorHints {
  fix?: string;
  docs?: string;
  details?: ApiErrorDetails;
}

/** 业务错误：code 决定 HTTP 状态与响应错误码 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hints: AppErrorHints;

  constructor(code: ErrorCode, message?: string, hints: AppErrorHints = {}) {
    super(message ?? code);
    this.code = code;
    this.hints = hints;
    this.name = 'AppError';
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }
}
