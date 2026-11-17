import type { ApiErrorDetails, ErrorCode } from '@hpc-mail/shared';

/** 非契约错误码：本地网络/超时/响应格式问题 */
export type ClientErrorCode = 'network' | 'timeout' | 'malformed' | 'session_changed';
export type ApiErrorCode = ErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  code: ApiErrorCode;
  httpStatus?: number | null;
  requestId?: string;
  cause?: unknown;
  /** 错误信封的改正建议与结构化补充（如 delivery_failed 的发件行与逐收件人结果） */
  fix?: string;
  details?: ApiErrorDetails;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number | null;
  readonly requestId?: string;
  readonly fix?: string;
  readonly details?: ApiErrorDetails;

  constructor(message: string, init: ApiErrorInit) {
    super(message, { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? null;
    this.requestId = init.requestId;
    this.fix = init.fix;
    this.details = init.details;
  }

  get unauthorized(): boolean {
    return this.httpStatus === 401 || this.code === 'unauthorized' || this.code === 'bad_credentials';
  }

  get forbidden(): boolean {
    return this.httpStatus === 403 || this.code === 'forbidden';
  }
}

export const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

/**
 * fetch 在请求未到达服务器时抛 TypeError，各浏览器文案不同：
 * Chrome「Failed to fetch」、Safari「Load failed」、Firefox「NetworkError when attempting to fetch resource.」。
 */
const FETCH_FAILURE = /failed to fetch|load failed|networkerror|network request failed|fetch failed/i;

/** 请求在处理前被服务端明确拒绝（4xx）：确定没有写入；网络中断、超时（含 408）与 5xx 不算，口径同写信页的 classifySendError */
export function isRejectedRequest(error: unknown): error is ApiError {
  return error instanceof ApiError && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500
    && error.httpStatus !== 408;
}

export function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && FETCH_FAILURE.test(error.message);
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ApiError('请求超时，请稍后重试', { code: 'timeout', cause: error });
  }
  if (isFetchFailure(error) || (error instanceof Error && !error.message)) {
    return new ApiError(NETWORK_ERROR_MESSAGE, { code: 'network', cause: error });
  }
  if (error instanceof Error) {
    return new ApiError(error.message, { code: 'network', cause: error });
  }
  return new ApiError('未知请求错误', { code: 'network', cause: error });
}
