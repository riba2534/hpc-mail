import { ERROR_STATUS, type ErrorCode } from '@hpc-mail/shared';

/** 业务错误：code 决定响应错误码与默认 HTTP 状态；个别场景（如上游投递失败 502）可显式指定状态 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, status: number = ERROR_STATUS[code]) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.name = 'AppError';
  }
}
