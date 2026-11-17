import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { type HostedDnsRecord, type HostedDomain, MAX_HOSTED_DNS_RECORDS } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useIsMobile } from '@/lib/use-media-query';
import { useCurrentUser } from '@/lib/use-session';
import { dnsRecordPriority, formatDnsTtl } from './hosted-dns-meta';
import { HostedDnsRecordDialog } from './hosted-dns-record-dialog';
import { hostedDomainApi } from './hosted-domains-api';
import { refreshAfterDnsWriteError, removeDnsRecord, useHostedDnsRecordsQuery } from './use-hosted-domains';

interface RecordActions {
  onEdit: (record: HostedDnsRecord) => void;
  onDelete: (record: HostedDnsRecord) => void;
}

const recordLabel = (record: HostedDnsRecord) => `${record.type} 记录 ${record.name}`;

/** 小屏卡片里的记录值：默认最多 3 行，被截断时点按内容展开/收起全文 */
function ExpandableContent({ text }: { text: string }) {
  // 回调 ref：截断前后元素会在 span 与 button 之间切换，需要对新元素重新测量
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    if (!node || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, text, expanded]);

  const body = (
    <span ref={setNode} className={cn('block whitespace-normal break-all', !expanded && 'line-clamp-3')}>
      {text}
    </span>
  );
  if (!clamped && !expanded) return body;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded(!expanded)}
      className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
    >
      {body}
      <span className="text-xs text-accent">{expanded ? '收起' : '展开全文'}</span>
    </button>
  );
}

function LockedReason({ record }: { record: HostedDnsRecord }) {
  if (!record.lockedReason) return null;
  return (
    <span className="flex min-w-0 items-start gap-1 text-xs text-ink-tertiary">
      <Lock aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span>{record.lockedReason}</span>
    </span>
  );
}

/** 只有 user 记录可以编辑删除；mail 与 readonly 记录一律只读 */
function RowActions({ record, actions }: { record: HostedDnsRecord; actions?: RecordActions }) {
  if (!actions || record.kind !== 'user') return null;
  return (
    <>
      <IconButton size="sm" aria-label={`编辑 ${recordLabel(record)}`} onClick={() => actions.onEdit(record)}>
        <Pencil className="size-4" />
      </IconButton>
      <IconButton size="sm" aria-label={`删除 ${recordLabel(record)}`} onClick={() => actions.onDelete(record)}>
        <Trash2 className="size-4 text-critical" />
      </IconButton>
    </>
  );
}

function RecordList({
  records,
  label,
  actions,
  mobile,
}: {
  records: HostedDnsRecord[];
  label: string;
  actions?: RecordActions;
  mobile: boolean;
}) {
  if (mobile) {
    return (
      <CardList aria-label={label}>
        {records.map((record) => {
          const priority = dnsRecordPriority(record);
          return (
            <CardListItem
              key={record.id}
              title={
                <span className="flex min-w-0 items-start gap-2">
                  <Badge tone={record.kind === 'user' ? 'accent' : 'neutral'} className="mt-0.5 shrink-0">
                    {record.type}
                  </Badge>
                  {/* 手机上没有悬停提示：名称折行完整显示 */}
                  <span title={record.fqdn} className="min-w-0 break-all">
                    {record.name}
                  </span>
                </span>
              }
              subtitle={<ExpandableContent text={record.content} />}
              meta={
                <>
                  <span>TTL {formatDnsTtl(record.ttl)}</span>
                  {priority !== null && <span>优先级 {priority}</span>}
                  {record.comment && <span className="break-all">{record.comment}</span>}
                  <LockedReason record={record} />
                </>
              }
              actions={<RowActions record={record} actions={actions} />}
            />
          );
        })}
      </CardList>
    );
  }

  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="px-3">类型</TableHead>
          <TableHead className="px-3">名称</TableHead>
          <TableHead className="px-3">内容</TableHead>
          <TableHead className="px-3">TTL</TableHead>
          <TableHead className="px-3">备注</TableHead>
          {actions && (
            <TableHead className="px-3">
              <span className="sr-only">操作</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => {
          const priority = dnsRecordPriority(record);
          return (
            <TableRow key={record.id}>
              <TableCell className="px-3 py-2.5">
                <Badge tone={record.kind === 'user' ? 'accent' : 'neutral'}>{record.type}</Badge>
              </TableCell>
              <TableCell className="px-3 py-2.5">
                <span title={record.fqdn} className="block max-w-[9rem] truncate font-medium">
                  {record.name}
                </span>
              </TableCell>
              {/* 宽度为 0 + w-full：内容列吃掉剩余宽度，超长时截断而不撑破表格 */}
              <TableCell className="w-full max-w-0 px-3 py-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span title={record.content} className="truncate">
                    {record.content}
                  </span>
                  {priority !== null && <span className="text-xs text-ink-tertiary">优先级 {priority}</span>}
                  <LockedReason record={record} />
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2.5 text-ink-secondary">{formatDnsTtl(record.ttl)}</TableCell>
              <TableCell className="px-3 py-2.5">
                <span title={record.comment || undefined} className="block max-w-[7rem] truncate text-ink-secondary">
                  {record.comment}
                </span>
              </TableCell>
              {actions && (
                <TableCell className="px-2 py-2.5">
                  <div className="flex justify-end gap-1">
                    <RowActions record={record} actions={actions} />
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** 邮箱收发占用的记录：默认折叠，展开后只读 */
function MailRecordsGroup({ records, mobile }: { records: HostedDnsRecord[]; mobile: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="hosted-dns-mail-records"
        onClick={() => setOpen(!open)}
        className="-mx-2 flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[13px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Lock aria-hidden className="size-3.5 shrink-0" />
        邮箱记录（{records.length} 条，由系统维护）
        <ChevronDown aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id="hosted-dns-mail-records">
          <RecordList records={records} label="邮箱记录" mobile={mobile} />
        </div>
      )}
    </div>
  );
}

function EmptyHints({ readOnly }: { readOnly: boolean }) {
  if (readOnly) return <p className="text-sm text-ink-tertiary">还没有添加解析记录。</p>;
  return (
    <div className="rounded-md border border-dashed border-line-strong p-4 text-[13px] text-ink-secondary">
      <p className="font-medium text-ink">还没有添加解析记录，常见用法：</p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
        <li>搭建网站：根域 @ 添加 A 记录指向服务器 IP，www 添加 CNAME 指向建站平台给出的域名。</li>
        <li>验证域名所有权：按服务商要求添加 TXT 记录，例如搜索引擎站长平台、证书签发。</li>
        <li>接入其他服务：给子域名添加 CNAME，例如 blog 指向博客平台给出的地址。</li>
      </ul>
    </div>
  );
}

/** 所有者与管理员维护域名的常用解析；邮箱占用的记录只读 */
export function HostedDnsSection({ domain }: { domain: HostedDomain }) {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const mobile = useIsMobile();
  const records = useHostedDnsRecordsQuery(domain.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<HostedDnsRecord | null>(null);
  const [deleting, setDeleting] = useState<HostedDnsRecord | null>(null);

  // 暂停的域名：所有者只读，管理员仍可修改；与服务端一致按当前用户角色判断（管理员自己的域名 role 为 owner）
  const readOnly = domain.status === 'suspended' && currentUser.role !== 'admin';
  const list = records.data ?? [];
  const mailRecords = list.filter((record) => record.kind === 'mail');
  const otherRecords = list.filter((record) => record.kind !== 'mail');
  const full = otherRecords.length >= MAX_HOSTED_DNS_RECORDS;

  const remove = useMutation({
    mutationFn: (record: HostedDnsRecord) => hostedDomainApi.deleteDnsRecord(domain.id, record.id),
    onSuccess: (_result, record) => {
      removeDnsRecord(queryClient, domain.id, record.id);
      toast({ title: `已删除 ${recordLabel(record)}`, variant: 'success' });
      setDeleting(null);
    },
    onError: (error) => {
      toast({ title: error instanceof ApiError ? error.message : '删除失败，请重试', variant: 'error' });
      refreshAfterDnsWriteError(queryClient, domain.id, error);
      // 记录已不存在或已无权修改：重试没有意义，关闭确认框
      if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'forbidden')) setDeleting(null);
    },
  });

  const actions: RecordActions | undefined = readOnly
    ? undefined
    : {
        onEdit: (record) => {
          setEditing(record);
          setDialogOpen(true);
        },
        onDelete: setDeleting,
      };

  return (
    <section aria-labelledby="hosted-domain-dns" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="hosted-domain-dns" className="text-sm font-semibold text-ink">
            DNS 解析
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            为该域名添加网站、域名验证等常用解析记录。邮箱所需的记录由系统维护，不能修改。
          </p>
        </div>
        {!readOnly && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!records.data || full}
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" />
            添加记录
          </Button>
        )}
      </div>

      {domain.status === 'pending' && (
        <div className="flex flex-col gap-1 rounded-md border border-accent/30 bg-accent-soft p-3 text-[13px] text-ink">
          <p>
            名称服务器生效前就可以添加解析：建议先把网站等原有记录补到这里，再修改名称服务器，网站等记录切换时不中断（根域邮件由本站接管）。
          </p>
          <p>
            请在{domain.expiresAt ? ` ${formatDateTime(domain.expiresAt)} ` : '截止时间'}前完成名称服务器修改，
            {domain.activatedAt ? '逾期未生效时会撤回这次重新接入，已添加的解析一并删除。' : '逾期未生效时域名会连同已添加的解析一起删除。'}
          </p>
        </div>
      )}
      {domain.status === 'suspended' &&
        (readOnly ? (
          <p className="rounded-md border border-caution/40 bg-caution-soft/40 p-3 text-[13px] text-caution">
            域名已被管理员暂停，解析只读。
          </p>
        ) : (
          <p className="text-xs text-ink-tertiary">域名已暂停：所有者只能查看解析，管理员仍可修改。</p>
        ))}

      {/* 已有数据时后台刷新失败（如限流）只给轻提示，继续显示上次的列表 */}
      {records.data ? (
        <>
          {records.isError && (
            <p role="alert" className="flex flex-wrap items-center gap-x-2 text-xs text-caution">
              <span>刷新失败：{records.error instanceof Error ? records.error.message : '网络异常'}，下面是上次加载的结果。</span>
              <button
                type="button"
                disabled={records.isFetching}
                onClick={() => void records.refetch()}
                className="rounded-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
              >
                重试
              </button>
            </p>
          )}
          {otherRecords.length > 0 && (
            <RecordList records={otherRecords} label="解析记录" actions={actions} mobile={mobile} />
          )}
          {!otherRecords.some((record) => record.kind === 'user') && <EmptyHints readOnly={readOnly} />}
          <p className="text-xs text-ink-tertiary">
            已添加 {otherRecords.length} / {MAX_HOSTED_DNS_RECORDS} 条
            {full && '，已达上限，删除不用的记录后才能继续添加'}
          </p>
          {mailRecords.length > 0 && <MailRecordsGroup records={mailRecords} mobile={mobile} />}
        </>
      ) : records.isError ? (
        <QueryErrorState error={records.error} onRetry={() => void records.refetch()} />
      ) : (
        <Skeleton className="h-24 w-full rounded-md" />
      )}

      {!readOnly && (
        <HostedDnsRecordDialog domain={domain} record={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && !remove.isPending && setDeleting(null)}
        title={deleting ? `删除 ${recordLabel(deleting)}？` : '删除解析记录？'}
        description={
          deleting
            ? `${deleting.fqdn} → ${deleting.content}。删除后立即生效，依赖这条记录的网站或服务可能受影响。`
            : undefined
        }
        confirmLabel="删除"
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </section>
  );
}
