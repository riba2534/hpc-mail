import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/errors';
import { classifyRouteError, RouteErrorPage } from './route-error-page';

function renderThrowing(error: unknown) {
  const Boom = () => {
    throw error;
  };
  const router = createMemoryRouter([{ path: '/', element: <Boom />, errorElement: <RouteErrorPage /> }]);
  render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyRouteError', () => {
  it('识别各浏览器的动态 import 失败', () => {
    expect(classifyRouteError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/a.js'))).toBe('chunk');
    expect(classifyRouteError(new TypeError('error loading dynamically imported module: http://x/a.js'))).toBe('chunk');
    expect(classifyRouteError(new TypeError('Importing a module script failed.'))).toBe('chunk');
    expect(classifyRouteError(new Error('Unable to preload CSS for /assets/a.css'))).toBe('chunk');
    expect(classifyRouteError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe('chunk');
  });

  it('识别 fetch 网络失败与 API 网络/超时错误', () => {
    expect(classifyRouteError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyRouteError(new TypeError('Load failed'))).toBe('network');
    expect(classifyRouteError(new ApiError('网络连接失败', { code: 'network' }))).toBe('network');
    expect(classifyRouteError(new ApiError('请求超时', { code: 'timeout' }))).toBe('network');
  });

  it('其他错误不归类', () => {
    expect(classifyRouteError(new Error('Cannot read properties of undefined'))).toBe('other');
    expect(classifyRouteError(new ApiError('无权访问', { code: 'forbidden', httpStatus: 403 }))).toBe('other');
    expect(classifyRouteError('boom')).toBe('other');
  });
});

describe('RouteErrorPage', () => {
  it('chunk 加载失败显示中文提示与刷新按钮，英文报错只在折叠的技术细节里', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = 'Failed to fetch dynamically imported module: http://localhost/assets/inbox-page-abc.js';
    renderThrowing(new TypeError(raw));
    expect(screen.getByRole('heading', { name: '页面资源加载失败' })).toBeInTheDocument();
    expect(screen.getByText(/网站刚刚更新或网络不稳定/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
    const details = screen.getByText('技术细节').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent(raw);
  });

  it('网络失败且离线时提示恢复连接', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('navigator', { onLine: false });
    renderThrowing(new TypeError('Failed to fetch'));
    expect(screen.getByRole('heading', { name: '网络连接失败' })).toBeInTheDocument();
    expect(screen.getByText(/恢复连接后刷新页面/)).toBeInTheDocument();
  });

  it('其他错误保持原展示，不显示技术细节折叠区', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderThrowing(new Error('组件渲染失败'));
    expect(screen.getByRole('heading', { name: '页面出错了' })).toBeInTheDocument();
    expect(screen.getByText('组件渲染失败')).toBeInTheDocument();
    expect(screen.queryByText('技术细节')).toBeNull();
  });
});
