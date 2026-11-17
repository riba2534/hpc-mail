import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileDown,
  Forward,
  ImageOff,
  Languages,
  Mail,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MessageDetail } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { messageApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { buildForward, buildReply, buildReplyAll, buildResend } from '@/features/compose/compose-init';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { Badge } from '@/components/ui/badge';
import type { MailListLinkState } from '@/features/inbox/mail-list';
import { mailHref, mailViewParams, parseMailView } from '@/features/inbox/mail-view';
import { type MessageListData, syncReadState } from '@/features/inbox/message-cache';
import { messageDetailQueryOptions } from '@/features/inbox/message-queries';
import { useDeleteMessages } from '@/features/inbox/use-delete-messages';
import { useMailShortcuts } from '@/features/inbox/use-mail-shortcuts';
import { useStarMutation } from '@/features/inbox/use-star';
import { cn } from '@/lib/cn';
import { attachmentIcon } from './attachment-icon';
import { countRemoteImages } from './count-remote-images';
import { downloadWithAuth, openOrDownloadWithAuth } from './download';
import { EmailHtml } from '@/lib/email-html';
import { PlainTextBody } from '@/lib/email-html/plain-text-body';
import { formatBytes, formatDateTime } from '@/lib/format';
import { extractOtp } from '@/lib/otp';
import { isTrustedSender, trustSender } from '@/lib/trusted-senders';
import { OtpBanner } from './otp-banner';
import { SenderAuthBanner, senderAuthFailed } from './sender-auth-banner';
import { TranslationBar } from './translation/translation-bar';
import { useMessageTranslation } from './translation/use-message-translation';
import { inspectVerificationLink } from './verification-link';
import { useDocumentTitle } from '@/lib/use-document-title';
import { useCurrentUser } from '@/lib/use-session';
import { QueryErrorState } from '@/components/query-error-state';
import { ApiError } from '@/api/errors';

/** 去重（不区分大小写，保留首次出现的写法） */
/** 详情页 j/k 翻阅的方向 */
type KeyboardStep = 'next' | 'prev';
/** 列表行带来的上下文，加上详情页内 j/k 翻阅时记下的方向（决定预取哪一封） */
type DetailLinkState = Partial<MailListLinkState> & { keyboard?: KeyboardStep };

function uniqueAddresses(addresses: string[], exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set(exclude);
  return addresses.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function RecipientLine({ label, addresses }: { label: string; addresses: string[] }) {
  if (addresses.length === 0) return null;
  return (
    <p className="text-ink-tertiary">
      {label}：<span className="break-all text-ink-secondary">{addresses.join('、')}</span>
    </p>
  );
}

function VerificationLinkBanner({ message }: { message: MessageDetail }) {
  const link = inspectVerificationLink(message.verificationLink, message.fromAddress);
  if (!link) return null;
  const unverifiedSender = senderAuthFailed(message.auth);
  const caution = link.mismatch || unverifiedSender;
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border px-4 py-3',
        caution ? 'border-caution/40 bg-caution-soft' : 'border-line bg-canvas',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-secondary">验证链接</p>
          <p className="truncate text-sm text-ink" title={link.href}>{link.hostname}</p>
        </div>
        <Button asChild size="sm" variant={caution ? 'secondary' : 'primary'}>
          <a href={link.href} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            打开验证链接
          </a>
        </Button>
      </div>
      {link.mismatch && (
        <p className="flex items-start gap-1.5 text-sm font-medium text-caution">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          链接域名与发件人不一致，请确认后再打开
        </p>
      )}
      {!link.mismatch && unverifiedSender && (
        <p className="flex items-start gap-1.5 text-sm font-medium text-caution">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          发件人未通过验证，请确认后再打开
        </p>
      )}
    </div>
  );
}

export function MessagePage() {
  const currentUser = useCurrentUser();
  const { id } = useParams();
  const messageId = Number(id);
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // 与列表行链接、悬停预取、启动预取解析同一查询串，命中同一个详情缓存
  const view = parseMailView(searchParams);
  const scope = view?.scope;
  const auditUser = scope === 'user';
  const personalView = !scope || scope === 'mine';
  const mutationScope = scope === 'unclaimed' ? ('unclaimed' as const) : undefined;
  const [imagesAllowedFor, setImagesAllowedFor] = useState<number | null>(null);
  const [htmlRoot, setHtmlRoot] = useState<HTMLElement | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const markedRef = useRef<number | null>(null);
  // 离开页面时中止进行中的下载：不再在别的页面弹出下载或打开标签页
  const unmountRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    unmountRef.current = controller;
    return () => controller.abort();
  }, []);

  const { data: ownedMailboxes } = useMailboxesQuery(false);
  const { data: message, isLoading, isError, error: detailError, refetch } = useQuery({
    ...messageDetailQueryOptions(messageId, view),
    enabled: Number.isInteger(messageId) && messageId > 0,
  });

  const star = useStarMutation(view);
  // 只读操作：共享邮件、管理员的未认领/用户视图同样可译
  const translation = useMessageTranslation(message, view, htmlRoot);
  // 标签页标题用邮件主题；加载中传 null 沿用路由默认标题
  useDocumentTitle(message ? message.subject || '（无主题）' : null);

  const { data: threadData } = useQuery({
    queryKey: queryKeys.messages.thread(messageId, view),
    queryFn: ({ signal }) => messageApi.thread(messageId, view, signal),
    enabled: Number.isInteger(messageId) && messageId > 0,
  });
  const thread = threadData?.items ?? [];

  // 「共享来的」：个人视图里地址不在自己认领列表中。只读：不自动标已读、不能标未读/删除/回复
  const ownedLoaded = ownedMailboxes !== undefined;
  const shared = Boolean(message && personalView && ownedLoaded && !ownedMailboxes.some((box) => box.address === message.address));
  const readStateWritable = !auditUser && (!personalView || ownedLoaded) && !shared;
  const canActAsOwner = readStateWritable;

  // 直链/新标签页打开时无历史可退，回退到收件箱而非停在已 404 的详情
  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/inbox');
  };

  // ---- 上一封 / 下一封：取自打开它的列表的缓存，首次命中时固定顺序（未读列表里已读的会被移出）----
  const listQuery = (location.state as MailListLinkState | null)?.list;
  const listKey = listQuery ? JSON.stringify(listQuery) : null;
  const orderRef = useRef<{ key: string; ids: number[] } | null>(null);
  let order = orderRef.current && orderRef.current.key === listKey ? orderRef.current.ids : null;
  if (listKey && listQuery && (!order || !order.includes(messageId))) {
    const data = queryClient.getQueryData<MessageListData>(queryKeys.messages.list(listQuery));
    const ids = data?.pages.flatMap((page) => page.items.map((item) => item.id)) ?? [];
    if (ids.includes(messageId)) {
      order = ids;
      orderRef.current = { key: listKey, ids };
    }
  }
  const position = order ? order.indexOf(messageId) : -1;
  const prevId = order && position > 0 ? order[position - 1] : undefined;
  const nextId = order && position >= 0 ? order[position + 1] : undefined;
  // j/k 进入的详情记下方向：连续翻阅时只预取同方向的下一封；直接打开、点链接或按钮切换都不预取
  const goToMessage = (target: number | undefined, keyboard?: KeyboardStep) => {
    if (target === undefined) return;
    const state: DetailLinkState = { ...(location.state as DetailLinkState | null), keyboard };
    navigate(mailHref(target, view ?? {}), { replace: true, state });
  };
  const keyboardStep = (location.state as DetailLinkState | null)?.keyboard;
  const prefetchTarget = keyboardStep === 'next' ? nextId : keyboardStep === 'prev' ? prevId : undefined;
  useEffect(() => {
    if (prefetchTarget !== undefined) void queryClient.prefetchQuery(messageDetailQueryOptions(prefetchTarget, view));
    // view 由查询串决定，随 messageId 一起变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetchTarget, queryClient]);

  const markRead = useMutation({
    // 个人视图让服务端随响应带回未读数，不再单独请求 unread-count
    mutationFn: (args: { id: number; isRead: boolean; scope: typeof mutationScope }) =>
      messageApi.markRead([args.id], args.isRead, args.scope, args.scope === undefined),
    onSuccess: (result, { id, isRead }) => {
      // 只同步这一封的已读状态与未读数；列表只标记过期，回到列表时由首页探测/单页重拉对齐
      if (result.changed > 0) syncReadState(queryClient, [id], isRead, result.unread);
    },
  });

  useEffect(() => {
    if (!readStateWritable) return;
    if (message && !message.isRead && markedRef.current !== message.id) {
      markedRef.current = message.id;
      markRead.mutate({ id: message.id, isRead: true, scope: mutationScope });
    }
    // 只在消息首次加载为未读时触发一次；共享邮件不改所有者的已读状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, message?.isRead, readStateWritable]);

  // Permission is bound to the current message, so the next mail cannot render a remote image even for one frame.
  const showRemoteImages = Boolean(message && (imagesAllowedFor === message.id || isTrustedSender(message.fromAddress, currentUser.id)));

  const deleteMutation = useDeleteMessages(mutationScope, () => goBack());

  const handleMarkUnread = () => {
    if (!readStateWritable) return;
    markRead.mutate({ id: messageId, isRead: false, scope: mutationScope });
    goBack();
  };

  // .eml 与附件都带 JWT 和详情的可见性范围下载，管理员审计视图才能取到
  const viewQuery = mailViewParams(view ?? {}).toString();
  const withView = (path: string) => (viewQuery ? `${path}?${viewQuery}` : path);

  const downloadEml = async () => {
    const signal = unmountRef.current?.signal;
    try {
      await downloadWithAuth(withView(`/api/messages/${messageId}/raw`), `message-${messageId}.eml`, signal);
    } catch (error) {
      if (!signal?.aborted) toast({ title: '下载失败', description: (error as Error).message, variant: 'error' });
    }
  };

  // 附件不用签名 URL（只留给正文内嵌图）：白名单图片在新标签页打开，其余按原文件名下载
  const openAttachment = async (attachment: MessageDetail['attachments'][number]) => {
    if (downloadingId !== null) return;
    setDownloadingId(attachment.id);
    const signal = unmountRef.current?.signal;
    try {
      await openOrDownloadWithAuth(
        withView(`/api/attachments/${attachment.id}`),
        attachment.filename || `attachment-${attachment.id}`,
        attachment.mimeType,
        signal,
      );
    } catch (error) {
      if (!signal?.aborted) toast({ title: '附件下载失败', description: (error as Error).message, variant: 'error' });
    } finally {
      setDownloadingId(null);
    }
  };

  // 大邮件解析 DOM / 跑正则较贵：只在正文变化时计算，切换图片开关、星标等不再重算
  const bodyHtml = message?.bodyHtml;
  const remoteImageCount = useMemo(() => (bodyHtml ? countRemoteImages(bodyHtml) : 0), [bodyHtml]);
  const extractedOtp = useMemo(
    () => (message && message.direction !== 'outbound' && !message.verificationCode
      ? extractOtp(message.subject, message.bodyText)?.code
      : undefined),
    [message?.direction, message?.verificationCode, message?.subject, message?.bodyText],
  );

  const reply = () => message && canActAsOwner && navigate('/compose', { state: buildReply(message) });
  const replyAll = () => message && canActAsOwner && navigate('/compose', { state: buildReplyAll(message) });
  const forward = () => message && canActAsOwner && navigate('/compose', { state: buildForward(message) });
  const toggleStar = () => message && star.mutate({ id: message.id, starred: !message.isStarred });
  const remove = () => {
    if (canActAsOwner && !deleteMutation.isPending) deleteMutation.mutate([messageId]);
  };

  useMailShortcuts(
    {
      j: () => goToMessage(nextId, 'next'),
      k: () => goToMessage(prevId, 'prev'),
      r: () => void reply(),
      a: () => void replyAll(),
      f: () => void forward(),
      s: () => void toggleStar(),
      t: () => (translation.available ? translation.toggle() : false),
      e: remove,
      '#': remove,
      u: goBack,
      'Shift+U': handleMarkUnread,
      Escape: goBack,
    },
    Boolean(message),
  );

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
            <Button variant="secondary" onClick={goBack}>
              返回
            </Button>
          }
          className="rounded-lg border border-line bg-surface"
        />
      </div>
    );
  }

  const outbound = message.direction === 'outbound';
  // 验证码 banner 只对收到的邮件有意义，自己发出的邮件不提取/不展示
  const otpCode = outbound ? undefined : message.verificationCode || extractedOtp;
  const toRecipients = uniqueAddresses(message.recipients.to);
  const ccRecipients = uniqueAddresses(message.recipients.cc, new Set(toRecipients.map((address) => address.toLowerCase())));
  const bccRecipients = outbound
    ? uniqueAddresses(message.recipients.bcc, new Set([...toRecipients, ...ccRecipients].map((address) => address.toLowerCase())))
    : [];
  const multipleRecipients = message.recipients.to.length + message.recipients.cc.length > 1;
  // pending：投递还在进行，结果未回填，不算问题；unknown：投递中断，部分收件人可能已收到
  const deliveryPending = outbound && message.status === 'pending';
  const deliveryUnknown = outbound && message.status === 'unknown';
  const sendIssue = outbound && !deliveryPending && (deliveryUnknown || message.errorDetail || message.status === 'failed');
  const failedRecipients = message.recipientOutcomes?.filter((outcome) => outcome.status === 'failed') ?? [];
  const unknownRecipients = message.recipientOutcomes?.filter((outcome) => outcome.status === 'unknown') ?? [];
  // 正文里已经就地显示的内联图不再在附件区重复列出
  const listedAttachments = message.attachments.filter((attachment) => !attachment.inline);
  const canMarkUnread = readStateWritable && !outbound;
  const hasMobileMenu = canActAsOwner || canMarkUnread || message.hasRaw || translation.available;

  return (
    <div className="mx-auto max-w-3xl">
      {/* 操作栏吸顶；小屏贴边 */}
      <div className="sticky top-14 z-20 -mx-4 mb-3 flex flex-nowrap items-center gap-1 border-b border-line bg-canvas px-2 py-1.5 sm:mx-0 sm:mb-4 sm:border-b-0 sm:px-0">
        <IconButton aria-label="返回列表" title="返回列表（u / Esc）" onClick={goBack}>
          <ArrowLeft className="size-5" />
        </IconButton>
        {order && position >= 0 && (
          <div className="flex items-center">
            <IconButton aria-label="上一封" title="上一封（k）" disabled={prevId === undefined} onClick={() => goToMessage(prevId)}>
              <ChevronLeft className="size-5" />
            </IconButton>
            <span className="hidden min-w-12 text-center text-xs tabular-nums text-ink-tertiary sm:inline">
              {position + 1} / {order.length}
            </span>
            <IconButton aria-label="下一封" title="下一封（j）" disabled={nextId === undefined} onClick={() => goToMessage(nextId)}>
              <ChevronRight className="size-5" />
            </IconButton>
          </div>
        )}
        {/* 小屏单行：次要操作（回复全部、转发、标未读、下载 .eml）收进「更多」 */}
        <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-1 sm:gap-1.5">
          {canActAsOwner && (
            <>
              <Button variant="secondary" size="sm" title="回复（r）" onClick={reply}>
                <Reply className="size-4" />
                回复
              </Button>
              {multipleRecipients && (
                <Button variant="ghost" size="sm" className="hidden sm:inline-flex" title="全部回复（a）" onClick={replyAll}>
                  <ReplyAll className="size-4" />
                  回复全部
                </Button>
              )}
              <Button variant="ghost" size="sm" className="hidden sm:inline-flex" title="转发（f）" onClick={forward}>
                <Forward className="size-4" />
                转发
              </Button>
            </>
          )}
          {translation.available && (
            <Button
              variant="ghost"
              size="sm"
              className={cn('hidden sm:inline-flex', translation.translated && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent')}
              title={`${translation.translated ? '显示原文' : '翻译成简体中文'}（t）`}
              aria-pressed={translation.translated}
              onClick={translation.toggle}
            >
              <Languages className="size-4" />
              翻译
            </Button>
          )}
          {hasMobileMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton className="sm:hidden" aria-label="更多操作">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {canActAsOwner && multipleRecipients && (
                  <DropdownMenuItem onSelect={replyAll}>
                    <ReplyAll className="size-4" />
                    回复全部
                  </DropdownMenuItem>
                )}
                {canActAsOwner && (
                  <DropdownMenuItem onSelect={forward}>
                    <Forward className="size-4" />
                    转发
                  </DropdownMenuItem>
                )}
                {translation.available && (
                  <DropdownMenuItem onSelect={translation.toggle}>
                    <Languages className="size-4" />
                    {translation.translated ? '显示原文' : '翻译'}
                  </DropdownMenuItem>
                )}
                {canMarkUnread && (
                  <DropdownMenuItem onSelect={handleMarkUnread}>
                    <Mail className="size-4" />
                    标为未读
                  </DropdownMenuItem>
                )}
                {message.hasRaw && (
                  <DropdownMenuItem onSelect={() => void downloadEml()}>
                    <FileDown className="size-4" />
                    下载原始邮件 (.eml)
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <IconButton
            aria-label={message.isStarred ? '取消星标' : '加星标'}
            title={`${message.isStarred ? '取消星标' : '加星标'}（s）`}
            aria-pressed={message.isStarred}
            onClick={toggleStar}
          >
            <Star className={cn('size-4', message.isStarred ? 'fill-caution text-caution' : 'text-ink-tertiary')} />
          </IconButton>
          {canMarkUnread && (
            <IconButton className="hidden sm:inline-grid" aria-label="标为未读" title="标为未读（Shift+U）" onClick={handleMarkUnread}>
              <Mail className="size-4" />
            </IconButton>
          )}
          {message.hasRaw && (
            <IconButton className="hidden sm:inline-grid" aria-label="下载原始邮件 (.eml)" onClick={downloadEml}>
              <FileDown className="size-4" />
            </IconButton>
          )}
          {canActAsOwner && (
            <IconButton aria-label="删除邮件" title="删除邮件（e）" disabled={deleteMutation.isPending} onClick={remove}>
              <Trash2 className="size-4 text-critical" />
            </IconButton>
          )}
        </div>
      </div>

      <article className="-mx-4 overflow-hidden border-y border-line bg-surface sm:mx-0 sm:rounded-lg sm:border-x">
        <header className="border-b border-line px-4 py-4 sm:px-5">
          <h1 className="text-lg font-semibold text-ink">{translation.subject ?? (message.subject || '（无主题）')}</h1>
          {translation.subject && <p className="mt-0.5 text-sm text-ink-tertiary">原文：{message.subject}</p>}
          <div className="mt-2 flex flex-col gap-1 text-sm text-ink-secondary">
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-ink">{message.fromName || message.fromAddress}</span>
              {message.fromName && <span className="break-all text-ink-tertiary">&lt;{message.fromAddress}&gt;</span>}
            </div>
            <RecipientLine label="收件人" addresses={toRecipients} />
            <RecipientLine label="抄送" addresses={ccRecipients} />
            <RecipientLine label="密送" addresses={bccRecipients} />
            <p className="flex flex-wrap items-center gap-2 text-ink-tertiary">
              <span>{formatDateTime(message.createdAt)}</span>
              <span className="text-ink-secondary">{message.address}</span>
              {shared && <Badge tone="neutral" title="共享给你的邮箱：只读，不会改变已读状态">共享 · 只读</Badge>}
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-4 px-4 py-5 sm:px-5">
          {!outbound && <SenderAuthBanner auth={message.auth} fromAddress={message.fromAddress} />}
          {translation.translated && <TranslationBar translation={translation} />}
          {deliveryPending && (
            <p role="status" className="rounded-md border border-line bg-canvas px-3 py-2.5 text-sm text-ink-secondary">投递中，结果尚未回填</p>
          )}
          {sendIssue && (
            <div className={cn('rounded-md border px-3 py-2.5 text-sm', deliveryUnknown ? 'border-caution/40 bg-caution-soft' : 'border-critical/40 bg-critical-soft')}>
              <p className={cn('font-medium', deliveryUnknown ? 'text-caution' : 'text-critical')}>
                {deliveryUnknown ? '投递结果未确认：部分收件人可能已收到，补发前先确认'
                  : message.status === 'failed' ? '发送失败' : '部分收件人失败'}
              </p>
              {message.errorDetail && (
                <p className="mt-1 break-words text-ink-secondary">{message.errorDetail}</p>
              )}
              {unknownRecipients.length > 0 && (
                <ul aria-label="结果未确认的收件人" className="mt-1 list-disc pl-4 text-ink-secondary">
                  {unknownRecipients.map((outcome) => <li key={outcome.address}>{outcome.address}：{outcome.error || '结果未确认'}</li>)}
                </ul>
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
          {!outbound && <VerificationLinkBanner message={message} />}

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
              onContentChange={setHtmlRoot}
            />
          ) : (
            <PlainTextBody text={message.bodyText || '（无正文）'} transformText={translation.transformText} />
          )}

          {listedAttachments.length > 0 && (
            <div className="border-t border-line pt-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
                <Paperclip className="size-4" />
                {listedAttachments.length} 个附件
              </p>
              <ul className="flex flex-col gap-2">
                {listedAttachments.map((attachment) => {
                  const Icon = attachmentIcon(attachment.mimeType, attachment.filename);
                  return (
                    <li key={attachment.id}>
                      <button
                        type="button"
                        title={attachment.filename}
                        aria-busy={downloadingId === attachment.id}
                        disabled={downloadingId !== null}
                        onClick={() => void openAttachment(attachment)}
                        className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover disabled:cursor-wait"
                      >
                        <Icon className="size-5 shrink-0 text-ink-tertiary" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-ink">{attachment.filename}</span>
                        <span className="shrink-0 text-xs text-ink-tertiary">{formatBytes(attachment.size)}</span>
                        {downloadingId === attachment.id
                          ? <Spinner className="size-4 shrink-0 text-ink-tertiary" />
                          : <Download className="size-4 shrink-0 text-ink-tertiary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </article>

      {thread.length > 1 && (
        <section className="-mx-4 mt-4 overflow-hidden border-y border-line bg-surface sm:mx-0 sm:rounded-lg sm:border-x">
          <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
            会话（{thread.length} 封）
          </h2>
          <ul className="flex flex-col p-1.5">
            {thread.map((item) => (
              <li key={item.id}>
                <Link
                  to={mailHref(item.id, view ?? {})}
                  state={location.state}
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
    </div>
  );
}
