import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  ExternalLink,
  Globe,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { type DomainEntry, type DomainOnboardingStatus, domainSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';

const WORKER_NAME = 'hpc-cloud-mail';
const CLOUDFLARE_DASH = 'https://dash.cloudflare.com';

/** 引导步骤：圆形序号 + 标题 + 内容 */
function GuideStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
        {n}
      </span>
      <div className="flex flex-1 flex-col gap-2 pt-0.5">
        <p className="text-sm font-medium text-ink">{title}</p>
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-secondary">{children}</div>
      </div>
    </li>
  );
}

/** 单个域名的接入自检徽标 */
function StatusBadge({
  isFetching,
  status,
}: {
  isFetching: boolean;
  status: DomainOnboardingStatus | undefined;
}) {
  if (isFetching) {
    return (
      <Badge tone="neutral">
        <Spinner className="size-3" />
        检测中
      </Badge>
    );
  }
  if (!status) return <Badge tone="neutral">未检测</Badge>;
  if (!status.resolved) {
    return (
      <Badge tone="critical">
        <AlertTriangle className="size-3" />
        检测失败
      </Badge>
    );
  }
  if (status.mxReady) {
    return (
      <Badge tone="positive">
        <CheckCircle2 className="size-3" />
        已接入
      </Badge>
    );
  }
  return (
    <Badge tone="caution">
      <AlertTriangle className="size-3" />
      MX 未生效
    </Badge>
  );
}

interface DomainRowProps {
  entry: DomainEntry;
  status: DomainOnboardingStatus | undefined;
  isFetching: boolean;
  busy: boolean;
  onTogglePublic: (domain: string, next: boolean) => void;
  onSetLimit: (domain: string, next: number) => void;
  onRefetch: () => void;
  onRemove: (domain: string) => void;
}

/** 单个域名行：接入状态 + 公开开关 + 按域名认领上限。上限输入本地暂存，失焦提交。 */
function DomainRow({
  entry,
  status,
  isFetching,
  busy,
  onTogglePublic,
  onSetLimit,
  onRefetch,
  onRemove,
}: DomainRowProps) {
  const [limitDraft, setLimitDraft] = useState(String(entry.perUserLimit));

  const commitLimit = () => {
    const parsed = Number.parseInt(limitDraft, 10);
    const next = Number.isNaN(parsed) ? entry.perUserLimit : Math.min(Math.max(parsed, 0), 10000);
    setLimitDraft(String(next));
    if (next !== entry.perUserLimit) onSetLimit(entry.domain, next);
  };

  const detail =
    status && status.resolved && !status.mxReady
      ? '未检测到 Cloudflare Email Routing 的 MX 记录，请先完成步骤 ①。'
      : status && !status.resolved
        ? 'DNS 查询失败，请稍后重新检测。'
        : null;

  return (
    <li className="flex flex-col gap-2.5 rounded-md border border-line px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm text-ink">{entry.domain}</span>
          <StatusBadge isFetching={isFetching} status={status} />
          {entry.public && <Badge tone="accent">公开</Badge>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton size="sm" aria-label={`重新检测 ${entry.domain}`} disabled={isFetching} onClick={onRefetch}>
            <RefreshCw className={`size-4 text-ink-tertiary ${isFetching ? 'animate-spin' : ''}`} />
          </IconButton>
          <IconButton size="sm" aria-label={`移除 ${entry.domain}`} onClick={() => onRemove(entry.domain)}>
            <Trash2 className="size-4 text-critical" />
          </IconButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <label className="flex cursor-pointer items-center gap-2 text-ink-secondary">
          <Switch checked={entry.public} disabled={busy} onCheckedChange={(v) => onTogglePublic(entry.domain, v)} />
          <span>{entry.public ? '公开给普通用户' : '仅管理员可用'}</span>
        </label>
        <span className="text-xs text-ink-tertiary">关掉后不能再被新认领，已认领的人仍可收发</span>
        {entry.public && (
          <div className="flex items-center gap-1.5 text-ink-secondary">
            <span>每人可认领</span>
            <Input
              type="number"
              min={0}
              max={10000}
              value={limitDraft}
              disabled={busy}
              onChange={(e) => setLimitDraft(e.target.value)}
              onBlur={commitLimit}
              className="h-8 w-16 px-2 text-center"
              aria-label={`${entry.domain} 每人可认领数`}
            />
            <span className="text-ink-tertiary">个（0=不限）</span>
          </div>
        )}
      </div>

      {detail && <p className="text-xs text-ink-tertiary">{detail}</p>}
    </li>
  );
}

export function DomainsPage() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: queryKeys.admin.settings,
    queryFn: () => adminApi.getSettings(),
  });
  // 全站已认领地址：用于删域名前预估影响面
  const { data: allMailboxes } = useMailboxesQuery(true);
  const [newDomain, setNewDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const list = settings?.domains.list ?? [];
  const affected = removing ? (allMailboxes ?? []).filter((box) => box.domain === removing) : [];

  // 每个域名一条接入自检 query，进页面自动探测 MX；支持单独「重新检测」
  const statusQueries = useQueries({
    queries: list.map((entry) => ({
      queryKey: queryKeys.admin.domainStatus(entry.domain),
      queryFn: () => adminApi.domainStatus(entry.domain),
      staleTime: 60_000,
      retry: false,
    })),
  });

  const persist = useMutation({
    mutationFn: (nextList: DomainEntry[]) => adminApi.updateSettings({ domains: { list: nextList } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.admin.settings, saved);
      // 可见性/公开域名变化会影响公开配置与「可见域名」两处
      void queryClient.invalidateQueries({ queryKey: queryKeys.config });
      void queryClient.invalidateQueries({ queryKey: queryKeys.domains });
    },
    onError: (err) =>
      toast({ title: err instanceof ApiError ? err.message : '保存失败，请重试', variant: 'error' }),
  });

  /** 局部更新某域名条目并落库 */
  const updateEntry = (domain: string, patch: Partial<DomainEntry>) => {
    persist.mutate(list.map((e) => (e.domain === domain ? { ...e, ...patch } : e)));
  };

  const addDomain = (event: FormEvent) => {
    event.preventDefault();
    const value = newDomain.trim().toLowerCase();
    const parsed = domainSchema.safeParse(value);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '域名格式非法');
      return;
    }
    if (list.some((e) => e.domain === parsed.data)) {
      setError('该域名已在列表中');
      return;
    }
    // 新域名默认「仅管理员」，需管理员显式打开公开开关
    persist.mutate([...list, { domain: parsed.data, public: false, perUserLimit: 0 }], {
      onSuccess: () => {
        toast({ title: '域名已添加（默认仅管理员可用）', variant: 'success' });
        setNewDomain('');
        setError(null);
      },
    });
  };

  const confirmRemove = () => {
    if (!removing) return;
    persist.mutate(
      list.filter((e) => e.domain !== removing),
      {
        onSuccess: () => {
          toast({ title: '域名已移除', variant: 'success' });
          setRemoving(null);
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <PageHeader
        title="收件域名"
        description="接入一个新域名分两侧：Cloudflare 侧开启收件能力，本站侧把域名加入系统。新域名默认仅管理员可用，需手动公开给普通用户。"
      />

      {/* 接入向导 */}
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <div>
          <h2 className="text-sm font-semibold text-ink">如何接入一个新域名</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            步骤 ①② 在 Cloudflare 后台完成（本站无法代办），步骤 ③ 在本页下方完成。
          </p>
        </div>

        <ol className="flex flex-col gap-5">
          <GuideStep n={1} title="在 Cloudflare 为该域开启 Email Routing">
            <p>
              进入目标域名所在的 Cloudflare 账户 → 选择该域名 → 左侧菜单 <b>Email</b> →{' '}
              <b>Email Routing</b> → 点击开启。Cloudflare 会自动为该域写入所需的 MX 与 SPF 记录（无需手动配）。
            </p>
            <div>
              <Button asChild variant="secondary" size="sm">
                <a href={CLOUDFLARE_DASH} target="_blank" rel="noreferrer">
                  打开 Cloudflare 控制台
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            </div>
          </GuideStep>

          <GuideStep n={2} title="创建 Catch-all 规则，指向本系统 Worker">
            <p>
              在 Email Routing → <b>Routing rules</b> → <b>Catch-all address</b> → 编辑 → 动作选{' '}
              <b>Send to a Worker</b> → 选择下面这个 Worker。这一步让任意前缀（如 <span className="font-mono">abc@你的域</span>）的邮件全部进入本系统。
            </p>
            <div className="flex items-center gap-2">
              <code className="rounded-sm bg-surface-active px-2 py-1 font-mono text-xs text-ink">
                {WORKER_NAME}
              </code>
              <CopyButton value={WORKER_NAME} label="复制 Worker 名" size="sm" />
            </div>
            <p className="text-ink-tertiary">
              ⚠️ Catch-all 动作必须选「Send to a Worker」，不要选「转发到某邮箱」，否则邮件不会进入本系统。
            </p>
          </GuideStep>

          <GuideStep n={3} title="在本页下方把域名添加进系统并按需公开">
            <p className="flex flex-wrap items-center gap-1.5">
              添加后默认<b>仅管理员可用</b>；打开该域名的「公开」开关后普通用户才可见、可认领，并可设每人认领上限。
              <ArrowDown className="size-3.5 text-ink-tertiary" />
            </p>
          </GuideStep>

          <GuideStep n={4} title="（可选）把常用外部邮箱加为已验证目标">
            <p>
              对外发信与转发默认即可送达任意外部邮箱。若额外在 Email Routing →{' '}
              <b>Destination addresses</b> 验证目标邮箱，邮箱转发将走 Cloudflare 原生通道、
              原样保留邮件头与签名（保真度更高）。
            </p>
            <p className="text-ink-tertiary">站内地址之间互发直接落库、即时送达。</p>
          </GuideStep>
        </ol>
      </section>

      {/* 本站域名列表 */}
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <div>
          <h2 className="text-sm font-semibold text-ink">本站域名</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            系统会自动检测每个域名的收件链路（MX 是否已指向 Cloudflare）。
            <b>公开</b>开关决定普通用户是否可见并认领该域名；<b>每人可认领</b>限制普通用户在该域名下的地址数（管理员不受限）。
          </p>
        </div>

        <form onSubmit={addDomain} className="flex items-start gap-2">
          <div className="flex-1">
            <Input
              placeholder="example.com"
              value={newDomain}
              invalid={error !== null}
              onChange={(event) => {
                setNewDomain(event.target.value);
                if (error) setError(null);
              }}
            />
            {error && <p className="mt-1 text-xs text-critical">{error}</p>}
          </div>
          <Button type="submit" variant="secondary" loading={persist.isPending}>
            <Plus className="size-4" />
            添加
          </Button>
        </form>

        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : list.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {list.map((entry, i) => {
              const q = statusQueries[i];
              return (
                <DomainRow
                  key={entry.domain}
                  entry={entry}
                  status={q?.data}
                  isFetching={q?.isFetching ?? false}
                  busy={persist.isPending}
                  onTogglePublic={(domain, next) => updateEntry(domain, { public: next })}
                  onSetLimit={(domain, next) => updateEntry(domain, { perUserLimit: next })}
                  onRefetch={() => q?.refetch()}
                  onRemove={setRemoving}
                />
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={Globe}
            title="还没有配置收件域名"
            description="按上方向导先在 Cloudflare 开启 Email Routing 并把 catch-all 指向本 Worker，再在这里把域名添加进来。"
            className="rounded-md border border-dashed border-line"
          />
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title="移除这个域名？"
        description={
          removing
            ? `移除 ${removing} 后，该域名将不再用于地址认领、发件白名单与前端展示。${
                affected.length > 0
                  ? `当前该域下有 ${affected.length} 个已认领地址，移除后这些用户将无法用该域发件（历史邮件仍保留、仍可收信直到 Cloudflare 侧关闭 catch-all）。`
                  : '（当前该域下暂无已认领地址。）'
              }`
            : undefined
        }
        confirmLabel="移除"
        tone="danger"
        loading={persist.isPending}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
