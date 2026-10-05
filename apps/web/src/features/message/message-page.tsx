import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileDown, Forward, ImageOff, MailOpen, MoreHorizontal, Paperclip, Reply, ReplyAll, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MessageDetail } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { buildForward, buildReply, buildReplyAll, buildResend } from '@/features/compose/compose-init';
import { useSharedMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { Badge } from '@/components/ui/badge';
import { mailHref } from '@/features/inbox/mail-view';
import { useStarMutation } from '@/features/inbox/use-star';
import { cn } from '@/lib/cn';
import { countRemoteImages } from './count-remote-images';
import { EmailHtml } from '@/lib/email-html';
import { formatBytes, formatDateTime } from '@/lib/format';
import { getAuthToken } from '@/lib/auth-token';
import { extractOtp } from '@/lib/otp';
import { isTrustedSender, trustSender } from '@/lib/trusted-senders';
import { OtpBanner } from './otp-banner';
import { useCurrentUser } from '@/lib/use-session';
import { QueryErrorState } from '@/components/query-error-state';
import { ApiError } from '@/api/errors';

export function MessagePage() {
  const currentUser = useCurrentUser();
  const { id } = useParams();
  const messageId = Number(id);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scopeRaw = searchParams.get('scope');
  const scope: 'mine' | 'unclaimed' | 'user' | undefined =
    scopeRaw === 'unclaimed' || scopeRaw === 'user' || scopeRaw === 'mine' ? scopeRaw : undefined;
  const userIdRaw = Number(searchParams.get('userId'));
  const userId = Number.isInteger(userIdRaw) && userIdRaw > 0 ? userIdRaw : undefined;
  const view = scope ? { scope, userId } : undefined;
  const auditUser = scope === 'user';
  const mutationScope = scope === 'unclaimed' ? ('unclaimed' as const) : undefined;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imagesAllowedFor, setImagesAllowedFor] = useState<number | null>(null);
  const markedRef = useRef<number | null>(null);

  const { data: sharedMailboxes, isPending: sharedPending } = useSharedMailboxesQuery();
  const { data: message, isLoading, isError, error: detailError, refetch } = useQuery({
    queryKey: queryKeys.messages.detail(messageId, view),
    queryFn: ({ signal }) => messageApi.detail(messageId, view, signal),
    enabled: Number.isInteger(messageId) && messageId > 0,
  });

  const star = useStarMutation(view);

  const { data: threadData } = useQuery({
    queryKey: ['messages', 'thread', messageId, view],
    queryFn: ({ signal }) => messageApi.thread(messageId, view, signal),
    enabled: Number.isInteger(messageId) && messageId > 0,
  });
  const thread = threadData?.items ?? [];

  const markRead = useMutation({
    mutationFn: (args: { id: number; isRead: boolean; scope: typeof mutationScope; view: typeof view }) => messageApi.markRead([args.id], args.isRead, args.scope),
    onSuccess: (result, { id, isRead, view: targetView }) => {
      queryClient.setQueryData<MessageDetail>(queryKeys.messages.detail(id, targetView), (prev) =>
        prev && result.changed > 0 ? { ...prev, isRead } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
    },
  });

  useEffect(() => {
    if (auditUser) return;
    if (message && !message.isRead && markedRef.current !== message.id) {
      markedRef.current = message.id;
      markRead.mutate({ id: message.id, isRead: true, scope: mutationScope, view });
    }
    // 只在消息首次加载为未读时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, message?.isRead, auditUser]);

  // Permission is bound to the current message, so the next mail cannot render a remote image even for one frame.
  const showRemoteImages = Boolean(message && (imagesAllowedFor === message.id || isTrustedSender(message.fromAddress, currentUser.id)));
  useEffect(() => setConfirmDelete(false), [messageId]);

  // 直链/新标签页打开时无历史可退，回退到收件箱而非停在已 404 的详情
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/inbox');
  };

  const deleteMutation = useMutation({
    mutationFn: () => messageApi.remove([messageId], mutationScope),
    onSuccess: (result) => {
      if (result.deleted === 0) {
        toast({ title: '这封邮件不能删除', variant: 'error' });
        return;
      }
      toast({ title: '邮件已删除', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
      goBack();
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const handleMarkUnread = () => {
    markRead.mutate({ id: messageId, isRead: false, scope: mutationScope, view });
    goBack();
  };

  // 下载原始 .eml：带鉴权头 fetch → blob → 触发下载
  const downloadEml = async () => {
    try {
      const qs = searchParams.toString();
      const res = await fetch(`/api/messages/${messageId}/raw${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${getAuthToken() ?? ''}` },
      });
      if (!res.ok) {
        toast({ title: '下载失败', variant: 'error' });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `message-${messageId}.eml`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: '下载失败', variant: 'error' });
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !message) {
    if (isError && !(detailError instanceof ApiError && (detailError.httpStatus === 404 || detailError.httpStatus === 403))) {
      return <QueryErrorState error={detailError} onRetry={() => void refetch()} />;
    }
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          title="邮件不存在"
          description="该邮件可能已被删除或你没有访问权限。"
          action={
            <Button variant="secondary" onClick={() => navigate(-1)}>
              返回
            </Button>
          }
          className="rounded-lg border border-line bg-surface"
        />
      </div>
    );
  }

  const outbound = message.direction === 'outbound';
  const shared = (sharedMailboxes ?? []).some((mailbox) => mailbox.address === message.address);
  const canActAsOwner = !auditUser && !shared && !sharedPending;
  // 验证码 banner 只对收到的邮件有意义，自己发出的邮件不提取/不展示
  const otpCode = outbound
    ? undefined
    : message.verificationCode || extractOtp(message.subject, message.bodyText)?.code;
  const recipients = [...message.recipients.to, ...message.recipients.cc];
  const remoteImageCount = message.bodyHtml ? countRemoteImages(message.bodyHtml) : 0;
  const sendIssue = outbound && (message.errorDetail || message.status === 'failed' || message.status === 'bounced');
  const failedRecipients = message.recipientOutcomes?.filter((outcome) => outcome.status === 'failed') ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IconButton aria-label="返回" onClick={() => navigate(-1)}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {canActAsOwner && (
            <>
              <Button variant="secondary" size="sm" onClick={() => navigate('/compose', { state: buildReply(message) })}>
                <Reply className="size-4" />
                回复
              </Button>
              {message.recipients.to.length + message.recipients.cc.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden sm:inline-flex"
                  onClick={() => navigate('/compose', { state: buildReplyAll(message) })}
                >
                  <ReplyAll className="size-4" />
                  回复全部
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => navigate('/compose', { state: buildForward(message) })}
              >
                <Forward className="size-4" />
                转发
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton className="sm:hidden" aria-label="更多回复操作">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {message.recipients.to.length + message.recipients.cc.length > 1 && (
                    <DropdownMenuItem onSelect={() => navigate('/compose', { state: buildReplyAll(message) })}>
                      <ReplyAll className="size-4" />
                      回复全部
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => navigate('/compose', { state: buildForward(message) })}>
                    <Forward className="size-4" />
                    转发
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          <IconButton
            aria-label={message.isStarred ? '取消星标' : '加星标'}
            aria-pressed={message.isStarred}
            onClick={() => star.mutate({ id: message.id, starred: !message.isStarred })}
          >
            <Star className={cn('size-4', message.isStarred ? 'fill-caution text-caution' : 'text-ink-tertiary')} />
          </IconButton>
          {!auditUser && (
            <IconButton aria-label="标为未读" onClick={handleMarkUnread}>
              <MailOpen className="size-4" />
            </IconButton>
          )}
          {message.hasRaw && (
            <IconButton aria-label="下载原始邮件 (.eml)" onClick={downloadEml}>
              <FileDown className="size-4" />
            </IconButton>
          )}
          {canActAsOwner && (
            <IconButton aria-label="删除邮件" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4 text-critical" />
            </IconButton>
          )}
        </div>
      </div>

      <article className="overflow-hidden rounded-lg border border-line bg-surface">
        <header className="border-b border-line px-5 py-4">
          <h1 className="text-lg font-semibold text-ink">{message.subject || '（无主题）'}</h1>
          <div className="mt-2 flex flex-col gap-1 text-sm text-ink-secondary">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-ink">{message.fromName || message.fromAddress}</span>
              {message.fromName && <span className="text-ink-tertiary">&lt;{message.fromAddress}&gt;</span>}
            </div>
            {recipients.length > 0 && (
              <p className="text-ink-tertiary">
                收件人：<span className="text-ink-secondary">{recipients.join('、')}</span>
              </p>
            )}
            <p className="flex flex-wrap items-center gap-2 text-ink-tertiary">
              <span>{formatDateTime(message.createdAt)}</span>
              <span className="text-ink-secondary">{message.address}</span>
              {shared && <Badge tone="neutral">共享</Badge>}
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-4 px-5 py-5">
          {sendIssue && (
            <div className="rounded-md border border-critical/40 bg-critical-soft px-3 py-2.5 text-sm">
              <p className="font-medium text-critical">
                {message.status === 'failed' ? '发送失败' : message.status === 'bounced' ? '退信' : '部分收件人失败'}
              </p>
              {message.errorDetail && (
                <p className="mt-1 break-words text-ink-secondary">{message.errorDetail}</p>
              )}
              {failedRecipients.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-ink-secondary">
                  {failedRecipients.map((outcome) => <li key={outcome.address}>{outcome.address}：{outcome.error || '发送失败'}</li>)}
                </ul>
              )}
              {canActAsOwner && failedRecipients.length > 0 && <button type="button" className="mr-4 mt-2 text-sm font-medium text-accent hover:underline" onClick={() => navigate('/compose', { state: buildResend(message, true) })}>仅重试失败收件人</button>}
              {canActAsOwner && (
              <button
                type="button"
                className="mt-2 text-sm font-medium text-accent hover:underline"
                onClick={() => navigate('/compose', { state: buildResend(message) })}
              >
                重新编辑并发送
              </button>
              )}
            </div>
          )}
          {!outbound && (message.status === 'degraded' || message.errorDetail) && <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
            <p className="font-medium text-caution">邮件内容可能不完整</p>
            <p>{message.errorDetail || '处理邮件时发生异常，部分正文或附件可能缺失。'}</p>
            <p>{message.hasRaw ? '可下载原始邮件检查完整内容。' : '未保存原始邮件，请联系发件人重新发送。'}</p>
          </div>}
          {otpCode && <OtpBanner code={otpCode} />}

          {remoteImageCount > 0 && !showRemoteImages && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
              <span className="flex items-center gap-2 text-ink-secondary">
                <ImageOff className="size-4 shrink-0 text-ink-tertiary" />
                已阻止 {remoteImageCount} 张远程图片以保护隐私
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-sm text-ink-tertiary hover:text-ink hover:underline"
                  onClick={() => {
                    trustSender(message.fromAddress, currentUser.id);
                    setImagesAllowedFor(message.id);
                  }}
                >
                  始终信任该发件人
                </button>
                <Button variant="secondary" size="sm" onClick={() => setImagesAllowedFor(message.id)}>
                  显示图片
                </Button>
              </div>
            </div>
          )}

          {message.bodyHtml ? (
            <EmailHtml
              html={message.bodyHtml}
              allowRemoteImages={showRemoteImages}
              trustedImageOrigins={[globalThis.location.origin]}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
              {message.bodyText || '（无正文）'}
            </pre>
          )}

          {message.attachments.length > 0 && (
            <div className="border-t border-line pt-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
                <Paperclip className="size-4" />
                {message.attachments.length} 个附件
              </p>
              <ul className="flex flex-col gap-2">
                {message.attachments.map((attachment) => (
                  <li key={attachment.id}>
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm transition-colors hover:bg-surface-hover"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{attachment.filename}</span>
                      <span className="shrink-0 text-xs text-ink-tertiary">{formatBytes(attachment.size)}</span>
                      <Download className="size-4 shrink-0 text-ink-tertiary" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </article>

      {thread.length > 1 && (
        <section className="mt-4 overflow-hidden rounded-lg border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
            会话（{thread.length} 封）
          </h2>
          <ul className="flex flex-col p-1.5">
            {thread.map((item) => (
              <li key={item.id}>
                <Link
                  to={mailHref(item.id, view ?? {})}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-surface-hover',
                    item.id === messageId && 'bg-accent-soft',
                  )}
                >
                  <span className="min-w-0 truncate text-ink">
                    <span className="text-ink-secondary">
                      {item.direction === 'outbound' ? '我' : item.fromName || item.fromAddress}：
                    </span>
                    {item.subject || '（无主题）'}
                  </span>
                  <span className="shrink-0 text-xs text-ink-tertiary">{formatDateTime(item.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除这封邮件？"
        description="邮件将移入回收站，可在 7 天内恢复；之后正文和附件会被永久删除。"
        confirmLabel="删除"
        tone="danger"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
