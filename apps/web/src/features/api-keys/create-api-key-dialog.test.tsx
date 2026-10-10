import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateApiKeyRequest, CreatedApiKey } from '@hpc-mail/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (_body: CreateApiKeyRequest): Promise<CreatedApiKey> => {
    throw new Error('not stubbed');
  }),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({ apiKeyApi: { create: mocks.create } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import {
  buildCurlExample,
  CreateApiKeyDialog,
  expiryFromPreset,
  matchScopePreset,
} from './create-api-key-dialog';

const DAY = 24 * 60 * 60 * 1000;

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CreateApiKeyDialog open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

function createdKey(overrides: Partial<CreatedApiKey> = {}): CreatedApiKey {
  return {
    id: 1,
    name: 'bot',
    keyPrefix: 'hpcm_ab',
    keySuffix: 'yz',
    scopes: ['mail.read', 'mailbox.read'],
    rateLimit: 120,
    allowedIps: [],
    status: 'active',
    expiresAt: null,
    lastUsedAt: null,
    createdAt: '2026-10-10T00:00:00Z',
    key: 'hpcm_secret_value',
    ...overrides,
  };
}

describe('API Key 预设工具函数', () => {
  it('勾选恰好等于预设时识别预设，否则为自定义', () => {
    expect(matchScopePreset(['mailbox.read', 'mail.read'])).toBe('read');
    expect(matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read'])).toBe('send');
    expect(matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write'])).toBe('full');
    expect(matchScopePreset(['mail.read'])).toBe('custom');
    expect(matchScopePreset([])).toBe('custom');
  });

  it('有效期预设换算为绝对时间', () => {
    const now = Date.UTC(2026, 9, 10);
    expect(expiryFromPreset('never', '', now)).toBeUndefined();
    expect(expiryFromPreset('7', '', now)).toBe(new Date(now + 7 * DAY).toISOString());
    expect(expiryFromPreset('90', '', now)).toBe(new Date(now + 90 * DAY).toISOString());
    expect(expiryFromPreset('custom', '', now)).toBeUndefined();
  });

  it('curl 示例按权限挑选可直接调用的端点', () => {
    expect(buildCurlExample('k', ['mail.read'], 'https://mail.test')).toBe(
      'curl -H "Authorization: Bearer k" "https://mail.test/v1/messages?limit=5"',
    );
    expect(buildCurlExample('k', ['mailbox.read'], 'https://mail.test')).toContain('/v1/mailboxes"');
    expect(buildCurlExample('k', ['mail.send'], 'https://mail.test')).toContain('/v1/status"');
  });
});

describe('CreateApiKeyDialog', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.toast.mockReset();
  });

  it('默认选中「只读收信」并按预设提交、永不过期', async () => {
    mocks.create.mockResolvedValue(createdKey());
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole('radio', { name: '只读收信' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '永不过期' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox', { name: '读取邮件' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '发送邮件' })).not.toBeChecked();

    await user.type(screen.getByLabelText(/名称/), '脚本');
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0]![0];
    expect([...body.scopes].sort()).toEqual(['mail.read', 'mailbox.read']);
    expect(body.expiresAt).toBeUndefined();
  });

  it('切换预设会改勾选，手动勾选后按结果高亮预设或自定义', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('radio', { name: '收发信' }));
    expect(screen.getByRole('checkbox', { name: '发送邮件' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '标记已读/删除' })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: '管理邮箱' }));
    expect(screen.getByRole('radio', { name: '完全访问' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('checkbox', { name: '发送邮件' }));
    const scopeGroup = screen.getByRole('radiogroup', { name: '权限预设' });
    expect(within(scopeGroup).getByRole('radio', { name: '自定义' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('checkbox', { name: '发送邮件' }));
    expect(screen.getByRole('radio', { name: '完全访问' })).toHaveAttribute('aria-checked', 'true');
  });

  it('有效期预设提交 now + N 天；自定义未选时间时就地提示', async () => {
    mocks.create.mockResolvedValue(createdKey());
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/名称/), '脚本');

    // 权限预设里也有「自定义」，后一个属于有效期
    const expiryGroup = screen.getByRole('radiogroup', { name: '有效期' });
    await user.click(within(expiryGroup).getByRole('radio', { name: '自定义' }));
    expect(screen.getByLabelText('自定义过期时间')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择过期时间');
    expect(mocks.create).not.toHaveBeenCalled();

    await user.click(screen.getByRole('radio', { name: '30 天' }));
    expect(screen.queryByLabelText('自定义过期时间')).toBeNull();
    expect(screen.getByText(/^将于 .+ 过期$/)).toBeInTheDocument();
    const before = Date.now();
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const expiresAt = Date.parse(mocks.create.mock.calls[0]![0].expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
  });

  it('创建成功后展示 curl 示例、发信提示与接入说明链接', async () => {
    mocks.create.mockResolvedValue(createdKey({ scopes: ['mail.read', 'mail.send', 'mailbox.read'] }));
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/名称/), '脚本');
    await user.click(screen.getByRole('button', { name: '创建' }));

    const example = await screen.findByLabelText('curl 示例');
    expect(example).toHaveTextContent(
      `curl -H "Authorization: Bearer hpcm_secret_value" "${globalThis.location.origin}/v1/messages?limit=5"`,
    );
    expect(screen.getByRole('button', { name: '复制命令' })).toBeInTheDocument();
    expect(screen.getByText('POST /v1/messages')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /给 AI Agent 的接入说明/ });
    expect(link).toHaveAttribute('href', '/skill.md');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
