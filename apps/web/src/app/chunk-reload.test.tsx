import { render, screen } from '@testing-library/react';
import { Component, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 模块内有「刷新进行中」状态，每个用例重新加载一份，模拟刷新后的新页面
async function freshModule() {
  vi.resetModules();
  return import('./chunk-reload');
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p>error: {this.state.error.message}</p> : this.props.children;
  }
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reloadForStaleChunk', () => {
  it('刷新一次后在冷却期内不再刷新，冷却后可再次自愈', async () => {
    const reload = vi.fn();
    const first = await freshModule();
    expect(first.reloadForStaleChunk(reload, 1_000)).toBe(true);
    // 同一页面内的后续失败（如 preloadError 与 import 失败同时到达）不重复刷新
    expect(first.reloadForStaleChunk(reload, 1_001)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const afterReload = await freshModule();
    expect(afterReload.reloadForStaleChunk(reload, 5_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    const nextDeploy = await freshModule();
    expect(nextDeploy.reloadForStaleChunk(reload, 40_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('sessionStorage 不可用时不自动刷新，避免死循环', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    const reload = vi.fn();
    const { reloadForStaleChunk } = await freshModule();
    expect(reloadForStaleChunk(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('离线时的加载失败不刷新', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const reload = vi.fn();
    const { reloadForStaleChunk } = await freshModule();
    expect(reloadForStaleChunk(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('vite:preloadError 不就地刷新、不吞错误，下一次换页时整页加载新版本', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const { installChunkReloadHandler, lazyWithReload } = await freshModule();
    const { preloadable } = await import('./route-modules');
    installChunkReloadHandler();
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    const load = preloadable(async () => ({ Page: () => <p>next page</p> }));
    await load();
    const Page = lazyWithReload(load, (m) => m.Page);
    render(<Page />);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});

describe('lazyWithReload', () => {
  it('已预热的模块首次渲染即同步可用，不经过 fallback', async () => {
    const { lazyWithReload } = await freshModule();
    const { preloadable } = await import('./route-modules');
    const load = preloadable(async () => ({ Page: ({ name }: { name: string }) => <p>hello {name}</p> }));
    await load();
    const Page = lazyWithReload(load, (m) => m.Page, <p>loading</p>);
    render(<Page name="mail" />);
    expect(screen.getByText('hello mail')).toBeInTheDocument();
    expect(screen.queryByText('loading')).toBeNull();
  });

  it('未就绪时先渲染 fallback，加载完成后替换', async () => {
    const { lazyWithReload } = await freshModule();
    const { preloadable } = await import('./route-modules');
    let resolve!: (value: { Page: () => ReactNode }) => void;
    const load = preloadable(() => new Promise<{ Page: () => ReactNode }>((done) => (resolve = done)));
    const Page = lazyWithReload(load, (m) => m.Page, <p>loading</p>);
    render(<Page />);
    expect(screen.getByText('loading')).toBeInTheDocument();
    resolve({ Page: () => <p>ready</p> });
    expect(await screen.findByText('ready')).toBeInTheDocument();
  });

  it('chunk 加载失败时刷新并保持 fallback，不闪错误页', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const { lazyWithReload } = await freshModule();
    const { preloadable } = await import('./route-modules');
    const load = preloadable<{ Page: () => ReactNode }>(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    const Page = lazyWithReload(load, (m) => m.Page, <p>loading</p>);
    render(
      <Boundary>
        <Page />
      </Boundary>,
    );
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText('loading')).toBeInTheDocument();
  });

  it('冷却期内再次失败则抛给错误边界', async () => {
    sessionStorage.setItem('hpc-mail:chunk-reload-at', String(Date.now()));
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const { lazyWithReload } = await freshModule();
    const { preloadable } = await import('./route-modules');
    const load = preloadable<{ Page: () => ReactNode }>(() => Promise.reject(new Error('chunk missing')));
    const Page = lazyWithReload(load, (m) => m.Page, <p>loading</p>);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <Boundary>
        <Page />
      </Boundary>,
    );
    expect(await screen.findByText('error: chunk missing')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });
});
