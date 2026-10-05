import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ListMessagesQuery } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';

export function useMessagesQuery(query: Partial<ListMessagesQuery>) {
  const result = useInfiniteQuery({
    queryKey: queryKeys.messages.list(query),
    queryFn: ({ pageParam, signal }) => messageApi.list({ ...query, cursor: pageParam || undefined }, signal),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Poll the whole query when there is only one page; multi-page views probe the head below.
    refetchInterval: (current) => (current.state.data?.pages.length ?? 0) <= 1 ? 20_000 : false,
    refetchOnWindowFocus: true,
  });
  const current = useRef({ query, result });
  current.current = { query, result };
  const [pollError, setPollError] = useState<Error | null>(null);
  const hasMultiplePages = (result.data?.pages.length ?? 0) > 1;
  const queryIdentity = JSON.stringify(query);

  useEffect(() => {
    setPollError(null);
    if (!hasMultiplePages) return;
    const controller = new AbortController();
    let pending = false;
    const checkHead = async () => {
      if (pending || document.visibilityState === 'hidden' || current.current.result.isFetching) return;
      pending = true;
      try {
        const head = await messageApi.list(current.current.query, controller.signal);
        if (controller.signal.aborted) return;
        setPollError(null);
        const previousHead = current.current.result.data?.pages[0];
        // Refetch from the first cursor when mail/read/star/status changes; never splice incompatible cursors.
        if (JSON.stringify(head) !== JSON.stringify(previousHead)) await current.current.result.refetch();
      } catch (error) {
        if (!controller.signal.aborted) setPollError(error instanceof Error ? error : new Error('刷新邮件失败'));
      } finally { pending = false; }
    };
    const timer = globalThis.setInterval(checkHead, 20_000);
    return () => { globalThis.clearInterval(timer); controller.abort(); };
  }, [queryIdentity, hasMultiplePages]);

  return {
    ...result,
    isError: result.isError || pollError !== null,
    error: result.error ?? pollError,
    refetch: (...args: Parameters<typeof result.refetch>) => { setPollError(null); return result.refetch(...args); },
  };
}
