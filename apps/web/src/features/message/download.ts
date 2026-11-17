import { NETWORK_ERROR_MESSAGE } from '@/api/errors';
import { getAuthToken } from '@/lib/auth-token';

/** 下载失败的可读原因：优先用服务端错误信封里的 message，没有时按状态码给出提示 */
async function failureMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: unknown } } | null;
    const message = payload?.error?.message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // 非 JSON 响应：按状态码给出提示
  }
  if (response.status === 401) return '登录已过期，请重新登录后再下载';
  if (response.status === 404) return '文件不存在或已被删除';
  return `下载失败（${response.status}），请稍后重试`;
}

/**
 * 带 JWT 拉取文件并触发浏览器下载。不打开签名 URL：签名会过期，鉴权请求在页面停留多久都能用。
 * 失败时抛出 message 可直接展示给用户的 Error。
 */
export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Authorization: `Bearer ${getAuthToken() ?? ''}` } });
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) throw new Error(await failureMessage(response));
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // 部分浏览器在 click 返回后才开始读取 blob，立即吊销会让下载失败
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
