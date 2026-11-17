import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

/** 距视口底部这么远时就开始加载下一页，滚动到底前数据已就绪 */
const PRELOAD_MARGIN = '600px 0px';

interface LoadMoreFooterProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/**
 * 分页列表的末尾：滚动接近时自动加载下一页，按钮作为手动兜底（无 IntersectionObserver 或键盘操作时）。
 * 加载完成后若末尾仍在视口附近（一页不够填满屏幕），观察器重建时会立即再触发一次。
 */
export function LoadMoreFooter({ hasNextPage, isFetchingNextPage, onLoadMore }: LoadMoreFooterProps) {
  const footer = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoadMore);
  useEffect(() => {
    latest.current = onLoadMore;
  });
  useEffect(() => {
    const node = footer.current;
    if (!node || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage]);

  if (!hasNextPage) return null;
  return (
    <div ref={footer} className="mt-3 text-center">
      <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={onLoadMore}>
        加载更多
      </Button>
    </div>
  );
}
