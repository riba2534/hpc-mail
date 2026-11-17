import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListMessagesQuery, MessageSummary } from '@hpc-mail/shared';
const mocks=vi.hoisted(()=>({restore:vi.fn(async(_ids:number[])=>({changed:0})),purge:vi.fn(async()=>({changed:1})),remove:vi.fn(async(ids:number[])=>({deleted:ids.length})),markRead:vi.fn(async(ids:number[])=>({changed:ids.length})),star:vi.fn(async(ids:number[])=>({changed:ids.length})),toast:vi.fn(),dismissToast:vi.fn(),items:[] as MessageSummary[],placeholder:false,hasNext:false,detail:vi.fn((_id:number,_view?:unknown,signal?:AbortSignal)=>new Promise((_,reject)=>{signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))}))}));
vi.mock('@/api/resources',()=>({messageApi:{restore:mocks.restore,purge:mocks.purge,remove:mocks.remove,markRead:mocks.markRead,star:mocks.star,detail:mocks.detail}}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast,dismissToast:mocks.dismissToast}));
vi.mock('@/features/mailboxes/use-mailboxes',()=>({useMailboxesQuery:()=>({data:[{id:1,address:'me@example.com',domain:'example.com'}]})}));
vi.mock('./use-star',()=>({useStarMutation:()=>({mutate:vi.fn()})}));
vi.mock('./use-messages',()=>({useMessagesQuery:()=>({data:{pages:[{items:mocks.items}]},isLoading:false,isPlaceholderData:mocks.placeholder,isError:false,fetchNextPage:vi.fn(),hasNextPage:mocks.hasNext,isFetchingNextPage:false,refetch:vi.fn()})}));
vi.mock('@tanstack/react-virtual',()=>({useWindowVirtualizer:()=>({getVirtualItems:()=>mocks.items.map((_,index)=>({index,start:index*84})),getTotalSize:()=>mocks.items.length*84,measureElement:vi.fn(),scrollToIndex:vi.fn()})}));
import { MailList } from './mail-list';
const mail=(id:number,extra:Partial<MessageSummary>={})=>({id,direction:'inbound',address:'me@example.com',domain:'example.com',fromAddress:'sender@example.com',fromName:'',subject:`mail-${id}`,preview:'body',verificationCode:'',status:'received',errorDetail:'',isRead:true,isStarred:false,hasAttachments:false,size:4,createdAt:'2026-10-05T00:00:00Z',...extra}) as MessageSummary;
beforeEach(()=>{mocks.placeholder=false;mocks.hasNext=false;mocks.detail.mockClear();mocks.dismissToast.mockClear();mocks.toast.mockClear();mocks.remove.mockClear();mocks.markRead.mockClear();mocks.restore.mockClear();mocks.items=[1,2].map((id)=>mail(id))});
function Detail(){const location=useLocation();return <p>detail {location.pathname} {JSON.stringify(location.state)}</p>}
function show(query:Partial<ListMessagesQuery>={trash:true},variant:'inbox'|'trash'='trash',client=new QueryClient()){render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<MailList query={query} variant={variant} emptyTitle="empty"/>}/><Route path="/mail/:id" element={<Detail/>}/></Routes></MemoryRouter></QueryClientProvider>);return client}
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
  it('a failed batch write shows the server reason and request id once',async()=>{
    const {queryClient}=await import('@/lib/query-client');
    const {ApiError}=await import('@/api/errors');
    mocks.markRead.mockRejectedValueOnce(new ApiError('没有权限修改这些邮件',{code:'forbidden',httpStatus:403,requestId:'req-7'}));
    show(inbox,'inbox',queryClient);selectAll();
    fireEvent.click(screen.getByRole('button',{name:'标为已读'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith({title:'标记失败',description:'没有权限修改这些邮件',requestId:'req-7',variant:'error'}));
    expect(mocks.toast).toHaveBeenCalledOnce();
    queryClient.clear();
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

describe('list semantics and undo shortcut',()=>{
  const inbox={scope:'mine' as const,direction:'inbound' as const};
  it('exposes the virtual rows as a list with their position in the set',()=>{
    mocks.items=[1,2,3].map((id)=>mail(id));
    const client=show(inbox,'inbox');
    const list=screen.getByRole('list',{name:'邮件列表'});
    const rows=within(list).getAllByRole('listitem');
    expect(rows.map((row)=>[row.getAttribute('aria-posinset'),row.getAttribute('aria-setsize')])).toEqual([['1','3'],['2','3'],['3','3']]);
    expect(list).not.toHaveAttribute('aria-busy');
    client.clear();
  });
  it('reports an unknown set size while more pages remain, and marks the list busy while showing previous results',()=>{
    mocks.hasNext=true;mocks.placeholder=true;
    const client=show(inbox,'inbox');
    const list=screen.getByRole('list',{name:'邮件列表'});
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize','-1');
    expect(list).toHaveAttribute('aria-busy','true');
    client.clear();
  });
  it('z undoes the latest delete like the toast button, once, and only within the undo window',async()=>{
    mocks.restore.mockResolvedValue({changed:1});
    mocks.toast.mockReturnValue(41);
    const client=show(inbox,'inbox');
    fireEvent.keyDown(window,{key:'j'});
    await waitFor(()=>expect(document.activeElement).toHaveAccessibleName('sender@example.com，mail-1'));
    fireEvent.keyDown(window,{key:'e'});
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'邮件已删除'})));
    fireEvent.keyDown(window,{key:'z'});
    await waitFor(()=>expect(mocks.restore).toHaveBeenCalledWith([1],undefined));
    expect(mocks.dismissToast).toHaveBeenCalledWith(41);
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'已撤销删除'})));
    fireEvent.keyDown(window,{key:'z'});
    await act(()=>new Promise((resolve)=>setTimeout(resolve,20)));
    expect(mocks.restore).toHaveBeenCalledOnce();

    // 撤销窗口过后 z 不再生效
    fireEvent.keyDown(window,{key:'j'});
    fireEvent.keyDown(window,{key:'e'});
    await waitFor(()=>expect(mocks.remove).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(mocks.toast.mock.calls.filter(([input])=>input.action)).toHaveLength(2));
    const now=Date.now();
    const clock=vi.spyOn(Date,'now').mockReturnValue(now+5_001);
    fireEvent.keyDown(window,{key:'z'});
    clock.mockRestore();
    await act(()=>new Promise((resolve)=>setTimeout(resolve,20)));
    expect(mocks.restore).toHaveBeenCalledOnce();
    mocks.restore.mockReset();mocks.restore.mockResolvedValue({changed:0});mocks.toast.mockReset();
    client.clear();
  });
});

describe('hover prefetch',()=>{
  const inbox={scope:'mine' as const,direction:'inbound' as const};
  const wait=(ms:number)=>act(()=>new Promise((resolve)=>setTimeout(resolve,ms)));
  it('waits 250ms on a row before prefetching its detail; passing over a row does not prefetch',async()=>{
    const client=show(inbox,'inbox');
    const row=screen.getByRole('link',{name:'sender@example.com，mail-1'});
    fireEvent.mouseEnter(row);await wait(180);fireEvent.mouseLeave(row);await wait(150);
    expect(mocks.detail).not.toHaveBeenCalled();
    fireEvent.mouseEnter(row);await wait(300);
    expect(mocks.detail.mock.calls.map(([id])=>id)).toEqual([1]);
    client.clear();
  });
  it('keeps at most one hover prefetch in flight: the previous one is cancelled',async()=>{
    const client=show(inbox,'inbox');
    fireEvent.mouseEnter(screen.getByRole('link',{name:'sender@example.com，mail-1'}));await wait(300);
    const first=mocks.detail.mock.calls[0]![2] as AbortSignal;
    expect(first.aborted).toBe(false);
    fireEvent.mouseEnter(screen.getByRole('link',{name:'sender@example.com，mail-2'}));await wait(300);
    expect(mocks.detail.mock.calls.map(([id])=>id)).toEqual([1,2]);
    expect(first.aborted).toBe(true);
    expect((mocks.detail.mock.calls[1]![2] as AbortSignal).aborted).toBe(false);
    client.clear();
  });
});
