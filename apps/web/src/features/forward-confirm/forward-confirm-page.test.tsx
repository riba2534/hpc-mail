import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => ({ address: 'friend@example.net' })) }));
vi.mock('@/api/resources', () => ({ notifyPrefsApi: { confirmForward: mocks.confirm } }));
import { ForwardConfirmPage, tokenFromHash } from './forward-confirm-page';

function renderPage(hash: string) {
  window.history.replaceState(null, '', `/forward/confirm${hash}`);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ForwardConfirmPage /></QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe('转发目标确认页', () => {
  it('从 # 后取 token', () => {
    expect(tokenFromHash('#token=abc123')).toBe('abc123');
    expect(tokenFromHash('')).toBe('');
  });

  it('打开页面不自动确认，点按钮才确认', async () => {
    renderPage(`#token=${'a'.repeat(64)}`);
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '同意接收转发' }));
    expect(await screen.findByRole('status')).toHaveTextContent('friend@example.net');
    expect(mocks.confirm).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('链接缺 token 时提示，不显示按钮', () => {
    renderPage('');
    expect(screen.getByRole('alert')).toHaveTextContent('链接不完整');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
