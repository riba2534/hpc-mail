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

export const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';

/**
 * fetch 在请求未到达服务器时抛 TypeError，各浏览器文案不同：
 * Chrome「Failed to fetch」、Safari「Load failed」、Firefox「NetworkError when attempting to fetch resource.」。
 */
const FETCH_FAILURE = /failed to fetch|load failed|networkerror|network request failed|fetch failed/i;

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

/**
 * 发送请求的结果是否不确定：请求可能已到达服务器并完成投递，只是响应没回来。
 * 这类错误应保留同一幂等键重试，而不是当作明确失败。
 */
export function isUncertainSendError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return ['network', 'timeout', 'conflict', 'malformed', 'session_changed'].includes(error.code)
    || error.httpStatus === 408
    || (error.httpStatus !== null && error.httpStatus >= 500);
}
