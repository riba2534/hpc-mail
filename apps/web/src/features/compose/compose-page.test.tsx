import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({user:{id:1,role:'user'},boxes:[] as Array<{id:number,address:string}>,domains:['one.example'],send:vi.fn(async(_payload:import('@hpc-mail/shared').InternalSendMailRequest,_key?:string)=>({id:22,status:'sent',errorDetail:'',recipientOutcomes:[] as Array<{address:string,status:string,error?:string}>})),single:vi.fn(),remove:vi.fn(async()=>({success:true})),toast:vi.fn()}));
vi.mock('@/api/resources',()=>({messageApi:{contacts:vi.fn(async()=>({contacts:[]})),send:mocks.send},uploadsApi:{single:mocks.single,remove:mocks.remove}}));
vi.mock('@/lib/use-config',()=>({useDomains:()=>({data:mocks.domains})}));
vi.mock('@/lib/use-session',()=>({useCurrentUser:()=>mocks.user}));
vi.mock('@/features/mailboxes/use-mailboxes',()=>({useMailboxesQuery:()=>({data:mocks.boxes})}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
import { ComposePage } from './compose-page';
import { draftKeyForUser, identityKeyForUser, lastIdentityKeyForUser, legacyDraftKeyForUser } from './compose-draft';
import { sendAttemptKeyForUser } from './send-attempt';
import { ApiError, NETWORK_ERROR_MESSAGE, toApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
vi.stubGlobal('ResizeObserver',class {observe() {} unobserve() {} disconnect() {}});
function routerFor(state?: import('./compose-init').ComposeInitial) {return createMemoryRouter([{path:'/compose',element:<ComposePage/>},{path:'/sent',element:<p>sent page</p>},{path:'/inbox',element:<p>inbox page</p>},{path:'/mail/:id',element:<p>mail page</p>}],{initialEntries:[{pathname:'/compose',state}]})}
function show(state?: import('./compose-init').ComposeInitial) {const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><RouterProvider router={routerFor(state)}/></QueryClientProvider>);return client}
describe('ComposePage complete delivery',()=>{
  beforeEach(()=>{localStorage.clear();mocks.send.mockClear();mocks.single.mockReset();mocks.toast.mockClear();mocks.user={id:1,role:'user'};mocks.boxes=[{id:9,address:'first@one.example'},{id:10,address:'second@two.example'}]});
  it('normal: sole owned mailbox is automatically chosen',async()=>{
    localStorage.clear();mocks.user={id:1,role:'user'};mocks.boxes=[{id:9,address:'solo@one.example'}];mocks.send.mockClear();
    const client=show({to:['recipient@one.example'],subject:'subject',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalled());
    expect(mocks.send.mock.calls[0]![0].from).toEqual({mailboxId:9});client.clear();
  });
  it('normal: reply selects its address across multiple owned domains',async()=>{
    localStorage.clear();mocks.user={id:1,role:'user'};mocks.boxes=[{id:9,address:'first@one.example'},{id:10,address:'second@two.example'}];mocks.send.mockClear();
    const client=show({fromAddress:'second@two.example',to:['sender@example.com'],subject:'reply',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalled());
    expect(mocks.send.mock.calls[0]![0].from).toEqual({mailboxId:10});client.clear();
  });
  it('blocks send after an upload fails and sends only after the user removes it',async()=>{
    mocks.single.mockRejectedValueOnce(new Error('upload failed'));
    const client=show({fromAddress:'first@one.example',to:['to@example.com'],subject:'test',body:'body'});
    const input=document.querySelector<HTMLInputElement>('input[type=file]')!;
    fireEvent.change(input,{target:{files:[new File(['hello'],'receipt.txt',{type:'text/plain'})]}});
    await screen.findByRole('button',{name:'上传失败，点击重试'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('附件尚未准备完成');
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'移除 receipt.txt'}));
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    client.clear();
  });
  it('restores identity, uploaded attachment, BCC and reply/forward context from a user draft',async()=>{
    localStorage.setItem(draftKeyForUser(1),JSON.stringify({fromAddress:'second@two.example',mailboxId:10,to:['to@example.com'],cc:[],bcc:['secret@example.com'],subject:'saved',body:'<b>saved</b>',isHtml:true,mode:'reply',replyToMessageId:77,forwardAttachmentsFrom:88,attachments:[{key:'a',filename:'saved.txt',mimeType:'text/plain',size:4,status:'ready',token:'saved-token',createdAt:Date.now()}]}));
    const client=show();
    fireEvent.click(await screen.findByRole('button',{name:'继续编辑'}));
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({from:{mailboxId:10},bcc:[{address:'secret@example.com',name:''}],html:'<b>saved</b>',attachmentTokens:[{token:'saved-token'}],replyToMessageId:77,forwardAttachmentsFrom:88});
    expect(localStorage.getItem(draftKeyForUser(1))).toBeNull();
    client.clear();
  });
  it('restores expired attachments with a blocking error instead of silently dropping them',async()=>{
    localStorage.setItem(draftKeyForUser(1),JSON.stringify({fromAddress:'first@one.example',to:['to@example.com'],cc:[],bcc:[],subject:'saved',body:'body',isHtml:false,attachments:[{key:'expired',filename:'expired.txt',mimeType:'text/plain',size:4,status:'ready',token:'expired-token',createdAt:Date.now()-25*3600000}]}));
    const client=show();
    fireEvent.click(await screen.findByRole('button',{name:'继续编辑'}));
    expect(screen.getByText(/附件已过期/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('附件尚未准备完成');
    expect(mocks.send).not.toHaveBeenCalled();
    client.clear();
  });
  it('uses a default identity for fresh compose while a reply keeps the addressed mailbox',async()=>{
    localStorage.setItem(identityKeyForUser(1),JSON.stringify({mailboxId:10,localPart:'',domain:''}));
    const client=show({to:['to@example.com'],subject:'test',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0].from).toEqual({mailboxId:10});
    client.clear();
  });
  it('administrator can send from an owned mailbox whose domain is no longer listed',async()=>{
    mocks.user={id:1,role:'admin'};
    const client=show({fromAddress:'second@two.example',to:['to@example.com'],subject:'test',body:'body'});
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveTextContent('second@two.example'));
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0].from).toEqual({mailboxId:10});
    client.clear();
  });
  it('after sending only marks affected lists and the replied thread stale, keeping every detail cache',async()=>{
    const client=show({fromAddress:'first@one.example',to:['First@one.example'],subject:'Re: hi',body:'body',mode:'reply',replyToMessageId:5,sourceMessageId:5});
    const emptyList={pages:[{items:[],nextCursor:null}],pageParams:['']};
    const sent=queryKeys.messages.list({direction:'outbound',scope:'mine'});const starred=queryKeys.messages.list({scope:'mine',starred:true});
    client.setQueryData(sent,emptyList);client.setQueryData(starred,emptyList);
    client.setQueryData(queryKeys.messages.detail(5),{id:5});client.setQueryData(queryKeys.messages.detail(8,{scope:'unclaimed'}),{id:8});
    client.setQueryData(queryKeys.messages.thread(5),{items:[{id:5}]});client.setQueryData(queryKeys.messages.thread(8),{items:[{id:8},{id:5}]});client.setQueryData(queryKeys.messages.thread(9),{items:[{id:9}]});
    client.setQueryData(queryKeys.messages.unreadCount,{unread:0});client.setQueryData(queryKeys.messages.contacts,{contacts:[]});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    expect(await screen.findByText('sent page')).toBeInTheDocument();
    // 新收件人进入往来联系人
    expect(client.getQueryState(queryKeys.messages.contacts)?.isInvalidated).toBe(true);
    const invalidated=(key:readonly unknown[])=>client.getQueryState(key)?.isInvalidated;
    expect(invalidated(queryKeys.messages.detail(5))).toBe(false);
    expect(invalidated(queryKeys.messages.detail(8,{scope:'unclaimed'}))).toBe(false);
    expect([invalidated(queryKeys.messages.thread(5)),invalidated(queryKeys.messages.thread(8)),invalidated(queryKeys.messages.thread(9))]).toEqual([true,true,false]);
    expect([invalidated(sent),invalidated(starred)]).toEqual([true,false]);
    // 发给自己认领的地址：站内投递进收件箱，未读数随之刷新
    expect(invalidated(queryKeys.messages.unreadCount)).toBe(true);
    client.clear();
  });
  it('partial recipient failure reports an error instead of a successful delivery toast',async()=>{
    mocks.send.mockResolvedValueOnce({id:22,status:'sent',errorDetail:'failed recipient',recipientOutcomes:[{address:'failed@example.com',status:'failed',error:'rejected'}]});
    const client=show({fromAddress:'first@one.example',to:['to@example.com','failed@example.com'],subject:'test',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({variant:'error',title:expect.stringContaining('1 个收件人发送失败')})));
    client.clear();
  });
  it('201 + status unknown：提示先向收件人核对再补发，进入详情页而不是报成功',async()=>{
    mocks.send.mockResolvedValueOnce({id:23,status:'unknown',errorDetail:'投递结果未确认，可能已送达，补发前先向收件人核对: to@example.com: timeout',
      recipientOutcomes:[{address:'to@example.com',status:'unknown',error:'timeout'}]});
    const client=show({fromAddress:'first@one.example',to:['to@example.com'],subject:'test',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({variant:'error',title:'1 个收件人的投递结果未确认',
      description:expect.stringContaining('请先向收件人核对')})));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({variant:'success'}));
    expect(await screen.findByText('mail page')).toBeInTheDocument();
    client.clear();
  });
  it('部分送达、部分失败、部分未确认：标题同时说明失败与未确认',async()=>{
    mocks.send.mockResolvedValueOnce({id:24,status:'sent',errorDetail:'部分收件人失败',recipientOutcomes:[{address:'to@example.com',status:'sent'},
      {address:'bad@example.com',status:'failed',error:'rejected'},{address:'slow@example.com',status:'unknown',error:'timeout'}]});
    const client=show({fromAddress:'first@one.example',to:['to@example.com','bad@example.com','slow@example.com'],subject:'test',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({variant:'error',title:'1 个收件人发送失败，1 个收件人的投递结果未确认'})));
    client.clear();
  });
});


describe('durable send idempotency',()=>{
  const initial={fromAddress:'first@one.example',to:['to@example.com'],subject:'retry-safe',body:'body'};
  const sent={id:22,status:'sent',errorDetail:'',recipientOutcomes:[]};
  function mount(state?:import('./compose-init').ComposeInitial){
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const view=render(<QueryClientProvider client={client}><RouterProvider router={routerFor(state)}/></QueryClientProvider>);
    return {client,...view};
  }
  beforeEach(()=>{
    localStorage.clear();mocks.send.mockReset();mocks.toast.mockClear();mocks.user={id:1,role:'user'};
    mocks.boxes=[{id:9,address:'first@one.example'}];
  });
  it('replays the same key after refresh when the original delivery succeeded but its response timed out',async()=>{
    const delivered=new Map<string,typeof sent>();
    let deliveries=0;
    mocks.send.mockImplementation(async(_payload,key)=>{
      expect(key).toBeTruthy();
      if(delivered.has(key!)) return delivered.get(key!)!;
      delivered.set(key!,sent);deliveries+=1;
      throw new ApiError('response timed out',{code:'timeout'});
    });
    const first=mount(initial);
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await screen.findByRole('alert');
    const key=mocks.send.mock.calls[0]![1];
    const sidecar=JSON.parse(localStorage.getItem(sendAttemptKeyForUser(1))!);
    expect(sidecar).toMatchObject({key,payloadHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(localStorage.getItem(sendAttemptKeyForUser(1))).not.toContain('to@example.com');
    first.unmount();first.client.clear();
    const refreshed=mount();
    fireEvent.click(await screen.findByRole('button',{name:'继续编辑'}));
    expect(screen.getByRole('status')).toHaveTextContent('上次发送结果待确认，可用原内容重试查询');
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![0]).toEqual(mocks.send.mock.calls[0]![0]);
    expect(mocks.send.mock.calls[1]![1]).toBe(key);
    expect(deliveries).toBe(1);
    await waitFor(()=>expect(localStorage.getItem(sendAttemptKeyForUser(1))).toBeNull());
    refreshed.unmount();refreshed.client.clear();
  });
  it('keeps a key across 5xx, rotates it after payload edits, and isolates the identical payload for another owner',async()=>{
    mocks.send.mockRejectedValue(new ApiError('gateway error',{code:'internal',httpStatus:503}));
    const first=mount(initial);
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await screen.findByRole('alert');
    const oldKey=mocks.send.mock.calls[0]![1];
    expect(JSON.parse(localStorage.getItem(sendAttemptKeyForUser(1))!).key).toBe(oldKey);
    fireEvent.change(screen.getByLabelText(/主题/),{target:{value:'edited'}});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
    const editedKey=mocks.send.mock.calls[1]![1];
    expect(editedKey).not.toBe(oldKey);
    await screen.findByRole('alert');
    const ownerAttempt=localStorage.getItem(sendAttemptKeyForUser(1));
    expect(JSON.parse(ownerAttempt!).key).toBe(editedKey);
    first.unmount();first.client.clear();
    mocks.user={id:2,role:'user'};
    const second=mount({...initial,subject:'edited'});
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(3));
    expect(mocks.send.mock.calls[2]![0]).toEqual(mocks.send.mock.calls[1]![0]);
    expect(mocks.send.mock.calls[2]![1]).not.toBe(editedKey);
    expect(localStorage.getItem(sendAttemptKeyForUser(1))).toBe(ownerAttempt);
    second.unmount();second.client.clear();
  });
  it('clears terminal rejection credentials and falls back to same-page retries if storage cannot persist',async()=>{
    mocks.send.mockRejectedValueOnce(new ApiError('invalid request',{code:'validation_failed',httpStatus:400}));
    const rejected=mount(initial);
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await screen.findByRole('alert');
    expect(localStorage.getItem(sendAttemptKeyForUser(1))).toBeNull();
    rejected.unmount();rejected.client.clear();
    // 发送失败的内容留作草稿；本用例只关心幂等凭据，清掉草稿避免恢复提示
    localStorage.removeItem(draftKeyForUser(1));
    mocks.send.mockReset();mocks.send.mockRejectedValueOnce(new ApiError('network lost',{code:'network'})).mockResolvedValueOnce(sent);
    const fallback=mount(initial);
    const setItem=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('quota exceeded')});
    try {
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await screen.findByRole('alert');
      const key=mocks.send.mock.calls[0]![1];
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'无法保存发送凭据'}));
      fireEvent.click(screen.getByRole('button',{name:'发送'}));
      await waitFor(()=>expect(mocks.send).toHaveBeenCalledTimes(2));
      expect(mocks.send.mock.calls[1]![1]).toBe(key);
    } finally {setItem.mockRestore();fallback.unmount();fallback.client.clear()}
  });
});

describe('scene drafts and leaving the page', () => {
  const reply = { fromAddress: 'first@one.example', to: ['sender@example.com'], subject: 'Re: hi', body: '\n\n> quoted', mode: 'reply' as const, replyToMessageId: 5, sourceMessageId: 5 };
  function mountRouter(state?: import('./compose-init').ComposeInitial) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = routerFor(state);
    const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    return { client, router, ...view };
  }
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('a reply neither overwrites the new-mail draft nor persists its untouched prefill', async () => {
    const saved = { to: ['draft@example.com'], cc: [], bcc: [], subject: 'unfinished', body: 'half written', isHtml: false };
    localStorage.setItem(draftKeyForUser(1, 'new'), JSON.stringify(saved));
    const { client, unmount } = mountRouter(reply);
    expect(screen.queryByRole('button', { name: '继续编辑' })).toBeNull();
    await screen.findByDisplayValue('Re: hi');
    expect(localStorage.getItem(draftKeyForUser(1, 'reply:5'))).toBeNull();
    fireEvent.change(screen.getByLabelText(/正文/), { target: { value: 'my answer' } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(draftKeyForUser(1, 'reply:5'))!)).toMatchObject({ body: 'my answer', replyToMessageId: 5 }));
    expect(JSON.parse(localStorage.getItem(draftKeyForUser(1, 'new'))!)).toMatchObject(saved);
    unmount(); client.clear();
  });

  it('migrates the legacy single-key draft to the new scene once, and discarding removes it', async () => {
    localStorage.setItem(legacyDraftKeyForUser(1), JSON.stringify({ to: ['old@example.com'], cc: [], bcc: [], subject: 'legacy', body: 'from before', isHtml: false }));
    const first = mountRouter();
    expect(await screen.findByText('继续编辑上次的草稿？')).toBeInTheDocument();
    expect(localStorage.getItem(legacyDraftKeyForUser(1))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(await screen.findByDisplayValue('legacy')).toBeInTheDocument();
    first.unmount(); first.client.clear();

    const second = mountRouter();
    fireEvent.click(await screen.findByRole('button', { name: '丢弃草稿' }));
    expect(localStorage.getItem(draftKeyForUser(1, 'new'))).toBeNull();
    expect(screen.getByLabelText(/主题/)).toHaveValue('');
    second.unmount(); second.client.clear();
  });

  it('cancel asks to save or discard; discarding clears the draft and leaves', async () => {
    const { client, router, unmount } = mountRouter();
    fireEvent.change(screen.getByLabelText(/主题/), { target: { value: 'typed' } });
    await waitFor(() => expect(localStorage.getItem(draftKeyForUser(1, 'new'))).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(await screen.findByRole('button', { name: '丢弃' }));
    await screen.findByText('inbox page');
    expect(router.state.location.pathname).toBe('/inbox');
    expect(localStorage.getItem(draftKeyForUser(1, 'new'))).toBeNull();
    unmount(); client.clear();
  });

  it('in-app navigation with unsaved edits is blocked until the user chooses', async () => {
    const { client, router, unmount } = mountRouter();
    fireEvent.change(screen.getByLabelText(/主题/), { target: { value: 'keep me' } });
    await act(() => router.navigate('/inbox'));
    expect(await screen.findByText('保存这封邮件的草稿？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
    await waitFor(() => expect(screen.queryByText('保存这封邮件的草稿？')).toBeNull());
    expect(router.state.location.pathname).toBe('/compose');
    await act(() => router.navigate('/inbox'));
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }));
    await screen.findByText('inbox page');
    expect(JSON.parse(localStorage.getItem(draftKeyForUser(1, 'new'))!)).toMatchObject({ subject: 'keep me' });
    unmount(); client.clear();
  });
});

describe('send errors, shortcuts and field validation', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('an uncertain network failure offers a same-key retry and clears once the user edits', async () => {
    mocks.send.mockRejectedValueOnce(toApiError(new TypeError('Failed to fetch'))).mockResolvedValueOnce({ id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show({ to: ['to@example.com'], subject: 'hello', body: 'body' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(NETWORK_ERROR_MESSAGE);
    expect(alert).toHaveTextContent('同一个幂等键');
    fireEvent.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![1]).toBe(mocks.send.mock.calls[0]![1]);
    client.clear();
  });

  it('editing after a failure removes the stale error', async () => {
    mocks.send.mockRejectedValueOnce(new ApiError('response timed out', { code: 'timeout' }));
    const client = show({ to: ['to@example.com'], subject: 'hello', body: 'body' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '重试发送' });
    fireEvent.change(screen.getByLabelText(/主题/), { target: { value: 'hello again' } });
    expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
    client.clear();
  });

  it('Ctrl/⌘+Enter sends from inside the editor', async () => {
    mocks.send.mockResolvedValueOnce({ id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show({ to: ['to@example.com'], subject: 'hello', body: 'body' });
    fireEvent.keyDown(screen.getByLabelText(/正文/), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    client.clear();
  });

  it('shows field-level errors and focuses the first invalid field', async () => {
    const client = show({ subject: '', body: 'body' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('至少需要一个收件人')).toBeInTheDocument();
    expect(screen.getByText('请填写主题')).toBeInTheDocument();
    expect(document.activeElement).toBe(document.getElementById('compose-to'));
    expect(mocks.send).not.toHaveBeenCalled();
    client.clear();
  });

  it('picks the last used identity before falling back to the first owned mailbox', async () => {
    mocks.boxes = [{ id: 9, address: 'first@one.example' }, { id: 10, address: 'second@two.example' }];
    localStorage.setItem(lastIdentityKeyForUser(1), JSON.stringify({ mailboxId: 10, localPart: '', domain: '' }));
    mocks.send.mockResolvedValue({ id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show({ to: ['to@example.com'], subject: 'hello', body: 'body' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0].from).toEqual({ mailboxId: 10 });
    client.clear();
  });
});

describe('idempotency error codes', () => {
  const initial = { fromAddress: 'first@one.example', to: ['to@example.com'], subject: 'pending?', body: 'body' };
  const savedKey = () => JSON.parse(localStorage.getItem(sendAttemptKeyForUser(1)) ?? 'null')?.key as string | undefined;
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('send_in_progress keeps the key, never retries on its own and points to Sent', async () => {
    mocks.send.mockRejectedValue(new ApiError('该发信请求正在处理或结果待确认，请勿重复提交', { code: 'send_in_progress', httpStatus: 409 }));
    const client = show(initial);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('发送结果待确认');
    expect(screen.getByRole('link', { name: '已发送' })).toHaveAttribute('href', '/sent');
    expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
    const key = mocks.send.mock.calls[0]![1];
    expect(savedKey()).toBe(key);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.send).toHaveBeenCalledOnce();
    // 用户手动再次点击：同一内容沿用原 key，只会查询原结果
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![1]).toBe(key);
    client.clear();
  });

  it('idempotency_mismatch drops the key so the next send uses a fresh one', async () => {
    mocks.send
      .mockRejectedValueOnce(new ApiError('相同 Idempotency-Key 不能用于不同的发信内容', { code: 'idempotency_mismatch', httpStatus: 409 }))
      .mockResolvedValueOnce({ id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show(initial);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('已为这封邮件更换新凭据');
    expect(screen.getByRole('link', { name: '已发送' })).toHaveAttribute('href', '/sent');
    expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
    expect(savedKey()).toBeUndefined();
    const oldKey = mocks.send.mock.calls[0]![1];
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![0]).toEqual(mocks.send.mock.calls[0]![0]);
    expect(mocks.send.mock.calls[1]![1]).toBeTruthy();
    expect(mocks.send.mock.calls[1]![1]).not.toBe(oldKey);
    await screen.findByText('sent page');
    client.clear();
  });

  it('delivery_failed lists each recipient reason, links to the failed record and sends again with a fresh key', async () => {
    mocks.send
      .mockRejectedValueOnce(new ApiError('全部收件人投递失败: to@example.com: destination not verified', {
        code: 'delivery_failed', httpStatus: 422,
        details: { messageId: 55, recipientOutcomes: [{ address: 'to@example.com', status: 'failed', error: 'destination not verified' }] },
      }))
      .mockResolvedValueOnce({ id: 23, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show(initial);
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('所有收件人都没有收到');
    expect(alert).toHaveTextContent('to@example.com：destination not verified');
    expect(screen.getByRole('link', { name: '查看失败记录' })).toHaveAttribute('href', '/mail/55');
    expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
    expect(savedKey()).toBeUndefined();
    const oldKey = mocks.send.mock.calls[0]![1];
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![1]).toBeTruthy();
    expect(mocks.send.mock.calls[1]![1]).not.toBe(oldKey);
    client.clear();
  });
});

describe('recipient_suppressed', () => {
  const savedKey = () => JSON.parse(localStorage.getItem(sendAttemptKeyForUser(1)) ?? 'null')?.key as string | undefined;
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('lists each suppressed recipient with its reason and release time, and sends again with a fresh key', async () => {
    mocks.send
      .mockRejectedValueOnce(new ApiError('全部收件人都在抑制名单中，没有发送', {
        code: 'recipient_suppressed', httpStatus: 422,
        details: { suppressed: [
          { address: 'gone@example.com', reason: 'hard_bounce', sendingDomain: 'one.example', since: '2026-11-01T00:00:00Z', expiresAt: null },
          { address: 'full@example.com', reason: 'soft_bounce', sendingDomain: 'one.example', since: '2026-11-01T00:00:00Z', expiresAt: '2026-11-02T00:00:00Z' },
        ] },
      }))
      .mockResolvedValueOnce({ id: 24, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show({ fromAddress: 'first@one.example', to: ['gone@example.com'], subject: 'hello', body: 'body' });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没有发送：收件人都在抑制名单中');
    expect(alert).toHaveTextContent('gone@example.com：此前退信（地址或域名不可用），需管理员解除');
    expect(alert).toHaveTextContent(`full@example.com：此前临时退信且重试耗尽，${new Date('2026-11-02T00:00:00Z').toLocaleString()} 自动解除`);
    expect(alert).toHaveTextContent('从 one.example 发给这些地址会直接失败');
    expect(savedKey()).toBeUndefined();
    const oldKey = mocks.send.mock.calls[0]![1];
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![1]).not.toBe(oldKey);
    client.clear();
  });
});

describe('resend of unconfirmed recipients', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('lists unconfirmed recipients without adding them to the retry', async () => {
    mocks.send.mockResolvedValue({ id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] });
    const client = show({ fromAddress: 'first@one.example', to: ['failed@example.com'], subject: 'retry', body: 'body', mode: 'resend',
      sourceMessageId: 7, unconfirmed: ['maybe@example.com'] });
    expect(screen.getByRole('status')).toHaveTextContent('投递结果未确认，可能已经收到，没有自动加入：maybe@example.com');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0].to).toEqual([{ address: 'failed@example.com', name: '' }]);
    client.clear();
  });
});

describe('source mail no longer available', () => {
  const sent = { id: 22, status: 'sent', errorDetail: '', recipientOutcomes: [] };
  beforeEach(() => {
    localStorage.clear(); mocks.send.mockReset(); mocks.toast.mockClear(); mocks.user = { id: 1, role: 'user' };
    mocks.boxes = [{ id: 9, address: 'first@one.example' }];
  });

  it('a reply whose original is gone can be sent as a new mail after the user confirms, with a new key', async () => {
    mocks.send.mockRejectedValueOnce(new ApiError('回复的原邮件不存在或不可见', { code: 'source_unavailable', httpStatus: 404 })).mockResolvedValueOnce(sent);
    const client = show({ fromAddress: 'first@one.example', to: ['sender@example.com'], subject: 'Re: hi', body: 'answer', mode: 'reply', replyToMessageId: 5, sourceMessageId: 5 });
    expect(screen.getByRole('heading', { level: 1, name: '回复邮件' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('原邮件已不存在，无法关联回复线程');
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({ replyToMessageId: 5 });
    fireEvent.click(screen.getByRole('button', { name: '作为新邮件发送' }));
    // 去掉回复关联后就是一封新邮件，标题随之变化
    expect(screen.getByRole('heading', { level: 1, name: '写邮件' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 只去掉关联，不自动重发
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    const { replyToMessageId: _dropped, ...rest } = mocks.send.mock.calls[0]![0];
    expect(mocks.send.mock.calls[1]![0]).toEqual(rest);
    expect(mocks.send.mock.calls[1]![1]).not.toBe(mocks.send.mock.calls[0]![1]);
    await screen.findByText('sent page');
    client.clear();
  });

  it('a reply-forward whose reply thread is gone (details.source = reply) offers to drop the reply link, not the attachments', async () => {
    mocks.send.mockRejectedValueOnce(new ApiError('回复的原邮件不存在或不可见', { code: 'source_unavailable', httpStatus: 404, details: { source: 'reply' } }));
    const client = show({ fromAddress: 'first@one.example', to: ['sender@example.com'], subject: 'Re: hi', body: 'answer', mode: 'reply', replyToMessageId: 5, forwardAttachmentsFrom: 8, sourceMessageId: 5 });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('原邮件已不存在，无法关联回复线程');
    fireEvent.click(screen.getByRole('button', { name: '作为新邮件发送' }));
    expect(screen.getByText(/将保留原邮件附件/)).toBeInTheDocument();
    client.clear();
  });

  it('a forward whose source attachments are gone can drop them and resend on the next click', async () => {
    mocks.send.mockRejectedValueOnce(new ApiError('转发的原邮件附件不可用', { code: 'source_unavailable', httpStatus: 404 })).mockResolvedValueOnce(sent);
    const client = show({ fromAddress: 'first@one.example', to: ['friend@example.com'], subject: 'Fwd: hi', body: 'fyi', mode: 'forward', forwardAttachmentsFrom: 8, sourceMessageId: 8 });
    expect(screen.getByText(/将保留原邮件附件/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('原邮件的附件已不可用，无法一起转发');
    fireEvent.click(screen.getByRole('button', { name: '去掉原邮件附件' }));
    expect(screen.queryByText(/将保留原邮件附件/)).toBeNull();
    expect(mocks.send).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[1]![0]).not.toHaveProperty('forwardAttachmentsFrom');
    expect(mocks.send.mock.calls[1]![1]).not.toBe(mocks.send.mock.calls[0]![1]);
    client.clear();
  });

  it.each(['发件邮箱不存在', '邮件不存在'])('a plain not_found (%s) stays a plain error: only source_unavailable offers to drop the source', async (text) => {
    mocks.send.mockRejectedValueOnce(new ApiError(text, { code: 'not_found', httpStatus: 404 }));
    const client = show({ fromAddress: 'first@one.example', to: ['sender@example.com'], subject: 'Re: hi', body: 'answer', mode: 'reply', replyToMessageId: 5, sourceMessageId: 5 });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: '作为新邮件发送' })).toBeNull();
    client.clear();
  });
});
