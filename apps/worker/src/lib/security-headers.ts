/**
 * 前端页面的安全响应头，唯一来源。生效的有两条路径：资产层直出的 HTML 走 apps/web/public/_headers 的 `/*` 段，
 * 经过 Worker 的响应（Agent 文档、/assets 404 等）走 index.ts 的 withSecurityHeaders。
 * _headers 是构建产物的一部分、无法 import 常量，由测试（test/security-headers.test.ts）逐字比对两边，改一处必须同步另一处。
 *
 * 邮件正文已在 Shadow DOM 内消毒并按用户意愿放行远程图片，故 img-src 放开 https:；样式含 React 内联 style，需 'unsafe-inline'。
 * frame-ancestors 'none' 防点击劫持；HSTS 强制 HTTPS。
 * Cloudflare Web Analytics 由边缘自动注入 beacon：脚本来自 static.cloudflareinsights.com，上报发往 cloudflareinsights.com，
 * 两个源都要放行，否则每次页面加载产生一条 CSP 违规且统计失效。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
