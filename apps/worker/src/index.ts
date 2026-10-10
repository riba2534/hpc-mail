import { createApp, isApiPath } from './app.js';
import { handleInbound } from './services/inbound.js';
import { runScheduled } from './services/scheduled.js';
import type { Env } from './types.js';

const app = createApp();

/**
 * 给前端资产响应加安全头。邮件正文已在 Shadow DOM 内消毒并按用户意愿放行远程图片，
 * 故 img-src 放开 https:；样式含 React 内联 style，需 'unsafe-inline'。
 * frame-ancestors 'none' 防点击劫持；HSTS 强制 HTTPS。
 */
const CSP = [
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

function withSecurityHeaders(res: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const SLOW_REQUEST_MS = 1500;

/**
 * 只计数、不代理语句：prepare/exec 各算一次往返，batch 整体算一次（抵消其中语句的 prepare）。
 * drizzle 对无参数语句在 batch 里会重复 prepare，故结果是近似值。
 */
function countingDb(db: D1Database, stats: { d1: number }): D1Database {
  return {
    prepare: (query: string) => {
      stats.d1++;
      return db.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => {
      stats.d1 += 1 - statements.length;
      return db.batch(statements);
    },
    exec: (query: string) => {
      stats.d1++;
      return db.exec(query);
    },
    dump: () => db.dump(),
    withSession: (constraint?: Parameters<D1Database['withSession']>[0]) => db.withSession(constraint),
  } as unknown as D1Database;
}

/** 日志里的路由：去掉查询串，数字 id 归一为 :id，避免高基数 */
function routeLabel(pathname: string): string {
  return pathname.replace(/\/\d+(?=\/|$)/g, '/:id');
}

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const started = Date.now();
  const stats = { d1: 0 };
  let res = await app.fetch(request, { ...env, db: countingDb(env.db, stats) }, ctx);
  const ms = Date.now() - started;
  const d1Calls = Math.max(0, stats.d1);
  const timing = `app;dur=${ms}, d1;desc="n=${d1Calls}"`;
  try {
    res.headers.append('Server-Timing', timing);
  } catch {
    // 不可变响应头（如透传的上游响应）复制一份再加
    res = new Response(res.body, res);
    res.headers.append('Server-Timing', timing);
  }
  if (ms > SLOW_REQUEST_MS) {
    const colo = (request as Request & { cf?: { colo?: string } }).cf?.colo ?? '';
    console.log(JSON.stringify({ event: 'slow_request', route: `${request.method} ${routeLabel(url.pathname)}`, status: res.status, ms, colo, d1Calls }));
  }
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) return handleApi(request, env, ctx, url);
    // 其余路径交给静态资源（SPA fallback 由 assets 处理）
    const res = await env.assets.fetch(request);
    // 缺失的哈希资源不能回退成 index.html：nosniff 下会拒绝把 HTML 当 JS 加载，
    // 且会把 HTML 错误缓存到 .js URL 上。命中 SPA fallback（HTML）时对 /assets/ 直接 404。
    if (
      url.pathname.startsWith('/assets/') &&
      (res.headers.get('content-type') || '').includes('text/html')
    ) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    // Agent 文档的静态响应默认不带 charset，显式 UTF-8 并拒绝 SPA fallback。
    if (url.pathname.endsWith('.md') || url.pathname === '/llms.txt') {
      if ((res.headers.get('content-type') || '').includes('text/html')) {
        return withSecurityHeaders(new Response('Not Found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        }));
      }
      return withSecurityHeaders(res, {
        'Content-Type': url.pathname.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
      });
    }
    const hashedAsset = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|webp)$/.test(url.pathname);
    return withSecurityHeaders(res, hashedAsset && res.ok ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : { 'Cache-Control': 'no-cache' });
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInbound(message, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env, _event.cron === '0 16 * * *');
  },
};
