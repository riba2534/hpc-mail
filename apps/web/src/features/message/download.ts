import { NETWORK_ERROR_MESSAGE } from '@/api/errors';
import { getAuthToken } from '@/lib/auth-token';

/** blob URL 交给下载或新标签页后保留的时间：部分浏览器在 click / 导航返回后才开始读取 blob，立即吊销会失败 */
const BLOB_URL_TTL_MS = 60_000;

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
 * 失败时抛出 message 可直接展示给用户的 Error。
 */
async function fetchBlob(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Authorization: `Bearer ${getAuthToken() ?? ''}` } });
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) throw new Error(await failureMessage(response));
  try {
    return await response.blob();
  } catch {
    throw new Error(NETWORK_ERROR_MESSAGE);
  }
}

function revokeLater(url: string): void {
  globalThis.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  revokeLater(url);
}

/** 带 JWT 拉取文件并触发浏览器下载 */
export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  saveBlob(await fetchBlob(path), filename);
}

/** 可在新标签页内联查看的类型：图片与 PDF。SVG 能携带脚本，blob URL 又与本站同源，按普通文件下载 */
function previewType(mimeType: string): string | null {
  const type = mimeType.split(';')[0]!.trim().toLowerCase();
  return type === 'application/pdf' || (type.startsWith('image/') && !type.startsWith('image/svg')) ? type : null;
}

/**
 * 图片与 PDF 在新标签页打开，其余类型下载。
 * 新标签页要在点击的同步阶段打开：等 fetch 完成后再 window.open 已失去用户手势，会被浏览器拦截；被拦截时退回下载。
 */
export async function openOrDownloadWithAuth(path: string, filename: string, mimeType: string): Promise<void> {
  const type = previewType(mimeType);
  if (!type) return downloadWithAuth(path, filename);
  const tab = window.open('', '_blank');
  let blob: Blob;
  try {
    blob = await fetchBlob(path);
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (!tab || tab.closed) {
    saveBlob(blob, filename);
    return;
  }
  // 服务端对 PDF 等类型统一返回 octet-stream（强制下载），按附件声明的类型重建，浏览器才会内联展示
  const url = URL.createObjectURL(new Blob([blob], { type }));
  tab.opener = null;
  tab.location.href = url;
  revokeLater(url);
}
