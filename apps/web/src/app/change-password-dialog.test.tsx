import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangePasswordResponse } from '@hpc-mail/shared';

const mocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/api/resources', () => ({ authApi: { changePassword: mocks.changePassword } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { ChangePasswordDialog } from './change-password-dialog';

// Radix Checkbox 用 ResizeObserver 测量尺寸，jsdom 没有
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function response(revokedApiKeys: number): ChangePasswordResponse {
  return { token: 'rotated-jwt', user: { id: 1, username: 'me', role: 'user' } as ChangePasswordResponse['user'], revokedApiKeys };
}

function show() {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChangePasswordDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/当前密码/), { target: { value: 'old-password' } });
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'new-password-1' } });
  fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: 'new-password-1' } });
  return { onOpenChange };
}

beforeEach(() => {
  localStorage.clear();
  mocks.changePassword.mockReset();
  mocks.toast.mockClear();
});

describe('ChangePasswordDialog', () => {
  it('revokes all API keys by default, explains the consequence and reports how many were revoked', async () => {
    mocks.changePassword.mockResolvedValue(response(2));
    const { onOpenChange } = show();
    const revoke = screen.getByRole('checkbox', { name: /同时吊销我的全部 API Key/ });
    expect(revoke).toBeChecked();
    expect(screen.getByText(/使用这些 Key 的脚本和 AI Agent 立即失效/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.changePassword).toHaveBeenCalledWith({ oldPassword: 'old-password', newPassword: 'new-password-1', revokeApiKeys: true });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '密码已修改', description: expect.stringContaining('已吊销 2 个 API Key') }));
    expect(localStorage.getItem('token')).toBe('rotated-jwt');
  });

  it('keeps API keys when the user unticks the option', async () => {
    mocks.changePassword.mockResolvedValue(response(0));
    const { onOpenChange } = show();
    fireEvent.click(screen.getByRole('checkbox', { name: /同时吊销我的全部 API Key/ }));
    expect(screen.getByRole('checkbox', { name: /同时吊销我的全部 API Key/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.changePassword).toHaveBeenCalledWith({ oldPassword: 'old-password', newPassword: 'new-password-1', revokeApiKeys: false });
    expect(mocks.toast).toHaveBeenCalledWith({ title: '密码已修改', description: undefined, variant: 'success' });
  });
});
