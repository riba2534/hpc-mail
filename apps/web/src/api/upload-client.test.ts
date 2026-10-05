import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken, setAuthToken } from '@/lib/auth-token';
import { xhrSend } from './upload-client';
let last:FakeXhr;
class FakeXhr {
  status=401;
  responseText=JSON.stringify({error:{code:'unauthorized',message:'expired'}});
  upload={onprogress:null};
  onload: (()=>void) | null=null;
  open=vi.fn(); setRequestHeader=vi.fn();send=vi.fn();abort=vi.fn();
  constructor(){last=this;}
}
beforeEach(()=>{localStorage.clear();vi.stubGlobal('XMLHttpRequest',FakeXhr)});
afterEach(()=>vi.unstubAllGlobals());
describe('upload authentication races',()=>{
  it('a late upload 401 preserves the replacement account token',async()=>{
    setAuthToken('old');
    const result=xhrSend({method:'POST',path:'/uploads'}).catch((error:unknown)=>error);
    setAuthToken('new');
    last.onload?.();await result;
    expect(getAuthToken()).toBe('new');
  });
  it('a late successful upload is rejected instead of assigning its token to the new account',async()=>{
    setAuthToken('old');
    const result=xhrSend({method:'POST',path:'/uploads'});
    setAuthToken('new');last.status=200;last.responseText=JSON.stringify({data:{token:'private-old-upload'}});
    last.onload?.();
    await expect(result).rejects.toMatchObject({code:'session_changed'});
  });
});
