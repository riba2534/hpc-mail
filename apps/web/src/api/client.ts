import { clearAuthToken, getAuthToken } from '@/lib/auth-token';
import { ApiError, toApiError } from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const API_BASE = '/api';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

export interface ApiRequestOptions<TBody = unknown> {
  body?: TBody;
  headers?: HeadersInit;
  query?: QueryParams;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 显式传 null 可发匿名请求；不传则自动附带 localStorage 中的 token */
  token?: string | null;
}

function appendQueryValue(search: URLSearchParams, key: string, value: QueryValue): void {
  if (value === null || value === undefined || value === '') return;
  search.append(key, String(value));
}

function withQuery(path: string, query?: QueryParams): string {
  if (!query) return path;
  const [pathname = '', currentSearch = ''] = path.split('?', 2);
  const search = new URLSearchParams(currentSearch);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach((item) => appendQueryValue(search, key, item as QueryValue));
    else appendQueryValue(search, key, value as QueryValue);
  }
  const serialized = search.toString();
  return `${pathname}${serialized ? `?${serialized}` : ''}`;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function bodyAndHeaders(body: unknown, inputHeaders?: HeadersInit): { body?: BodyInit; headers: Headers } {
  const headers = new Headers(inputHeaders);
  if (body === undefined || body === null) return { headers };
  if (isBodyInit(body)) return { body, headers };
  headers.set('Content-Type', 'application/json');
  return { body: JSON.stringify(body), headers };
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function toErrorFromResponse(response: Response): Promise<ApiError> {
  const payload = (await readJson(response)) as
    | { error?: { code?: string; message?: string }; requestId?: string }
    | undefined;
  const code = (payload?.error?.code ?? 'internal') as ApiError['code'];
  const message = payload?.error?.message || `请求失败（${response.status}）`;
  const requestId = payload?.requestId ?? response.headers.get('x-request-id') ?? undefined;
  return new ApiError(message, { code, httpStatus: response.status, requestId });
}

export async function apiRequest<TResponse, TBody = unknown>(
  method: string,
  path: string,
  options: ApiRequestOptions<TBody> = {},
): Promise<TResponse> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const { body, headers } = bodyAndHeaders(options.body, options.headers);
    headers.set('Accept', 'application/json');
    const token = options.token === undefined ? getAuthToken() : options.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(`${API_BASE}${withQuery(path, options.query)}`, {
      method,
      headers,
      body,
      signal: controller.signal,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      const error = await toErrorFromResponse(response);
      if (error.unauthorized && token && token === getAuthToken()) clearAuthToken();
      throw error;
    }

    if (token && token !== getAuthToken()) {
      throw new ApiError('登录账户已变化，请重新操作', { code: 'session_changed' });
    }
    if (response.status === 204) return undefined as TResponse;
    const payload = (await readJson(response)) as { data?: TResponse } | undefined;
    if (token && token !== getAuthToken()) {
      throw new ApiError('登录账户已变化，请重新操作', { code: 'session_changed' });
    }
    if (!payload || typeof payload !== 'object' || !('data' in payload)) {
      throw new ApiError('服务器返回了无法识别的响应', { code: 'malformed', httpStatus: response.status });
    }
    return payload.data as TResponse;
  } catch (error) {
    throw toApiError(error);
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export const api = {
  get: <TResponse>(path: string, options?: Omit<ApiRequestOptions, 'body'>) =>
    apiRequest<TResponse>('GET', path, options),
  post: <TResponse, TBody = unknown>(path: string, body?: TBody, options?: Omit<ApiRequestOptions<TBody>, 'body'>) =>
    apiRequest<TResponse, TBody>('POST', path, { ...options, body }),
  put: <TResponse, TBody = unknown>(path: string, body?: TBody, options?: Omit<ApiRequestOptions<TBody>, 'body'>) =>
    apiRequest<TResponse, TBody>('PUT', path, { ...options, body }),
  delete: <TResponse, TBody = unknown>(path: string, body?: TBody, options?: Omit<ApiRequestOptions<TBody>, 'body'>) =>
    apiRequest<TResponse, TBody>('DELETE', path, { ...options, body }),
};
