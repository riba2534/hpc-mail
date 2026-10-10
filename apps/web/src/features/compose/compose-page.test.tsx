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
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({from:{mailboxId:10},bcc:['secret@example.com'],html:'<b>saved</b>',attachmentTokens:['saved-token'],replyToMessageId:77,forwardAttachmentsFrom:88});
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
  it('partial recipient failure reports an error instead of a successful delivery toast',async()=>{
    mocks.send.mockResolvedValueOnce({id:22,status:'sent',errorDetail:'failed recipient',recipientOutcomes:[{address:'failed@example.com',status:'failed',error:'rejected'}]});
    const client=show({fromAddress:'first@one.example',to:['to@example.com','failed@example.com'],subject:'test',body:'body'});
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({variant:'error',title:expect.stringContaining('1 个收件人发送失败')})));
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
