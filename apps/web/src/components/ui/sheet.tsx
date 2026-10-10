import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const SIDES = {
  left: 'inset-y-0 left-0 h-full w-[85vw] max-w-xs border-r',
  right: 'inset-y-0 right-0 h-full w-full max-w-md border-l',
  bottom: 'inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-lg border-t',
} as const;

export function SheetContent({
  className,
  children,
  side = 'right',
  title,
  description,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  side?: keyof typeof SIDES;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col overflow-hidden border-line bg-surface shadow-lg focus:outline-none',
          SIDES[side],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="flex flex-col gap-1">
            <DialogPrimitive.Title className="text-base font-semibold text-ink">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="text-sm text-ink-secondary">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            aria-label="关闭"
            className="grid size-8 shrink-0 place-items-center rounded-md text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
