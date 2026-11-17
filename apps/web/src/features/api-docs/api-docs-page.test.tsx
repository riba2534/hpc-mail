import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiDocsPage } from './api-docs-page';
import { REFERENCE_DOCS } from './docs-manifest';

const docs: Record<string, string> = {
  '/skill.md':
    '---\nname: hpc-mail\ndescription: 入口简介\n---\n\n# HPC Mail\n\n见[发送](references/mail.md#发送)与[外站](https://example.com/x)。\n',
  '/references/mail.md': '# 邮件、验证码与发送\n\n## 读取\n\n正文\n\n## 发送\n\n回到[入口](../skill.md)。\n',
};

const markdown = (body: string) => new Response(body, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const body = docs[String(input)];
  return body === undefined
    ? new Response('{"error":{"code":"not_found","message":"Not found"}}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    : markdown(body);
});
const scrollIntoView = vi.fn();

function renderPage(path: string) {
  const router = createMemoryRouter([{ path: '/api-docs/:doc?', element: <ApiDocsPage /> }], { initialEntries: [path] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const fetchedPaths = () => fetchMock.mock.calls.map(([input]) => String(input));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  scrollIntoView.mockClear();
});

describe('ApiDocsPage', () => {
  it('加载中显示占位', () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    renderPage('/api-docs');
    expect(screen.getByRole('status', { name: '文档加载中' })).toBeInTheDocument();
    expect(fetchedPaths()).toEqual(['/skill.md']);
  });

  it('入口渲染 skill.md：去掉 frontmatter、显示简介；目录、原文与 OpenAPI 链接齐全', async () => {
    renderPage('/api-docs');
    expect(await screen.findByRole('heading', { level: 1, name: 'HPC Mail' })).toBeInTheDocument();
    expect(screen.getByText('入口简介')).toBeInTheDocument();
    expect(screen.queryByText(/name: hpc-mail/)).toBeNull();

    // 窄屏顶部与宽屏侧栏各一份（由断点切换显示），内容相同；侧栏分组
    const navs = screen.getAllByRole('navigation', { name: '文档目录' });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const entries = within(nav).getAllByRole('link');
      expect(entries.map((link) => link.getAttribute('href'))).toEqual([
        '/api-docs',
        ...REFERENCE_DOCS.map((doc) => `/api-docs/${doc.slug}`),
      ]);
      expect(within(nav).getByRole('link', { name: 'HPC Mail' })).toHaveAttribute('aria-current', 'page');
      expect(within(nav).getByRole('link', { name: '管理员功能' })).not.toHaveAttribute('aria-current');
    }
    expect(within(navs[1]!).getByText('参考文档')).toBeInTheDocument();

    const raw = screen.getByRole('link', { name: '查看原文' });
    expect(raw).toHaveAttribute('href', '/skill.md');
    expect(raw).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'OpenAPI' })).toHaveAttribute('href', '/v1/openapi.json');
    expect(screen.getByRole('link', { name: '会话 OpenAPI' })).toHaveAttribute('href', '/api/openapi.json');

    const external = screen.getByRole('link', { name: '外站' });
    expect(external).toHaveAttribute('href', 'https://example.com/x');
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('正文里的文档链接走站内路由并滚动到锚点，../skill.md 回到入口', async () => {
    const user = userEvent.setup();
    const router = renderPage('/api-docs');
    await user.click(await screen.findByRole('link', { name: '发送' }));

    expect(await screen.findByRole('heading', { level: 1, name: '邮件、验证码与发送' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/api-docs/mail');
    expect(decodeURIComponent(router.state.location.hash)).toBe('#发送');
    expect(fetchedPaths()).toEqual(['/skill.md', '/references/mail.md']);
    await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(screen.getByRole('heading', { level: 2, name: '发送' })));
    expect(screen.getByRole('link', { name: '查看原文' })).toHaveAttribute('href', '/references/mail.md');

    await user.click(screen.getByRole('link', { name: '入口' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'HPC Mail' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/api-docs');
  });

  it('加载失败显示错误与重试，重试成功后显示正文', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(async () => new Response('oops', { status: 502 }));
    renderPage('/api-docs/mail');
    expect(await screen.findByText('加载失败')).toBeInTheDocument();
    expect(screen.getByText('文档加载失败（HTTP 502）')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('heading', { level: 1, name: '邮件、验证码与发送' })).toBeInTheDocument();
  });

  it('网络错误显示网络提示', async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderPage('/api-docs/mail');
    expect(await screen.findByText('网络连接失败，请检查网络后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });

  it('未登记的文档提示不存在且不发请求，可回到入口', async () => {
    const user = userEvent.setup();
    const router = renderPage('/api-docs/nope');
    expect(screen.getByText('文档不存在')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '查看原文' })).toBeNull();

    await user.click(screen.getByRole('link', { name: '返回文档入口' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'HPC Mail' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/api-docs');
  });

  it('原文返回 404 时同样提示不存在', async () => {
    renderPage('/api-docs/errors');
    expect(await screen.findByText('文档不存在')).toBeInTheDocument();
    expect(fetchedPaths()).toEqual(['/references/errors.md']);
  });

  it('SPA 回退的 HTML 不当作文档渲染', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } }),
    );
    renderPage('/api-docs/mcp');
    expect(await screen.findByText('文档不存在')).toBeInTheDocument();
  });
});
