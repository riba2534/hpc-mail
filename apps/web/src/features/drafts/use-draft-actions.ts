import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Draft, DraftSummary, Mailbox } from '@hpc-mail/shared';
import { useNavigate } from 'react-router-dom';
import { ApiError, toApiError } from '@/api/errors';
import { toast } from '@/components/ui/toast';
import { classifySendError } from '@/features/compose/send-attempt';
import { deliveryFailureLines, notifySendResult } from '@/features/compose/send-result';
import { ownedAddressSet, syncAfterSend, syncSentMessage } from '@/features/inbox/message-cache';
import { markDraftSent, refreshDraft, removeDraftFromLists, storeDraft } from './draft-cache';
import { draftsApi } from './drafts-api';

/** 发送失败的提示：口径与写信页一致，另加草稿特有的版本冲突与发送中 */
function notifySendError(error: ApiError): void {
  if (error.code === 'delivery_failed') {
    toast({ title: '发送失败：所有收件人都没有收到', description: deliveryFailureLines(error.message, error.details).join('；'), variant: 'error' });
  } else if (error.code === 'draft_state_conflict') {
    toast({
      title: '草稿已被修改，没有发送',
      description: '审阅之后草稿又有改动（可能是 Agent 更新了它），已载入最新内容，请重新审阅后再发送。',
      variant: 'error',
    });
  } else if (error.code === 'send_in_progress') {
    toast({ title: '草稿正在发送', description: '稍后在草稿箱查看结果，不要换别的方式重发。' });
  } else if (classifySendError(error) === 'uncertain') {
    toast({
      title: '发送结果不确定',
      description: `${error.message}。草稿只会发出一次：稍后刷新草稿箱查看状态，再次点击发送不会重复投递。`,
      variant: 'error',
    });
  } else {
    toast({ title: '发送失败', description: error.message, variant: 'error' });
  }
}

/** 草稿箱的写操作：发送（人审后）、取消定时、删除；成功后就地更新列表与详情缓存 */
export function useDraftActions(mailboxes: Mailbox[] | undefined) {
  const client = useQueryClient();
  const navigate = useNavigate();

  // 带上审阅时的版本：之后又被改过（Agent 更新了内容）服务端 409、不发出，用户没看过的内容不会发出去
  const send = useMutation({
    mutationFn: (draft: DraftSummary | Draft) => draftsApi.send(draft.id, draft.version),
    onSuccess: (result, draft) => {
      markDraftSent(client, draft, result.id);
      const sources = 'replyToMessageId' in draft ? [draft.replyToMessageId, draft.forwardAttachmentsFrom] : [];
      syncAfterSend(client, {
        sourceIds: sources.filter((id): id is number => typeof id === 'number'),
        recipients: [...draft.to, ...draft.cc, ...draft.bcc],
        owned: ownedAddressSet(mailboxes),
      });
      if (notifySendResult(result)) navigate(`/mail/${result.id}`);
    },
    onError: (err, draft) => {
      const error = toApiError(err);
      // 服务端已记下一封全部失败的外发，已发送列表要显示它
      if (error.code === 'delivery_failed') syncSentMessage(client, { sourceIds: [], selfDelivered: false });
      notifySendError(error);
      // 失败（failed）、保持原状态并记下原因、或已被别人改过：读回当前状态
      void refreshDraft(client, draft.id);
    },
  });

  // 取消定时不带版本：内容同时被改过也照样取消，用户要的是「先别发」
  const cancelSchedule = useMutation({
    mutationFn: (draft: DraftSummary | Draft) => draftsApi.update(draft.id, { sendAt: null }),
    onSuccess: (draft) => {
      storeDraft(client, draft);
      toast({ title: '已取消定时发送', description: '草稿保留在草稿箱，可以修改后再发送或重新安排。', variant: 'success' });
    },
    onError: (err, draft) => {
      toast({ title: '取消定时失败', description: toApiError(err).message, variant: 'error' });
      void refreshDraft(client, draft.id);
    },
  });

  const remove = useMutation({
    mutationFn: (draft: DraftSummary | Draft) => draftsApi.remove(draft.id),
    onSuccess: (_result, draft) => {
      removeDraftFromLists(client, draft.id);
      toast({ title: '草稿已删除', variant: 'success' });
    },
    onError: (err, draft) => {
      const error = toApiError(err);
      if (error.code === 'not_found') {
        removeDraftFromLists(client, draft.id);
        toast({ title: '草稿已不存在' });
        return;
      }
      toast({ title: '删除失败', description: error.message, variant: 'error' });
      void refreshDraft(client, draft.id);
    },
  });

  return { send, cancelSchedule, remove };
}
