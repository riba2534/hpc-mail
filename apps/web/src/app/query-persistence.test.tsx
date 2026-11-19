import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageSummary, Page } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import type { MessageListData } from '@/features/inbox/message-cache';
import { clearAuthToken, getAuthRevision, setAuthToken } from '@/lib/auth-token';
import { readTokenClaims } from '@/lib/token-claims';
import {
  defaultInboxListKey,
  installQueryPersistence,
  QUERY_CACHE_MAX_AGE_MS,
  QUERY_CACHE_MAX_BYTES,
  QUERY_CACHE_WRITE_DELAY_MS,
  queryCacheStorageKey,
  restoreQueryCache,
  useRestoredQueryRefreshing,
  writeQueryCache,
} from './query-persistence';

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (sub: number, exp?: number) => `${b64url({ alg: 'HS256' })}.${b64url({ sub, sid: 's', exp })}.sig`;
const user = (id: number) => ({ id, username: `u${id}`, role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false });
const message = (id: number, extra: Partial<MessageSummary> = {}) => ({ id, subject: `subject ${id}`, preview: '', ...extra }) as MessageSummary;
const listData = (...pages: MessageSummary[][]): MessageListData => ({
  pages: pages.map((items, index) => ({ items, nextCursor: index < pages.length - 1 ? `c${index + 1}` : null }) as Page<MessageSummary>),
  pageParams: pages.map((_, index) => (index === 0 ? '' : `c${index}`)),
});
const stored = (userId: number) => JSON.parse(localStorage.getItem(queryCacheStorageKey(userId)) ?? 'null');
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** 模拟本账户首屏查询都已成功 */
function seedQueries(client: QueryClient, userId: number) {
  const revision = getAuthRevision();
  client.setQueryData(queryKeys.sessionForRevision(revision), user(userId));
  client.setQueryData(defaultInboxListKey(), listData([message(1), message(2)], [message(3)]));
  client.setQueryData(queryKeys.messages.unreadCount, { unread: 4 });
  client.setQueryData(queryKeys.mailboxes.list('mine'), [{ address: 'me@example.com', domain: 'example.com' }]);
  client.setQueryData(queryKeys.mailboxes.shared, []);
  client.setQueryData(queryKeys.domains, ['example.com']);
  client.setQueryData(queryKeys.config, { siteTitle: 'HPC Mail' });
  // 不应落盘的：详情、筛选视图、管理视图、全站地址
  client.setQueryData(queryKeys.messages.detail(1, undefined), { id: 1, bodyHtml: 'secret body', attachments: [{ url: 'https://signed' }] });
  client.setQueryData(queryKeys.messages.list({ direction: 'inbound', scope: 'mine', unread: true }), listData([message(9)]));
  client.setQueryData(queryKeys.messages.list({ scope: 'unclaimed' }), listData([message(10)]));
  client.setQueryData(queryKeys.admin.users, [{ id: 99 }]);
  client.setQueryData(queryKeys.mailboxes.list('all'), [{ address: 'other@example.com' }]);
}

beforeEach(() => {
  localStorage.clear();
  setAuthToken(jwt(1));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('readTokenClaims', () => {
  it('只解析 payload 的 sub/exp，格式不对返回 null', () => {
    expect(readTokenClaims(jwt(42, 100))).toEqual({ sub: 42, exp: 100 });
    expect(readTokenClaims(null)).toBeNull();
    expect(readTokenClaims('opaque-token')).toBeNull();
    expect(readTokenClaims(`a.${b64url({ sub: '42' })}.c`)).toBeNull();
    expect(readTokenClaims('a.%%%.c')).toBeNull();
  });
});

describe('writeQueryCache', () => {
  it('按用户写入首屏查询；收件箱只留首页；不写详情、筛选视图与管理视图', () => {
    const client = newClient();
    seedQueries(client, 1);
    writeQueryCache(client, 5_000);
    const cache = stored(1);
    expect(cache.savedAt).toBe(5_000);
    expect(Object.keys(cache.entries)).toEqual(['session', 'inbox', 'unread', 'mailboxes', 'shared', 'domains', 'config']);
    expect(cache.entries.session.data.id).toBe(1);
    expect(cache.entries.inbox.data.pages).toHaveLength(1);
    expect(cache.entries.inbox.data.pages[0].items.map((item: MessageSummary) => item.id)).toEqual([1, 2]);
    expect(cache.entries.inbox.data.pageParams).toEqual(['']);
    expect(typeof cache.entries.inbox.updatedAt).toBe('number');
    const raw = localStorage.getItem(queryCacheStorageKey(1))!;
    for (const secret of ['secret body', 'https://signed', 'subject 9', 'subject 10', 'other@example.com', '"id":99']) {
      expect(raw).not.toContain(secret);
    }
    client.clear();
  });

  it('首屏缓存移除主题、摘要、验证码、验证链接和条件同步指纹', () => {
    const client = newClient();
    seedQueries(client, 1);
    const data = listData([message(4, {
      subject: 'Email secret 123456',
      verificationCode: '123456',
      verificationLink: 'https://example.test/auth?token=private',
      preview: 'Email body token',
    })]);
    data.pages[0]!.head = 'previous-content-fingerprint';
    client.setQueryData(defaultInboxListKey(), data);
    writeQueryCache(client);
    const raw = localStorage.getItem(queryCacheStorageKey(1))!;
    for (const secret of ['123456', 'Email secret', 'token=private', 'Email body token', 'previous-content-fingerprint']) {
      expect(raw).not.toContain(secret);
    }
    expect(stored(1).entries.inbox.data.pages[0].items[0]).toMatchObject({ id: 4, preview: '', subject: '', verificationCode: '' });
    expect(data.pages[0]!.items[0]!.verificationCode).toBe('123456');
    client.clear();
  });

  it('会话用户与 token 不是同一账户、或会话尚未成功时不写', () => {
    const client = newClient();
    seedQueries(client, 2);
    writeQueryCache(client);
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    expect(localStorage.getItem(queryCacheStorageKey(2))).toBeNull();
    clearAuthToken();
    seedQueries(client, 1);
    writeQueryCache(client);
    expect(localStorage.length).toBe(0);
    client.clear();
  });

  it('超过大小上限时按重要性保留：放不下的大项跳过，其余照存', () => {
    const client = newClient();
    seedQueries(client, 1);
    const huge = 'x'.repeat(QUERY_CACHE_MAX_BYTES);
    client.setQueryData(defaultInboxListKey(), listData([message(1, { fromName: huge })]));
    writeQueryCache(client);
    const raw = localStorage.getItem(queryCacheStorageKey(1))!;
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(QUERY_CACHE_MAX_BYTES + 64);
    expect(Object.keys(JSON.parse(raw).entries)).toEqual(['session', 'unread', 'mailboxes', 'shared', 'domains', 'config']);
    client.clear();
  });
});

describe('restoreQueryCache', () => {
  function persistFor(userId: number, now = Date.now()) {
    const writer = newClient();
    seedQueries(writer, userId);
    writeQueryCache(writer, now);
    writer.clear();
  }

  it('升级时删除旧首屏缓存和持久化发件人信任', () => {
    localStorage.setItem('hpc-query-cache:v1:1', '{"verificationCode":"123456"}');
    localStorage.setItem('hpc-trusted-image-senders:1', '["sender@example.test"]');
    const client = newClient();
    expect(restoreQueryCache(client)).toBe(false);
    expect(localStorage.getItem('hpc-query-cache:v1:1')).toBeNull();
    expect(localStorage.getItem('hpc-trusted-image-senders:1')).toBeNull();
    expect(client.getQueryData(defaultInboxListKey())).toBeUndefined();
  });

  it('恢复到与页面相同的 queryKey，保留原 updatedAt 并标记为过期', () => {
    persistFor(1);
    const entries = stored(1).entries;
    const client = newClient();
    expect(restoreQueryCache(client)).toBe(true);
    const revision = getAuthRevision();
    expect(client.getQueryData(queryKeys.sessionForRevision(revision))).toEqual(user(1));
    const list = client.getQueryData<MessageListData>(defaultInboxListKey())!;
    expect(list.pages).toHaveLength(1);
    expect(list.pages[0]!.items.map((item) => item.id)).toEqual([1, 2]);
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 4 });
    expect(client.getQueryData(queryKeys.config)).toEqual({ siteTitle: 'HPC Mail' });
    const state = client.getQueryState(defaultInboxListKey())!;
    expect(state.dataUpdatedAt).toBe(entries.inbox.updatedAt);
    // staleTime 为 Infinity 的公开配置也必须在挂载/预取时刷新
    expect(client.getQueryCache().find({ queryKey: queryKeys.config, exact: true })!.isStaleByTime(Number.POSITIVE_INFINITY)).toBe(true);
    expect(client.getQueryData(queryKeys.messages.detail(1, undefined))).toBeUndefined();
    client.clear();
  });

  it('超过 7 天的项作废；会话用户过期则整份缓存作废并删除', () => {
    const now = Date.now();
    persistFor(1, now);
    const raw = stored(1);
    raw.entries.inbox.updatedAt = now - QUERY_CACHE_MAX_AGE_MS - 1;
    localStorage.setItem(queryCacheStorageKey(1), JSON.stringify(raw));
    const client = newClient();
    expect(restoreQueryCache(client, now)).toBe(true);
    expect(client.getQueryData(defaultInboxListKey())).toBeUndefined();
    expect(client.getQueryData(queryKeys.messages.unreadCount)).toEqual({ unread: 4 });
    client.clear();

    raw.entries.session.updatedAt = now - QUERY_CACHE_MAX_AGE_MS - 1;
    localStorage.setItem(queryCacheStorageKey(1), JSON.stringify(raw));
    expect(restoreQueryCache(client, now)).toBe(false);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
  });

  it('按 token 的 sub 隔离：只读当前账户的缓存，并清掉其他账户与旧版本的残留', () => {
    persistFor(1);
    localStorage.setItem('hpc-query-cache:v0:1', '{}');
    setAuthToken(jwt(2));
    persistFor(2);
    expect(localStorage.getItem(queryCacheStorageKey(1))).not.toBeNull();
    const client = newClient();
    expect(restoreQueryCache(client)).toBe(true);
    expect(client.getQueryData(queryKeys.sessionForRevision(getAuthRevision()))).toEqual(user(2));
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    expect(localStorage.getItem('hpc-query-cache:v0:1')).toBeNull();
    client.clear();
  });

  it('缓存里的会话用户不是 token 的账户时不恢复', () => {
    persistFor(1);
    localStorage.setItem(queryCacheStorageKey(3), localStorage.getItem(queryCacheStorageKey(1))!);
    setAuthToken(jwt(3));
    const client = newClient();
    expect(restoreQueryCache(client)).toBe(false);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(localStorage.getItem(queryCacheStorageKey(3))).toBeNull();
  });

  it('token 已过期或没有 token 时不恢复；没有 token 时删除全部缓存', () => {
    const now = Date.now();
    setAuthToken(jwt(1, Math.floor(now / 1000) - 10));
    persistFor(1, now);
    const client = newClient();
    expect(restoreQueryCache(client, now)).toBe(false);
    expect(client.getQueryCache().getAll()).toHaveLength(0);

    clearAuthToken();
    localStorage.setItem(queryCacheStorageKey(1), '{}');
    expect(restoreQueryCache(client, now)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('损坏的数据被丢弃', () => {
    localStorage.setItem(queryCacheStorageKey(1), '{not json');
    const client = newClient();
    expect(restoreQueryCache(client)).toBe(false);
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
  });
});

describe('installQueryPersistence', () => {
  it('查询成功后防抖约 1 秒写入', async () => {
    vi.useFakeTimers();
    const client = newClient();
    const uninstall = installQueryPersistence(client);
    const revision = getAuthRevision();
    await client.fetchQuery({ queryKey: queryKeys.sessionForRevision(revision), queryFn: async () => user(1) });
    await client.fetchQuery({ queryKey: queryKeys.messages.unreadCount, queryFn: async () => ({ unread: 1 }) });
    // 非持久化查询不触发写入
    vi.advanceTimersByTime(QUERY_CACHE_WRITE_DELAY_MS - 1);
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    vi.advanceTimersByTime(1);
    expect(stored(1).entries.unread.data).toEqual({ unread: 1 });
    uninstall();
    client.clear();
  });

  it('退出登录与 401 清 token 时删除全部持久缓存，并取消待写入', async () => {
    vi.useFakeTimers();
    const client = newClient();
    const uninstall = installQueryPersistence(client);
    seedQueries(client, 1);
    vi.advanceTimersByTime(QUERY_CACHE_WRITE_DELAY_MS);
    expect(stored(1)).not.toBeNull();
    localStorage.setItem('hpc-query-cache:v1:7', '{}');

    clearAuthToken();
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    expect(localStorage.getItem('hpc-query-cache:v1:7')).toBeNull();

    // 401：apiRequest 清 token 走同一条路径；清理前排队的写入不会在之后复活缓存
    setAuthToken(jwt(1));
    seedQueries(client, 1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401, headers: { 'content-type': 'application/json' } })));
    const { messageApi } = await import('@/api/resources');
    await expect(messageApi.unreadCount()).rejects.toBeInstanceOf(ApiError);
    vi.advanceTimersByTime(QUERY_CACHE_WRITE_DELAY_MS * 2);
    expect(localStorage.length).toBe(0);
    vi.unstubAllGlobals();
    uninstall();
    client.clear();
  });

  it('跨标签页切换账户时删除持久缓存', () => {
    vi.useFakeTimers();
    const client = newClient();
    const uninstall = installQueryPersistence(client);
    seedQueries(client, 1);
    vi.advanceTimersByTime(QUERY_CACHE_WRITE_DELAY_MS);
    expect(stored(1)).not.toBeNull();
    act(() => {
      localStorage.setItem('token', jwt(2));
      window.dispatchEvent(new StorageEvent('storage', { key: 'token' }));
    });
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    uninstall();
    client.clear();
  });

  it('/auth/me 返回 403（账号已禁用）时删除持久缓存', async () => {
    vi.useFakeTimers();
    const client = newClient();
    const uninstall = installQueryPersistence(client);
    seedQueries(client, 1);
    vi.advanceTimersByTime(QUERY_CACHE_WRITE_DELAY_MS);
    expect(stored(1)).not.toBeNull();
    await client
      .fetchQuery({
        queryKey: queryKeys.sessionForRevision(getAuthRevision()),
        queryFn: async () => {
          throw new ApiError('账号已被禁用', { code: 'user_disabled', httpStatus: 403 });
        },
      })
      .catch(() => undefined);
    expect(localStorage.getItem(queryCacheStorageKey(1))).toBeNull();
    uninstall();
    client.clear();
  });
});

describe('useRestoredQueryRefreshing', () => {
  function Probe() {
    const syncing = useRestoredQueryRefreshing(defaultInboxListKey());
    return <p>{syncing ? 'syncing' : 'idle'}</p>;
  }

  it('仅在显示恢复的缓存且后台刷新进行中时为 true', async () => {
    const writer = newClient();
    seedQueries(writer, 1);
    writeQueryCache(writer);
    writer.clear();
    const client = newClient();
    restoreQueryCache(client);
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    expect(screen.getByText('idle')).toBeInTheDocument();

    let resolvePage!: (page: Page<MessageSummary>) => void;
    const fetchPage = () => new Promise<Page<MessageSummary>>((done) => (resolvePage = done));
    const refresh = (): Promise<void> =>
      client.prefetchInfiniteQuery({ queryKey: defaultInboxListKey(), queryFn: fetchPage, initialPageParam: '' });

    let pending!: Promise<void>;
    act(() => void (pending = refresh()));
    expect(screen.getByText('syncing')).toBeInTheDocument();
    await act(async () => {
      resolvePage(listData([message(5)]).pages[0]!);
      await pending;
    });
    expect(screen.getByText('idle')).toBeInTheDocument();

    // 刷新过后的普通轮询不再提示
    act(() => void (pending = client.refetchQueries({ queryKey: defaultInboxListKey() })));
    expect(client.getQueryState(defaultInboxListKey())!.fetchStatus).toBe('fetching');
    expect(screen.getByText('idle')).toBeInTheDocument();
    await act(async () => {
      resolvePage(listData([message(6)]).pages[0]!);
      await pending;
    });
    client.clear();
  });
});
