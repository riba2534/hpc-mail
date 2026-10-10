import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** 窄屏下替代表格的卡片列表：与 Table 同样的外框，行间分隔线 */
export function CardList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul className={cn('divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface', className)} {...props} />;
}

export interface CardListItemProps {
  /** 主行：地址 / 用户名等识别信息 */
  title: ReactNode;
  /** 副行：次要说明（备注、归属人等） */
  subtitle?: ReactNode;
  /** 元信息：状态徽标、计数、时间，换行排列 */
  meta?: ReactNode;
  /** 右侧操作，通常是一个「更多操作」菜单 */
  actions?: ReactNode;
  className?: string;
}

export function CardListItem({ title, subtitle, meta, actions, className }: CardListItemProps) {
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', className)}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">{title}</div>
        {subtitle && <div className="mt-0.5 truncate text-[13px] text-ink-secondary">{subtitle}</div>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-tertiary">{meta}</div>}
      </div>
      {actions && <div className="-mr-1 flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}
