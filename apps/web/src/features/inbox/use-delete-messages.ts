import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MessageMutationScope } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { toast } from '@/components/ui/toast';
import { snapshotListMembership, syncRemovedMessages, syncRestoredMessages } from './message-cache';

/** 删除后的撤销窗口 */
export const UNDO_WINDOW_MS = 5_000;

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
      toast({
        title: result.deleted > 1 ? `已删除 ${result.deleted} 封` : '邮件已删除',
        description: '可在回收站保留 7 天',
        variant: 'success',
        duration: UNDO_WINDOW_MS,
        action: { label: '撤销', onClick: () => void undo(ids, membership) },
      });
      onDeleted?.(ids);
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });
}
