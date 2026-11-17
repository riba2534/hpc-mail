import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SystemDomainCheck, SystemDomainPrecheck, SystemDomainStepState, SystemDomainSteps, SystemDomainZone, SystemDomainZonesView,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { CloudflareZonesCard } from './cloudflare-zones-card';
import { FAST_POLL_MS, SLOW_POLL_MS, pollIntervalFor } from './system-domains-api';

const steps = (routing: SystemDomainStepState = 'missing', catchAll: SystemDomainStepState = 'missing', sending: SystemDomainStepState = 'missing'): SystemDomainSteps => ({
  zone: { state: 'ready', detail: '' }, routing: { state: routing, detail: '' }, catchAll: { state: catchAll, detail: '' }, sending: { state: sending, detail: '' },
});

const zone = (name: string, extra: Partial<SystemDomainZone> = {}): SystemDomainZone => ({
  zoneId: name.replace(/[^a-z]/g, '').padEnd(32, 'a').slice(0, 32), name, status: 'active', type: 'full', paused: false,
  category: 'available', hidden: false, owner: null, onboarding: null,
  readiness: { verdict: 'ready', confirmCount: 0, reasons: [], registrar: { name: 'Cloudflare, Inc.', cloudflare: true }, checkedAt: null },
  ...extra,
});

const view = (zones: SystemDomainZone[], extra: Partial<SystemDomainZonesView> = {}): SystemDomainZonesView => ({
  configured: true, zones, others: [], unlistedTasks: [],
  counts: { available: zones.length, onboarding: 0, system: 41, hosted: 86, inconsistent: 0, hostedByAdmin: 2, hidden: 1 },
  complete: true, hiddenRevision: 3, ...extra,
});

const check = (fields: Partial<SystemDomainCheck>): SystemDomainCheck => ({
  key: 'mx', state: 'conflict', severity: 'confirm', ack: null, danger: false, title: '', current: null, proposed: null, impact: '', records: [], ...fields,
});

const precheckOf = (zoneId: string, checks: SystemDomainCheck[], fingerprint = 'fp1'): SystemDomainPrecheck => ({
  mode: 'existing_zone', domain: 'mail.test', zoneId, zoneStatus: 'active', checkedAt: '2026-11-17T00:00:00.000Z', checks,
  steps: [{ kind: 'mx.delete', detail: '删除 1 条第三方 MX' }], requiredAcks: checks.flatMap((c) => (c.ack ? [c.ack] : [])),
  verdict: checks.some((c) => c.severity === 'blocker') ? 'blocked' : 'confirm', fingerprint, registrar: null, nameServers: [], dnssec: null,
});

const mxCheck = check({ key: 'mx', ack: 'mx.delete', danger: true, title: '根域有 1 条其他邮件服务的 MX，需要删除', current: '1 smtp.example.net', impact: '该域名将不再经 smtp.example.net 收信', records: [{ type: 'MX', name: 'mail.test', content: 'smtp.example.net', priority: 1, ttl: 1 }] });
const spfCheck = check({ key: 'spf', ack: 'spf.merge', title: '合并已有的 SPF', current: 'v=spf1 -all', proposed: 'v=spf1 include:_spf.mx.cloudflare.net -all', impact: '合并后' });

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(<QueryClientProvider client={client}><MemoryRouter><CloudflareZonesCard /></MemoryRouter></QueryClientProvider>);
  return { client, ...utils };
}

function routeGet(zonesView: SystemDomainZonesView, precheck?: SystemDomainPrecheck) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/zones')) return zonesView;
    if (path.endsWith('/precheck')) return precheck;
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Cloudflare 中可接入的域名', () => {
  it('Worker 没有 Cloudflare 凭据时整个卡片不显示', async () => {
    routeGet({ ...view([]), configured: false });
    const { container, client } = renderCard();
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    client.clear();
  });

  it('按就绪摘要显示每行的状态与按钮', async () => {
    routeGet(view([
      zone('ready.test'),
      zone('confirm.test', { readiness: { verdict: 'confirm', confirmCount: 2, reasons: ['替换 catch-all 规则', '合并已有的 SPF'], registrar: { name: 'X', cloudflare: false }, checkedAt: null } }),
      zone('blocked.test', { readiness: { verdict: 'blocked', confirmCount: 0, reasons: ['catch-all 由其他 Worker 的 Wrangler 配置管理'], registrar: null, checkedAt: null } }),
      zone('pending.test', { status: 'pending', readiness: { verdict: 'pending', confirmCount: 0, reasons: [], registrar: null, checkedAt: null } }),
      zone('later.test', { readiness: { verdict: 'unchecked', confirmCount: 0, reasons: [], registrar: null, checkedAt: null } }),
    ], { others: [
      zone('sys.test', { category: 'system', readiness: null }),
      zone('own.test', { category: 'hosted', readiness: null, owner: { userId: 1, username: 'root', isAdmin: true } }),
      zone('odd.test', { category: 'inconsistent', readiness: null, owner: { userId: 2, username: 'bob', isAdmin: false } }),
    ] }));
    const { client } = renderCard();
    expect(await screen.findByText('可直接接入')).toBeInTheDocument();
    expect(screen.getByText('Cloudflare 购买')).toBeInTheDocument();
    expect(screen.getByText('外部注册')).toBeInTheDocument();
    expect(screen.getByText('需确认 2 项：替换 catch-all 规则；合并已有的 SPF')).toBeInTheDocument();
    expect(screen.getByText(/无法接入：catch-all 由其他 Worker/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接入 blocked.test' })).toBeNull();
    expect(screen.getByText(/等待 Cloudflare 激活/)).toBeInTheDocument();
    expect(screen.getByText(/未检查/)).toBeInTheDocument();
    expect(screen.getByText(/已是系统域名 41 个、用户托管 86 个（其中管理员名下 2 个）/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /可展开查看/ }));
    expect(screen.getByText('管理员名下托管')).toBeInTheDocument();
    expect(screen.getByText(/托管记录的 zone 与账户中的不一致/)).toHaveClass('text-critical');
    client.clear();
  });

  it('可直接接入：点一下就创建任务，不弹确认框', async () => {
    const ready = zone('ready.test');
    routeGet(view([ready]));
    mocks.post.mockResolvedValue({ id: 7, domain: 'ready.test', mode: 'existing_zone', state: 'configuring', zoneId: ready.zoneId, steps: steps(), errorCode: '', lastError: '', updatedAt: '', nextCheckAt: null, cancelRequested: false });
    const { client } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: '接入 ready.test' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings', { mode: 'existing_zone', zoneId: ready.zoneId }, expect.anything()));
    expect(mocks.get).not.toHaveBeenCalledWith('/admin/system-domains/precheck', expect.anything());
    expect(screen.queryByRole('dialog')).toBeNull();
    // 行内进度
    expect(await screen.findByLabelText('接入进度')).toBeInTheDocument();
    client.clear();
  });

  it('需确认：先预检再弹框，危险项红字列出 MX，全部勾选后才能提交，提交带指纹与确认项', async () => {
    const target = zone('mail.test', { readiness: { verdict: 'confirm', confirmCount: 2, reasons: [], registrar: null, checkedAt: null } });
    routeGet(view([target]), precheckOf(target.zoneId, [mxCheck, spfCheck]));
    mocks.post.mockResolvedValue({ id: 8, domain: 'mail.test', mode: 'existing_zone', state: 'configuring', zoneId: target.zoneId, steps: steps(), errorCode: '', lastError: '', updatedAt: '', nextCheckAt: null, cancelRequested: false });
    const { client } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: '接入 mail.test' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('该域名将不再经 smtp.example.net 收信')).toHaveClass('text-critical');
    expect(within(dialog).getByText(/MX mail.test 1 smtp.example.net/)).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: '确认并接入' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: `确认：${mxCheck.title}` }));
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: `确认：${spfCheck.title}` }));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings',
      { mode: 'existing_zone', zoneId: target.zoneId, fingerprint: 'fp1', accept: ['mx.delete', 'spf.merge'] }, expect.anything()));
    client.clear();
  });

  it('接入返回 409 且带最新预检时弹出确认框', async () => {
    const ready = zone('ready.test');
    routeGet(view([ready]));
    mocks.post.mockRejectedValueOnce(new ApiError('需要确认 1 项变更', { code: 'conflict', httpStatus: 409, details: { precheck: precheckOf(ready.zoneId, [spfCheck], 'fp2') } }));
    const { client } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: '接入 ready.test' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('合并已有的 SPF')).toBeInTheDocument();
    client.clear();
  });

  it('无法接入的行：查看只读说明，没有提交按钮', async () => {
    const blocked = zone('blocked.test', { readiness: { verdict: 'blocked', confirmCount: 0, reasons: ['x'], registrar: null, checkedAt: null } });
    routeGet(view([blocked]), precheckOf(blocked.zoneId, [check({ key: 'catchAll', severity: 'blocker', title: 'catch-all 由其他 Worker 的 Wrangler 配置管理' })]));
    const { client } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/暂时无法接入/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '确认并接入' })).toBeNull();
    client.clear();
  });

  it('隐藏与显示已隐藏：带隐藏列表 revision', async () => {
    routeGet(view([zone('noise.test')]));
    mocks.put.mockResolvedValue({ hiddenZones: ['noise.test'], revision: 4 });
    const { client } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: '隐藏 noise.test' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/admin/system-domains/hidden-zones', { domain: 'noise.test', hidden: true, expectedRevision: 3 }));
    fireEvent.click(screen.getByRole('button', { name: '显示已隐藏（1）' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/admin/system-domains/zones', expect.objectContaining({ query: { hidden: '1' } })));
    client.clear();
  });

  it('进行中的任务显示在行内：阻断时红字说明 MX 已删除，可重试；待确认跳详情页', async () => {
    routeGet(view([
      zone('gap.test', { category: 'onboarding', readiness: null, onboarding: { id: 3, domain: 'gap.test', mode: 'existing_zone', state: 'blocked', steps: steps('missing', 'ready'), errorCode: 'mx_removed_routing_pending', lastError: 'MX 已删除，路由尚未开启', updatedAt: '', nextCheckAt: null, cancelRequested: false } }),
      zone('ask.test', { category: 'onboarding', readiness: null, onboarding: { id: 4, domain: 'ask.test', mode: 'existing_zone', state: 'needs_confirmation', steps: steps(), errorCode: '', lastError: '', updatedAt: '', nextCheckAt: null, cancelRequested: false } }),
    ], { unlistedTasks: [{ id: 5, domain: 'new.test', mode: 'new_zone', state: 'creating_zone', steps: steps('waiting', 'waiting', 'waiting'), errorCode: '', lastError: '', updatedAt: '', nextCheckAt: null, cancelRequested: false }] }));
    mocks.post.mockResolvedValue({ id: 3, domain: 'gap.test', mode: 'existing_zone', state: 'configuring', zoneId: null, steps: steps(), errorCode: '', lastError: '', updatedAt: '', nextCheckAt: null, cancelRequested: false });
    const { client } = renderCard();
    expect((await screen.findByText(/MX 已删除，路由尚未开启：该域名暂时收不到信/)).closest('p')).toHaveClass('text-critical');
    expect(screen.getByRole('link', { name: '去确认' })).toHaveAttribute('href', '/admin/domains/onboarding/4');
    expect(screen.getByText('new.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/system-domains/onboardings/3/check', undefined, expect.anything()));
    client.clear();
  });

  it('轮询间隔按任务状态切换', () => {
    expect(pollIntervalFor(['configuring', 'awaiting_ns'])).toBe(FAST_POLL_MS);
    expect(pollIntervalFor(['awaiting_ns'])).toBe(SLOW_POLL_MS);
    expect(pollIntervalFor(['blocked'])).toBe(SLOW_POLL_MS);
    expect(pollIntervalFor(['needs_confirmation', 'completed'])).toBe(false);
    expect(pollIntervalFor([])).toBe(false);
  });
});
