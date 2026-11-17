import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UserSearchResult } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface UserSearchProps {
  /** 输入框的无障碍名称 */
  label: string;
  /** 结果行按钮文字，如「添加」「选择」 */
  actionLabel: string;
  /** 交给服务端排除的用户（通常是域名所有者） */
  excludeUserId?: number;
  /** 本地再隐藏的用户（已是成员等） */
  hiddenIds?: readonly number[];
  disabled?: boolean;
  autoFocus?: boolean;
  onPick: (user: UserSearchResult) => void;
}

/** 按用户名搜索启用中的用户：复用邮箱共享的选人接口，普通用户与管理员都可调用 */
export function UserSearch({ label, actionLabel, excludeUserId, hiddenIds = [], disabled, autoFocus, onPick }: UserSearchProps) {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const normalized = search.trim().toLowerCase();
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(normalized), 250);
    return () => globalThis.clearTimeout(timer);
  }, [normalized]);
  const ready = normalized.length > 0 && normalized === debounced;
  const users = useQuery({
    queryKey: queryKeys.mailboxes.shareUsers(debounced, excludeUserId),
    queryFn: ({ signal }) => mailboxApi.searchShareUsers(debounced, excludeUserId, signal),
    enabled: ready,
  });
  const results = ready ? (users.data?.items ?? []).filter((user) => !hiddenIds.includes(user.id)) : [];
  const searching = normalized.length > 0 && (!ready || users.isPending);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input
          aria-label={label}
          autoFocus={autoFocus}
          autoComplete="off"
          maxLength={32}
          placeholder="输入用户名搜索"
          className="pl-9"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {searching ? (
        <p role="status" className="text-sm text-ink-secondary">正在搜索用户…</p>
      ) : ready && users.isError ? (
        <QueryErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : ready && results.length === 0 ? (
        <p role="status" className="text-sm text-ink-secondary">没有匹配的启用用户。</p>
      ) : results.length > 0 ? (
        <ul aria-label="匹配的用户" className="max-h-48 overflow-y-auto rounded-md border border-line">
          {results.map((user) => (
            <li key={user.id} className="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-ink">{user.username}</span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`${actionLabel} ${user.username}`}
                disabled={disabled}
                onClick={() => onPick(user)}
              >
                {actionLabel}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {ready && users.data?.hasMore && (
        <p className="text-xs text-ink-tertiary">已显示前 20 位匹配用户，请输入更完整的用户名。</p>
      )}
    </div>
  );
}
