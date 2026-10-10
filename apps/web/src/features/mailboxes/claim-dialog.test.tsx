import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  claim: vi.fn(async (body: { localPart: string; domain: string }) => ({ address: `${body.localPart}@${body.domain}` })),
  availability: vi.fn(async (): Promise<{ available: boolean; reason?: string }> => ({ available: true })),
  toast: vi.fn(),
  writeClipboard: vi.fn(async () => true),
}));
vi.mock('@/api/resources', () => ({ mailboxApi: { claim: mocks.claim, availability: mocks.availability } }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('@/components/ui/copy-button', () => ({ writeClipboard: mocks.writeClipboard }));
import { ClaimDialog } from './claim-dialog';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function renderDialog(domains = ['example.com'], onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (list: string[]) => (
    <QueryClientProvider client={client}>
      <ClaimDialog open onOpenChange={onOpenChange} domains={list} />
    </QueryClientProvider>
  );
  const view = render(wrap(domains));
  return { client, view, rerender: (list: string[]) => view.rerender(wrap(list)) };
}

afterEach(() => vi.clearAllMocks());

describe('claim selected domain retention', () => {
  it('chooses an available domain when the previous selection is removed', async () => {
    const { client, rerender } = renderDialog(['old.example', 'new.example']);
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'test' } });
    rerender(['new.example']);
    fireEvent.click(screen.getByRole('button', { name: '认领' }));
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith({ localPart: 'test', domain: 'new.example' }));
    client.clear();
  });
});

describe('认领可用性原因', () => {
  it.each([
    ['taken', '该地址已被占用'],
    ['reserved', '该前缀为系统保留'],
    ['quota', '已达个人上限'],
    ['domain_limit', '该域名下的认领数已达上限'],
    ['domain_unavailable', '该域名当前不可认领'],
  ])('reason=%s 显示对应提示并禁用提交', async (reason, text) => {
    mocks.availability.mockResolvedValueOnce({ available: false, reason });
    const { client } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    expect(await screen.findByText(new RegExp(text), {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领' })).toBeDisabled();
    expect(screen.getByLabelText('前缀')).toHaveAttribute('aria-invalid', 'true');
    client.clear();
  });

  it('可认领时提示完整地址', async () => {
    const { client } = renderDialog();
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    expect(await screen.findByText('hello@example.com 可以认领', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '认领' })).toBeEnabled();
    client.clear();
  });
});

describe('随机生成与认领成功', () => {
  it('随机生成立即填入合法前缀并跳过防抖查询可用性', async () => {
    const { client } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '随机生成' }));
    const value = (screen.getByLabelText('前缀') as HTMLInputElement).value;
    expect(value).toMatch(/^[a-z][a-z2-9]{7}$/);
    await waitFor(() => expect(mocks.availability).toHaveBeenCalledWith(value, 'example.com'));
    client.clear();
  });

  it('成功 toast 带「复制地址」操作，点击复制完整地址', async () => {
    const onOpenChange = vi.fn();
    const { client } = renderDialog(['example.com'], onOpenChange);
    fireEvent.change(screen.getByPlaceholderText('例如 hello'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: '认领' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const success = mocks.toast.mock.calls.map(([input]) => input).find((input) => input.title === '地址认领成功');
    expect(success).toMatchObject({ description: 'hello@example.com', action: { label: '复制地址' } });
    success.action.onClick();
    await waitFor(() => expect(mocks.writeClipboard).toHaveBeenCalledWith('hello@example.com'));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: '已复制到剪贴板', variant: 'success' }));
    client.clear();
  });
});
