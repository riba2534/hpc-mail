import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/lib/security-headers.js';
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
    expect(headersFor(headersFile, '/*')).toEqual(SECURITY_HEADERS);
  });

  it('CSP 放行 Cloudflare Web Analytics 的脚本与上报源，其余仍只允许本站', () => {
    const directives = Object.fromEntries(CONTENT_SECURITY_POLICY.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name!, values];
    }));
    expect(directives['script-src']).toEqual(["'self'", 'https://static.cloudflareinsights.com']);
    expect(directives['connect-src']).toEqual(["'self'", 'https://cloudflareinsights.com']);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it('经过 Worker 的前端响应带同一组安全头', async () => {
    const response = await worker.fetch(new Request('https://mail.example/skill.md'), {
      ...env,
      assets: { fetch: async () => new Response('# skill', { headers: { 'Content-Type': 'text/markdown' } }) } as unknown as Fetcher,
    }, createExecutionContext());
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name), name).toBe(value);
  });
});
