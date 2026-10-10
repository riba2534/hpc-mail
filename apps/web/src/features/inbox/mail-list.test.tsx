import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageSummary } from '@hpc-mail/shared';
const mocks=vi.hoisted(()=>({restore:vi.fn(async(_ids:number[])=>({changed:0})),purge:vi.fn(async()=>({changed:1})),remove:vi.fn(async(ids:number[])=>({deleted:ids.length})),markRead:vi.fn(async(ids:number[])=>({changed:ids.length})),star:vi.fn(async(ids:number[])=>({changed:ids.length})),toast:vi.fn(),items:[] as MessageSummary[]}));
vi.mock('@/api/resources',()=>({messageApi:{restore:mocks.restore,purge:mocks.purge,remove:mocks.remove,markRead:mocks.markRead,star:mocks.star}}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
vi.mock('@/features/mailboxes/use-mailboxes',()=>({useMailboxesQuery:()=>({data:[{id:1,address:'me@example.com',domain:'example.com'}]})}));
vi.mock('./use-star',()=>({useStarMutation:()=>({mutate:vi.fn()})}));
vi.mock('./use-messages',()=>({useMessagesQuery:()=>({data:{pages:[{items:mocks.items}]},isLoading:false,isError:false,fetchNextPage:vi.fn(),hasNextPage:false,isFetchingNextPage:false,refetch:vi.fn()})}));
vi.mock('@tanstack/react-virtual',()=>({useWindowVirtualizer:()=>({getVirtualItems:()=>mocks.items.map((_,index)=>({index,start:index*84})),getTotalSize:()=>mocks.items.length*84,measureElement:vi.fn(),scrollToIndex:vi.fn()})}));
import { MailList } from './mail-list';
const mail=(id:number,extra:Partial<MessageSummary>={})=>({id,direction:'inbound',address:'me@example.com',domain:'example.com',fromAddress:'sender@example.com',fromName:'',subject:`mail-${id}`,preview:'body',verificationCode:'',status:'received',errorDetail:'',isRead:true,isStarred:false,hasAttachments:false,size:4,createdAt:'2026-10-05T00:00:00Z',...extra}) as MessageSummary;
beforeEach(()=>{mocks.toast.mockClear();mocks.remove.mockClear();mocks.markRead.mockClear();mocks.restore.mockClear();mocks.items=[1,2].map((id)=>mail(id))});
function Detail(){const location=useLocation();return <p>detail {location.pathname} {JSON.stringify(location.state)}</p>}
function show(query:Partial<ListMessagesQuery>={trash:true},variant:'inbox'|'trash'='trash'){const client=new QueryClient();render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<MailList query={query} variant={variant} emptyTitle="empty"/>}/><Route path="/mail/:id" element={<Detail/>}/></Routes></MemoryRouter></QueryClientProvider>);return client}
function selectAll(){fireEvent.click(screen.getAllByRole('checkbox',{name:/^选择：/})[0]!);fireEvent.click(screen.getByRole('checkbox',{name:/^选择：/}))}
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
  it('shows the remaining retention days and no star in the trash',()=>{
    mocks.items=[mail(1,{deletedAt:new Date(Date.now()-2*86_400_000).toISOString()})];
    const client=show();
    expect(screen.getByText('5 天后清除')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'加星标'})).toBeNull();
    client.clear();
  });
});

describe('inbox list toolbar and rows',()=>{
  const inbox={scope:'mine' as const,direction:'inbound' as const};
  it('select-all checkbox selects every loaded row in place',()=>{
    const client=show(inbox,'inbox');
    fireEvent.click(screen.getByRole('checkbox',{name:'全选已加载（2 封）'}));
    expect(screen.getByText('已选 2 封')).toBeInTheDocument();
    expect(screen.getByRole('checkbox',{name:'取消全选'})).toHaveAttribute('aria-checked','true');
    client.clear();
  });
  it('skips shared mail when marking read and explains why',async()=>{
    mocks.items=[mail(1,{isRead:false}),mail(2,{isRead:false,address:'shared@example.com'})];
    const client=show(inbox,'inbox');selectAll();
    expect(screen.getByText(/已选中 1 封共享邮件/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'标为已读'}));
    await waitFor(()=>expect(mocks.markRead).toHaveBeenCalledWith([1],true,undefined));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:expect.stringContaining('跳过 1 封共享邮件')})));
    client.clear();
  });
  it('shows shared mail as read: the read state belongs to the owner',()=>{
    mocks.items=[mail(1,{isRead:false}),mail(2,{isRead:false,address:'shared@example.com'})];
    const client=show(inbox,'inbox');
    expect(screen.getByRole('link',{name:'未读，sender@example.com，mail-1'})).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'sender@example.com，mail-2'})).toBeInTheDocument();
    client.clear();
  });
  it('disables read actions when only shared mail is selected',()=>{
    mocks.items=[mail(2,{address:'shared@example.com'})];
    const client=show(inbox,'inbox');
    fireEvent.click(screen.getByRole('checkbox',{name:/^选择：/}));
    expect(screen.getByRole('button',{name:'标为已读'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'标为未读'})).toBeDisabled();
    client.clear();
  });
  it('deleting offers an undo that restores the mail',async()=>{
    mocks.restore.mockResolvedValueOnce({changed:1});
    const client=show(inbox,'inbox');
    fireEvent.click(screen.getAllByRole('checkbox',{name:/^选择：/})[0]!);
    fireEvent.click(screen.getByRole('button',{name:'删除'}));
    await waitFor(()=>expect(mocks.remove).toHaveBeenCalledWith([1],undefined));
    const deleted=mocks.toast.mock.calls.map(([input])=>input).find((input)=>input.action);
    expect(deleted).toMatchObject({title:'邮件已删除',duration:5000,action:{label:'撤销'}});
    await act(async()=>deleted.action.onClick());
    expect(mocks.restore).toHaveBeenCalledWith([1],undefined);
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'已撤销删除'})));
    client.clear();
  });
  it('copies a verification code from the row without opening the mail',async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
    mocks.items=[mail(1,{verificationCode:'482913',verificationLink:'https://login.example.com/verify?t=1'})];
    const client=show(inbox,'inbox');
    fireEvent.click(screen.getByRole('button',{name:'复制验证码 482913'}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith('482913'));
    expect(await screen.findByRole('button',{name:'已复制验证码 482913'})).toBeInTheDocument();
    expect(screen.queryByText(/^detail/)).toBeNull();
    const link=screen.getByRole('link',{name:'打开验证链接 login.example.com'});
    expect(link).toHaveAttribute('target','_blank');
    expect(link).toHaveAttribute('rel','noopener noreferrer');
    client.clear();
  });
  it('row checkboxes are named after the sender and subject',()=>{
    const client=show(inbox,'inbox');
    fireEvent.click(screen.getByRole('checkbox',{name:'选择：sender@example.com - mail-1'}));
    expect(screen.getByRole('checkbox',{name:'取消选择：sender@example.com - mail-1'})).toHaveAttribute('aria-checked','true');
    expect(screen.getByRole('checkbox',{name:'选择：sender@example.com - mail-2'})).toHaveAttribute('aria-checked','false');
    client.clear();
  });
  it('a verification link on a different domain is only a warning that leads to the detail page',async()=>{
    mocks.items=[mail(1,{fromAddress:'service@paypal.example',verificationLink:'https://login-secure-check.example/verify'})];
    const client=show(inbox,'inbox');
    expect(screen.queryByRole('link',{name:/打开验证链接/})).toBeNull();
    expect(screen.getByText('链接域名不一致')).toBeInTheDocument();
    expect(document.querySelector('a[href^="https://login-secure-check.example"]')).toBeNull();
    const row=screen.getByRole('link',{name:'service@paypal.example，mail-1，验证链接域名与发件人不一致'});
    fireEvent.click(row);
    expect(await screen.findByText(/detail \/mail\/1/)).toBeInTheDocument();
    client.clear();
  });
  it('keyboard: j moves focus, x selects, e deletes, o opens with list context',async()=>{
    const client=show(inbox,'inbox');
    fireEvent.keyDown(window,{key:'j'});
    await waitFor(()=>expect(document.activeElement).toHaveAccessibleName('sender@example.com，mail-1'));
    fireEvent.keyDown(window,{key:'j'});
    await waitFor(()=>expect(document.activeElement).toHaveAccessibleName('sender@example.com，mail-2'));
    fireEvent.keyDown(window,{key:'x'});
    expect(screen.getByText('已选 1 封')).toBeInTheDocument();
    fireEvent.keyDown(window,{key:'e'});
    await waitFor(()=>expect(mocks.remove).toHaveBeenCalledWith([2],undefined));
    fireEvent.keyDown(window,{key:'k'});
    fireEvent.keyDown(window,{key:'o'});
    expect(await screen.findByText(/detail \/mail\/1/)).toHaveTextContent('"direction":"inbound"');
    client.clear();
  });
});
