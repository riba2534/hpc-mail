import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, X } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { emailAddressSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast';
import { FilterBar } from '@/features/inbox/filter-bar';
import { MailList } from '@/features/inbox/mail-list';
import { useInboxFilters } from '@/features/inbox/use-inbox-filters';
import { useDomains } from '@/lib/use-config';

type Direction = 'inbound' | 'outbound';

const DIRECTION_OPTIONS = [
  { value: 'inbound', label: '已接收' },
  { value: 'outbound', label: '已发送' },
] as const;

const DIRECTION_COPY: Record<
  Direction,
  { description: string; emptyTitle: string; emptyDescription: string }
> = {
  inbound: {
    description: '尚未被任何人认领的地址收到的邮件（catch-all）。已认领地址的信请到对应用户页查看。',
    emptyTitle: '暂无未认领收件',
    emptyDescription: '目前没有未认领地址收到的邮件。',
  },
  outbound: {
    description: '从未认领地址发出的邮件（通常是管理员用任意前缀试投）。用户已发送请到对应用户页查看。',
    emptyTitle: '暂无未认领发件',
    emptyDescription: '目前没有从未认领地址发出的邮件。',
  },
};

/** 全站邮件方向（已接收/已发送）双向绑定 URL；切到已发送时清掉无意义的未读参数 */
export function useAdminMailDirection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const direction: Direction = searchParams.get('direction') === 'outbound' ? 'outbound' : 'inbound';

  const setDirection = useCallback(
    (next: Direction) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === 'outbound') {
            params.set('direction', 'outbound');
            // outbound 行恒为已读，未读筛选无意义，切换时一并清掉
            params.delete('unread');
          } else {
            params.delete('direction');
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { direction, setDirection };
}

/** 按完整地址筛选：回车或失焦提交，清空即取消筛选；非法地址就地提示，不改动当前筛选 */
function AddressFilterInput({
  address,
  onAddressChange,
}: {
  address: string | null;
  onAddressChange: (address: string | null) => void;
}) {
  const [text, setText] = useState(address ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(address ?? '');
    setError(null);
  }, [address]);

  const commit = () => {
    const value = text.trim();
    if (!value) {
      setError(null);
      if (address) onAddressChange(null);
      return;
    }
    const parsed = emailAddressSchema.safeParse(value);
    if (!parsed.success) {
      setError('请输入完整地址，例如 abc@example.com');
      return;
    }
    setError(null);
    setText(parsed.data);
    if (parsed.data !== address) onAddressChange(parsed.data);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    commit();
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1 sm:max-w-sm">
      <div className="relative">
        <AtSign className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input
          aria-label="按地址筛选"
          aria-describedby={error ? 'admin-mail-address-error' : undefined}
          value={text}
          invalid={error !== null}
          placeholder="按完整地址筛选，回车确认"
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          className="pl-9 pr-9"
        />
        {text && (
          <IconButton
            size="sm"
            aria-label="清除地址筛选"
            className="absolute right-0.5 top-1/2 -translate-y-1/2"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setText('');
              setError(null);
              if (address) onAddressChange(null);
            }}
          >
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      {error && (
        <p id="admin-mail-address-error" role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
    </form>
  );
}

/** 地址筛选生效时：提示正在看哪个未认领地址，并可直接认领到当前管理员名下 */
function UnclaimedAddressBanner({ address, onClear }: { address: string; onClear: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [address]);

  const claim = useMutation({
    mutationFn: () => {
      const at = address.lastIndexOf('@');
      return mailboxApi.claim({ localPart: address.slice(0, at), domain: address.slice(at + 1) });
    },
    onSuccess: () => {
      invalidateMailboxOwnership(queryClient);
      toast({ title: `已认领 ${address}`, description: '可在收件箱查看该地址的全部历史邮件。', variant: 'success' });
      navigate(`/inbox?address=${encodeURIComponent(address)}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '认领失败，请重试'),
  });

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 break-all text-ink-secondary">
          正在查看 <span className="font-medium text-ink">{address}</span> 的未认领邮件
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            loading={claim.isPending}
            onClick={() => {
              setError(null);
              claim.mutate();
            }}
          >
            认领到我
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            清除
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

export function AdminMailPage() {
  const { filters, setDomain, setAddress, setUnread, setQuery, reset } = useInboxFilters();
  const { direction, setDirection } = useAdminMailDirection();
  const { data: visibleDomains } = useDomains();

  const isInbound = direction === 'inbound';
  const copy = DIRECTION_COPY[direction];

  const hasActiveFilters = Boolean(filters.domain || filters.address || (isInbound && filters.unread) || filters.q);

  const query = {
    direction,
    scope: 'unclaimed' as const,
    domain: filters.domain ?? undefined,
    address: filters.address ?? undefined,
    unread: (isInbound && filters.unread) || undefined,
    q: filters.q || undefined,
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="全站邮件" description={copy.description} />
      <div className="flex flex-col gap-4">
        <SegmentedControl
          aria-label="邮件方向"
          value={direction}
          onValueChange={setDirection}
          options={DIRECTION_OPTIONS}
          className="self-start"
        />
        <FilterBar
          filters={filters}
          domains={visibleDomains ?? []}
          addressOptions={[]}
          showUnread={isInbound}
          onDomainChange={setDomain}
          onAddressChange={setAddress}
          onUnreadChange={setUnread}
          onQueryChange={setQuery}
        />
        <AddressFilterInput address={filters.address} onAddressChange={setAddress} />
        {filters.address && <UnclaimedAddressBanner address={filters.address} onClear={() => setAddress(null)} />}
        <MailList
          query={query}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={reset}
          emptyTitle={copy.emptyTitle}
          emptyDescription={copy.emptyDescription}
        />
      </div>
    </div>
  );
}
