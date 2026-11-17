import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';

/** 距视口底部这么远时就开始加载下一页，滚动到底前数据已就绪 */
const PRELOAD_MARGIN = '600px 0px';

interface LoadMoreFooterProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** false：只在点击按钮时加载（草稿箱、审计日志） */
  auto?: boolean;
}

/**
 * 分页列表的末尾：auto 时滚动接近即自动加载下一页，按钮作为手动兜底（无 IntersectionObserver 或键盘操作时）。
 * 加载完成后若末尾仍在视口附近（一页不够填满屏幕），观察器重建时会立即再触发一次。
 */
export function LoadMoreFooter({ hasNextPage, isFetchingNextPage, onLoadMore, auto = true }: LoadMoreFooterProps) {
  const footer = useRef<HTMLDivElement>(null);
  const latest = useRef(onLoadMore);
  useEffect(() => {
    latest.current = onLoadMore;
  });
  useEffect(() => {
    const node = footer.current;
    if (!auto || !node || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current();
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [auto, hasNextPage, isFetchingNextPage]);

  if (!hasNextPage) return null;
  return (
    <div ref={footer} className="mt-3 text-center">
      <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={onLoadMore}>
        加载更多
      </Button>
    </div>
  );
}
