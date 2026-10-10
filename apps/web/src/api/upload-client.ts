import { clearAuthToken, getAuthToken } from '@/lib/auth-token';
import { ApiError, NETWORK_ERROR_MESSAGE } from './errors';

const API_BASE = '/api';

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface XhrSendOptions {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: Blob | ArrayBuffer;
  headers?: Record<string, string>;
  onProgress?: (p: UploadProgress) => void;
  /** 0 = 不超时；默认 10 分钟（大文件分片上传留足余量） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface EnvelopeOk<T> {
  data: T;
}
interface EnvelopeErr {
  error?: { code?: string; message?: string };
  requestId?: string;
}

/**
 * 基于 XMLHttpRequest 的上传通道：fetch 不支持上传进度，XHR 的 upload.onprogress 可。
 * 复用 /api 的 token 注入、{data}/{error} 信封解析、401 清 token、超时映射。仅用于
 * 需要真实上传进度的二进制上传（单片直传 / 分片）；小 JSON 请求仍走 api.post。
 */
export function xhrSend<T>(opts: XhrSendOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const search = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    xhr.open(opts.method, `${API_BASE}${opts.path}${search}`);

    const token = getAuthToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Accept', 'application/json');
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) xhr.setRequestHeader(k, v);
    }
    xhr.timeout = opts.timeoutMs === undefined ? 10 * 60_000 : opts.timeoutMs;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress({ loaded: e.loaded, total: e.total });
      }
    };
    xhr.onload = () => {
      let payload: (EnvelopeOk<T> & EnvelopeErr) | undefined;
      try {
        payload = JSON.parse(xhr.responseText) as EnvelopeOk<T> & EnvelopeErr;
      } catch {
        payload = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (token && token !== getAuthToken()) {
          return reject(new ApiError('登录账户已变化，请重新上传', { code: 'session_changed' }));
        }
        if (xhr.status === 204) return resolve(undefined as T);
        if (payload && typeof payload === 'object' && 'data' in payload) {
          return resolve(payload.data);
        }
        return reject(
          new ApiError('服务器返回了无法识别的响应', { code: 'malformed', httpStatus: xhr.status }),
        );
      }
      const code = (payload?.error?.code ?? 'internal') as ApiError['code'];
      const message = payload?.error?.message || `请求失败（${xhr.status}）`;
      const err = new ApiError(message, {
        code,
        httpStatus: xhr.status,
        requestId: payload?.requestId,
      });
      if (err.unauthorized && token && token === getAuthToken()) clearAuthToken();
      reject(err);
    };
    xhr.onerror = () => reject(new ApiError(NETWORK_ERROR_MESSAGE, { code: 'network' }));
    xhr.ontimeout = () => reject(new ApiError('请求超时，请稍后重试', { code: 'timeout' }));
    xhr.onabort = () => reject(new ApiError('上传已取消', { code: 'timeout' }));

    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new ApiError('上传已取消', { code: 'timeout' }));
        return;
      }
      else opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(opts.body);
  });
}
