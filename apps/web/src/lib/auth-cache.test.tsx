import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/api/resources', () => ({
  authApi: { me: vi.fn(async () => ({ id: localStorage.getItem('token') === 'A' ? 1 : 2, username: localStorage.getItem('token') })) },
  mailboxApi: { list: vi.fn(async () => [{ address: `${localStorage.getItem('token')}@example.com` }]) },
}));
import { setAuthToken } from './auth-token';
import { useSessionQuery } from './use-session';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
function Probe() { const session = useSessionQuery(); const boxes = useMailboxesQuery(); return <div>session={session.data?.username};mailbox={boxes.data?.[0]?.address}</div>; }
describe('account cache isolation', () => {
  beforeEach(() => localStorage.clear());
  it('clears cached mail and reloads the new account on cross-tab token changes', async () => {
    setAuthToken('A');
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    await screen.findByText('session=A;mailbox=A@example.com');
    client.setQueryData(['messages', 'detail', 1], { privateBody: 'account A secret' });
    act(() => {
      localStorage.setItem('token', 'B');
      window.dispatchEvent(new StorageEvent('storage', { key: 'token', oldValue: 'A', newValue: 'B' }));
    });
    expect(client.getQueryData(['messages', 'detail', 1])).toBeUndefined();
    expect(screen.queryByText('session=A;mailbox=A@example.com')).toBeNull();
    await screen.findByText('session=B;mailbox=B@example.com');
    act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    expect(client.getQueryData(['messages', 'detail', 1])).toBeUndefined();
    expect(screen.queryByText('session=B;mailbox=B@example.com')).toBeNull();
    client.clear();
  });
});
