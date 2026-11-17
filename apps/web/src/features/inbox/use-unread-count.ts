import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';

const POLL_INTERVAL_MS = 20_000;

interface ListPollers {
  count: number;
  listeners: Set<() => void>;
  /** 上一次从服务端拿到未读数（sync 成功或未读数自身刷新）的时间 */
  refreshedAt?: number;
}

/** 每个 QueryClient 上正在轮询 /messages/sync 的列表视图数 */
const listPollers = new WeakMap<QueryClient, ListPollers>();

function pollersOf(client: QueryClient): ListPollers {
  let pollers = listPollers.get(client);
  if (!pollers) {
    pollers = { count: 0, listeners: new Set() };
    listPollers.set(client, pollers);
  }
  return pollers;
}

/** 记下刚从服务端拿到未读数：sync 成功与未读数查询成功时调用 */
export function markUnreadRefreshed(client: QueryClient, at = Date.now()): void {
  pollersOf(client).refreshedAt = at;
}

/**
 * 列表视图建立时距下一次 sync 的等待：上次刷新后满一个轮询周期即可，切换筛选或页面不会推迟刷新，
 * 也不会在一个周期内多发。没有记录（刚启动）或未读数正在刷新时等满一个周期。
 */
export function nextUnreadRefreshDelay(client: QueryClient, now = Date.now()): number {
  const { refreshedAt } = pollersOf(client);
  if (refreshedAt === undefined || client.getQueryState(queryKeys.messages.unreadCount)?.fetchStatus === 'fetching') {
    return POLL_INTERVAL_MS;
  }
  return Math.min(POLL_INTERVAL_MS, Math.max(0, POLL_INTERVAL_MS - (now - refreshedAt)));
}

/**
 * 列表视图开始轮询 /messages/sync 时调用：sync 每轮都带回未读数，期间未读数不再自己轮询。
 * 返回恢复函数，列表卸载或切换筛选时调用。
 */
export function pauseUnreadCountPolling(client: QueryClient): () => void {
  const pollers = pollersOf(client);
  const notify = () => pollers.listeners.forEach((listener) => listener());
  pollers.count += 1;
  notify();
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    pollers.count -= 1;
    notify();
  };
}

function useListPolling(client: QueryClient): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const pollers = pollersOf(client);
      pollers.listeners.add(listener);
      return () => {
        pollers.listeners.delete(listener);
      };
    },
    [client],
  );
  return useSyncExternalStore(subscribe, () => pollersOf(client).count > 0, () => false);
}

/**
 * 未读收件数（用户自己认领地址）。key 在 messages 前缀下，读/删/星标失效会连带刷新。
 * enabled=false 时不请求也不轮询（站点强制两步验证而账号未绑定时，接口只会返回 403）。
 */
export function useUnreadCount(enabled = true) {
  const client = useQueryClient();
  const listPolling = useListPolling(client);
  return useQuery({
    enabled,
    queryKey: queryKeys.messages.unreadCount,
    queryFn: async () => {
      const result = await messageApi.unreadCount();
      markUnreadRefreshed(client);
      return result;
    },
    staleTime: POLL_INTERVAL_MS,
    // 列表视图在轮询时由 sync 写入未读数：暂停自身的定时、聚焦与恢复联网刷新，每轮只发一个请求
    refetchInterval: listPolling ? false : POLL_INTERVAL_MS,
    refetchOnWindowFocus: !listPolling,
    refetchOnReconnect: !listPolling,
  });
}
