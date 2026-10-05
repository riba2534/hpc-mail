import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({user:{id:1,role:'user'},boxes:[] as Array<{id:number,address:string}>,domains:['one.example'],send:vi.fn(async(_payload:import('@hpc-mail/shared').InternalSendMailRequest,_key?:string)=>({id:22,status:'sent',errorDetail:'',recipientOutcomes:[] as Array<{address:string,status:string,error?:string}>})),single:vi.fn(),remove:vi.fn(async()=>({success:true})),toast:vi.fn()}));
vi.mock('@/api/resources',()=>({messageApi:{contacts:vi.fn(async()=>({contacts:[]})),send:mocks.send},uploadsApi:{single:mocks.single,remove:mocks.remove}}));
vi.mock('@/lib/use-config',()=>({useDomains:()=>({data:mocks.domains})}));
vi.mock('@/lib/use-session',()=>({useCurrentUser:()=>mocks.user}));
vi.mock('@/features/mailboxes/use-mailboxes',()=>({useMailboxesQuery:()=>({data:mocks.boxes})}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
import { ComposePage } from './compose-page';
import { draftKeyForUser, identityKeyForUser } from './compose-draft';
import { sendAttemptKeyForUser } from './send-attempt';
import { ApiError } from '@/api/errors';
vi.stubGlobal('ResizeObserver',class {observe() {} unobserve() {} disconnect() {}});
function show(state?: import('./compose-init').ComposeInitial) {const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[{pathname:'/compose',state}]}><ComposePage/></MemoryRouter></QueryClientProvider>);return client}
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
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
    await waitFor(()=>expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({from:{mailboxId:10},bcc:['secret@example.com'],html:'<b>saved</b>',attachmentTokens:['saved-token'],replyToMessageId:77,forwardAttachmentsFrom:88});
    expect(localStorage.getItem(draftKeyForUser(1))).toBeNull();
    client.clear();
  });
  it('restores expired attachments with a blocking error instead of silently dropping them',async()=>{
    localStorage.setItem(draftKeyForUser(1),JSON.stringify({fromAddress:'first@one.example',to:['to@example.com'],cc:[],bcc:[],subject:'saved',body:'body',isHtml:false,attachments:[{key:'expired',filename:'expired.txt',mimeType:'text/plain',size:4,status:'ready',token:'expired-token',createdAt:Date.now()-25*3600000}]}));
    const client=show();
    expect(screen.getByRole('alert')).toHaveTextContent('附件已过期');
    fireEvent.click(screen.getByRole('button',{name:'发送'}));
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
    const view=render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[{pathname:'/compose',state}]}><ComposePage/></MemoryRouter></QueryClientProvider>);
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
