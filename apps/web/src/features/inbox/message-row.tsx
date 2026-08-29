import { Check, KeyRound, Paperclip, Star } from 'lucide-react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MessageSummary, OutboundStatus } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';

const OUTBOUND_STATUS: Record<OutboundStatus, { label: string; tone: BadgeTone }> = {
  sent: { label: '已发送', tone: 'neutral' },
  delivered: { label: '已送达', tone: 'positive' },
  bounced: { label: '退信', tone: 'critical' },
  failed: { label: '失败', tone: 'critical' },
  complained: { label: '投诉', tone: 'caution' },
  delayed: { label: '延迟', tone: 'caution' },
};

/** 已发送列表：主字段展示收件人（否则每行都是自己的发件地址，无法区分发给了谁） */
function outboundRecipientLabel(message: MessageSummary): string {
  const to = message.recipientsTo ?? [];
  if (to.length === 0) return message.address;
  return to.length === 1 ? `发至 ${to[0]}` : `发至 ${to[0]} +${to.length - 1}`;
}

export function MessageRow({
  message,
  href,
  onToggleStar,
  selected = false,
  selectionActive = false,
  onToggleSelect,
}: {
  message: MessageSummary;
  href: string;
  onToggleStar: (message: MessageSummary) => void;
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: (id: number, event: MouseEvent) => void;
}) {
  const outbound = message.direction === 'outbound';
  const unread = !outbound && !message.isRead;
  const primary = outbound ? outboundRecipientLabel(message) : message.fromName || message.fromAddress;
  const status = OUTBOUND_STATUS[message.status as OutboundStatus];
  const failed = outbound && (message.status === 'failed' || message.status === 'bounced');

  return (
    <div
      className={cn(
        'group relative border-b border-line transition-colors hover:bg-surface-hover',
        selected ? 'bg-accent-soft' : 'bg-surface',
      )}
    >
      <div className={cn('flex items-start gap-3 py-3 pr-11', onToggleSelect ? 'pl-3' : 'pl-4')}>
        {onToggleSelect && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={selected ? '取消选择' : '选择'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleSelect(message.id, event);
            }}
            className={cn(
              'mt-0.5 grid size-5 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              selected
                ? 'border-accent bg-accent text-on-accent'
                : 'border-line-strong bg-surface text-transparent hover:border-accent',
              selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            <Check className="size-3.5" />
          </button>
        )}

        <Link to={href} className="block min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="未读" />}
              <span className={cn('truncate text-sm text-ink', unread ? 'font-semibold' : 'font-medium')}>
                {primary}
              </span>
            </span>
            <span className="shrink-0 text-xs text-ink-tertiary">{formatRelativeTime(message.createdAt)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-medium text-ink' : 'text-ink-secondary')}>
              {message.subject || '（无主题）'}
            </span>
            {message.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-ink-tertiary" />}
            {message.verificationCode && (
              <Badge tone="caution" className="shrink-0">
                <KeyRound className="size-3" />
                {message.verificationCode}
              </Badge>
            )}
            {outbound && status && (
              <Badge tone={status.tone} className="shrink-0">
                {status.label}
              </Badge>
            )}
            {!outbound && (
              <span className="ml-auto hidden max-w-[45%] shrink-0 truncate text-xs text-ink-tertiary sm:inline">
                {message.address}
              </span>
            )}
          </div>
          {failed && message.errorDetail ? (
            <p className="mt-0.5 truncate text-sm text-critical">{message.errorDetail}</p>
          ) : (
            message.preview && <p className="mt-0.5 truncate text-sm text-ink-tertiary">{message.preview}</p>
          )}
        </Link>
      </div>

      <button
        type="button"
        aria-label={message.isStarred ? '取消星标' : '加星标'}
        aria-pressed={message.isStarred}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleStar(message);
        }}
        className="absolute right-3 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Star className={cn('size-4', message.isStarred ? 'fill-caution text-caution' : 'text-ink-tertiary')} />
      </button>
    </div>
  );
}
