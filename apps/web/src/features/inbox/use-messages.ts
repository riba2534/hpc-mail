import { focusManager, onlineManager, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { mergeHeadPage, type MessageListData } from './message-cache';
import { messageListQueryOptions } from './message-queries';

const POLL_INTERVAL_MS = 20_000;
const singlePage = (query: { state: { data?: MessageListData } }) => (query.state.data?.pages.length ?? 0) <= 1;

export function useMessagesQuery(query: Partial<ListMessagesQuery>) {
  const queryClient = useQueryClient();
  // Single-page lists poll/refetch as a whole; multi-page lists probe the head below and merge it in place.
  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({
    ...messageListQueryOptions(query),
    refetchInterval: (current) => (singlePage(current) ? POLL_INTERVAL_MS : false),
    refetchOnWindowFocus: singlePage,
    refetchOnReconnect: singlePage,
    refetchOnMount: singlePage,
  });
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const [pollError, setPollError] = useState<Error | null>(null);
  const hasMultiplePages = (data?.pages.length ?? 0) > 1;
  const queryIdentity = JSON.stringify(query);

  useEffect(() => {
    setPollError(null);
    if (!hasMultiplePages) return;
    const queryKey = queryKeys.messages.list(latestQuery.current);
    const controller = new AbortController();
    let pending = false;
    const probeHead = async () => {
      const state = queryClient.getQueryState(queryKey);
      if (pending || document.visibilityState === 'hidden' || !state || state.fetchStatus !== 'idle') return;
      pending = true;
      try {
        const head = await messageApi.list(latestQuery.current, controller.signal);
        if (controller.signal.aborted) return;
        setPollError(null);
        const latest = queryClient.getQueryState(queryKey);
        // Paging, refetching or an optimistic write happened meanwhile: drop this probe and merge on the next one.
        if (!latest || latest.fetchStatus !== 'idle' || latest.dataUpdatedAt !== state.dataUpdatedAt) return;
        if (queryClient.isMutating() > 0) return;
        queryClient.setQueryData<MessageListData>(queryKey, (current) => current && mergeHeadPage(current, head));
      } catch (probeError) {
        if (!controller.signal.aborted) setPollError(probeError instanceof Error ? probeError : new Error('刷新邮件失败'));
      } finally {
        pending = false;
      }
    };
    const timer = globalThis.setInterval(() => void probeHead(), POLL_INTERVAL_MS);
    const unsubscribeFocus = focusManager.subscribe((focused) => {
      if (focused) void probeHead();
    });
    const unsubscribeOnline = onlineManager.subscribe((online) => {
      if (online) void probeHead();
    });
    // Stale on mount (e.g. back from a mail after marking it read): one head request instead of N page refetches.
    if (queryClient.getQueryCache().find({ queryKey, exact: true })?.isStale()) void probeHead();
    return () => {
      globalThis.clearInterval(timer);
      unsubscribeFocus();
      unsubscribeOnline();
      controller.abort();
    };
  }, [queryClient, queryIdentity, hasMultiplePages]);

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
    isError: isError || pollError !== null,
    error: error ?? pollError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch: refetchAll,
  };
}
