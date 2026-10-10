import { Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FilterChip } from '@/components/ui/filter-chip';
import { inputClassName } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { SEARCH_SHORTCUT_ATTR } from '@/lib/use-keyboard-shortcuts';
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
  /** 一次清除域名/地址/未读（保留搜索词）；提供时小屏筛选面板显示「清除筛选」 */
  onClearFacets?: () => void;
}

const UNREAD_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
] as const;

function DomainChips({
  domains,
  value,
  onChange,
  className,
}: {
  domains: string[];
  value: string | null;
  onChange: (domain: string | null) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="按域名筛选" className={cn('flex items-center gap-2', className)}>
      <FilterChip className="shrink-0" active={value === null} onClick={() => onChange(null)}>
        全部域名
      </FilterChip>
      {domains.map((domain) => (
        <FilterChip key={domain} className="shrink-0" active={value === domain} onClick={() => onChange(domain)}>
          {domain}
        </FilterChip>
      ))}
    </div>
  );
}

/**
 * 收件箱筛选：桌面端域名标签单行可横向滚动，地址/已读状态/搜索一行；
 * 小屏只保留搜索框，域名、地址、全部/未读收进「筛选」打开的底部面板。
 */
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
  onClearFacets,
}: FilterBarProps) {
  const [text, setText] = useState(filters.q);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => setText(filters.q), [filters.q]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      if (text !== filters.q) onQueryChange(text);
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [text, filters.q, onQueryChange]);

  const activeCount =
    (filters.domain ? 1 : 0) + (filters.address ? 1 : 0) + (showUnread && filters.unread ? 1 : 0);
  const hasSheetFilters = domains.length > 0 || addressOptions.length > 0 || showUnread;

  const addressPicker = addressOptions.length > 0 && (
    <Combobox
      aria-label={addressLabel}
      value={filters.address}
      onChange={onAddressChange}
      options={addressOptions}
      placeholder={addressLabel}
      searchPlaceholder="搜索地址…"
    />
  );
  const unreadPicker = showUnread && (
    <SegmentedControl
      aria-label="已读状态"
      value={filters.unread ? 'unread' : 'all'}
      onValueChange={(value) => onUnreadChange(value === 'unread')}
      options={UNREAD_OPTIONS}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {domains.length > 0 && (
        <DomainChips
          domains={domains}
          value={filters.domain}
          onChange={onDomainChange}
          className="-mx-1 hidden overflow-x-auto px-1 py-0.5 sm:flex"
        />
      )}

      <div className="flex items-center gap-2">
        {addressPicker && <div className="hidden w-64 shrink-0 sm:block">{addressPicker}</div>}
        {unreadPicker && <div className="hidden shrink-0 sm:block">{unreadPicker}</div>}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            type="search"
            aria-label="搜索邮件"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="搜索主题、发件人、正文…"
            className={cn(inputClassName, 'border-line-strong pl-9 focus:border-accent focus:ring-2 focus:ring-accent/20')}
            {...{ [SEARCH_SHORTCUT_ATTR]: '' }}
          />
        </div>
        {hasSheetFilters && (
          <Button
            variant="secondary"
            className="shrink-0 px-3 sm:hidden"
            aria-label={activeCount > 0 ? `筛选（已选 ${activeCount} 项）` : '筛选'}
            onClick={() => setSheetOpen(true)}
          >
            <SlidersHorizontal className="size-4" />
            筛选
            {activeCount > 0 && (
              <span className="grid min-w-5 place-items-center rounded-full bg-accent px-1 text-xs font-semibold leading-5 text-on-accent">
                {activeCount}
              </span>
            )}
          </Button>
        )}
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" title="筛选邮件">
          <div className="flex flex-col gap-5 px-5 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {domains.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-secondary">域名</h3>
                <DomainChips domains={domains} value={filters.domain} onChange={onDomainChange} className="flex-wrap" />
              </section>
            )}
            {addressPicker && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-secondary">地址</h3>
                {addressPicker}
              </section>
            )}
            {unreadPicker && (
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-secondary">已读状态</h3>
                <div>{unreadPicker}</div>
              </section>
            )}
            <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
              {activeCount > 0 && onClearFacets && (
                <Button variant="ghost" className="mr-auto" onClick={onClearFacets}>
                  清除筛选
                </Button>
              )}
              <Button onClick={() => setSheetOpen(false)}>完成</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
