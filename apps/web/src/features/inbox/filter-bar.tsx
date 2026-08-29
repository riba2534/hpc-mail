import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FilterChip } from '@/components/ui/filter-chip';
import { inputClassName } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { cn } from '@/lib/cn';
import type { InboxFilters } from './use-inbox-filters';

export interface FilterBarProps {
  filters: InboxFilters;
  domains: string[];
  addressOptions: ComboboxOption[];
  addressLabel?: string;
  /** 未读筛选开关；outbound 视图下已读状态无意义，隐藏之 */
  showUnread?: boolean;
  onDomainChange: (domain: string | null) => void;
  onAddressChange: (address: string | null) => void;
  onUnreadChange: (unread: boolean) => void;
  onQueryChange: (q: string) => void;
}

const UNREAD_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
] as const;

export function FilterBar({
  filters,
  domains,
  addressOptions,
  addressLabel = '选择邮箱地址',
  showUnread = true,
  onDomainChange,
  onAddressChange,
  onUnreadChange,
  onQueryChange,
}: FilterBarProps) {
  const [text, setText] = useState(filters.q);

  useEffect(() => setText(filters.q), [filters.q]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (text !== filters.q) onQueryChange(text);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [text, filters.q, onQueryChange]);

  return (
    <div className="flex flex-col gap-3">
      {domains.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={filters.domain === null} onClick={() => onDomainChange(null)}>
            全部域名
          </FilterChip>
          {domains.map((domain) => (
            <FilterChip key={domain} active={filters.domain === domain} onClick={() => onDomainChange(domain)}>
              {domain}
            </FilterChip>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {addressOptions.length > 0 && (
          <div className="sm:w-64">
            <Combobox
              aria-label={addressLabel}
              value={filters.address}
              onChange={onAddressChange}
              options={addressOptions}
              placeholder={addressLabel}
              searchPlaceholder="搜索地址…"
            />
          </div>
        )}
        {showUnread && (
          <SegmentedControl
            aria-label="已读状态"
            value={filters.unread ? 'unread' : 'all'}
            onValueChange={(value) => onUnreadChange(value === 'unread')}
            options={UNREAD_OPTIONS}
          />
        )}
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="搜索主题、发件人、正文…"
            className={cn(inputClassName, 'border-line-strong pl-9 focus:border-accent focus:ring-2 focus:ring-accent/20')}
          />
        </div>
      </div>
    </div>
  );
}
