import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MessageMutationScope } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { dismissToast, toast } from '@/components/ui/toast';
import { snapshotListMembership, syncRemovedMessages, syncRestoredMessages } from './message-cache';

/** 删除后的撤销窗口 */
export const UNDO_WINDOW_MS = 5_000;

/** 最近一次删除的撤销：与通知里的「撤销」按钮同一个动作，任一方用过即失效 */
let latestUndo: { run: () => void; toastId: number; expiresAt: number } | null = null;

/** 撤销最近一次删除（列表的 z 快捷键）：只在撤销窗口内有效，同时关闭那条通知；没有可撤销的删除时返回 false */
export function undoLatestDelete(now = Date.now()): boolean {
  const pending = latestUndo;
  if (!pending || now > pending.expiresAt) return false;
  dismissToast(pending.toastId);
  pending.run();
  return true;
}

/**
 * 删除邮件（移入回收站）并给出 5 秒「撤销」：撤销调用 restore，成功后把邮件放回删除前所在的列表。
 * onDeleted 在服务端确认删除后调用（如详情页返回列表）。
 */
export function useDeleteMessages(scope?: MessageMutationScope, onDeleted?: (ids: number[]) => void) {
  const queryClient = useQueryClient();

  const undo = async (ids: number[], membership: ReturnType<typeof snapshotListMembership>) => {
    try {
      const { changed } = await messageApi.restore(ids, scope);
      if (changed === 0) {
        toast({ title: '撤销失败，邮件可能已被永久删除', variant: 'error' });
        return;
      }
      syncRestoredMessages(queryClient, ids, membership);
      if (changed !== ids.length) void queryClient.invalidateQueries({ queryKey: queryKeys.messages.lists });
      toast({ title: changed === ids.length ? '已撤销删除' : `已恢复 ${changed} 封`, variant: 'success' });
    } catch {
      toast({ title: '撤销失败，可到回收站恢复', variant: 'error' });
    }
  };

  return useMutation({
    mutationFn: (ids: number[]) => messageApi.remove(ids, scope),
    onSuccess: (result, ids) => {
      if (result.deleted === 0) {
        toast({ title: ids.length > 1 ? '这些邮件不能删除' : '这封邮件不能删除', variant: 'error' });
        return;
      }
      const membership = snapshotListMembership(queryClient, ids);
      syncRemovedMessages(queryClient, ids, 'live');
      // 部分无权限或已在别处改变：就地结果不可信，整表对齐
      if (result.deleted !== ids.length) void queryClient.invalidateQueries({ queryKey: queryKeys.messages.lists });
      const run = () => {
        if (latestUndo?.run === run) latestUndo = null;
        void undo(ids, membership);
      };
      latestUndo = {
        run,
        toastId: toast({
          title: result.deleted > 1 ? `已删除 ${result.deleted} 封` : '邮件已删除',
          description: '可在回收站保留 7 天',
          variant: 'success',
          duration: UNDO_WINDOW_MS,
          action: { label: '撤销', onClick: run },
        }),
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      };
      onDeleted?.(ids);
    },
    meta: { errorTitle: '删除失败' },
  });
}
