import { hashKey, type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { inboxListQuery, parseInboxFilters } from '@/features/inbox/inbox-query';
import type { MessageListData } from '@/features/inbox/message-cache';
import { getAuthRevision, getAuthToken, subscribeAuthToken } from '@/lib/auth-token';
import { safeStorage, storageKeys } from '@/lib/local-storage';
import { isObject, readTokenClaims } from '@/lib/token-claims';

/**
 * 首屏查询的按用户持久化：再次打开时先用上次的数据渲染外壳与收件箱，挂载后照常在后台刷新。
 * 只存首屏必需的少量查询；邮件详情、正文、附件链接与管理视图一律不落盘。
 */
export const QUERY_CACHE_PREFIX = 'hpc-query-cache:';
const QUERY_CACHE_VERSION = 'v1';
/** 数据写入（取到）超过 7 天即作废 */
export const QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** 整体上限（UTF-8 字节）：超出时按重要性只保留排在前面的几项 */
export const QUERY_CACHE_MAX_BYTES = 512 * 1024;
export const QUERY_CACHE_WRITE_DELAY_MS = 1_000;

export const queryCacheStorageKey = (userId: number) => `${QUERY_CACHE_PREFIX}${QUERY_CACHE_VERSION}:${userId}`;

/** 收件箱默认视图（自己的收件、无筛选）：与 InboxPage 在 /inbox 下得到同一个 queryKey */
export const defaultInboxListKey = () => queryKeys.messages.list(inboxListQuery(parseInboxFilters(new URLSearchParams())));

interface PersistedQuery {
  name: string;
  key: (revision: number) => QueryKey;
  /** 只存需要的部分（列表只留首页） */
  pick?: (data: unknown) => unknown;
  valid?: (data: unknown, userId: number) => boolean;
}

/** 缓存里的会话用户必须就是 token 所属账户 */
const isSessionOf = (data: unknown, userId: number) => isObject(data) && data.id === userId;

/** 按重要性排序：会话用户决定能否先渲染外壳，其次是收件箱首屏 */
const PERSISTED_QUERIES: readonly PersistedQuery[] = [
  { name: 'session', key: (revision) => queryKeys.sessionForRevision(revision), valid: isSessionOf },
  {
    name: 'inbox',
    key: defaultInboxListKey,
    pick: (data) => {
      const list = data as MessageListData;
      return { pages: list.pages.slice(0, 1), pageParams: list.pageParams.slice(0, 1) };
    },
    valid: (data) =>
      isObject(data) && Array.isArray(data.pages) && data.pages.length === 1 && isObject(data.pages[0])
      && Array.isArray(data.pages[0].items) && Array.isArray(data.pageParams) && data.pageParams.length === 1,
  },
  { name: 'unread', key: () => queryKeys.messages.unreadCount, valid: isObject },
  { name: 'mailboxes', key: () => queryKeys.mailboxes.list('mine'), valid: Array.isArray },
  { name: 'shared', key: () => queryKeys.mailboxes.shared, valid: Array.isArray },
  { name: 'domains', key: () => queryKeys.domains, valid: Array.isArray },
  { name: 'config', key: () => queryKeys.config, valid: isObject },
];

interface StoredEntry {
  data: unknown;
  updatedAt: number;
}


const persistedKeys = () => storageKeys((key) => key.startsWith(QUERY_CACHE_PREFIX));

/** 删除所有账户的持久缓存（退出登录、401、切换账户），下一个使用这台电脑的人看不到上一位的邮件 */
export function clearPersistedQueryCache(): void {
  const store = safeStorage();
  for (const key of persistedKeys()) {
    try {
      store?.removeItem(key);
    } catch {
      // 存储不可用时无从清理，也就无从读取
    }
  }
}

/** 已恢复查询的 hash → 恢复时的 updatedAt；用于判断页面显示的是否仍是上次的缓存 */
const restoredQueries = new WeakMap<QueryClient, Map<string, number>>();

/**
 * 启动时（createRoot 之前）把当前账户的持久缓存写进 queryClient。
 * 数据保留原 updatedAt 并标记失效：页面立即渲染缓存，挂载/预取时照常后台刷新。返回是否恢复了会话用户。
 */
export function restoreQueryCache(client: QueryClient, now = Date.now()): boolean {
  const claims = readTokenClaims(getAuthToken());
  if (!claims) {
    clearPersistedQueryCache();
    return false;
  }
  const storageKey = queryCacheStorageKey(claims.sub);
  const store = safeStorage();
  // 其他账户与旧版本的残留一并清掉
  for (const key of persistedKeys()) if (key !== storageKey) store?.removeItem(key);
  // token 已过期时服务端必然 401：不先闪现旧收件箱再跳登录页
  if (claims.exp !== undefined && claims.exp * 1000 <= now) return false;

  let entries: Record<string, StoredEntry> | null = null;
  try {
    const parsed: unknown = JSON.parse(store?.getItem(storageKey) ?? 'null');
    if (isObject(parsed) && isObject(parsed.entries)) entries = parsed.entries as Record<string, StoredEntry>;
  } catch {
    entries = null;
  }
  const fresh = (entry: StoredEntry | undefined): entry is StoredEntry =>
    isObject(entry) && typeof entry.updatedAt === 'number' && now - entry.updatedAt <= QUERY_CACHE_MAX_AGE_MS;
  // 会话用户不属于当前 token 的账户时整份缓存不可信
  const session = entries?.session;
  if (!entries || !fresh(session) || !isSessionOf(session.data, claims.sub)) {
    store?.removeItem(storageKey);
    return false;
  }

  const revision = getAuthRevision();
  const restored = new Map<string, number>();
  for (const query of PERSISTED_QUERIES) {
    const entry = entries[query.name];
    if (!fresh(entry) || (query.valid && !query.valid(entry.data, claims.sub))) continue;
    const queryKey = query.key(revision);
    if (client.getQueryData(queryKey) !== undefined) continue;
    const updatedAt = Math.min(entry.updatedAt, now);
    client.setQueryData(queryKey, entry.data, { updatedAt });
    const cached = client.getQueryCache().find({ queryKey, exact: true });
    // 失效标记让 staleTime 较长的查询（如公开配置）也会在挂载/预取时刷新
    cached?.invalidate();
    if (cached) restored.set(cached.queryHash, updatedAt);
  }
  restoredQueries.set(client, restored);
  return true;
}

/** 把当前账户的首屏查询写入 localStorage。只在会话用户与 token 的 sub 一致时写，避免切换账户的间隙写错 key。 */
export function writeQueryCache(client: QueryClient, now = Date.now()): void {
  const claims = readTokenClaims(getAuthToken());
  if (!claims) return;
  const revision = getAuthRevision();
  const session = client.getQueryState(queryKeys.sessionForRevision(revision));
  if (session?.status !== 'success' || !isSessionOf(session.data, claims.sub)) return;

  const encoder = new TextEncoder();
  const parts: string[] = [];
  let bytes = 0;
  for (const query of PERSISTED_QUERIES) {
    const state = client.getQueryState(query.key(revision));
    if (state?.data === undefined) continue;
    const data = query.pick ? query.pick(state.data) : state.data;
    const part = `${JSON.stringify(query.name)}:${JSON.stringify({ data, updatedAt: state.dataUpdatedAt } satisfies StoredEntry)}`;
    const size = encoder.encode(part).byteLength;
    // 放不下的跳过，继续尝试后面更小的项；会话用户都放不下就不写
    if (bytes + size > QUERY_CACHE_MAX_BYTES) {
      if (parts.length === 0) return;
      continue;
    }
    parts.push(part);
    bytes += size;
  }
  const key = queryCacheStorageKey(claims.sub);
  try {
    safeStorage()?.setItem(key, `{"savedAt":${now},"entries":{${parts.join(',')}}}`);
  } catch {
    // 配额不足等：宁可不留，也不留半截旧数据
    safeStorage()?.removeItem(key);
  }
}

/**
 * 订阅查询缓存：首屏查询成功后防抖写入；token 变化（登录、退出、401、跨标签页切换账户）时
 * 取消待写入并删除全部持久缓存；/auth/me 返回 403（如账号已禁用）时同样删除。返回取消订阅函数。
 */
export function installQueryPersistence(client: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hashes: { revision: number; session: string; all: Set<string> } | undefined;
  const persistedHashes = () => {
    const revision = getAuthRevision();
    if (hashes?.revision !== revision) {
      const all = new Set(PERSISTED_QUERIES.map((query) => hashKey(query.key(revision))));
      hashes = { revision, session: hashKey(queryKeys.sessionForRevision(revision)), all };
    }
    return hashes;
  };
  const cancel = () => {
    globalThis.clearTimeout(timer);
    timer = undefined;
  };
  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return;
    const { action } = event;
    if (action.type !== 'success' && action.type !== 'error') return;
    const { session, all } = persistedHashes();
    if (!all.has(event.query.queryHash)) return;
    if (action.type === 'error') {
      if (event.query.queryHash === session && action.error instanceof ApiError && action.error.forbidden) {
        cancel();
        clearPersistedQueryCache();
      }
      return;
    }
    cancel();
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      writeQueryCache(client);
    }, QUERY_CACHE_WRITE_DELAY_MS);
  });
  const unsubscribeToken = subscribeAuthToken(() => {
    cancel();
    clearPersistedQueryCache();
  });
  return () => {
    cancel();
    unsubscribeCache();
    unsubscribeToken();
  };
}

/** 该查询正显示启动时恢复的缓存、且后台刷新进行中（页头「同步中」提示） */
export function useRestoredQueryRefreshing(queryKey: QueryKey): boolean {
  const client = useQueryClient();
  const hash = hashKey(queryKey);
  const subscribe = useCallback(
    (listener: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) listener();
      }),
    [client, hash],
  );
  const getSnapshot = () => {
    const restoredAt = restoredQueries.get(client)?.get(hash);
    if (restoredAt === undefined) return false;
    const state = client.getQueryCache().get(hash)?.state;
    return state?.dataUpdatedAt === restoredAt && state.fetchStatus === 'fetching';
  };
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
