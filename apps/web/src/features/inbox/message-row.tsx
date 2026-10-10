import { Check, KeyRound, Link2, Paperclip, Star, TriangleAlert } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MessageSummary, OutboundStatus } from '@hpc-mail/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { useCopy } from '@/components/ui/copy-button';
import { inspectVerificationLink } from '@/features/message/verification-link';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';

const OUTBOUND_STATUS: Record<OutboundStatus, { label: string; tone: BadgeTone }> = {
  sent: { label: '已提交', tone: 'neutral' },
  delivered: { label: '已送达', tone: 'positive' },
  bounced: { label: '退信', tone: 'critical' },
  failed: { label: '失败', tone: 'critical' },
  complained: { label: '投诉', tone: 'caution' },
  delayed: { label: '延迟', tone: 'caution' },
};

/** 回收站保留天数（与后端清理周期一致） */
export const TRASH_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

/** 回收站邮件距自动清除还剩几天；没有删除时间时返回 null */
export function trashDaysLeft(deletedAt: string | undefined, now = Date.now()): number | null {
  const deleted = deletedAt ? Date.parse(deletedAt) : Number.NaN;
  if (!Number.isFinite(deleted)) return null;
  return Math.max(0, Math.ceil((deleted + TRASH_RETENTION_DAYS * DAY_MS - now) / DAY_MS));
}

/** 已发送列表：主字段展示收件人（否则每行都是自己的发件地址，无法区分发给了谁） */
function outboundRecipientLabel(message: MessageSummary): string {
  const to = message.recipientsTo ?? [];
  if (to.length === 0) return message.address;
  return to.length === 1 ? `发至 ${to[0]}` : `发至 ${to[0]} +${to.length - 1}`;
}

/** 列表里的验证码：点击直接复制，不进入详情 */
function OtpChip({ code }: { code: string }) {
  const { copied, copy } = useCopy('验证码已复制');
  return (
    <button
      type="button"
      title="复制验证码"
      aria-label={copied ? `已复制验证码 ${code}` : `复制验证码 ${code}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copy(code);
      }}
      className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-sm border border-otp-border bg-otp-bg px-1.5 py-0.5 font-mono text-xs font-semibold leading-tight text-otp-ink transition-colors hover:border-otp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {copied ? <Check className="size-3" aria-hidden /> : <KeyRound className="size-3" aria-hidden />}
      {code}
    </button>
  );
}

export type RowCheckbox = 'hover' | 'always' | 'hidden';

/** 列表行：props 均为稳定引用或原始值，memo 后轮询/翻页只重渲染真正变化的行 */
export const MessageRow = memo(function MessageRow({
  message,
  href,
  linkState,
  onToggleStar,
  selected = false,
  checkbox = 'hover',
  tapToSelect = false,
  onToggleSelect,
  shared = false,
  trash = false,
  now,
  onOpenIntent,
}: {
  message: MessageSummary;
  href: string;
  /** 跟随链接带到详情页的列表上下文（上一封/下一封据此取序） */
  linkState?: unknown;
  onToggleStar: (message: MessageSummary) => void;
  selected?: boolean;
  /** 复选框显示方式：桌面悬停出现 / 常显（已在多选） / 不渲染（触屏未进入多选） */
  checkbox?: RowCheckbox;
  /** 触屏多选模式：点行切换选中而不是打开 */
  tapToSelect?: boolean;
  onToggleSelect?: (id: number, event: MouseEvent) => void;
  /** 这封信来自共享给当前用户的邮箱（只读） */
  shared?: boolean;
  /** 回收站：不显示星标，显示剩余保留天数 */
  trash?: boolean;
  /** 相对时间的基准；由列表按分钟更新，memo 行才能刷新「n 分钟前」 */
  now?: number;
  /** 悬停/聚焦/触摸行时上报（null = 离开），供列表预取详情 */
  onOpenIntent?: (id: number | null) => void;
}) {
  const outbound = message.direction === 'outbound';
  // 共享邮件的已读状态属于所有者：成员视角一律按已读样式显示
  const unread = !outbound && !shared && !message.isRead;
  const primary = outbound ? outboundRecipientLabel(message) : message.fromName || message.fromAddress;
  const subject = message.subject || '（无主题）';
  const status = OUTBOUND_STATUS[message.status as OutboundStatus];
  const failed = outbound && Boolean(message.errorDetail || message.status === 'failed' || message.status === 'bounced');
  // 验证链接：与发件域一致才允许在列表里直接打开；不一致只做警示，点击进入详情页核对
  const verification = outbound ? null : inspectVerificationLink(message.verificationLink, message.fromAddress);
  const daysLeft = trash ? trashDaysLeft(message.deletedAt, now) : null;
  const showCheckbox = Boolean(onToggleSelect) && checkbox !== 'hidden';

  return (
    <div
      data-message-id={message.id}
      className={cn(
        'group relative border-b border-line transition-colors',
        selected ? 'bg-accent-soft' : 'bg-surface hover:bg-surface-hover',
      )}
    >
      <div className={cn('flex items-start gap-3 py-3', trash ? 'pr-4' : 'pr-11', showCheckbox ? 'pl-3' : 'pl-4')}>
        {showCheckbox && onToggleSelect && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`${selected ? '取消选择' : '选择'}：${primary} - ${subject}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleSelect(message.id, event);
            }}
            className={cn(
              'relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              selected
                ? 'border-accent bg-accent text-on-accent'
                : 'border-line-strong bg-surface text-transparent hover:border-accent',
              checkbox === 'always' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            )}
          >
            <Check className="size-3.5" />
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden />}
              {/* 链接用 ::after 铺满整行；行内的复制/链接/星标按钮叠在其上（z-10），不嵌套交互元素 */}
              <Link
                to={href}
                state={linkState}
                data-row-link
                aria-label={`${unread ? '未读，' : ''}${primary}，${subject}${verification?.mismatch ? '，验证链接域名与发件人不一致' : ''}`}
                className={cn(
                  'scroll-mt-32 scroll-mb-6 truncate text-sm text-ink outline-none after:absolute after:inset-0',
                  'focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus',
                  unread ? 'font-semibold' : 'font-medium',
                )}
                onClick={
                  tapToSelect && onToggleSelect
                    ? (event) => {
                        event.preventDefault();
                        onToggleSelect(message.id, event);
                      }
                    : undefined
                }
                onMouseEnter={() => onOpenIntent?.(message.id)}
                onMouseLeave={() => onOpenIntent?.(null)}
                onFocus={() => onOpenIntent?.(message.id)}
                onBlur={() => onOpenIntent?.(null)}
                onTouchStart={() => onOpenIntent?.(message.id)}
              >
                {primary}
              </Link>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-tertiary">
              {daysLeft !== null && (
                <Badge tone={daysLeft <= 1 ? 'critical' : 'neutral'} title="回收站邮件到期后自动永久删除">
                  {daysLeft === 0 ? '即将清除' : `${daysLeft} 天后清除`}
                </Badge>
              )}
              {formatRelativeTime(message.createdAt, now)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn('truncate text-sm', unread ? 'font-medium text-ink' : 'text-ink-secondary')}>
              {subject}
            </span>
            {message.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-ink-tertiary" aria-label="有附件" />}
            {message.verificationCode && <OtpChip code={message.verificationCode} />}
            {verification && !verification.mismatch && (
              <a
                href={verification.href}
                target="_blank"
                rel="noopener noreferrer"
                title={`在新标签打开验证链接（${verification.hostname}）`}
                aria-label={`打开验证链接 ${verification.hostname}`}
                onClick={(event) => event.stopPropagation()}
                className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-xs font-medium leading-tight text-accent transition-colors hover:bg-accent hover:text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <Link2 className="size-3" aria-hidden />
                <span className="hidden sm:inline">验证链接</span>
              </a>
            )}
            {/* 不叠在行链接之上：点击落到行链接，进入详情页查看警告后再决定是否打开 */}
            {verification?.mismatch && (
              <Badge tone="caution" className="shrink-0" title={`验证链接指向 ${verification.hostname}，与发件人域名不一致`}>
                <TriangleAlert className="size-3" aria-hidden />
                <span className="hidden sm:inline">链接域名不一致</span>
              </Badge>
            )}
            {outbound && status && (
              <Badge tone={failed ? 'critical' : status.tone} className="shrink-0">
                {failed && message.status !== 'failed' && message.status !== 'bounced' ? '部分失败' : status.label}
              </Badge>
            )}
            {!outbound && (message.status === 'degraded' || message.errorDetail) && <Badge tone="caution">内容异常</Badge>}
            {!outbound && (
              <span className="ml-auto hidden max-w-[45%] shrink-0 items-center gap-1.5 truncate text-xs text-ink-tertiary sm:inline-flex">
                {shared && (
                  <Badge tone="neutral" className="shrink-0">
                    共享
                  </Badge>
                )}
                {message.address}
              </span>
            )}
          </div>
          {failed && message.errorDetail ? (
            <p className="mt-0.5 truncate text-sm text-critical">{message.errorDetail}</p>
          ) : (
            message.preview && <p className="mt-0.5 truncate text-sm text-ink-tertiary">{message.preview}</p>
          )}
          {!outbound && (
            <p className="mt-0.5 truncate text-xs text-ink-tertiary sm:hidden">
              {shared && '共享 · '}
              {message.address}
            </p>
          )}
        </div>
      </div>

      {!trash && (
        <button
          type="button"
          aria-label={message.isStarred ? '取消星标' : '加星标'}
          title={message.isStarred ? '取消星标' : '加星标'}
          aria-pressed={message.isStarred}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleStar(message);
          }}
          className="absolute right-3 top-1/2 z-10 grid size-7 -translate-y-1/2 place-items-center rounded-md transition-colors hover:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Star className={cn('size-4', message.isStarred ? 'fill-caution text-caution' : 'text-ink-tertiary')} />
        </button>
      )}
    </div>
  );
});
