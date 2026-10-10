import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ mode: 'closed' as 'closed' | 'invite' | 'open' }));
const login = vi.hoisted(() => vi.fn(async () => {
  throw new Error('offline');
}));
const register = vi.hoisted(() => vi.fn(async () => {
  throw new Error('offline');
}));
vi.mock('@/api/resources', () => ({ authApi: { login, register } }));

vi.mock('@/lib/use-config', () => ({
  usePublicConfig: () => ({
    data: { siteTitle: 'HPC Mail', registrationMode: config.mode, domains: [] },
    isLoading: false,
  }),
}));

import { LoginPage } from './login-page';

function renderPage(children: ReactNode = <LoginPage />) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/login']}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoginPage 注册模式分支', () => {
  beforeEach(() => localStorage.clear());

  it('closed 模式不显示注册入口', () => {
    config.mode = 'closed';
    renderPage();
    expect(screen.queryByRole('radio', { name: '注册' })).toBeNull();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('invite 模式的注册需要邀请码字段', async () => {
    config.mode = 'invite';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    expect(screen.getByText('邀请码')).toBeInTheDocument();
  });

  it('open 模式的注册不显示邀请码字段', async () => {
    config.mode = 'open';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    expect(screen.queryByText('邀请码')).toBeNull();
  });
});

describe('LoginPage 提交前校验', () => {
  beforeEach(() => {
    localStorage.clear();
    login.mockClear();
    config.mode = 'closed';
  });

  it('提交时按需加载契约，非法用户名不发请求', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/用户名/, { selector: 'input' }), 'A!');
    await user.type(screen.getByLabelText(/密码/, { selector: 'input' }), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户名需为 3-32 位');
    expect(login).not.toHaveBeenCalled();
  });

  it('校验通过后发起登录', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/用户名/, { selector: 'input' }), 'alice');
    await user.type(screen.getByLabelText(/密码/, { selector: 'input' }), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(1));
  });
});

describe('LoginPage 字段级错误', () => {
  beforeEach(() => {
    localStorage.clear();
    login.mockClear();
    register.mockClear();
  });

  const field = (label: RegExp) => screen.getByLabelText(label, { selector: 'input' });

  it('用户名为空时在用户名字段下提示，不发请求', async () => {
    config.mode = 'closed';
    const user = userEvent.setup();
    renderPage();
    await user.type(field(/密码/), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入用户名');
    expect(field(/用户名/)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/密码/)).not.toHaveAttribute('aria-invalid');
    // 修改该字段后错误消失
    await user.type(field(/用户名/), 'a');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(login).not.toHaveBeenCalled();
  });

  it('注册时两次密码不一致在确认密码字段下提示', async () => {
    config.mode = 'open';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    await user.type(field(/^用户名/), 'alice');
    await user.type(field(/^密码/), 'password-1');
    await user.type(field(/^确认密码/), 'password-2');
    await user.click(screen.getByRole('button', { name: '注册并登录' }));
    expect(screen.getByRole('alert')).toHaveTextContent('两次输入的密码不一致');
    expect(field(/^确认密码/)).toHaveAttribute('aria-invalid', 'true');
    expect(register).not.toHaveBeenCalled();
  });

  it('契约校验错误归位到对应字段', async () => {
    config.mode = 'open';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    await user.type(field(/^用户名/), 'alice');
    await user.type(field(/^密码/), 'short');
    await user.type(field(/^确认密码/), 'short');
    await user.click(screen.getByRole('button', { name: '注册并登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('密码至少 8 位');
    expect(field(/^密码/)).toHaveAttribute('aria-invalid', 'true');
    expect(field(/^用户名/)).not.toHaveAttribute('aria-invalid');
    expect(register).not.toHaveBeenCalled();
  });

  it('邀请码为空提示在邀请码字段，切换模式清空确认密码', async () => {
    config.mode = 'invite';
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    await user.type(field(/^用户名/), 'alice');
    await user.type(field(/^密码/), 'password-1');
    await user.type(field(/^确认密码/), 'password-1');
    await user.click(screen.getByRole('button', { name: '注册并登录' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请输入邀请码');
    expect(field(/^邀请码/)).toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('radio', { name: '登录' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '注册' }));
    expect(field(/^确认密码/)).toHaveValue('');
  });
});
