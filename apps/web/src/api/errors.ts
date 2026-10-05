import type { ErrorCode } from '@hpc-mail/shared';

/** 非契约错误码：本地网络/超时/响应格式问题 */
export type ClientErrorCode = 'network' | 'timeout' | 'malformed' | 'session_changed';
export type ApiErrorCode = ErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  code: ApiErrorCode;
  httpStatus?: number | null;
  requestId?: string;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number | null;
  readonly requestId?: string;

  constructor(message: string, init: ApiErrorInit) {
    super(message, { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? null;
    this.requestId = init.requestId;
  }

  get unauthorized(): boolean {
    return this.httpStatus === 401 || this.code === 'unauthorized' || this.code === 'bad_credentials';
  }

  get forbidden(): boolean {
    return this.httpStatus === 403 || this.code === 'forbidden';
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError('请求超时，请稍后重试', { code: 'timeout', cause: error });
  }
  if (error instanceof Error) {
    return new ApiError(error.message || '网络请求失败', { code: 'network', cause: error });
  }
  return new ApiError('未知请求错误', { code: 'network', cause: error });
}
