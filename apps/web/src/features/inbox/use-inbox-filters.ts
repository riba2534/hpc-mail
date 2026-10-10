import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type InboxFilters, parseInboxFilters } from './inbox-query';

export type { InboxFilters } from './inbox-query';

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : null;
}

/**
 * 收件箱四维过滤器双向绑定到 URL（唯一 source of truth）。
 * 联动约束：切换域名时清空不属于该域的地址；选中地址时自动同步域名。
 */
export function useInboxFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<InboxFilters>(() => parseInboxFilters(searchParams), [searchParams]);

  const mutate = useCallback(
    (mutator: (params: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutator(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setDomain = useCallback(
    (domain: string | null) => {
      mutate((params) => {
        if (domain) params.set('domain', domain);
        else params.delete('domain');
        const currentAddress = params.get('address');
        if (currentAddress && domainOf(currentAddress) !== domain) params.delete('address');
      });
    },
    [mutate],
  );

  const setAddress = useCallback(
    (address: string | null) => {
      mutate((params) => {
        if (address) {
          params.set('address', address);
          const domain = domainOf(address);
          if (domain) params.set('domain', domain);
        } else {
          params.delete('address');
        }
      });
    },
    [mutate],
  );

  const setUnread = useCallback(
    (unread: boolean) => {
      mutate((params) => {
        if (unread) params.set('unread', '1');
        else params.delete('unread');
      });
    },
    [mutate],
  );

  const setQuery = useCallback(
    (q: string) => {
      mutate((params) => {
        if (q.trim()) params.set('q', q);
        else params.delete('q');
      });
    },
    [mutate],
  );

  const reset = useCallback(() => {
    mutate((params) => {
      params.delete('domain');
      params.delete('address');
      params.delete('unread');
      params.delete('q');
    });
  }, [mutate]);

  return { filters, setDomain, setAddress, setUnread, setQuery, reset };
}
