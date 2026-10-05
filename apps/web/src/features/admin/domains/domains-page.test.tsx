import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(async (patch) => ({ domains: patch.domains })), toast: vi.fn() }));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.get, updateSettings: mocks.update, domainStatus: vi.fn(async () => ({resolved:false})) } }));
vi.mock('@/features/mailboxes/use-mailboxes', () => ({useMailboxesQuery: () => ({data: []})}));
vi.mock('@/components/ui/toast', () => ({toast: mocks.toast}));
import { DomainsPage } from './domains-page';
import { ApiError } from '@/api/errors';

describe('domain configuration safety', () => {
  it('blocks adding until a failed GET is successfully retried', async () => {
    mocks.get.mockRejectedValueOnce(new Error('settings network error'));
    mocks.get.mockResolvedValue({domains:{revision:7,list:[{domain:'old.example',public:true,perUserLimit:2}]}});
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByRole('button', {name:'重新加载'});
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name:'重新加载'}));
    await screen.findByText('old.example');
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:7,domains:{list:[{domain:'old.example',public:true,perUserLimit:2},{domain:'new.example',public:false,perUserLimit:0}]}}));
    client.clear();
  });
  it('blocks adding while settings are still pending', () => {
    mocks.get.mockImplementation(() => new Promise(() => {})); mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    expect(screen.getByPlaceholderText('example.com')).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', {name:'添加'}).closest('form')!);
    expect(mocks.update).not.toHaveBeenCalled();
    client.clear();
  });
  it('reloads configuration on concurrent revision conflicts', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[]}});
    mocks.update.mockRejectedValueOnce(new ApiError('changed', {code:'conflict',httpStatus:409}));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('还没有配置收件域名');
    const calls = mocks.get.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(calls));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:expect.stringContaining('重新加载')}));
    client.clear();
  });
});
