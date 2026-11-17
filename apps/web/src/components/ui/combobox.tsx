import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
}

export interface ComboboxProps {
  value: string | null;
  onChange: (value: string | null) => void;
  /** 按传入顺序展示；排序由调用方决定（如置顶「自定义」项） */
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** 放在 Dialog / Sheet 里时传 true：由弹层接管滚动锁，否则外层的锁会吞掉列表的滚轮 */
  modal?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/** 带搜索框的下拉选择：按标签与说明做不区分大小写的包含匹配 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  emptyText = '无匹配项',
  clearable = true,
  disabled,
  invalid,
  modal = false,
  className,
  id,
  ...aria
}: ComboboxProps) {
  const isInvalid = invalid ?? aria['aria-invalid'] === true;
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value) ?? null;
  const optionId = (index: number) => `${listId}-option-${index}`;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) => option.label.toLowerCase().includes(q) || option.description?.toLowerCase().includes(q),
    );
  }, [options, query]);

  // 键盘移动或打开时，让高亮项保持在可视区域内
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, filtered]);

  const commit = (option: ComboboxOption) => {
    onChange(option.value);
    setOpen(false);
    setQuery('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = filtered[active];
      if (option) commit(option);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <PopoverPrimitive.Root
      modal={modal}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(Math.max(options.findIndex((option) => option.value === value), 0));
        }
      }}
    >
      <div className="relative min-w-0">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            role="combobox"
            id={id}
            disabled={disabled}
            aria-label={aria['aria-label']}
            aria-describedby={aria['aria-describedby']}
            aria-invalid={isInvalid || undefined}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listId : undefined}
            className={cn(
              'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface pl-3 text-sm outline-none transition-[border-color,box-shadow]',
              'focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60',
              isInvalid && 'border-critical focus:border-critical focus:ring-critical/20',
              clearable && selected ? 'pr-14' : 'pr-3',
              className,
            )}
          >
            <span className={cn('truncate', selected ? 'text-ink' : 'text-ink-tertiary')}>
              {selected ? selected.label : placeholder}
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-ink-tertiary" />
          </button>
        </PopoverPrimitive.Trigger>
        {clearable && selected && !disabled && (
          <button
            type="button"
            aria-label="清除选择"
            onClick={() => onChange(null)}
            className="absolute right-8 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-ink-tertiary hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-max min-w-[max(var(--radix-popover-trigger-width),14rem)] max-w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-md"
        >
          <div className="border-b border-line p-2">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              type="search"
              aria-label={searchPlaceholder.replace(/…$/, '')}
              aria-controls={listId}
              // 焦点一直留在搜索框，键盘高亮项靠 activedescendant 播报
              aria-autocomplete="list"
              aria-activedescendant={filtered[active] ? optionId(active) : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={searchPlaceholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="h-8 w-full rounded-md bg-surface px-2 text-sm text-ink outline-none placeholder:text-ink-tertiary"
            />
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label={aria['aria-label']} className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-ink-tertiary">{emptyText}</p>
            ) : (
              filtered.map((option, index) => (
                // 选项不可聚焦：按下时阻止默认行为，焦点留在搜索框
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  data-index={index}
                  aria-selected={option.value === value}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commit(option)}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    index === active ? 'bg-accent-soft text-accent' : 'text-ink',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-xs text-ink-tertiary">{option.description}</span>
                    )}
                  </span>
                  {option.value === value && <Check className="size-4 shrink-0" />}
                </div>
              ))
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
