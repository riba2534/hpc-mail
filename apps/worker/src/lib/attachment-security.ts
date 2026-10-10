const SAFE_INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export function normalizeMimeType(value: string | undefined | null): string {
  return String(value || '')
    .split(';')[0]
    ?.trim()
    .toLowerCase() ?? '';
}

export function sanitizeFilename(value: string | undefined | null = 'download'): string {
  const filename = String(value || 'download')
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\0\x01-\x1f\x7f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/["']/g, '')
    .trim()
    .slice(0, 180);
  return filename || 'download';
}

/**
 * `filename=` 兜底只能是 ASCII：非 ASCII 连续段替换为 `_`，保留扩展名；
 * 主干没有任何字母数字时用 download 代替。完整 UTF-8 名由 `filename*` 提供。
 */
export function asciiFallbackFilename(filename: string): string {
  const ascii = (value: string) => value.replace(/[^\x20-\x7e]+/g, '_').replace(/\\/g, '_');
  const dot = filename.lastIndexOf('.');
  const hasExt = dot > 0 && dot < filename.length - 1;
  const stem = ascii(hasExt ? filename.slice(0, dot) : filename);
  const ext = hasExt ? ascii(filename.slice(dot)) : '';
  return `${/[A-Za-z0-9]/.test(stem) ? stem : 'download'}${/[A-Za-z0-9]/.test(ext) ? ext : ''}`;
}

/** RFC 5987 ext-value：encodeURIComponent 不编码的 '()* 也需转义 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 生成安全下载响应头：图片可 inline，其余强制 attachment + octet-stream */
export function buildSecureHeaders(
  requestedType: string | undefined | null,
  filename: string,
): Headers {
  const normalized = normalizeMimeType(requestedType);
  const safeInline = SAFE_INLINE_IMAGE_TYPES.has(normalized);
  const type = safeInline ? normalized : 'application/octet-stream';
  const safeFilename = sanitizeFilename(filename);
  const mode = safeInline ? 'inline' : 'attachment';
  return new Headers({
    'Content-Type': type,
    'Content-Disposition': `${mode}; filename="${asciiFallbackFilename(safeFilename)}"; filename*=UTF-8''${encodeRfc5987(safeFilename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
  });
}

export { SAFE_INLINE_IMAGE_TYPES };
