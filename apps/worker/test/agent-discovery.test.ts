import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import worker from '../src/index.js';

const app = createApp();

describe('Agent 接口发现与错误契约', () => {
  it('未知 API 返回可解析的错误和关联 requestId，包含当前认证接口的描述链接', async () => {
    for (const namespace of ['api', 'v1']) {
      const ctx = createExecutionContext();
      const response = await app.request(`/${namespace}/missing-agent-endpoint`, {}, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string }; requestId: string };
      expect(body.error.code).toBe('not_found');
      expect(body.requestId).toBe(response.headers.get('X-Request-ID'));
      expect(body.requestId).toBeTruthy();
      expect(response.headers.get('Link')).toContain(`</${namespace}/openapi.json>`);
      expect(response.headers.get('Link')).toContain('</skill.md>');
    }
  });

  it('不存在的 Markdown 文档不能作为成功的技能正文返回 SPA HTML', async () => {
    const response = await worker.fetch(new Request('https://mail.example/agent/missing.md'), {
      ...env,
      assets: { fetch: async () => new Response('<html>SPA fallback</html>', { headers: { 'Content-Type': 'text/html' } }) } as unknown as Fetcher,
    }, createExecutionContext());
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(await response.text()).toBe('Not Found');
  });

  it('真实 Markdown 文档保留内容并明确 UTF-8 编码', async () => {
    const content = '---\nname: hpc-mail\n---\n邮箱操作';
    const response = await worker.fetch(new Request('https://mail.example/skill.md'), {
      ...env,
      assets: { fetch: async () => new Response(content, { headers: { 'Content-Type': 'text/markdown' } }) } as unknown as Fetcher,
    }, createExecutionContext());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(await response.text()).toBe(content);
  });
});
