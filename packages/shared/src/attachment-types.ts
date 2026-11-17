/**
 * 附件内联展示的类型白名单（服务端下载响应与网页预览共用）。
 * 只有规范化后精确命中的光栅图片才允许内联展示；SVG、HTML 以及 `image/png,text/html`
 * 这类拼接值一律按下载处理——浏览器对拼接类型可能取最后一个，按 HTML 渲染。
 */
export const SAFE_INLINE_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
];

/** 取分号前的主类型，去空白、转小写；不做其他纠正，拼接值保持原样以便白名单拒绝 */
export function normalizeMimeType(value: string | undefined | null): string {
  return String(value || '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** 规范化后精确命中白名单才算可内联的图片 */
export function isSafeInlineImageType(value: string | undefined | null): boolean {
  return SAFE_INLINE_IMAGE_TYPES.includes(normalizeMimeType(value));
}
