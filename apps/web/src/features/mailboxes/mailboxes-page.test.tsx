import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({release:vi.fn(async()=>({success:true,deletedMessages:1})),toast:vi.fn()}));
vi.mock('@/api/resources',()=>({mailboxApi:{release:mocks.release}}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
vi.mock('@/lib/use-config',()=>({useDomains:()=>({data:['example.com']})}));
vi.mock('./use-mailboxes',()=>({useMailboxesQuery:()=>({data:[{id:9,address:'me@example.com',domain:'example.com',displayName:'',messageCount:0,createdAt:'2026-10-05T00:00:00Z'}],isLoading:false,isError:false})}));
import { MailboxesPage } from './mailboxes-page';
describe('mailbox release',()=>{
  it('offers clearing history even if the cached count is zero and refreshes all ownership-dependent data',async()=>{
    const client=new QueryClient();
    const invalidate=vi.spyOn(client,'invalidateQueries');
    client.setQueryData(['messages','detail',7],{privateBody:'old owner'});
    render(<QueryClientProvider client={client}><MemoryRouter><MailboxesPage/></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button',{name:'释放地址'}));
    fireEvent.click(screen.getByRole('checkbox',{name:'同时永久删除该地址的全部历史邮件'}));
    fireEvent.click(screen.getByRole('button',{name:'释放并删除历史'}));
    await waitFor(()=>expect(mocks.release).toHaveBeenCalledWith(9,true));
    await waitFor(()=>expect(invalidate).toHaveBeenCalledWith({queryKey:['admin','mailbox-shares']}));
    expect(client.getQueryData(['messages','detail',7])).toBeUndefined();
    client.clear();
  });
});
