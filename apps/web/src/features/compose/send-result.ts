import type { ApiErrorDetails, MessageSummary } from '@hpc-mail/shared';
import { toast } from '@/components/ui/toast';
import { isFailedOutcome } from '@/features/message/delivery-outcomes';

/**
 * 发送成功（201）后的提示，写信页与草稿箱共用。部分收件人失败或结果未确认时报错误，
 * 返回 true 表示应进入这封发件的详情查看（失败目标可补发，未确认的先向收件人核对）。
 */
export function notifySendResult(result: Pick<MessageSummary, 'status' | 'errorDetail' | 'recipientOutcomes'>): boolean {
  const failures = result.recipientOutcomes?.filter(isFailedOutcome) ?? [];
  // 结果未确认的收件人可能已经收到：提示先核对，不引导直接重发
  const unconfirmed = result.recipientOutcomes?.filter((outcome) => outcome.status === 'unknown') ?? [];
  const issue = failures.length > 0 || Boolean(result.errorDetail) || result.status === 'failed';
  if (unconfirmed.length > 0 || result.status === 'unknown') {
    toast({
      title: [
        failures.length ? `${failures.length} 个收件人发送失败` : '',
        unconfirmed.length ? `${unconfirmed.length} 个收件人的投递结果未确认` : '投递结果未确认',
      ].filter(Boolean).join('，'),
      description: '可能已经收到：请先向收件人核对，确认没收到再补发，避免重复投递',
      variant: 'error',
    });
    return true;
  }
  toast({ title: issue ? failures.length ? `${failures.length} 个收件人发送失败，请查看并重试失败目标` : '邮件发送有异常，请查看详情' : result.status === 'delivered' ? '站内邮件已送达' : '邮件已提交发送', variant: issue ? 'error' : 'success' });
  return issue;
}

/** 422 delivery_failed：每个收件人都被拒收，什么也没发出；列出逐收件人原因，没有时用错误信息 */
export function deliveryFailureLines(message: string, details?: ApiErrorDetails): string[] {
  const outcomes = details?.recipientOutcomes ?? [];
  return outcomes.length ? outcomes.map((outcome) => `${outcome.address}：${outcome.error || '发送失败'}`) : [message];
}
