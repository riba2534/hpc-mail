import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemDomainCheck, SystemDomainOnboarding, SystemDomainPrecheck } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { AddExternalDomainDialog } from './add-external-domain-dialog';
import { OnboardingDetailPage } from './onboarding-detail-page';

const check = (fields: Partial<SystemDomainCheck>): SystemDomainCheck => ({
  key: 'catchAll', state: 'conflict', severity: 'confirm', ack: 'catchAll.replace', danger: false, title: '替换 catch-all 规则',
  current: '交给 Worker other', proposed: '交给 Worker hpc-cloud-mail', impact: 'Worker other 将收不到这个域名的信', records: [], ...fields,
});

const precheck = (fingerprint: string, checks: SystemDomainCheck[] = [check({})], extra: Partial<SystemDomainPrecheck> = {}): SystemDomainPrecheck => ({
  mode: 'existing_zone', domain: 'mail.test', zoneId: 'a'.repeat(32), zoneStatus: 'active', checkedAt: '2026-11-17T00:00:00.000Z', checks,
  steps: [], requiredAcks: checks.flatMap((c) => (c.ack ? [c.ack] : [])), verdict: 'confirm', fingerprint, registrar: null, nameServers: [], dnssec: null, ...extra,
});

const task = (extra: Partial<SystemDomainOnboarding> = {}): SystemDomainOnboarding => ({
  id: 9, domain: 'mail.test', mode: 'existing_zone', state: 'needs_confirmation', zoneId: 'a'.repeat(32), zoneOrigin: 'linked', zoneStatus: 'active',
  nameServers: [], originalNameServers: [], originalRegistrar: '', dnssec: 'unknown',
  steps: { zone: { state: 'ready', detail: '' }, routing: { state: 'missing', detail: '' }, catchAll: { state: 'conflict', detail: '' }, sending: { state: 'missing', detail: '' } },
  precheck: precheck('fp1'), accepted: [], changes: [], errorCode: '', lastError: '', cancelRequested: false, canDeleteZone: false,
  createdBy: 'root', createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z', stateChangedAt: '2026-11-17T00:00:00.000Z',
  checkedAt: null, nextCheckAt: null, activatedAt: null, finishedAt: null, dashboardUrl: 'https://dash.cloudflare.com/acct/mail.test', ...extra,
});

function renderPage(id = 9) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/admin/domains/onboarding/${id}`]}>
        <Routes><Route path="/admin/domains/onboarding/:id" element={<OnboardingDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('接入详情页', () => {
  it('只有 404 当作不存在；403 是凭据或权限问题，显示错误与重试', async () => {
    mocks.get.mockRejectedValueOnce(new ApiError('不存在', { code: 'not_found', httpStatus: 404 }));
    let client = renderPage();
    expect(await screen.findByText('接入任务不存在')).toBeInTheDocument();
    client.clear();
    cleanup();
    mocks.get.mockRejectedValueOnce(new ApiError('Token 无权限', { code: 'forbidden', httpStatus: 403 }));
    client = renderPage(10);
    expect(await screen.findByRole('button', { name: '重新加载' })).toBeInTheDocument();
    expect(screen.queryByText('接入任务不存在')).toBeNull();
    client.clear();
  });

  it('待确认：确认后调用 confirm；指纹过期 409 时用新预检刷新并需要重新勾选', async () => {
    mocks.get.mockResolvedValue(task());
    mocks.post.mockRejectedValueOnce(new ApiError('Cloudflare 上的配置已变化', {
      code: 'conflict', httpStatus: 409,
      details: { precheck: precheck('fp2', [check({ current: '交给 Worker another', impact: 'Worker another 将收不到这个域名的信' })]) },
    }));
    mocks.post.mockResolvedValueOnce(task({ state: 'configuring' }));
    const client = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '确认并继续' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '确认：替换 catch-all 规则' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并继续' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings/9/confirm', { fingerprint: 'fp1', accept: ['catchAll.replace'] }, expect.anything()));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Worker another 将收不到这个域名的信')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: '确认并继续' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '确认：替换 catch-all 规则' }));
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/admin/system-domains/onboardings/9/confirm', { fingerprint: 'fp2', accept: ['catchAll.replace'] }, expect.anything()));
    client.clear();
  });

  it('取消：本任务创建且未激活的 zone 才出现删除勾选（默认勾选）', async () => {
    mocks.get.mockResolvedValue(task({ mode: 'new_zone', state: 'awaiting_ns', zoneOrigin: 'created', canDeleteZone: true, precheck: null, nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], dnssec: 'unknown' }));
    mocks.post.mockResolvedValue(task({ state: 'cancelled' }));
    let client = renderPage();
    expect(await screen.findByText('ada.ns.cloudflare.com')).toBeInTheDocument();
    expect(screen.getByText(/DNSSEC 检测失败（不等于未开启）/)).toBeInTheDocument();
    expect(screen.getByText(/NS 生效需要时间/)).toHaveClass('text-critical');
    fireEvent.click(screen.getByRole('button', { name: '取消接入' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: '同时删除本次创建、未生效的 zone' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消接入' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings/9/cancel', { deleteCreatedZone: true }, expect.anything()));
    client.clear();
    cleanup();

    mocks.get.mockResolvedValue(task({ state: 'blocked', canDeleteZone: false, precheck: null }));
    client = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '取消接入' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消接入' }));
    await waitFor(() => expect(mocks.post).toHaveBeenLastCalledWith('/admin/system-domains/onboardings/9/cancel', { deleteCreatedZone: false }, expect.anything()));
    client.clear();
  });

  it('删除 MX 后路由未开启：红字提示；台账列出原值', async () => {
    mocks.get.mockResolvedValue(task({
      state: 'blocked', errorCode: 'mx_removed_routing_pending', lastError: 'MX 已删除，路由尚未开启：HTTP 500', precheck: null,
      changes: [{ seq: 1, kind: 'mx.delete', status: 'done', at: '2026-11-17T00:00:00.000Z', target: 'rec1', before: '{"content":"smtp.example.net","priority":1}', error: null }],
    }));
    const client = renderPage();
    expect((await screen.findByText(/该域名暂时收不到信/)).closest('p')).toHaveClass('text-critical');
    expect(screen.getByText(/原值：.*smtp.example.net/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /在 Cloudflare 控制台查看/ })).toHaveAttribute('href', 'https://dash.cloudflare.com/acct/mail.test');
    client.clear();
  });
});

describe('添加不在 Cloudflare 的域名', () => {
  it('预检后必须确认改 NS 才能建 zone，建好后展示分配的 NS', async () => {
    mocks.get.mockResolvedValue(precheck('fpn', [check({ key: 'nameServers', ack: 'ns.change', title: '需要把 NS 改到 Cloudflare', current: null, proposed: null, impact: '改 NS 会影响整个域名的 DNS' })], { mode: 'new_zone', domain: 'outside.test', zoneId: null, dnssec: 'on' }));
    mocks.post.mockResolvedValue(task({ id: 12, mode: 'new_zone', domain: 'outside.test', state: 'awaiting_ns', nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] }));
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><MemoryRouter><AddExternalDomainDialog open onOpenChange={() => {}} /></MemoryRouter></QueryClientProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: '要添加的域名' }), { target: { value: 'Outside.test' } });
    fireEvent.click(screen.getByRole('button', { name: '检查' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/admin/system-domains/precheck', expect.objectContaining({ query: { mode: 'new_zone', domain: 'outside.test' } })));
    expect(await screen.findByText(/DNSSEC 已开启/)).toBeInTheDocument();
    expect(screen.getByText(/改 NS 会影响整个域名的 DNS（网站、其他邮件服务等）/)).toBeInTheDocument();
    const create = screen.getByRole('button', { name: '创建 zone 并获取 NS' });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '确认：需要把 NS 改到 Cloudflare' }));
    fireEvent.click(create);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings', { mode: 'new_zone', domain: 'outside.test', fingerprint: 'fpn', accept: ['ns.change'] }, expect.anything()));
    expect(await screen.findByText('bob.ns.cloudflare.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看进度' })).toBeInTheDocument();
    client.clear();
  });
});
