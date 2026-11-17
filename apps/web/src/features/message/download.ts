import { isSafeInlineImageType, normalizeMimeType } from '@hpc-mail/shared';
import { NETWORK_ERROR_MESSAGE } from '@/api/errors';
import { clearAuthToken, getAuthToken } from '@/lib/auth-token';

/** 连续这么久没有收到响应或新数据就中止。按「无进展」计时，大附件只要还在传就不会被掐断 */
const IDLE_TIMEOUT_MS = 60_000;
/** 下载用的 blob URL：部分浏览器在 click 返回后才开始读取 blob，立即吊销会失败 */
const DOWNLOAD_URL_TTL_MS = 60_000;
/** 预览用的 blob URL 留久一些：新标签页里刷新或另存时还要读取 */
const PREVIEW_URL_TTL_MS = 5 * 60_000;

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
 * 带 JWT 拉取文件。不打开签名 URL：签名会过期，鉴权请求在页面停留多久都能用。
 * 失败时抛出 message 可直接展示给用户的 Error；调用方中止（signal）时抛 AbortError，不需要提示。
 */
async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const token = getAuthToken();

  try {
    restartTimer();
    let response: Response;
    const chunks: BlobPart[] = [];
    try {
      response = await fetch(path, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      });
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          chunks.push(chunk.value);
          restartTimer();
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
      if (timedOut) throw new Error('下载超时，请检查网络后重试');
      throw new Error(NETWORK_ERROR_MESSAGE, { cause: error });
    }
    if (!response.ok) {
      // 与 api/client 一致：当前会话失效就清掉 token，外壳随之回到登录页
      if (response.status === 401 && token && token === getAuthToken()) clearAuthToken();
      throw new Error(await failureMessage(response));
    }
    const blob = response.body ? new Blob(chunks) : await response.blob();
    // 读完的同时调用方已离开页面：不再下载或打开
    if (signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
    return blob;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function revokeLater(url: string, ttlMs: number): void {
  globalThis.setTimeout(() => URL.revokeObjectURL(url), ttlMs);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  revokeLater(url, DOWNLOAD_URL_TTL_MS);
}

/** 带 JWT 拉取文件并按原文件名下载 */
export async function downloadWithAuth(path: string, filename: string, signal?: AbortSignal): Promise<void> {
  saveBlob(await fetchBlob(path, signal), filename);
}

/**
 * 白名单内的光栅图片在新标签页打开，其余类型（PDF、SVG、HTML、`image/png,text/html` 这类拼接值等）按原文件名下载。
 * blob URL 与本站同源：只要浏览器把它当 HTML/SVG 渲染，脚本就能读到登录凭据，所以判定只用与服务端同一份白名单，
 * 重建 Blob 也只用规范化后的白名单类型，绝不沿用来信声明的原值。
 * 新标签页要在点击的同步阶段打开：等 fetch 完成后再 window.open 已失去用户手势，会被拦截；被拦截时退回下载。
 */
export async function openOrDownloadWithAuth(path: string, filename: string, mimeType: string, signal?: AbortSignal): Promise<void> {
  if (!isSafeInlineImageType(mimeType)) return downloadWithAuth(path, filename, signal);
  const type = normalizeMimeType(mimeType);
  const tab = window.open('', '_blank');
  let blob: Blob;
  try {
    blob = await fetchBlob(path, signal);
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (!tab || tab.closed) {
    saveBlob(blob, filename);
    return;
  }
  const url = URL.createObjectURL(new Blob([blob], { type }));
  tab.opener = null;
  tab.location.href = url;
  revokeLater(url, PREVIEW_URL_TTL_MS);
}
