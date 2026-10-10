import type { ComponentPropsWithRef } from 'react';
import { cn } from '@/lib/cn';

export type IconButtonVariant = 'ghost' | 'secondary';
export type IconButtonSize = 'sm' | 'md';

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-hover',
};

const SIZES: Record<IconButtonSize, string> = {
  sm: 'size-8',
  md: 'size-9',
};

export interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  'aria-label': string;
}

/** 纯图标按钮：aria-label 同时作为原生 title 提示（可用 title 覆盖） */
export function IconButton({ className, variant = 'ghost', size = 'md', type = 'button', title, ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      title={title ?? props['aria-label']}
      className={cn(
        'inline-grid place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}
