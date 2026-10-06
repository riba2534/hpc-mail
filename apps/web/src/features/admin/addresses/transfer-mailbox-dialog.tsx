import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Mailbox, TransferMailboxRequest, UserSearchResult } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

export function TransferMailboxDialog({ mailbox, onClose }: { mailbox: Mailbox | null; onClose: () => void }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [target, setTarget] = useState<UserSearchResult | null>(null);
  const [active, setActive] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const normalized = search.trim().toLowerCase();
  useEffect(() => {
    setSearch(''); setDebounced(''); setTarget(null); setActive(0);
  }, [mailbox?.id]);
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(normalized), 250);
    return () => globalThis.clearTimeout(timer);
  }, [normalized]);
  const ready = normalized.length > 0 && normalized === debounced;
  const users = useQuery({
    queryKey: queryKeys.admin.userSearch(debounced, mailbox?.userId),
    queryFn: ({ signal }) => adminApi.searchUsers(debounced, mailbox?.userId, signal),
    enabled: mailbox !== null && ready && target === null,
  });
  const results = ready ? users.data?.items ?? [] : [];
  const searching = !target && normalized.length > 0 && (!ready || users.isFetching || users.isPending);
  const showResults = !target && ready && !searching && !users.isError && results.length > 0;
  useEffect(() => {
    if (showResults) resultsRef.current?.querySelectorAll('[role="option"]')[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active, showResults, results]);
  const choose = (user: UserSearchResult) => {
    setTarget(user); setSearch(user.username); setActive(0);
  };
  const transfer = useMutation({
    mutationFn: ({ id, body }: { id: number; body: TransferMailboxRequest }) => adminApi.transferMailbox(id, body),
    onSuccess: result => {
      toast({ title: result.transferred ? `邮箱已过户给 ${result.mailbox.ownerUsername}` : '邮箱已属于目标用户', variant: 'success' });
      invalidateMailboxOwnership(client);
      onClose();
    },
    onError: error => {
      toast({ title: error instanceof ApiError ? error.message : '过户失败，请重试', variant: 'error' });
      if (error instanceof ApiError && error.code === 'conflict') {
        invalidateMailboxOwnership(client);
        onClose();
      }
    },
  });

  return (
    <Dialog open={mailbox !== null} onOpenChange={next => !next && !transfer.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader title="过户邮箱" description={mailbox?.address} />
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm text-ink-secondary">当前主人：<b className="text-ink">{mailbox?.ownerUsername || '未知用户'}</b>。过户后，目标用户将获得完整收发权限及全部历史邮件、附件，旧共享授权将全部撤销。</p>
          <FormField label="目标用户" required>
            {field => <div className="flex flex-col gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
                <Input {...field} role="combobox" aria-expanded={showResults} aria-autocomplete="list"
                  aria-controls={showResults ? `${field.id}-results` : undefined}
                  aria-activedescendant={showResults && results[active] ? `${field.id}-result-${results[active]!.id}` : undefined}
                  autoFocus autoComplete="off" maxLength={32} placeholder="输入用户名搜索" className="pl-9"
                  value={search} disabled={transfer.isPending}
                  onChange={event => { setSearch(event.target.value); setTarget(null); setActive(0); }}
                  onKeyDown={event => {
                    if (!showResults || event.nativeEvent.isComposing) return;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActive(index => Math.max(0, Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      if (results[active]) choose(results[active]!);
                    }
                  }} />
              </div>
              {!normalized && <p className="text-xs text-ink-tertiary">输入用户名查找目标用户。</p>}
              {searching && <p role="status" className="text-sm text-ink-secondary">正在搜索用户…</p>}
              {!target && ready && users.isError && <QueryErrorState error={users.error} onRetry={() => void users.refetch()} />}
              {showResults && <div ref={resultsRef} id={`${field.id}-results`} role="listbox" aria-label="匹配的用户" className="max-h-40 overflow-y-auto rounded-md border border-line p-1">
                {results.map((user, index) => <button key={user.id} id={`${field.id}-result-${user.id}`} type="button" role="option"
                  aria-selected={false} tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => choose(user)}
                  className={`flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm ${index === active ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-hover'}`}>
                  <span className="min-w-0 truncate">{user.username}</span>
                  <span className="shrink-0 text-xs text-ink-tertiary">{user.role === 'admin' ? '管理员' : '普通用户'}</span>
                </button>)}
              </div>}
              {!target && ready && !searching && !users.isError && users.data && results.length === 0 && <p role="status" className="text-sm text-ink-secondary">没有匹配的可过户用户。</p>}
              {showResults && users.data?.hasMore && <p className="text-xs text-ink-tertiary">匹配用户较多，已显示前 20 位，请继续输入更完整的用户名。</p>}
              {target && <p className="flex items-center gap-1 text-sm text-accent"><Check className="size-4" />已选择：{target.username}{target.role === 'admin' ? '（管理员）' : ''}</p>}
            </div>}
          </FormField>
          <p className="text-sm text-ink-secondary">管理员过户不受认领配额、保留前缀和域名公开性限制。之后的新邮件按新主人的个人设置通知和转发；已有通知不重复发送。</p>
          {target && <p className="text-sm text-ink">确认将 {mailbox?.address} 从 {mailbox?.ownerUsername} 过户给 <b>{target.username}</b>。</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" disabled={transfer.isPending} onClick={onClose}>取消</Button>
          <Button loading={transfer.isPending} disabled={!target || transfer.isPending} onClick={() => mailbox && target && transfer.mutate({
            id: mailbox.id, body: { userId: target.id, expectedOwnerId: mailbox.userId },
          })}>确认过户</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
