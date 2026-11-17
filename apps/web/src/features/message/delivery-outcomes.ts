import type { RecipientOutcome } from '@hpc-mail/shared';

/** 明确没有送到的收件人：发送时被拒（failed）或投递回执退信（bounced）；补发与失败提示都按这个口径 */
export function isFailedOutcome(outcome: Pick<RecipientOutcome, 'status'>): boolean {
  return outcome.status === 'failed' || outcome.status === 'bounced';
}
