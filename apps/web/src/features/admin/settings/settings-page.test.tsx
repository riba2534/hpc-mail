import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SECRET_MASK as SHARED_SECRET_MASK, type Settings } from '@hpc-mail/shared';

const SETTINGS = {
  domains: { revision: 3, list: [] },
  register_mode: 'invite',
  code_extract: { enabled: true, aiEnabled: true },
  site: { title: 'HPC Mail' },
  api: { enabled: true },
  security: { require2fa: false },
  retention: { unclaimedDays: 90, allMessagesDays: 0 },
  quota: { dailyOutbound: 0, dailyRecipients: 0, relayDaily: 300, relayPerUserDaily: 50, relayUnclaimedDaily: 50 },
  mailbox_policy: { perUserLimit: 5, reservedLocalParts: ['admin', 'root'] },
  ai_model: { baseUrl: 'https://api.deepseek.com', apiKey: '******', model: 'deepseek-flash' },
  translation: { enabled: true, dailyCharsPerUser: 200000 },
  claim_random: { paidSuspendedLimit: 2, pendingDays: 7, suspendedPercent: 50, dailyLimit: 3 },
  hosted_domains: { enabled: true, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 10, pendingDays: 7, autoClaimLimit: 1000 },
} as unknown as Settings;

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  post: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.get, updateSettings: mocks.update } }));
vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));

import { parseReservedLocalParts, SECRET_MASK, SettingsPage } from './settings-page';

function mount() {
  mocks.get.mockResolvedValue(structuredClone(SETTINGS));
  mocks.update.mockImplementation(async (patch: Partial<Settings>) => ({ ...structuredClone(SETTINGS), ...patch }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path: '/admin/settings', element: <SettingsPage /> },
      { path: '/admin/users', element: <p>用户页</p> },
    ],
    { initialEntries: ['/admin/settings'] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

describe('parseReservedLocalParts', () => {
  it('支持逗号（含全角）、空白、换行分隔，转小写并去重', () => {
    expect(parseReservedLocalParts('Admin, root，ops\nhelp  admin、')).toEqual(['admin', 'root', 'ops', 'help']);
    expect(parseReservedLocalParts(' , \n')).toEqual([]);
  });
});

describe('SettingsPage 保留前缀', () => {
  it('输入逗号不会被吞掉，保存时提交解析后的数组', async () => {
    const { client } = mount();
    const textarea = await screen.findByDisplayValue('admin, root');

    fireEvent.change(textarea, { target: { value: 'admin, root, ' } });
    expect(textarea).toHaveValue('admin, root, ');
    // 只多了分隔符，解析结果不变，不算改动
    expect(screen.queryByText('有未保存的更改')).toBeNull();

    fireEvent.change(textarea, { target: { value: 'admin, root, Billing\nops' } });
    expect(textarea).toHaveValue('admin, root, Billing\nops');
    expect(screen.getByText('共 4 个')).toBeInTheDocument();

    fireEvent.blur(textarea);
    expect(textarea).toHaveValue('admin, root, billing, ops');

    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          mailbox_policy: { perUserLimit: 5, reservedLocalParts: ['admin', 'root', 'billing', 'ops'] },
        }),
      ),
    );
    expect(mocks.update.mock.calls[0]![0]).not.toHaveProperty('domains');
    client.clear();
  });

  it('有未保存改动时站内跳转先确认，选择留下则不离开', async () => {
    const { client, router } = mount();
    const textarea = await screen.findByDisplayValue('admin, root');
    fireEvent.change(textarea, { target: { value: 'admin' } });

    void router.navigate('/admin/users');
    expect(await screen.findByText('离开此页？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '留在此页' }));
    await waitFor(() => expect(screen.queryByText('离开此页？')).toBeNull());
    expect(router.state.location.pathname).toBe('/admin/settings');

    void router.navigate('/admin/users');
    fireEvent.click(await screen.findByRole('button', { name: '放弃改动并离开' }));
    expect(await screen.findByText('用户页')).toBeInTheDocument();
    client.clear();
  });
});

describe('SettingsPage AI 模型与翻译', () => {
  const saveAiModel = async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    return mocks.update.mock.calls.at(-1)![0].ai_model as Settings['ai_model'];
  };

  it('本地掩码常量与 shared 一致', () => {
    expect(SECRET_MASK).toBe(SHARED_SECRET_MASK);
  });

  it('已配置的 Key 显示为空输入框；不改 Key 提交掩码，输入新值即替换', async () => {
    mocks.update.mockClear();
    const { client } = mount();
    const keyInput = await screen.findByPlaceholderText('已配置（输入可替换，清除请用按钮）');
    expect(keyInput).toHaveValue('');

    fireEvent.change(screen.getByDisplayValue('deepseek-flash'), { target: { value: 'deepseek-chat' } });
    expect((await saveAiModel())).toMatchObject({ apiKey: SECRET_MASK, model: 'deepseek-chat' });

    fireEvent.change(keyInput, { target: { value: 'sk-new' } });
    expect((await saveAiModel()).apiKey).toBe('sk-new');
    client.clear();
  });

  it('输入后删空恢复为保持原值；清除按钮提交空串删除 Key', async () => {
    mocks.update.mockClear();
    const { client } = mount();
    const keyInput = await screen.findByPlaceholderText('已配置（输入可替换，清除请用按钮）');
    fireEvent.change(keyInput, { target: { value: 'sk-typo' } });
    expect(screen.getByText('有未保存的更改')).toBeInTheDocument();
    fireEvent.change(keyInput, { target: { value: '' } });
    expect(screen.queryByText('有未保存的更改')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清除 API Key' }));
    expect(screen.getByPlaceholderText('保存后将删除已配置的 Key')).toBeInTheDocument();
    expect((await saveAiModel()).apiKey).toBe('');
    client.clear();
  });

  it('测试连接使用表单当前值，未改动的 Key 传掩码，显示耗时与示例译文', async () => {
    mocks.post.mockResolvedValueOnce({ ok: true, latencyMs: 812, sample: '你好，世界' });
    const { client } = mount();
    const baseUrl = await screen.findByDisplayValue('https://api.deepseek.com');
    fireEvent.change(baseUrl, { target: { value: 'https://llm.example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        '/admin/settings/ai-model-test',
        { baseUrl: 'https://llm.example.com/v1', apiKey: SECRET_MASK, model: 'deepseek-flash' },
        expect.anything(),
      ),
    );
    expect(await screen.findByText('连接成功 · 耗时 812 ms')).toBeInTheDocument();
    expect(screen.getByText('示例译文：你好，世界')).toBeInTheDocument();

    // 改动配置后旧结果不再展示
    fireEvent.change(screen.getByDisplayValue('deepseek-flash'), { target: { value: 'other-model' } });
    expect(screen.queryByText('连接成功 · 耗时 812 ms')).toBeNull();
    client.clear();
  });

  it('测试失败显示服务端原因；非 https 地址不能测试', async () => {
    const { ApiError } = await import('@/api/errors');
    mocks.post.mockRejectedValueOnce(new ApiError('模型服务返回 401：API Key 无效', { code: 'validation_failed', httpStatus: 400 }));
    const { client } = mount();
    await screen.findByDisplayValue('https://api.deepseek.com');
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }));
    expect(await screen.findByText('模型服务返回 401：API Key 无效')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('https://api.deepseek.com'), { target: { value: 'http://api.deepseek.com' } });
    expect(screen.getByText('接口地址必须以 https:// 开头')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    client.clear();
  });
});

describe('SettingsPage AI 翻译开关', () => {
  it('隐私提示在 AI 模型分区；模型未配置完整时开关旁提示先配置；保存开关与每日上限', async () => {
    mocks.update.mockClear();
    const { client } = mount();
    const toggle = await screen.findByRole('switch', { name: '启用 AI 翻译' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/含验证码关键词但正则未识别出验证码的来信/)).toBeInTheDocument();
    expect(screen.getByText('使用上方 AI 模型；未配置模型时只用正则识别。')).toBeInTheDocument();
    expect(screen.queryByText('需先配置 AI 模型')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清除 API Key' }));
    expect(screen.getByText('需先配置 AI 模型')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('200000'), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update.mock.calls[0]![0]).toMatchObject({
      translation: { enabled: true, dailyCharsPerUser: 50000 },
      ai_model: { apiKey: '' },
    });
    client.clear();
  });
});

describe('SettingsPage 随机认领规则', () => {
  it('移除旧排除阈值，保留每日上限与未注册天数，保存兼容字段原值', async () => {
    const { client } = mount();
    const days = await screen.findByRole('spinbutton', { name: /未注册邮箱计入天数/ });
    const daily = screen.getByRole('spinbutton', { name: /每个后缀每日新增上限/ });
    expect(screen.queryByRole('spinbutton', { name: /付费被封排除阈值/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: /封号率排除阈值/ })).not.toBeInTheDocument();
    expect(days).toHaveValue(7);
    expect(daily).toHaveValue(3);
    expect(screen.getByText(/有历史封号记录的域名禁止认领/)).toHaveTextContent('不保证未来不会封号');

    fireEvent.change(days, { target: { value: '120' } });
    // 超过上限按 90 天截断
    expect(days).toHaveValue(90);
    fireEvent.change(daily, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ claim_random: { paidSuspendedLimit: 2, pendingDays: 90, suspendedPercent: 50, dailyLimit: 0 } }),
      ),
    );
    expect(mocks.update.mock.calls.at(-1)![0]).not.toHaveProperty('domains');
    client.clear();
  });

  it('旧服务端没有这一块时不显示该分区', async () => {
    const { claim_random: _omit, ...legacy } = structuredClone(SETTINGS);
    mocks.get.mockResolvedValue(legacy);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: '/', element: <SettingsPage /> }]);
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('邮箱认领策略');
    expect(screen.queryByText('随机认领规则')).toBeNull();
    client.clear();
  });
});

describe('SettingsPage 域名托管', () => {
  it('编辑开关与额度，越界值按范围截断，随整页保存提交完整的 hosted_domains', async () => {
    mocks.update.mockClear();
    const { client } = mount();
    const toggle = await screen.findByRole('switch', { name: '启用域名托管' });
    expect(toggle).toBeChecked();
    const days = screen.getByRole('spinbutton', { name: /等待生效天数/ });
    const pendingPerUser = screen.getByRole('spinbutton', { name: /每人同时等待生效数/ });
    expect(days).toHaveValue(7);
    expect(screen.getByRole('spinbutton', { name: /每人最多托管域名数/ })).toHaveValue(3);

    fireEvent.click(toggle);
    fireEvent.change(days, { target: { value: '40' } });
    expect(days).toHaveValue(28);
    fireEvent.change(pendingPerUser, { target: { value: '0' } });
    expect(pendingPerUser).toHaveValue(1);
    fireEvent.change(screen.getByRole('spinbutton', { name: /全站同时等待生效数/ }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          hosted_domains: { enabled: false, maxPerUser: 3, maxPendingPerUser: 1, maxPendingTotal: 20, pendingDays: 28, autoClaimLimit: 1000 },
        }),
      ),
    );
    client.clear();
  });
});

describe('SettingsPage 转发中转配额', () => {
  it('显示中转全站、每人与未认领地址上限，越界按范围截断，随外发配额一起保存', async () => {
    mocks.update.mockClear();
    const { client } = mount();
    const site = await screen.findByRole('spinbutton', { name: /转发中转全站每日上限/ });
    const perUser = screen.getByRole('spinbutton', { name: /转发中转每人每日上限/ });
    const unclaimed = screen.getByRole('spinbutton', { name: /未认领地址转发中转每日上限/ });
    expect(site).toHaveValue(300);
    expect(perUser).toHaveValue(50);
    expect(unclaimed).toHaveValue(50);
    expect(screen.getAllByText(/原生转发不计入/)).toHaveLength(3);

    fireEvent.change(site, { target: { value: '200000' } });
    expect(site).toHaveValue(100000);
    fireEvent.change(perUser, { target: { value: '0' } });
    fireEvent.change(unclaimed, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          quota: { dailyOutbound: 0, dailyRecipients: 0, relayDaily: 100000, relayPerUserDaily: 0, relayUnclaimedDaily: 20 },
        }),
      ),
    );
    client.clear();
  });
});
