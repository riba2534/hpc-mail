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
  quota: { dailyOutbound: 0, dailyRecipients: 0 },
  mailbox_policy: { perUserLimit: 5, reservedLocalParts: ['admin', 'root'] },
  ai_model: { baseUrl: 'https://api.deepseek.com', apiKey: '******', model: 'deepseek-flash' },
  translation: { enabled: true, dailyCharsPerUser: 200000 },
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
