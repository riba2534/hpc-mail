import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  type CreatedWebhookEndpoint,
  createWebhookEndpointRequestSchema,
  MAX_WEBHOOK_ENDPOINTS_PER_USER,
  WEBHOOK_EVENT_TYPES,
  type WebhookEndpoint,
  type WebhookEventType,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { webhookApi } from '@/api/resources';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

export const EVENT_LABELS: Record<WebhookEventType, string> = {
  'mail.received': '收到新邮件',
  'mail.sent': '发信成功',
  'mail.failed': '发信失败',
  'hosted_domain.activated': '托管域名可以收信',
  'hosted_domain.sending_ready': '托管域名发信就绪',
  'hosted_domain.moved': '托管域名已迁走',
};

const splitList = (text: string) => text.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean);
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** 新建端点：成功后只在这里显示一次签名密钥 */
function CreateEndpointDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>(['mail.received']);
  const [addresses, setAddresses] = useState('');
  const [domains, setDomains] = useState('');
  const [includeBody, setIncludeBody] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedWebhookEndpoint | null>(null);

  const create = useMutation({
    mutationFn: webhookApi.create,
    onSuccess: (data) => {
      setCreated(data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.root });
    },
    onError: (err) => setError(errorText(err, '创建失败，请重试')),
  });

  const close = () => {
    setUrl('');
    setDescription('');
    setEvents(['mail.received']);
    setAddresses('');
    setDomains('');
    setIncludeBody(false);
    setError(null);
    setCreated(null);
    onOpenChange(false);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = { url: url.trim(), description, events, addresses: splitList(addresses), domains: splitList(domains), includeBody };
    const parsed = createWebhookEndpointRequestSchema.safeParse(body);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    setError(null);
    create.mutate(body);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md">
        {created ? (
          <>
            <DialogHeader title="端点已创建" description="签名密钥只显示这一次，请保存到接收端用于校验 webhook-signature。" />
            <DialogBody className="flex flex-col gap-3">
              <code className="break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-ink">{created.secret}</code>
              <div>
                <CopyButton value={created.secret} label="复制密钥" size="sm" />
              </div>
            </DialogBody>
            <DialogFooter>
              <Button onClick={close}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader title="新建 Webhook 端点" />
            <form onSubmit={submit}>
              <DialogBody className="flex flex-col gap-4">
                <FormField label="接收地址" required description="公网 HTTPS 地址">
                  {(field) => <Input {...field} placeholder="https://example.com/hpc-mail" value={url} onChange={(e) => setUrl(e.target.value)} />}
                </FormField>
                <FormField label="备注">
                  {(field) => <Input {...field} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />}
                </FormField>
                <div role="group" aria-label="订阅事件" className="grid grid-cols-2 gap-2">
                  {WEBHOOK_EVENT_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-2 text-sm text-ink">
                      <Checkbox
                        checked={events.includes(type)}
                        onCheckedChange={() => setEvents((prev) => (prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]))}
                      />
                      {EVENT_LABELS[type]}
                    </label>
                  ))}
                </div>
                <FormField label="只推这些地址" description="逗号分隔；与下面的域名任一命中即推送，都留空表示全部">
                  {(field) => <Input {...field} placeholder="me@example.com" value={addresses} onChange={(e) => setAddresses(e.target.value)} />}
                </FormField>
                <FormField label="只推这些域名" description="逗号分隔；托管域名事件只按域名过滤">
                  {(field) => <Input {...field} placeholder="example.com" value={domains} onChange={(e) => setDomains(e.target.value)} />}
                </FormField>
                <label className="flex items-center justify-between gap-3 text-sm text-ink">
                  收信事件附带正文
                  <Switch checked={includeBody} onCheckedChange={setIncludeBody} aria-label="收信事件附带正文" />
                </label>
                {error && <p role="alert" className="text-sm text-critical">{error}</p>}
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={close}>取消</Button>
                <Button type="submit" loading={create.isPending} disabled={!url || events.length === 0}>创建</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 最近投递：失败的可以手动重试一次 */
function Deliveries({ endpoint }: { endpoint: WebhookEndpoint }) {
  const queryClient = useQueryClient();
  const deliveries = useQuery({ queryKey: queryKeys.webhooks.deliveries(endpoint.id), queryFn: () => webhookApi.deliveries(endpoint.id) });
  const retry = useMutation({
    mutationFn: (deliveryId: number) => webhookApi.retry(endpoint.id, deliveryId),
    onSuccess: () => {
      toast({ title: '已重新投递', variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.root });
    },
    onError: (err) => toast({ title: errorText(err, '重试失败'), variant: 'error' }),
  });
  if (deliveries.isLoading) return <Skeleton className="h-16 w-full rounded-md" />;
  if (deliveries.isError) return <QueryErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} />;
  const items = deliveries.data?.items ?? [];
  if (!items.length) return <p className="text-xs text-ink-tertiary">还没有投递记录。</p>;
  return (
    <ul aria-label="最近投递" className="flex flex-col gap-1 text-xs">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-2">
          <Badge tone={item.status === 'succeeded' ? 'positive' : item.status === 'failed' ? 'critical' : 'neutral'}>{item.status}</Badge>
          <span className="text-ink">{EVENT_LABELS[item.eventType] ?? item.eventType}</span>
          <span className="text-ink-tertiary">{formatDateTime(item.createdAt)} · 第 {item.attempts} 次</span>
          {item.lastError && <span className="text-ink-tertiary">{item.lastHttpStatus ? `HTTP ${item.lastHttpStatus} ` : ''}{item.lastError}</span>}
          {item.status === 'failed' && endpoint.status === 'active' && (
            <Button size="sm" variant="ghost" loading={retry.isPending && retry.variables === item.id} onClick={() => retry.mutate(item.id)}>
              重试
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function EndpointCard({ endpoint }: { endpoint: WebhookEndpoint }) {
  const queryClient = useQueryClient();
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.root });

  const toggle = useMutation({
    mutationFn: () => webhookApi.update(endpoint.id, { enabled: endpoint.status !== 'active' }),
    onSuccess: () => void refresh(),
    onError: (err) => toast({ title: errorText(err, '操作失败'), variant: 'error' }),
  });
  const test = useMutation({
    mutationFn: () => webhookApi.test(endpoint.id),
    onSuccess: (result) => toast(result.ok
      ? { title: `测试事件已送达（HTTP ${result.httpStatus}）`, variant: 'success' }
      : { title: '测试事件发送失败', description: result.error, variant: 'error' }),
    onError: (err) => toast({ title: errorText(err, '发送失败'), variant: 'error' }),
  });
  const rotate = useMutation({
    mutationFn: () => webhookApi.rotateSecret(endpoint.id),
    onSuccess: (data) => {
      setRotated(data.secret);
      void refresh();
    },
    onError: (err) => toast({ title: errorText(err, '轮换失败'), variant: 'error' }),
  });
  const remove = useMutation({
    mutationFn: () => webhookApi.remove(endpoint.id),
    onSuccess: () => {
      toast({ title: '端点已删除', variant: 'success' });
      void refresh();
    },
    onError: (err) => toast({ title: errorText(err, '删除失败'), variant: 'error' }),
  });

  const filters = [...endpoint.addresses, ...endpoint.domains];
  return (
    <li className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={endpoint.status === 'active' ? 'positive' : 'caution'}>{endpoint.status === 'active' ? '启用' : '已停用'}</Badge>
        <span className="min-w-0 break-all font-medium text-ink">{endpoint.url}</span>
      </div>
      {endpoint.disabledReason && <p role="alert" className="text-xs text-critical">{endpoint.disabledReason}</p>}
      <p className="text-xs text-ink-secondary">
        {endpoint.events.map((type) => EVENT_LABELS[type]).join('、')}
        {filters.length ? ` · 仅 ${filters.join('、')}` : ' · 全部地址'}
        {endpoint.includeBody ? ' · 附带正文' : ''}
        {endpoint.description ? ` · ${endpoint.description}` : ''}
      </p>
      <p className="text-xs text-ink-tertiary">
        密钥 {endpoint.secretPrefix}…
        {endpoint.lastSuccessAt ? ` · 最近成功 ${formatDateTime(endpoint.lastSuccessAt)}` : ''}
        {endpoint.consecutiveFailures ? ` · 连续失败 ${endpoint.consecutiveFailures} 次` : ''}
      </p>
      {rotated && (
        <div className="flex flex-col gap-1 rounded-md border border-caution-soft bg-caution-soft px-3 py-2 text-xs text-caution">
          新密钥（只显示这一次，已立即生效）：
          <code className="break-all font-mono text-ink">{rotated}</code>
          <div><CopyButton value={rotated} label="复制密钥" size="sm" /></div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>发送测试</Button>
        <Button size="sm" variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate()}>
          {endpoint.status === 'active' ? '停用' : '重新启用'}
        </Button>
        <Button size="sm" variant="ghost" loading={rotate.isPending} onClick={() => rotate.mutate()}>
          <KeyRound className="size-3.5" />
          轮换密钥
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowDeliveries((v) => !v)}>{showDeliveries ? '收起投递' : '查看投递'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>删除</Button>
      </div>
      {showDeliveries && <Deliveries endpoint={endpoint} />}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="删除这个端点？"
        description="端点和它的投递记录会一起删除，之后的事件不再推送。"
        confirmLabel="删除"
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

/** 个人设置里的 Webhook v2 端点管理 */
export function WebhooksSection({ id }: { id: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const endpoints = useQuery({ queryKey: queryKeys.webhooks.list, queryFn: webhookApi.list });

  return (
    <section id={id} tabIndex={-1} className="flex scroll-mt-20 flex-col gap-4 rounded-lg border border-line bg-surface p-5 focus:outline-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Webhook</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">
            把收信、发信结果与托管域名状态推送到你的服务，按 Svix 格式签名，失败自动重试。
            <a href="/references/webhooks.md" target="_blank" rel="noreferrer" className="ml-1 text-accent hover:underline">接入说明</a>
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={(endpoints.data?.length ?? 0) >= MAX_WEBHOOK_ENDPOINTS_PER_USER}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5" />
          新建端点
        </Button>
      </div>
      {endpoints.isLoading ? (
        <Skeleton className="h-20 w-full rounded-md" />
      ) : endpoints.isError ? (
        <QueryErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
      ) : endpoints.data?.length ? (
        <ul aria-label="Webhook 端点" className="flex flex-col gap-3">
          {endpoints.data.map((endpoint) => <EndpointCard key={endpoint.id} endpoint={endpoint} />)}
        </ul>
      ) : (
        <p className="text-sm text-ink-tertiary">还没有端点。</p>
      )}
      <CreateEndpointDialog open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}
