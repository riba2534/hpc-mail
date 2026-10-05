import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({restore:vi.fn(async()=>({changed:0})),purge:vi.fn(async()=>({changed:1})),toast:vi.fn()}));
vi.mock('@/api/resources',()=>({messageApi:{restore:mocks.restore,purge:mocks.purge}}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
vi.mock('@/features/mailboxes/use-mailboxes',()=>({useSharedMailboxesQuery:()=>({data:[]})}));
vi.mock('./use-star',()=>({useStarMutation:()=>({mutate:vi.fn()})}));
vi.mock('./use-messages',()=>({useMessagesQuery:()=>({data:{pages:[{items:[1,2].map((id)=>({id,direction:'inbound',address:'me@example.com',domain:'example.com',fromAddress:'sender@example.com',fromName:'',subject:`mail-${id}`,preview:'body',verificationCode:'',status:'received',errorDetail:'',isRead:true,isStarred:false,hasAttachments:false,size:4,createdAt:'2026-10-05T00:00:00Z'}))}]},isLoading:false,isError:false,fetchNextPage:vi.fn(),hasNextPage:false,isFetchingNextPage:false,refetch:vi.fn()})}));
vi.mock('@tanstack/react-virtual',()=>({useWindowVirtualizer:()=>({getVirtualItems:()=>[0,1].map((index)=>({index,start:index*84})),getTotalSize:()=>168,measureElement:vi.fn()})}));
import { MailList } from './mail-list';
beforeEach(()=>mocks.toast.mockClear());
function show(){const client=new QueryClient();render(<QueryClientProvider client={client}><MemoryRouter><MailList query={{trash:true}} variant="trash" emptyTitle="empty"/></MemoryRouter></QueryClientProvider>);return client}
function selectAll(){fireEvent.click(screen.getAllByRole('checkbox',{name:'选择'})[0]!);fireEvent.click(screen.getByRole('checkbox',{name:'选择'}))}
describe('trash mutation feedback',()=>{
  it('does not report the requested ids as restored when the actual changed count is zero',async()=>{
    const client=show();selectAll();fireEvent.click(screen.getByRole('button',{name:'恢复'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'没有可恢复的邮件'})));
    client.clear();
  });
  it('reports only the number actually purged after a partial selection result',async()=>{
    const client=show();selectAll();fireEvent.click(screen.getByRole('button',{name:'永久删除'}));
    fireEvent.click(screen.getByRole('button',{name:'永久删除 2 封'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'已永久删除 1 封'})));
    client.clear();
  });
});
