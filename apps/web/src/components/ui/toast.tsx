import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export type ToastVariant = 'default' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  title: string;
  description?: string;
  duration?: number;
  variant?: ToastVariant;
  /** 单个操作按钮（如「撤销」）；点击后执行并关闭通知 */
  action?: ToastAction;
}

interface ToastItem extends ToastInput {
  id: number;
}

type Listener = (event: { type: 'add'; item: ToastItem } | { type: 'dismiss'; id: number }) => void;
const listeners = new Set<Listener>();
let nextToastId = 1;

/** 模块级触发器：任意位置（含 mutation 回调）可直接调用；返回 id 供 dismissToast 关闭 */
export function toast(input: ToastInput): number {
  const item: ToastItem = { ...input, id: nextToastId++ };
  listeners.forEach((listener) => listener({ type: 'add', item }));
  return item.id;
}

export function dismissToast(id: number): void {
  listeners.forEach((listener) => listener({ type: 'dismiss', id }));
}

const ICONS: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CircleCheck,
  error: CircleX,
};

const ICON_TONES: Record<ToastVariant, string> = {
  default: 'text-accent',
  success: 'text-positive',
  error: 'text-critical',
};

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const variant = item.variant ?? 'default';
  const Icon = ICONS[variant];
  // 悬停或键盘聚焦时暂停计时，留够时间点「撤销」
  const [paused, setPaused] = useState(false);
  const remaining = useRef(item.duration ?? 4000);

  useEffect(() => {
    if (paused) return;
    const startedAt = Date.now();
    const timer = globalThis.setTimeout(() => onDismiss(item.id), remaining.current);
    return () => {
      globalThis.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
    };
  }, [item.id, paused, onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-md"
    >
      <Icon className={cn('mt-0.5 size-5', ICON_TONES[variant])} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{item.title}</p>
        {item.description && <p className="mt-0.5 text-sm text-ink-secondary">{item.description}</p>}
      </div>
      <div className="flex items-center gap-1">
        {item.action && (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              onDismiss(item.id);
            }}
            className="h-7 rounded-md px-2 text-sm font-medium text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {item.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="关闭通知"
          className="grid size-6 place-items-center rounded-md text-ink-tertiary hover:bg-surface-hover hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (event) => {
      if (event.type === 'add') setItems((current) => [...current.slice(-2), event.item]);
      else setItems((current) => current.filter((item) => item.id !== event.id));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);

  return (
    <>
      {children}
      {/* 小屏有可见底部导航（app-shell 给它加 data-bottom-nav）时上移让出导航高度，否则贴底并让出安全区 */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-0 sm:max-w-sm sm:items-end max-md:[body:has([data-bottom-nav])_&]:bottom-16 md:pb-4"
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </>
  );
}
