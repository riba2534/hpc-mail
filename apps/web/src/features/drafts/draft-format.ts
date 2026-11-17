import type { DraftStatus, DraftSummary, Mailbox, MailAddress, SendFrom } from '@hpc-mail/shared';
import type { BadgeTone } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';

export const DRAFT_STATUS_META: Record<DraftStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: '草稿', tone: 'neutral' },
  scheduled: { label: '定时发送', tone: 'accent' },
  sending: { label: '发送中', tone: 'caution' },
  sent: { label: '已发送', tone: 'positive' },
  failed: { label: '发送失败', tone: 'critical' },
};

/** 状态标签：定时的带上发送时间 */
export function draftStatusLabel(draft: Pick<DraftSummary, 'status' | 'sendAt'>): string {
  if (draft.status === 'scheduled' && draft.sendAt) return `定时于 ${formatDateTime(draft.sendAt)}`;
  return DRAFT_STATUS_META[draft.status].label;
}

/** 来源：Agent 用 API Key 建的标出 Key 名称（Key 已删除时只写 API） */
export function draftSourceLabel(draft: Pick<DraftSummary, 'createdVia' | 'apiKeyName'>): string {
  if (draft.createdVia === 'web') return '网页';
  return draft.apiKeyName ? `API · ${draft.apiKeyName}` : 'API';
}

/**
 * 发件地址：{mailboxId} 用已加载的邮箱列表解析成地址，{localPart, domain} 直接拼；
 * 邮箱已不在列表里（释放或过户）时显示编号，未设置为 null。
 */
export function draftFromAddress(from: SendFrom | null, mailboxes: Mailbox[] | undefined): string | null {
  if (!from) return null;
  if (from.mailboxId) return mailboxes?.find((box) => box.id === from.mailboxId)?.address ?? `邮箱 #${from.mailboxId}`;
  if (from.localPart && from.domain) return `${from.localPart}@${from.domain}`.toLowerCase();
  return null;
}

/** 发件地址的显示文本：带显示名时 `名称 <地址>` */
export function draftFromLabel(from: SendFrom | null, mailboxes: Mailbox[] | undefined): string | null {
  const address = draftFromAddress(from, mailboxes);
  if (!address) return null;
  return from?.displayName ? `${from.displayName} <${address}>` : address;
}

/** 收件人写回输入框的写法：显示名含双引号时整体加引号并转义，解析后与原值一致 */
export function addressInputText(value: MailAddress): string {
  if (!value.name) return value.address;
  const name = value.name.includes('"') ? `"${value.name.replace(/(["\\])/g, '\\$1')}"` : value.name;
  return `${name} <${value.address}>`;
}

/** 列表里的收件人摘要：最多列出前三个，其余计数 */
export function recipientsSummary(draft: Pick<DraftSummary, 'to' | 'cc' | 'bcc'>): string {
  const all = [...draft.to, ...draft.cc, ...draft.bcc];
  if (all.length === 0) return '（未填写收件人）';
  const shown = all.slice(0, 3).map((item) => item.name || item.address).join('、');
  return all.length > 3 ? `${shown} 等 ${all.length} 人` : shown;
}
