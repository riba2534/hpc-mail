import { focusManager, keepPreviousData, onlineManager, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { mergeHeadPage, type MessageListData } from './message-cache';
import { messageListQueryOptions } from './message-queries';
import { markUnreadRefreshed, nextUnreadRefreshDelay, pauseUnreadCountPolling } from './use-unread-count';

const POLL_INTERVAL_MS = 20_000;
/** Search views: sync re-runs the unindexed full-text match, so the head is probed less often. */
const SEARCH_POLL_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 2_500;
type ListQuery = { state: { data?: MessageListData } };
const singlePage = (query: ListQuery) => (query.state.data?.pages.length ?? 0) <= 1;
const withoutData = (query: ListQuery) => query.state.data === undefined;

export function useMessagesQuery(query: Partial<ListMessagesQuery>) {
  const queryClient = useQueryClient();
  // Once loaded, polling, focus and reconnect go through /messages/sync below and refetch only when the head changed.
  // Until the first page arrives (e.g. the initial load failed) the list keeps retrying as a whole.
  const { data, isLoading, isPlaceholderData, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({
    ...messageListQueryOptions(query),
    // Switching filters or the search term keeps showing the previous results until the new ones arrive,
    // instead of flashing the whole list back to a skeleton.
    placeholderData: keepPreviousData,
    refetchInterval: (current) => (withoutData(current) ? POLL_INTERVAL_MS : false),
    refetchOnWindowFocus: withoutData,
    refetchOnReconnect: withoutData,
    refetchOnMount: singlePage,
  });
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const [pollError, setPollError] = useState<Error | null>(null);
  const hasData = data !== undefined;
  const queryIdentity = JSON.stringify(query);

  useEffect(() => {
    setPollError(null);
    if (!hasData) return;
    const queryKey = queryKeys.messages.list(latestQuery.current);
    const controller = new AbortController();
    const searching = Boolean(latestQuery.current.q);
    const interval = searching ? SEARCH_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    // sync carries the unread count every round, so the unread-count query stops polling on its own meanwhile.
    // Search views sync less often than the unread count refreshes, so there it keeps polling by itself.
    const resumeUnreadPolling = searching ? () => {} : pauseUnreadCountPolling(queryClient);
    let pending = false;
    // Paging, refetching, an optimistic write or a pending mutation happened meanwhile: drop this round's result.
    const untouched = (since: number) => {
      const latest = queryClient.getQueryState(queryKey);
      return latest?.fetchStatus === 'idle' && latest.dataUpdatedAt === since && queryClient.isMutating() === 0;
    };
    /** One round: sync, then refetch or merge the head when it changed. Throws when a request fails. */
    const round = async (probeOnly: boolean) => {
      const state = queryClient.getQueryState<MessageListData>(queryKey);
      if (!state?.data || state.fetchStatus !== 'idle') return;
      const since = state.dataUpdatedAt;
      if (!probeOnly) {
        const unreadSince = queryClient.getQueryState(queryKeys.messages.unreadCount)?.dataUpdatedAt;
        const sync = await messageApi.sync(latestQuery.current, controller.signal);
        if (controller.signal.aborted) return;
        markUnreadRefreshed(queryClient);
        setPollError(null);
        // The unread count does not depend on list edits (the unread-count query is paused meanwhile): write it unless
        // a mutation is pending or the count was refreshed elsewhere since the request went out.
        const unread = queryClient.getQueryState(queryKeys.messages.unreadCount);
        if (queryClient.isMutating() === 0 && unread?.dataUpdatedAt === unreadSince && unread?.fetchStatus !== 'fetching') {
          queryClient.setQueryData(queryKeys.messages.unreadCount, { unread: sync.unread });
        }
        if (!untouched(since)) return;
        const latest = queryClient.getQueryState<MessageListData>(queryKey);
        // A first page without head (persisted by an older build) or a failed refetch counts as changed.
        if (!latest?.data || (latest.status !== 'error' && latest.data.pages[0]?.head === sync.head)) return;
        if (latest.data.pages.length <= 1) {
          await queryClient.refetchQueries({ queryKey, exact: true });
          return;
        }
      }
      // Multi-page lists fetch only the head page and merge it in place instead of refetching every cursor.
      const head = await messageApi.list(latestQuery.current, controller.signal);
      if (controller.signal.aborted) return;
      setPollError(null);
      if (!untouched(since)) return;
      queryClient.setQueryData<MessageListData>(queryKey, (current) => current && mergeHeadPage(current, head));
    };
    const skipped = () => document.visibilityState === 'hidden' || !onlineManager.isOnline();
    const retryDelay = () =>
      new Promise<void>((resolve) => {
        const timeout = globalThis.setTimeout(resolve, RETRY_DELAY_MS);
        controller.signal.addEventListener('abort', () => {
          globalThis.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    const check = async ({ probeOnly = false } = {}) => {
      if (pending || skipped()) return;
      // pending spans the retry as well, so neither the timer nor focus/online can start an overlapping round.
      pending = true;
      try {
        await round(probeOnly);
      } catch {
        // A single failure (e.g. waking up before the network is back) retries once quietly; only two in a row
        // surface as an error.
        await retryDelay();
        if (controller.signal.aborted || skipped()) return;
        try {
          await round(probeOnly);
        } catch (pollFailure) {
          if (!controller.signal.aborted) setPollError(pollFailure instanceof Error ? pollFailure : new Error('刷新邮件失败'));
        }
      } finally {
        pending = false;
      }
    };
    // The first round waits only for the rest of the interval since the last refresh: switching filters or pages
    // neither postpones it nor sends an extra one within the interval. A new search term was just fetched in full.
    let timer: ReturnType<typeof setInterval> | undefined;
    const firstTimer = globalThis.setTimeout(() => {
      void check();
      timer = globalThis.setInterval(() => void check(), interval);
    }, searching ? interval : nextUnreadRefreshDelay(queryClient));
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) void check();
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) void check();
    });
    // Stale multi-page list on mount (e.g. back from a mail after marking it read): one head request instead of
    // N page refetches. Stale single-page lists are refetched by refetchOnMount.
    const cached = queryClient.getQueryCache().find<MessageListData>({ queryKey, exact: true });
    if ((cached?.state.data?.pages.length ?? 0) > 1 && cached?.isStale()) void check({ probeOnly: true });
    return () => {
      globalThis.clearTimeout(firstTimer);
      globalThis.clearInterval(timer);
      unsubscribeFocus();
      unsubscribeOnline();
      controller.abort();
      resumeUnreadPolling();
    };
  }, [queryClient, queryIdentity, hasData]);

  const refetchAll = useCallback(
    (...args: Parameters<typeof refetch>) => {
      setPollError(null);
      return refetch(...args);
    },
    [refetch],
  );

  // Only destructured fields are tracked, so background fetch-status flips no longer re-render the list.
  return {
    data,
    isLoading,
    /** Still showing the previous filter's results while the new ones load. */
    isPlaceholderData,
    isError: isError || pollError !== null,
    error: error ?? pollError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch: refetchAll,
  };
}
