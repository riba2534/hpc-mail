import { useInfiniteQuery } from '@tanstack/react-query';
import type { Draft, DraftStatus, DraftSummary, MailAddress, Mailbox } from '@hpc-mail/shared';
import { Clock, FilePen, MoreHorizontal, PenLine, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import type { ComposeInitial } from '@/features/compose/compose-init';
import { DraftReviewDialog } from './draft-review-dialog';
import { DRAFT_STATUS_META, draftFromLabel, draftSourceLabel, draftStatusLabel, recipientsSummary } from './draft-format';
import { draftKeys, draftsApi } from './drafts-api';
import { useDraftActions } from './use-draft-actions';

type Filter = DraftStatus | 'all';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'scheduled', label: '定时' },
  { value: 'failed', label: '失败' },
  { value: 'sent', label: '已发送' },
];

/** 地址栏的 ?status=：只认列出的筛选，其余回到全部 */
function parseFilter(value: string | null): Filter {
  return FILTERS.find((option) => option.value === value)?.value ?? 'all';
}

const EDITABLE = new Set<DraftStatus>(['draft', 'scheduled', 'failed']);
/** 有定时或发送中的草稿时定期刷新：到点后服务器发出，状态会变 */
const PENDING_REFRESH_MS = 30_000;

const addressList = (items: MailAddress[]) => items.map((item) => (item.name ? `${item.name} <${item.address}>` : item.address)).join('、');

/** 发送确认（人审的最后一步）：写明从哪个地址发给谁，定时的说明会立即发出 */
function SendConfirmation({ draft, mailboxes }: { draft: DraftSummary | Draft; mailboxes: Mailbox[] | undefined }) {
  const from = draftFromLabel(draft.from, mailboxes);
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1">
        {([
          ['发件地址', from ?? '未设置'],
          ['收件人', addressList(draft.to) || '（未填写）'],
          ['抄送', addressList(draft.cc)],
          ['密送', addressList(draft.bcc)],
          ['主题', draft.subject || '（无主题）'],
          ['附件', draft.attachmentCount ? `${draft.attachmentCount} 个` : ''],
        ] as const).filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="w-16 shrink-0 text-ink-tertiary">{label}</dt>
            <dd className="min-w-0 flex-1 break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {draft.status === 'scheduled' && draft.sendAt && <p>原定 {formatDateTime(draft.sendAt)} 定时发送，确认后立即发出。</p>}
      {draft.createdVia === 'api' && (
        <p>这份草稿由 {draftSourceLabel(draft)} 创建，请确认收件人与内容无误再发送；发送后无法撤回。</p>
      )}
    </div>
  );
}

function DeleteDescription({ draft }: { draft: DraftSummary }) {
  if (draft.status === 'sent') return <>只删除草稿，已发出的邮件仍在「已发送」里。</>;
  if (draft.status === 'scheduled') return <>定时发送随之取消，草稿里的附件一并删除，无法恢复。</>;
  return <>草稿与其中的附件将被删除，无法恢复。</>;
}

export function DraftsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const statusFilter = parseFilter(params.get('status'));
  const { data: mailboxes } = useMailboxesQuery(false);
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: draftKeys.list(statusFilter),
    queryFn: ({ pageParam, signal }) =>
      draftsApi.list({ status: statusFilter === 'all' ? undefined : statusFilter, cursor: pageParam || undefined }, signal),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some((item) => item.status === 'scheduled' || item.status === 'sending'))
        ? PENDING_REFRESH_MS
        : false,
  });
  const drafts = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const { send, cancelSchedule, remove } = useDraftActions(mailboxes);
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [sendTarget, setSendTarget] = useState<DraftSummary | Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DraftSummary | null>(null);
  const busy = send.isPending || cancelSchedule.isPending || remove.isPending;

  const setFilter = (value: Filter) => {
    const next = new URLSearchParams(params);
    if (value === 'all') next.delete('status');
    else next.set('status', value);
    setParams(next, { replace: true });
  };
  const edit = (draft: DraftSummary) => navigate('/compose', { state: { serverDraftId: draft.id } satisfies ComposeInitial });
  const confirmSend = () => {
    if (!sendTarget) return;
    send.mutate(sendTarget, {
      onSuccess: () => {
        setSendTarget(null);
        setReviewId(null);
      },
      // 审阅详情保持打开：版本冲突时它已换成最新内容，用户重新看过再发
      onError: () => setSendTarget(null),
    });
  };
  const confirmDelete = () => {
    if (!deleteTarget) return;
    remove.mutate(deleteTarget, {
      onSettled: () => {
        setDeleteTarget(null);
        setReviewId((current) => (current === deleteTarget.id ? null : current));
      },
    });
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="草稿箱"
        description="保存在服务器上的草稿与定时发送。Agent 用 API Key 创建的草稿也在这里，审阅确认后再发出。"
      />
      <div className="mb-4 overflow-x-auto">
        <SegmentedControl aria-label="按状态筛选" value={statusFilter} onValueChange={setFilter} options={FILTERS} />
      </div>

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : isError ? (
        <QueryErrorState error={error} onRetry={() => void refetch()} />
      ) : drafts.length === 0 ? (
        <EmptyState
          icon={FilePen}
          title={statusFilter === 'all' ? '草稿箱是空的' : `没有「${FILTERS.find((item) => item.value === statusFilter)?.label}」状态的草稿`}
          description="在写信页点「存到草稿箱」或「定时发送」，或让 Agent 用 API Key 创建草稿（POST /v1/drafts），草稿会出现在这里等你确认。"
          className="rounded-lg border border-line bg-surface"
        />
      ) : (
        <>
          <CardList>
            {drafts.map((draft) => {
              const meta = DRAFT_STATUS_META[draft.status];
              const editable = EDITABLE.has(draft.status);
              return (
                <CardListItem
                  key={draft.id}
                  title={
                    <button
                      type="button"
                      className="min-w-0 truncate text-left hover:underline"
                      onClick={() => setReviewId(draft.id)}
                    >
                      {draft.subject || '（无主题）'}
                    </button>
                  }
                  subtitle={`发给 ${recipientsSummary(draft)}`}
                  meta={
                    <>
                      <Badge tone={meta.tone}>{draftStatusLabel(draft)}</Badge>
                      <Badge tone={draft.createdVia === 'api' ? 'accent' : 'neutral'}>{draftSourceLabel(draft)}</Badge>
                      <span className="max-w-full truncate">从 {draftFromLabel(draft.from, mailboxes) ?? '（未设置发件地址）'}</span>
                      {draft.attachmentCount > 0 && <span>{draft.attachmentCount} 个附件</span>}
                      <span title={formatDateTime(draft.updatedAt)}>更新于 {formatRelativeTime(draft.updatedAt)}</span>
                      {draft.messageId !== null && (
                        <Link to={`/mail/${draft.messageId}`} className="text-accent hover:underline">
                          {draft.status === 'failed' ? '查看失败记录' : '查看发件记录'}
                        </Link>
                      )}
                      {draft.errorDetail && (
                        <span className={draft.status === 'failed' ? 'basis-full text-critical' : 'basis-full text-caution'}>
                          {draft.status === 'failed' ? '失败原因' : '上次发送'}：{draft.errorDetail}
                        </span>
                      )}
                    </>
                  }
                  actions={
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setReviewId(draft.id)}>
                        审阅
                      </Button>
                      {draft.status !== 'sending' && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton size="sm" aria-label="更多操作">
                              <MoreHorizontal className="size-4" />
                            </IconButton>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {editable && (
                              <>
                                <DropdownMenuItem disabled={busy} onSelect={() => setSendTarget(draft)}>
                                  <Send className="size-4 text-ink-tertiary" />
                                  发送…
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => edit(draft)}>
                                  <PenLine className="size-4 text-ink-tertiary" />
                                  编辑
                                </DropdownMenuItem>
                              </>
                            )}
                            {draft.status === 'scheduled' && (
                              <DropdownMenuItem disabled={busy} onSelect={() => cancelSchedule.mutate(draft)}>
                                <Clock className="size-4 text-ink-tertiary" />
                                取消定时
                              </DropdownMenuItem>
                            )}
                            {editable && <DropdownMenuSeparator />}
                            <DropdownMenuItem tone="danger" onSelect={() => setDeleteTarget(draft)}>
                              <Trash2 className="size-4" />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </>
                  }
                />
              );
            })}
          </CardList>
          {hasNextPage && (
            <div className="mt-3 text-center">
              <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
                加载更多
              </Button>
            </div>
          )}
        </>
      )}

      <DraftReviewDialog
        draftId={reviewId}
        mailboxes={mailboxes}
        busy={busy}
        onClose={() => setReviewId(null)}
        onSend={setSendTarget}
        onEdit={edit}
        onCancelSchedule={(draft) => cancelSchedule.mutate(draft)}
        onDelete={setDeleteTarget}
      />
      <ConfirmDialog
        open={sendTarget !== null}
        onOpenChange={(open) => !open && !send.isPending && setSendTarget(null)}
        title="确认发送这封邮件？"
        description={sendTarget && <SendConfirmation draft={sendTarget} mailboxes={mailboxes} />}
        confirmLabel="发送"
        loading={send.isPending}
        onConfirm={confirmSend}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && !remove.isPending && setDeleteTarget(null)}
        title="删除这份草稿？"
        description={deleteTarget && <DeleteDescription draft={deleteTarget} />}
        confirmLabel="删除"
        tone="danger"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
