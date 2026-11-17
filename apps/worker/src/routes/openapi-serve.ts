import type { Context } from 'hono';
import type { AppContext } from '../types.js';

/** 自部署通常只有一两个 origin；超过时整表清空，任意 Host 也撑不大 */
const MAX_CACHED = 8;
const cache = new Map<string, string>();

/**
 * GET /api/openapi.json 与 /v1/openapi.json：文档只取决于请求 origin。构建模块按需加载（不进 Worker 冷启动，
 * 收件、定时任务也不必初始化它们），序列化结果按 origin 缓存在 isolate 内，重复请求不再重建几百 KB 的文档。
 */
export async function serveOpenApi(c: Context<AppContext>, which: 'api' | 'v1'): Promise<Response> {
  const origin = new URL(c.req.url).origin;
  const key = `${which} ${origin}`;
  let body = cache.get(key);
  if (body === undefined) {
    const spec = which === 'api'
      ? (await import('./api-openapi.js')).buildSessionOpenApiSpec(origin)
      : (await import('./v1/openapi.js')).buildOpenApiSpec(origin);
    body = JSON.stringify(spec);
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(key, body);
  }
  return c.body(body, 200, { 'Content-Type': 'application/json' });
}
