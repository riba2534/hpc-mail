import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateApiKeyInput, CreatedApiKey, SessionUser } from '@hpc-mail/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (_body: CreateApiKeyInput): Promise<CreatedApiKey> => {
    throw new Error('not stubbed');
  }),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({
  apiKeyApi: { create: mocks.create },
  mailboxApi: { list: async () => [{ id: 42, address: 'bot@hpc.email', domain: 'hpc.email' }, { id: 43, address: 'other@hpc.email', domain: 'hpc.email' }] },
}));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { CurrentUserContext } from '@/lib/use-session';
import {
  buildCurlExample,
  CreateApiKeyDialog,
  domainScopeNote,
  expiryFromPreset,
  matchScopePreset,
} from './create-api-key-dialog';

const DAY = 24 * 60 * 60 * 1000;

function renderDialog(role: SessionUser['role'] = 'user') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user: SessionUser = { id: 1, username: 'alice', role, createdAt: '', avatarUrl: null, twoFactorEnabled: false };
  return render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <CreateApiKeyDialog open onOpenChange={vi.fn()} />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
}

/** 名称与当前密码是提交前必填的两项 */
async function fillRequired(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText(/名称/), name);
  await user.type(screen.getByLabelText(/当前密码/), 'current-pass');
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
    allowedMailboxIds: [],
    allowedDomains: [],
    key: 'hpcm_secret_value',
    ...overrides,
  };
}

describe('API Key 预设工具函数', () => {
  it('勾选恰好等于预设时识别预设，否则为自定义', () => {
    expect(matchScopePreset(['mailbox.read', 'mail.read'])).toBe('read');
    expect(matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read'])).toBe('send');
    expect(
      matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write', 'domain.read', 'domain.write',
        'mailbox.share', 'webhook.write', 'notify.read', 'notify.write']),
    ).toBe('full');
    // 「完全访问」不含管理员能力
    expect(matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write', 'domain.read', 'domain.write',
      'mailbox.share', 'webhook.write', 'notify.read', 'notify.write', 'admin'])).toBe('custom');
    // 托管域名两项加入之前的「完全访问」：已有 Key 不自动获得新 scope，按自定义显示
    expect(matchScopePreset(['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write'])).toBe('custom');
    expect(matchScopePreset(['mail.read'])).toBe('custom');
    expect(matchScopePreset([])).toBe('custom');
  });

  it('托管域名权限的说明：写权限提示风险，只读说明用途，未勾选不提示', () => {
    expect(domainScopeNote(['mail.read', 'domain.read', 'domain.write'])).toMatchObject({ tone: 'caution', text: expect.stringContaining('DNS 解析') });
    expect(domainScopeNote(['domain.write'])?.text).toContain('删除域名');
    expect(domainScopeNote(['domain.read'])).toMatchObject({ tone: 'info', text: expect.stringContaining('接入进度') });
    expect(domainScopeNote(['mail.read', 'mailbox.write'])).toBeNull();
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

    await fillRequired(user, '脚本');
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
    await user.click(screen.getByRole('checkbox', { name: '查看托管域名' }));
    for (const label of ['管理共享', '配置 Webhook', '读取通知配置', '修改通知配置']) await user.click(screen.getByRole('checkbox', { name: label }));
    expect(screen.getByRole('radio', { name: '完全访问' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: '接入域名与解析' }));
    expect(screen.getByRole('radio', { name: '完全访问' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('checkbox', { name: '发送邮件' }));
    const scopeGroup = screen.getByRole('radiogroup', { name: '权限预设' });
    expect(within(scopeGroup).getByRole('radio', { name: '自定义' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('checkbox', { name: '发送邮件' }));
    expect(screen.getByRole('radio', { name: '完全访问' })).toHaveAttribute('aria-checked', 'true');
  });

  it('托管域名权限默认不勾选；勾选后显示用途，写权限与「完全访问」显示风险提示并随请求提交', async () => {
    mocks.create.mockResolvedValue(createdKey());
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole('checkbox', { name: '查看托管域名' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '接入域名与解析' })).not.toBeChecked();
    expect(screen.queryByText(/托管域名的 DNS 解析/)).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: '查看托管域名' }));
    expect(screen.getByText(/可读取你托管域名的接入进度/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '查看托管域名' }));
    await user.click(screen.getByRole('radio', { name: '完全访问' }));
    expect(screen.getByRole('checkbox', { name: '接入域名与解析' })).toBeChecked();
    expect(screen.getByText(/修改托管域名的 DNS 解析/)).toHaveClass('text-caution');

    await fillRequired(user, '域名脚本');
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0].scopes).toEqual(expect.arrayContaining(['domain.read', 'domain.write']));
  });

  it('有效期预设提交 now + N 天；自定义未选时间时就地提示', async () => {
    mocks.create.mockResolvedValue(createdKey());
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, '脚本');

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

  it('提交带上当前密码与限定的邮箱、域名；没填密码时不能提交', async () => {
    mocks.create.mockResolvedValue(createdKey());
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByLabelText(/名称/), '单邮箱');
    expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();
    await user.click(screen.getByText('限定邮箱或域名（可选）'));
    await user.click(await screen.findByRole('checkbox', { name: 'bot@hpc.email' }));
    await user.type(screen.getByLabelText(/限定域名/), 'mine.example');
    await user.type(screen.getByLabelText(/当前密码/), 'current-pass');
    await user.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ password: 'current-pass', allowedMailboxIds: [42], allowedDomains: ['mine.example'] });
  });

  it('管理员能力只对管理员显示，勾选后提示并按规则校验白名单与有效期', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.queryByRole('checkbox', { name: '管理员能力' })).toBeNull();
    cleanup();

    renderDialog('admin');
    await user.click(screen.getByRole('checkbox', { name: '管理员能力' }));
    expect(screen.getByText(/必须设置 IP 白名单/)).toBeInTheDocument();
    await fillRequired(user, '运维');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('alert')).toHaveTextContent('IP 白名单');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('创建成功后展示 curl 示例、发信提示与接入说明链接', async () => {
    mocks.create.mockResolvedValue(createdKey({ scopes: ['mail.read', 'mail.send', 'mailbox.read'] }));
    const user = userEvent.setup();
    renderDialog();
    await fillRequired(user, '脚本');
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
