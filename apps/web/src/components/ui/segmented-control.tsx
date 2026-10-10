import { type KeyboardEvent, useRef } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  'aria-label'?: string;
  className?: string;
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/** 单选分段：radiogroup 语义，Tab 只停在选中项，方向键/Home/End 切换并移动焦点 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = options.findIndex((option) => option.value === value);
  // 当前值不在选项里时让第一项可聚焦，保证键盘仍能进入
  const tabStop = activeIndex >= 0 ? activeIndex : 0;

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    buttonsRef.current[index]?.focus();
    if (option.value !== value) onValueChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = options.length;
    if (count === 0) return;
    let next: number | null = null;
    if (NEXT_KEYS.has(event.key)) next = (index + 1) % count;
    else if (PREV_KEYS.has(event.key)) next = (index - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={aria['aria-label']}
      className={cn('inline-flex h-9 items-center gap-0.5 rounded-md border border-line-strong bg-surface p-0.5', className)}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'inline-flex h-full items-center justify-center rounded-[6px] px-3 text-center text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              active ? 'bg-accent text-on-accent' : 'text-ink-secondary hover:text-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
