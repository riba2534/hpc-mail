import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Inbox,
  LogOut,
  Plus,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { HostedDomain, HostedDomainStatus, HostedDomainStepState } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { usePublicConfig } from '@/lib/use-config';
import { useDocumentTitle } from '@/lib/use-document-title';
import { useCurrentUser } from '@/lib/use-session';
import { DeleteHostedDomainDialog } from './delete-hosted-domain-dialog';
import {
  HOSTED_DOMAIN_STATUS_META,
  HOSTED_DOMAIN_STEPS,
  HostedDomainRoleBadge,
  HostedDomainStatusBadge,
  NsPropagationNotice,
} from './hosted-domain-meta';
import { HostedDomainMembersSection } from './hosted-domain-members';
import { HostedDnsSection } from './hosted-dns-section';
import { hostedDomainApi } from './hosted-domains-api';
import { ReconnectHostedDomainSection } from './reconnect-hosted-domain-section';
import { TransferHostedDomainDialog } from './transfer-hosted-domain-dialog';
import { forgetHostedDomain, storeHostedDomain, useHostedDomainQuery } from './use-hosted-domains';

/** NS 已生效、可以认领地址收信的状态（与 HOSTED_DOMAIN_USABLE_STATUSES 一致） */
const USABLE_STATUSES: readonly HostedDomainStatus[] = ['provisioning', 'active', 'error'];

const STEP_STATES: Record<HostedDomainStepState, { label: string; icon: LucideIcon; className: string }> = {
  waiting: { label: '等待中', icon: CircleDashed, className: 'text-ink-tertiary' },
  ready: { label: '已生效', icon: CircleCheck, className: 'text-positive' },
  error: { label: '异常', icon: CircleAlert, className: 'text-critical' },
};

const isGone = (error: unknown) => error instanceof ApiError && (error.notFound || error.httpStatus === 403);

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** 指引步骤：圆形序号 + 标题 + 内容 */
function GuideStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
        {n}
      </span>
      <div className="flex flex-1 flex-col gap-1 pt-0.5">
        <p className="text-sm font-medium text-ink">{title}</p>
        <div className="text-[13px] leading-relaxed text-ink-secondary">{children}</div>
      </div>
    </li>
  );
}

function SummarySection({ domain }: { domain: HostedDomain }) {
  const usable = USABLE_STATUSES.includes(domain.status);
  const meta = HOSTED_DOMAIN_STATUS_META[domain.status];
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <HostedDomainStatusBadge status={domain.status} />
        <HostedDomainRoleBadge role={domain.role} />
      </div>
      <p className="mt-2 text-sm text-ink">
        {(domain.role === 'member' && meta.memberDescription) || meta.description}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-tertiary">所有者</dt>
          <dd className="truncate text-ink">
            {domain.ownerUsername}
            {domain.role === 'owner' ? '（我）' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-tertiary">已认领地址</dt>
          <dd className="text-ink">{domain.mailboxCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-tertiary">成员</dt>
          <dd className="text-ink">{domain.memberCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-tertiary">添加时间</dt>
          <dd className="text-ink">{formatDateTime(domain.createdAt)}</dd>
        </div>
        {domain.activatedAt && (
          <div>
            <dt className="text-xs text-ink-tertiary">生效时间</dt>
            <dd className="text-ink">{formatDateTime(domain.activatedAt)}</dd>
          </div>
        )}
      </dl>
      {usable && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link to={`/mailboxes?claim=1&domain=${encodeURIComponent(domain.domain)}`}>
              <Plus className="size-4" />
              认领地址
            </Link>
          </Button>
          <Button asChild size="sm" variant="secondary">
            <Link to={`/inbox?domain=${encodeURIComponent(domain.domain)}`}>
              <Inbox className="size-4" />
              查看来信
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}

function ProgressSection({ domain, canManage }: { domain: HostedDomain; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data: config } = usePublicConfig();
  const check = useMutation({
    // 变量带上检测前的时间：服务端 15 秒内不重复检测，时间没变说明这次被跳过
    mutationFn: (_previousCheckedAt: string | null) => hostedDomainApi.check(domain.id),
    onSuccess: (updated, previousCheckedAt) => {
      storeHostedDomain(queryClient, updated);
      if (updated.checkedAt === previousCheckedAt) {
        toast({ title: '刚检测过，请稍后再试' });
        return;
      }
      toast({
        title: updated.status === 'active' ? '收发均已生效' : '检测完成',
        description: updated.status === 'active' ? undefined : `当前状态：${HOSTED_DOMAIN_STATUS_META[updated.status].label}`,
        variant: 'success',
      });
    },
    onError: (error) => toast({ title: error instanceof ApiError ? error.message : '检测失败，请稍后重试', variant: 'error' }),
  });
  // 暂停与删除中不做检测；站点关闭托管后服务端也会拒绝手动检测
  const checkable = canManage && domain.status !== 'suspended' && domain.status !== 'deleting';
  const siteDisabled = config?.hostedDomainsEnabled === false;
  const polling = domain.status === 'pending' || domain.status === 'provisioning';

  return (
    <Section
      title="生效进度"
      actions={
        checkable && (
          <Button
            size="sm"
            variant="secondary"
            loading={check.isPending}
            disabled={siteDisabled}
            onClick={() => check.mutate(domain.checkedAt)}
          >
            {!check.isPending && <RefreshCw className="size-4" />}
            立即检测
          </Button>
        )
      }
    >
      <ol aria-label="开通环节" className="flex flex-col divide-y divide-line rounded-md border border-line">
        {HOSTED_DOMAIN_STEPS.map((step) => {
          const state = STEP_STATES[domain.steps[step.key]];
          const Icon = state.icon;
          return (
            <li key={step.key} className="flex items-center gap-3 px-3 py-2.5">
              <Icon aria-hidden className={cn('size-5 shrink-0', state.className)} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{step.label}</p>
                <p className="text-xs text-ink-tertiary">{step.description}</p>
              </div>
              <span className={cn('shrink-0 text-[13px] font-medium', state.className)}>{state.label}</span>
            </li>
          );
        })}
      </ol>
      {domain.lastError && (
        <p role="alert" className="break-words rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-critical">
          最近一次错误：{domain.lastError}
        </p>
      )}
      <div className="flex flex-col gap-1 text-xs text-ink-tertiary">
        <p title={domain.checkedAt ? formatDateTime(domain.checkedAt) : undefined}>
          上次检测：{domain.checkedAt ? formatRelativeTime(domain.checkedAt) : '尚未检测'}
          {polling && '，等待生效期间本页每 30 秒自动刷新'}
        </p>
        {checkable && siteDisabled && <p>本站已关闭域名托管，暂不能手动检测，系统仍会定时核对。</p>}
        {domain.status === 'pending' && domain.expiresAt && (
          <p className="text-caution">
            请在 {formatDateTime(domain.expiresAt)} 前完成名称服务器修改，
            {domain.activatedAt ? '逾期仍未生效会撤回这次重新接入（地址与历史邮件保留，可再次重新接入）。' : '逾期仍未生效会自动删除。'}
          </p>
        )}
      </div>
      {domain.status === 'pending' && <NsPropagationNotice />}
    </Section>
  );
}

function NameServerSection({ domain }: { domain: HostedDomain }) {
  const highlight = domain.status === 'pending' || domain.status === 'moved';
  // 需要用户动手（含有待处理提醒）时默认展开，其余状态折叠备查；手动切换后以手动为准
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (highlight || domain.warnings.length > 0);
  const summary =
    domain.status === 'pending'
      ? '域名还没有生效：按下面的步骤到注册商修改名称服务器。'
      : domain.status === 'moved'
        ? '名称服务器已不再指向本站，收发已停止：如需继续使用，请按下面的信息改回。'
        : '以下是本站分配的名称服务器，供核对。';

  return (
    <section className={cn('rounded-lg border bg-surface', highlight ? 'border-accent' : 'border-line')}>
      <h2 className="text-sm font-semibold text-ink">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="hosted-domain-ns-guide"
          onClick={() => setToggled(!open)}
          className="flex w-full items-start justify-between gap-3 rounded-lg px-5 py-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span className="flex flex-col gap-0.5">
            <span>修改名称服务器</span>
            <span className="text-[13px] font-normal text-ink-secondary">{summary}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn('mt-0.5 size-4 shrink-0 text-ink-tertiary transition-transform', open && 'rotate-180')}
          />
        </button>
      </h2>
      {open && (
        <div id="hosted-domain-ns-guide" className="flex flex-col gap-5 border-t border-line px-5 pb-5 pt-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-secondary">
              把 <b className="text-ink">{domain.domain}</b> 的名称服务器改为下面两条：
            </p>
            <ul aria-label="本站分配的名称服务器" className="flex flex-col gap-2">
              {domain.nameServers.map((ns) => (
                <li key={ns} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-ink">
                    {ns}
                  </code>
                  <CopyButton value={ns} ariaLabel={`复制 ${ns}`} size="sm" className="shrink-0" />
                </li>
              ))}
            </ul>
            {(domain.originalNameServers.length > 0 || domain.originalRegistrar) && (
              <dl className="mt-1 flex flex-col gap-1 text-xs text-ink-tertiary">
                {domain.originalRegistrar && (
                  <div className="flex gap-1">
                    <dt className="shrink-0">注册商：</dt>
                    <dd className="text-ink-secondary">{domain.originalRegistrar}</dd>
                  </div>
                )}
                {domain.originalNameServers.length > 0 && (
                  <div className="flex gap-1">
                    <dt className="shrink-0">原名称服务器：</dt>
                    <dd className="break-all font-mono text-ink-secondary">{domain.originalNameServers.join('、')}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
          {domain.warnings.length > 0 && (
            <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft/40 p-3 text-sm">
              <p className="flex items-center gap-1.5 font-medium text-caution">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                需要你处理
              </p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink">
                {domain.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[13px] text-ink-secondary">
            修改名称服务器前，先在下方「DNS 解析」补上网站等原有记录，网站等记录切换时不中断（根域邮件由本站接管）。
          </p>
          <ol className="flex flex-col gap-4">
            <GuideStep n={1} title="登录域名注册商">
              登录购买该域名的服务商控制台{domain.originalRegistrar ? `（${domain.originalRegistrar}）` : ''}，进入域名管理。
            </GuideStep>
            <GuideStep n={2} title="找到名称服务器设置">
              在该域名的设置里找到「DNS 服务器」「名称服务器」或「Nameservers」。如果开启了 DNSSEC，请先关闭。
            </GuideStep>
            <GuideStep n={3} title="改为自定义，只填这两条">
              选择「自定义名称服务器」，删除原有的全部条目，只填写上面两条。
            </GuideStep>
            <GuideStep n={4} title="保存并等待生效">
              保存后需要等注册局发布新的名称服务器并由 Cloudflare 确认。生效后本页会自动更新，也可以点「立即检测」。
            </GuideStep>
          </ol>
          {domain.status === 'moved' && <NsPropagationNotice />}
        </div>
      )}
    </section>
  );
}

function ManageSection({ domain }: { domain: HostedDomain }) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <Section title="过户与删除">
      <div className="flex flex-col divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">过户域名</p>
            <p className="text-[13px] text-ink-secondary">把域名及其管理权限交给其他用户，可连同地址和历史邮件一起过户。</p>
          </div>
          <Button variant="secondary" onClick={() => setTransferOpen(true)}>
            过户
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">删除托管</p>
            <p className="text-[13px] text-ink-secondary">释放该域名下全部地址并永久删除其邮件，不可恢复。</p>
          </div>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            删除托管
          </Button>
        </div>
      </div>
      <TransferHostedDomainDialog domain={domain} open={transferOpen} onOpenChange={setTransferOpen} />
      <DeleteHostedDomainDialog domain={domain} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </Section>
  );
}

/** 成员退出共享：只移除自己，已认领的地址仍归自己 */
function LeaveButton({ domain }: { domain: HostedDomain }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const [open, setOpen] = useState(false);
  const leave = useMutation({
    mutationFn: () => hostedDomainApi.removeMember(domain.id, currentUser.id),
    onSuccess: () => {
      toast({ title: `已退出 ${domain.domain} 的共享`, variant: 'success' });
      setOpen(false);
      navigate('/domains', { replace: true });
      forgetHostedDomain(queryClient, domain.id);
    },
    onError: (error) => toast({ title: error instanceof ApiError ? error.message : '退出失败，请重试', variant: 'error' }),
  });
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <LogOut className="size-4" />
        退出共享
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !leave.isPending && setOpen(next)}
        title={`退出 ${domain.domain} 的共享？`}
        description="退出后不能再在该域名下认领新地址；你已认领的地址及其邮件仍归你所有。重新加入需要所有者再次共享。"
        confirmLabel="退出共享"
        tone="danger"
        loading={leave.isPending}
        onConfirm={() => leave.mutate()}
      />
    </>
  );
}

function BackButton({ admin }: { admin: boolean }) {
  return (
    <Button asChild variant="secondary" size="sm">
      <Link to={admin ? '/admin/hosted-domains' : '/domains'}>
        <ArrowLeft className="size-4" />
        {admin ? '返回托管域名' : '返回我的域名'}
      </Link>
    </Button>
  );
}

export function HostedDomainDetailPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const validId = Number.isInteger(id) && id > 0;
  const queryClient = useQueryClient();
  // 从列表进来时先用列表里的这一行渲染，详情返回后替换
  const { data: domain, isLoading, isError, error, refetch } = useHostedDomainQuery(id, validId, () =>
    queryClient.getQueryData<HostedDomain[]>(queryKeys.hostedDomains.list)?.find((item) => item.id === id),
  );
  useDocumentTitle(domain?.domain);

  if (!validId || (isError && isGone(error)) || (!isLoading && !isError && !domain)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="域名不存在" actions={<BackButton admin={false} />} />
        <EmptyState
          title="没有找到这个域名"
          description="它可能已被删除或过户，或者你已不在共享名单中。"
          className="rounded-lg border border-line bg-surface"
        />
      </div>
    );
  }

  if (isLoading || !domain) {
    return (
      <div className="mx-auto max-w-3xl">
        {isError ? (
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        ) : (
          <Skeleton className="h-48 w-full rounded-lg" />
        )}
      </div>
    );
  }

  const canManage = domain.role === 'owner' || domain.role === 'admin';
  const active = domain.status !== 'deleting';

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageHeader
        title={<span className="break-all">{domain.domain}</span>}
        actions={
          <>
            {domain.role === 'member' && <LeaveButton domain={domain} />}
            <BackButton admin={domain.role === 'admin'} />
          </>
        }
      />
      <SummarySection domain={domain} />

      <ProgressSection domain={domain} canManage={canManage} />
      {canManage && domain.status === 'moved' && <ReconnectHostedDomainSection domain={domain} />}
      {canManage && active && <NameServerSection domain={domain} />}
      {canManage && active && <HostedDnsSection domain={domain} />}
      {canManage && active && <HostedDomainMembersSection domain={domain} />}
      {canManage && active && <ManageSection domain={domain} />}
    </div>
  );
}
