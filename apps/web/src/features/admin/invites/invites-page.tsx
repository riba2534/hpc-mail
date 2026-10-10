import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, MoreHorizontal, Plus, Ticket } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Invite, type RegistrationMode, createInviteRequestSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { adminApi } from '@/api/resources';
import { PageHeader } from '@/components/page-header';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardList, CardListItem } from '@/components/ui/card-list';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useIsMobile } from '@/lib/use-media-query';

const STATUS_META: Record<Invite['status'], { label: string; tone: BadgeTone }> = {
  usable: { label: '可用', tone: 'positive' },
  exhausted: { label: '已用完', tone: 'neutral' },
  expired: { label: '已过期', tone: 'neutral' },
  revoked: { label: '已作废', tone: 'critical' },
};

const MODE_LABELS: Record<RegistrationMode, string> = {
  closed: '关闭',
  invite: '邀请码',
  open: '开放',
};

const MODE_HINTS: Partial<Record<RegistrationMode, string>> = {
  open: '当前为开放注册，邀请码不生效。',
  closed: '当前已关闭注册，邀请码不能用于注册。',
};

/** 当前注册模式：只有「邀请码」模式下邀请码才起作用，其余模式给出提示 */
function RegistrationModeNotice() {
  const { data: settings } = useQuery({ queryKey: queryKeys.admin.settings, queryFn: () => adminApi.getSettings() });
  if (!settings) return null;
  const mode = settings.register_mode;
  const hint = MODE_HINTS[mode];
  return (
    <div
      className={
        hint
          ? 'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-caution/40 bg-caution-soft/40 px-4 py-3 text-sm'
          : 'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface px-4 py-3 text-sm'
      }
    >
      <span className="flex items-center gap-2 text-ink-secondary">
        当前注册模式
        <Badge tone={mode === 'invite' ? 'accent' : 'caution'}>{MODE_LABELS[mode]}</Badge>
      </span>
      {hint && (
        <span className="flex items-center gap-1.5 text-ink">
          <AlertTriangle aria-hidden className="size-4 shrink-0 text-caution" />
          {hint}
        </span>
      )}
      <Link
        to="/admin/settings"
        className="ml-auto text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {hint ? '前往系统设置修改' : '系统设置'}
      </Link>
    </div>
  );
}

function CreateInviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [count, setCount] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: Parameters<typeof adminApi.createInvites>[0]) => adminApi.createInvites(payload),
    onSuccess: (created) => {
      toast({ title: `已生成 ${created.length} 个邀请码`, variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.invites });
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '生成失败，请重试'),
  });

  const reset = () => {
    setCount(1);
    setMaxUses(1);
    setExpiresAt('');
    setNote('');
    setError(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const payload = {
      count,
      maxUses,
      note,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
    };
    const parsed = createInviteRequestSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    mutation.mutate(parsed.data);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader title="生成邀请码" />
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField label="生成数量">
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    min={1}
                    max={50}
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value))}
                  />
                )}
              </FormField>
              <FormField label="每码可用次数">
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    min={1}
                    max={1000}
                    value={maxUses}
                    onChange={(event) => setMaxUses(Number(event.target.value))}
                  />
                )}
              </FormField>
            </div>
            <FormField label="有效期" description="留空则永不过期">
              {(field) => (
                <Input
                  {...field}
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="备注">
              {(field) => (
                <Input
                  {...field}
                  maxLength={128}
                  placeholder="可选"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </FormField>
            {error && <p className="text-sm text-critical">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              生成
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function usedByLabel(invite: Invite): string {
  if (invite.usedBy.length === 0) return '';
  return invite.usedBy.slice(0, 3).join('、') + (invite.usedBy.length > 3 ? ` +${invite.usedBy.length - 3}` : '');
}

export function InvitesPage() {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: queryKeys.admin.invites, queryFn: () => adminApi.listInvites() });
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<Invite | null>(null);

  const revoke = useMutation({
    mutationFn: (id: number) => adminApi.revokeInvite(id),
    onSuccess: () => {
      toast({ title: '邀请码已作废', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.admin.invites });
      setRevoking(null);
    },
    onError: () => toast({ title: '作废失败，请重试', variant: 'error' }),
  });

  const invites = data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="邀请码"
        description="邀请码注册模式下用于放行新用户注册。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            生成邀请码
          </Button>
        }
      />
      <RegistrationModeNotice />

      {isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : invites.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="还没有邀请码"
          description="生成邀请码后可分发给待注册用户。"
          action={<Button onClick={() => setCreateOpen(true)}>生成邀请码</Button>}
          className="rounded-lg border border-line bg-surface"
        />
      ) : isMobile ? (
        <CardList>
          {invites.map((invite) => {
            const status = STATUS_META[invite.status];
            return (
              <CardListItem
                key={invite.id}
                title={
                  <>
                    <code className="truncate font-mono text-sm text-ink">{invite.code}</code>
                    <CopyButton value={invite.code} size="sm" />
                  </>
                }
                subtitle={invite.note || undefined}
                meta={
                  <>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span>
                      已用 {invite.usedCount} / {invite.maxUses}
                    </span>
                    <span>{invite.expiresAt ? `${formatDateTime(invite.expiresAt)} 到期` : '永久有效'}</span>
                    {invite.usedBy.length > 0 && <span title={invite.usedBy.join('、')}>注册者 {usedByLabel(invite)}</span>}
                  </>
                }
                actions={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton size="sm" aria-label="更多操作">
                        <MoreHorizontal className="size-4" />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        tone="danger"
                        disabled={invite.status !== 'usable'}
                        onSelect={() => setRevoking(invite)}
                      >
                        作废邀请码
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            );
          })}
        </CardList>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>邀请码</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>使用</TableHead>
              <TableHead>有效期</TableHead>
              <TableHead>备注</TableHead>
              <TableHead>注册者</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.map((invite) => {
              const status = STATUS_META[invite.status];
              return (
                <TableRow key={invite.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm text-ink">{invite.code}</code>
                      <CopyButton value={invite.code} size="sm" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </TableCell>
                  <TableCell className="text-ink-secondary">
                    {invite.usedCount} / {invite.maxUses}
                  </TableCell>
                  <TableCell className="text-ink-tertiary">
                    {invite.expiresAt ? formatDateTime(invite.expiresAt) : '永久'}
                  </TableCell>
                  <TableCell className="text-ink-secondary">{invite.note || '—'}</TableCell>
                  <TableCell className="text-ink-secondary">
                    {invite.usedBy.length > 0 ? (
                      <span className="text-sm" title={invite.usedBy.join('、')}>
                        {usedByLabel(invite)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={invite.status !== 'usable'}
                      onClick={() => setRevoking(invite)}
                    >
                      作废
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreateInviteDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => !next && setRevoking(null)}
        title="作废这个邀请码？"
        description={revoking ? `作废后 ${revoking.code} 将无法再用于注册。` : undefined}
        confirmLabel="作废"
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}
