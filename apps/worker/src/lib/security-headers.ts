/**
 * 前端页面的安全响应头，唯一来源。生效的有两条路径：资产层直出的 HTML 走 apps/web/public/_headers 的 `/*` 段，
 * 经过 Worker 的响应（Agent 文档、/assets 404 等）走 index.ts 的 withSecurityHeaders。
 * _headers 是构建产物的一部分、无法 import 常量，由测试（test/security-headers.test.ts）逐字比对两边，改一处必须同步另一处。
 *
 * 邮件正文使用隔离 iframe，按单封邮件的 CSP 限制远程图片；外层样式含 React 内联 style。
 * frame-ancestors 'none' 防点击劫持；HSTS 强制 HTTPS。
 * SPA 路由共用外壳。通过 no-transform 禁止边缘注入统计脚本，并在 CSP 中限制脚本与连接为同源。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-DNS-Prefetch-Control': 'off',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/** SPA 外壳可以重验证；no-transform 同时阻止 Cloudflare 自动注入统计脚本。 */
export const APP_SHELL_CACHE_CONTROL = 'public, max-age=0, must-revalidate, no-transform';
