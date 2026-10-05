import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const mocks = vi.hoisted(() => ({replace:vi.fn(async () => ({grantees:[{userId:3}]})),toast:vi.fn()}));
vi.mock('@/api/resources', () => ({adminApi:{
  listMailboxShares:vi.fn(async () => [{mailboxId:1,address:'shared@example.com',domain:'example.com',displayName:'',grantees:[{userId:2,username:'disabled-old',grantedAt:'2026-10-01'}]}]),
  listUsers:vi.fn(async () => [{id:2,username:'disabled-old',role:'user',status:'disabled'},{id:3,username:'active-new',role:'user',status:'active'}]),
  replaceMailboxShares:mocks.replace,
}}));
vi.mock('@/components/ui/toast', () => ({toast:mocks.toast}));
import { SharedMailboxesPage } from './shared-mailboxes-page';
vi.stubGlobal('ResizeObserver',class {observe() {} unobserve() {} disconnect() {}});
describe('sharing to a formerly active user', () => {
  it('lets the administrator deselect an inactive member and save a new valid user', async () => {
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><SharedMailboxesPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
    await screen.findByRole('checkbox',{name:'active-new'});
    expect(screen.getByRole('checkbox',{name:/disabled-old/})).toBeChecked();
    expect(screen.getByRole('button',{name:'保存'})).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{name:/disabled-old/}));
    fireEvent.click(screen.getByRole('checkbox',{name:'active-new'}));
    fireEvent.click(screen.getByRole('button',{name:'保存'}));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({mailboxId:1,userIds:[3]}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    client.clear();
  });
});
