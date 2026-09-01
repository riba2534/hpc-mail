import { AlertCircle } from 'lucide-react';
import { ApiError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';

export function QueryErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  const message = error instanceof Error ? error.message : '网络异常，请稍后重试';

  return (
    <EmptyState
      icon={AlertCircle}
      title="加载失败"
      description={
        <>
          {message}
          {requestId && <span className="mt-1 block text-xs text-ink-tertiary">请求编号：{requestId}</span>}
        </>
      }
      action={
        <Button variant="secondary" onClick={onRetry}>
          重新加载
        </Button>
      }
      className={cn('rounded-lg border border-line bg-surface', className)}
    />
  );
}
