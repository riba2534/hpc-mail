import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateWebhookEndpointInput, WebhookEndpoint } from '@hpc-mail/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

const endpoint = (overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: 1, url: 'https://hooks.example.com/hpc', description: '', events: ['mail.received'], addresses: [], domains: [],
  includeBody: false, status: 'active', disabledReason: '', consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
  secretPrefix: 'whsec_abcd', createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z', ...overrides,
});
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  test: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({
  webhookApi: { list: mocks.list, create: mocks.create, test: mocks.test, update: mocks.update, remove: vi.fn(), rotateSecret: vi.fn(),
    deliveries: vi.fn(async () => ({ items: [], nextCursor: null })), retry: vi.fn() },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
import { WebhooksSection } from './webhooks-section';

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><WebhooksSection id="profile-webhooks" /></QueryClientProvider>);
  return client;
}

afterEach(() => vi.clearAllMocks());

describe('Webhook 端点', () => {
  it('列出端点与自动停用原因，测试发送报告接收端结果', async () => {
    mocks.list.mockResolvedValue([endpoint({ status: 'disabled', disabledReason: '连续投递失败，已自动停用（最近一次：Webhook HTTP 503）' })]);
    mocks.test.mockResolvedValue({ ok: false, httpStatus: 503, error: 'Webhook HTTP 503', durationMs: 12 });
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByText('https://hooks.example.com/hpc')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('自动停用');
    expect(screen.getByRole('button', { name: '重新启用' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '发送测试' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '测试事件发送失败', variant: 'error' })));
  });

  it('新建时提交事件与过滤，成功后只显示一次签名密钥', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.create.mockImplementation(async (body: CreateWebhookEndpointInput) => ({ ...endpoint(), ...body, secret: 'whsec_c2VjcmV0' }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: '新建端点' }));
    await user.type(screen.getByLabelText(/接收地址/), 'https://hooks.example.com/new');
    await user.click(screen.getByRole('checkbox', { name: '发信失败' }));
    await user.type(screen.getByLabelText(/只推这些域名/), 'example.com, other.example');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('whsec_c2VjcmV0')).toBeInTheDocument();
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      url: 'https://hooks.example.com/new', events: ['mail.received', 'mail.failed'], domains: ['example.com', 'other.example'], addresses: [],
    });
  });

  it('不是 https 的地址就地提示，不调用接口', async () => {
    mocks.list.mockResolvedValue([]);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: '新建端点' }));
    await user.type(screen.getByLabelText(/接收地址/), 'http://hooks.example.com/new');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toHaveTextContent('https');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
