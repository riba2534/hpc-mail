import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangePasswordResponse } from '@hpc-mail/shared';
import { queryKeys } from '@/api/query-keys';
import { getAuthRevision, setAuthToken } from '@/lib/auth-token';

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

function show(client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ChangePasswordDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/当前密码/), { target: { value: 'old-password' } });
  fireEvent.change(screen.getByLabelText(/^新密码/), { target: { value: 'new-password-1' } });
  fireEvent.change(screen.getByLabelText(/确认新密码/), { target: { value: 'new-password-1' } });
  return { onOpenChange, client };
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

  it('同一账户换发 token：保留查询缓存并预填新一代会话，外壳不必重新加载用户', async () => {
    const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '');
    const jwt = (sid: string) => `${b64url({ alg: 'HS256' })}.${b64url({ sub: 1, sid })}.sig`;
    setAuthToken(jwt('before'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(['messages', 'detail', 1], { body: 'mine' });
    const before = getAuthRevision();
    mocks.changePassword.mockResolvedValue({ ...response(0), token: jwt('after') });
    const { onOpenChange } = show(client);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(getAuthRevision()).toBe(before + 1);
    expect(client.getQueryData(queryKeys.sessionForRevision(getAuthRevision()))).toEqual(response(0).user);
    expect(client.getQueryData(['messages', 'detail', 1])).toEqual({ body: 'mine' });
  });
});
