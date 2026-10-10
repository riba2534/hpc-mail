import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * 有未保存改动时拦截离开：站内跳转弹确认框（react-router blocker），刷新/关闭标签页走浏览器原生 beforeunload。
 * 同一路径内只改查询串或锚点不拦截。需在数据路由（createBrowserRouter）下使用。
 */
export function UnsavedChangesGuard({
  when,
  description = '有未保存的改动，离开后这些改动会丢失。',
}: {
  when: boolean;
  description?: string;
}) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!when) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 旧版浏览器需要 returnValue 才弹窗
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [when]);

  // 保存完成后改动消失：放行已拦下的跳转
  useEffect(() => {
    if (!when && blocker.state === 'blocked') blocker.proceed();
  }, [when, blocker]);

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset();
      }}
      title="离开此页？"
      description={description}
      cancelLabel="留在此页"
      confirmLabel="放弃改动并离开"
      tone="danger"
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );
}
