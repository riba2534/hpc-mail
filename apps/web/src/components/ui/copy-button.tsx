import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { toast } from './toast';

export interface CopyButtonProps {
  value: string;
  /** 按钮上可见的文字；省略时只显示图标 */
  label?: string;
  /** 无障碍名称，如「复制验证码」；省略时可见文字即名称，纯图标时为「复制」 */
  ariaLabel?: string;
  className?: string;
  size?: 'sm' | 'md';
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到 execCommand
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制并给出 toast + 1.5 秒「已复制」状态，供自定义外观的复制入口复用 */
export function useCopy(successTitle = '已复制到剪贴板') {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = globalThis.setTimeout(() => setCopied(false), 1500);
    return () => globalThis.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(
    async (value: string) => {
      const ok = await writeClipboard(value);
      if (ok) {
        setCopied(true);
        toast({ title: successTitle, variant: 'success' });
      } else {
        toast({ title: '复制失败，请手动选择', variant: 'error' });
      }
      return ok;
    },
    [successTitle],
  );

  return { copied, copy };
}

export function CopyButton({ value, label, ariaLabel, className, size = 'md' }: CopyButtonProps) {
  const { copied, copy } = useCopy();
  // 有可见文字时由文字提供名称，避免「复制复制」式的重复朗读
  const accessibleName = copied ? '已复制' : ariaLabel ?? (label ? undefined : '复制');

  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={accessibleName}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface font-medium text-ink transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3 text-sm',
        className,
      )}
    >
      {copied ? <Check className="size-4 text-positive" aria-hidden /> : <Copy className="size-4 text-ink-tertiary" aria-hidden />}
      {label && <span>{copied ? '已复制' : label}</span>}
    </button>
  );
}
