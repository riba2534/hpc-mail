import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@hpc-mail/shared';
import { CurrentUserContext } from '@/lib/use-session';
const mocks = vi.hoisted(() => ({
  setup: vi.fn(async () => ({
    secret: 'JBSWY3DPEHPK3PXP',
    otpauthUri: 'otpauth://totp/HPC%20Mail:alice?secret=JBSWY3DPEHPK3PXP&issuer=HPC%20Mail',
  })),
  enable: vi.fn(async () => ({ recoveryCodes: ['aaaa-1111', 'bbbb-2222'] })),
}));
vi.mock('@/api/resources', () => ({ authApi: { setup2fa: mocks.setup, enable2fa: mocks.enable, disable2fa: vi.fn() } }));
import { recoveryCodesText, TwoFactorSection } from './two-factor-section';

const user: SessionUser = { id: 1, username: 'alice', role: 'user', createdAt: '', avatarUrl: null, twoFactorEnabled: false };

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CurrentUserContext.Provider value={user}>
        <TwoFactorSection />
      </CurrentUserContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}

async function enableToRecovery() {
  fireEvent.click(screen.getByRole('button', { name: '启用两步验证' }));
  expect(await screen.findByRole('img', { name: '两步验证二维码' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('6 位验证码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并启用' }));
  return screen.findByRole('dialog', { name: '保存恢复码' });
}

afterEach(() => vi.clearAllMocks());

describe('两步验证', () => {
  it('启用时本地渲染二维码，并提供「复制密钥」「复制链接」两个按钮', async () => {
    const client = renderSection();
    fireEvent.click(screen.getByRole('button', { name: '启用两步验证' }));
    expect(await screen.findByRole('img', { name: '两步验证二维码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制密钥' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制链接' })).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    client.clear();
  });

  it('验证码不足 6 位就地提示，不调用接口', async () => {
    const client = renderSection();
    fireEvent.click(screen.getByRole('button', { name: '启用两步验证' }));
    await screen.findByRole('img', { name: '两步验证二维码' });
    fireEvent.change(screen.getByLabelText('6 位验证码'), { target: { value: '12a3' } });
    expect(screen.getByLabelText('6 位验证码')).toHaveValue('123');
    fireEvent.click(screen.getByRole('button', { name: '验证并启用' }));
    expect(screen.getByRole('alert')).toHaveTextContent('6 位数字');
    expect(mocks.enable).not.toHaveBeenCalled();
    client.clear();
  });

  it('未保存恢复码就关闭时要求确认', async () => {
    const client = renderSection();
    await enableToRecovery();
    fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
    expect(await screen.findByRole('dialog', { name: '确认已保存恢复码？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认已保存恢复码？' })).toBeNull());
    expect(screen.getByRole('dialog', { name: '保存恢复码' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
    fireEvent.click(await screen.findByRole('button', { name: '已保存，关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    client.clear();
  });

  it('下载 .txt 后可直接关闭', async () => {
    const createObjectURL = vi.fn(() => 'blob:codes');
    const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const client = renderSection();
    await enableToRecovery();
    fireEvent.click(screen.getByRole('button', { name: '下载 .txt' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('hpc-mail-recovery-codes-alice.txt');
    fireEvent.click(screen.getByRole('button', { name: '我已保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    click.mockRestore();
    Object.assign(URL, original);
    client.clear();
  });

  it('恢复码文本包含账户与全部恢复码', () => {
    const text = recoveryCodesText('alice', ['aaaa-1111', 'bbbb-2222'], new Date('2026-10-10T00:00:00Z'));
    expect(text).toContain('账户：alice');
    expect(text).toContain('aaaa-1111\nbbbb-2222');
  });
});
