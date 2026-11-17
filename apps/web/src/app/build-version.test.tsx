import { act, render } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toast: vi.fn(() => 7), dismissToast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast, dismissToast: mocks.dismissToast }));

import {
  CLIENT_BUILD,
  FIRST_CHECK_DELAY_MS,
  fetchServerBuild,
  isStaleBuild,
  MIN_CHECK_GAP_MS,
  reloadForNewBuild,
  useBuildVersionCheck,
} from './build-version';

const configResponse = (build: string | null, status = 200) =>
  new Response('{"data":{}}', {
    status,
    headers: { 'content-type': 'application/json', ...(build === null ? {} : { 'X-HPC-Build': build }) },
  });

function renderShell(clientBuild: string, reload: () => void) {
  function Shell() {
    useBuildVersionCheck(clientBuild, reload);
    return <Outlet />;
  }
  const router = createMemoryRouter(
    [{ path: '/', element: <Shell />, children: [{ path: 'inbox', element: <p>inbox</p> }, { path: 'sent', element: <p>sent</p> }, { path: 'mail/:id', element: <p>mail</p> }] }],
    { initialEntries: ['/inbox'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  sessionStorage.clear();
  mocks.toast.mockClear();
  mocks.dismissToast.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('isStaleBuild', () => {
  it('两边都是正式构建且不同才算过期；local 或取不到不判定', () => {
    expect(isStaleBuild('aaa', 'bbb')).toBe(true);
    expect(isStaleBuild('aaa', 'aaa')).toBe(false);
    expect(isStaleBuild('local', 'bbb')).toBe(false);
    expect(isStaleBuild('aaa', 'local')).toBe(false);
    expect(isStaleBuild('aaa', null)).toBe(false);
    expect(isStaleBuild('aaa', '')).toBe(false);
  });

  it('测试环境没有注入构建号，视为本地构建', () => {
    expect(CLIENT_BUILD).toBe('local');
  });
});

describe('fetchServerBuild', () => {
  it('不经缓存请求 /api/config，读 X-HPC-Build 响应头', async () => {
    const fetchMock = vi.fn(async () => configResponse('sha-new'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchServerBuild()).resolves.toBe('sha-new');
    expect(fetchMock).toHaveBeenCalledWith('/api/config', expect.objectContaining({ cache: 'no-store' }));
  });

  it('非 2xx 时不采信', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => configResponse('sha-new', 503)));
    await expect(fetchServerBuild()).resolves.toBeNull();
  });
});

describe('reloadForNewBuild', () => {
  it('同一个线上版本在本标签页只自动刷新一次', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild('sha-new', reload)).toBe(true);
    expect(reloadForNewBuild('sha-new', reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    // 之后又发了新版本：可以再刷新一次
    expect(reloadForNewBuild('sha-newer', reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('离线时不刷新', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const reload = vi.fn();
    expect(reloadForNewBuild('sha-new', reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('useBuildVersionCheck', () => {
  it('线上版本不同：提示刷新，并在下一次切换页面时整页加载新版本', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => configResponse('sha-new'));
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    const router = renderShell('sha-old', reload);
    // 启动时不与首屏请求抢
    expect(fetchMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '网站已更新', action: expect.objectContaining({ label: '刷新' }) }));
    // 只提示，不就地刷新
    expect(reload).not.toHaveBeenCalled();
    await act(() => router.navigate('/sent'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('自动刷新过一次仍不一致时不再提示、不再刷新', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('hpc-mail:build-reloaded-for', 'sha-new');
    vi.stubGlobal('fetch', vi.fn(async () => configResponse('sha-new')));
    const reload = vi.fn();
    const router = renderShell('sha-old', reload);
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS));
    await act(() => router.navigate('/sent'));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('版本一致时什么都不做；切回标签页时按间隔再查', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => configResponse('sha-old'));
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    const router = renderShell('sha-old', reload);
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS));
    await act(() => router.navigate('/sent'));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    // 距上次不足 5 分钟：切回标签页不重复请求
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(MIN_CHECK_GAP_MS));
    fetchMock.mockResolvedValue(configResponse('sha-new'));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledOnce();
  });

  it('本地构建不检查', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => configResponse('sha-new'));
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    const router = renderShell('local', reload);
    await act(() => vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS * 10));
    await act(() => router.navigate('/sent'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
