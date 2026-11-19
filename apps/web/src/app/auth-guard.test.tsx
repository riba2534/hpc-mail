import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/api/query-keys';
import { draftKeyForUser } from '@/features/compose/compose-draft';
import { getAuthRevision, setAuthToken } from '@/lib/auth-token';
import { readTokenClaims } from '@/lib/token-claims';
import { useCurrentUser } from '@/lib/use-session';

const shellMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('./route-modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./route-modules')>();
  function StubShell() {
    const user = useCurrentUser();
    useEffect(() => {
      shellMounts.count += 1;
    }, []);
    return <p>shell {user.username} {user.role}</p>;
  }
  return { ...actual, loadAppShell: actual.preloadable(async () => ({ AppShell: StubShell })) };
});

import { AuthGuard } from './auth-guard';
import { installQueryPersistence, queryCacheStorageKey, restoreQueryCache, writeQueryCache } from './query-persistence';

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const TOKEN = `${b64url({ alg: 'HS256' })}.${b64url({ sub: 1, sid: 's' })}.sig`;
const cachedUser = { id: 1, username: 'cached', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let client: QueryClient;
let uninstall: () => void;

/** 上次打开时写下的持久缓存 → 本次启动恢复 */
function bootWithPersistedSession() {
  setAuthToken(TOKEN);
  const writer = new QueryClient();
  writer.setQueryData(queryKeys.sessionForRevision(getAuthRevision()), cachedUser);
  writeQueryCache(writer);
  writer.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  expect(restoreQueryCache(client)).toBe(true);
  uninstall = installQueryPersistence(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<AuthGuard />} />
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  uninstall();
  client.clear();
  vi.unstubAllGlobals();
});

describe('AuthGuard 使用恢复的会话', () => {
  it('不等 /auth/me 先渲染外壳，返回后以服务端的用户为准', async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (respond = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    bootWithPersistedSession();
    expect(await screen.findByText('shell cached user')).toBeInTheDocument();
    // 挂载时后台校验当前会话
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.anything()));
    respond(json(200, { data: { ...cachedUser, username: 'fresh', role: 'admin' } }));
    expect(await screen.findByText('shell fresh admin')).toBeInTheDocument();
  });

  it('/auth/me 返回 401 时清 token、清缓存并回到登录页', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'unauthorized', message: '登录已过期' } })));
    bootWithPersistedSession();
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    // 内存缓存同样清空（登出后的守卫只留一个未启用、无数据的会话查询）
    expect(client.getQueryCache().getAll().filter((query) => query.state.data !== undefined)).toHaveLength(0);
  });

  it('/auth/me 返回 403（账号已禁用）时以服务端为准', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { error: { code: 'user_disabled', message: '账号已被禁用' } })));
    bootWithPersistedSession();
    expect(await screen.findByText('账号已被禁用')).toBeInTheDocument();
    expect(screen.queryByText(/^shell/)).toBeNull();
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
  });

  it('网络失败时继续使用缓存的用户', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    bootWithPersistedSession();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(client.getQueryState(queryKeys.sessionForRevision(getAuthRevision()))?.status).toBe('error'));
    expect(screen.getByText('shell cached user')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe(TOKEN);
  });
});

describe('守卫错误页的退出登录', () => {
  const seed = () => {
    localStorage.setItem(draftKeyForUser(1, 'reply:9'), '{}');
    localStorage.setItem('hpc-trusted-image-senders:1', '["friend@example.com"]');
    localStorage.setItem(draftKeyForUser(2), '{}');
  };
  const logoutCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url, init]) => url === '/api/auth/logout' && (init as RequestInit | undefined)?.method === 'POST');

  it('账号已禁用时与外壳菜单走同一条清理路径：吊销会话、删除该账户的本机数据，回到登录页', async () => {
    const fetchMock = vi.fn(async () => json(403, { error: { code: 'user_disabled', message: '账号已被禁用' } }));
    vi.stubGlobal('fetch', fetchMock);
    bootWithPersistedSession();
    seed();
    await screen.findByText('账号已被禁用');

    screen.getByRole('button', { name: '退出登录' }).click();
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(logoutCalls(fetchMock)).toHaveLength(1);
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:9'))).toBeNull();
    expect(localStorage.getItem('hpc-trusted-image-senders:1')).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(2))).not.toBeNull();
  });

  it('没有用户数据（网络失败、无缓存）时按 token 里的账户清理', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(TOKEN);
    seed();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    uninstall = () => {};
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox" element={<AuthGuard />} />
            <Route path="/login" element={<p>login page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText('暂时无法加载账户');

    screen.getByRole('button', { name: '退出登录' }).click();
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(logoutCalls(fetchMock)).toHaveLength(1);
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:9'))).toBeNull();
    expect(localStorage.getItem(draftKeyForUser(2))).not.toBeNull();
  });
});

describe('同一账户换发 token', () => {
  const jwt = (sub: number, sid: string) => `${b64url({ alg: 'HS256' })}.${b64url({ sub, sid })}.sig`;

  it('其他标签页改密换发 token：外壳不重挂、不闪全屏加载、查询缓存保留；换成其他账户才重挂并清缓存', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const sub = readTokenClaims(new Headers(init?.headers).get('Authorization')!.slice('Bearer '.length))!.sub;
      return json(200, { data: { ...cachedUser, id: sub, username: `user${sub}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    setAuthToken(jwt(1, 'before'));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    uninstall = () => {};
    shellMounts.count = 0;
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route path="/inbox" element={<AuthGuard />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('shell user1 user')).toBeInTheDocument();
    expect(shellMounts.count).toBe(1);
    client.setQueryData(['messages', 'detail', 1], { body: 'mine' });

    act(() => setAuthToken(jwt(1, 'after-password-change')));
    // 新一代会话在后台校验，期间沿用上一代的用户，不出现全屏加载
    expect(screen.getByText('shell user1 user')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.getQueryState(queryKeys.sessionForRevision(getAuthRevision()))?.status).toBe('success'));
    expect(shellMounts.count).toBe(1);
    expect(client.getQueryData(['messages', 'detail', 1])).toEqual({ body: 'mine' });

    act(() => setAuthToken(jwt(2, 'someone-else')));
    expect(screen.queryByText('shell user1 user')).toBeNull();
    expect(await screen.findByText('shell user2 user')).toBeInTheDocument();
    expect(shellMounts.count).toBe(2);
    expect(client.getQueryData(['messages', 'detail', 1])).toBeUndefined();
  });
});
