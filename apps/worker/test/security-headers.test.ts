import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { APP_SHELL_CACHE_CONTROL, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/lib/security-headers.js';
import headersFile from '../../web/public/_headers?raw';

/** 解析 _headers 中某个路径段下的 `Name: value` 行 */
function headersFor(file: string, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inSection = false;
  for (const line of file.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { inSection = line.trim() === path; continue; }
    if (!inSection) continue;
    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

describe('前端安全响应头（R56）', () => {
  it('资产层 _headers 的 /* 段与 Worker 常量逐字一致', () => {
    expect(headersFor(headersFile, '/*')).toEqual({ ...SECURITY_HEADERS, 'Cache-Control': APP_SHELL_CACHE_CONTROL });
  });

  it('CSP 的脚本与连接只允许本站', () => {
    const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name!, values];
    }));
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it('HTML 页面经 Worker 时同样禁止边缘改写和注入', async () => {
    const response = await worker.fetch(new Request('https://mail.example/mail/123'), {
      ...env,
      assets: { fetch: async () => new Response('<!doctype html><main>mail</main>', { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher,
    }, createExecutionContext());
    expect(response.headers.get('Cache-Control')?.split(', ')).toContain('no-transform');
    expect(await response.text()).toContain('<main>mail</main>');
  });

  it('经过 Worker 的前端响应带同一组安全头', async () => {
    const response = await worker.fetch(new Request('https://mail.example/skill.md'), {
      ...env,
      assets: { fetch: async () => new Response('# skill', { headers: { 'Content-Type': 'text/markdown' } }) } as unknown as Fetcher,
    }, createExecutionContext());
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name), name).toBe(value);
  });
});
