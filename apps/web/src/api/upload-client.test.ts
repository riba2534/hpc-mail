import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken, setAuthToken } from '@/lib/auth-token';
import { uploadsApi } from './resources';
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
describe('uploadsApi',()=>{
  it('loads the XHR channel on demand and resolves the envelope data',async()=>{
    setAuthToken('t');
    const previous=last;
    const result=uploadsApi.single(new Blob(['x']),'a.txt','text/plain');
    await vi.waitFor(()=>expect(last).not.toBe(previous));
    expect(last.open).toHaveBeenCalledWith('POST','/api/uploads?filename=a.txt&mimeType=text%2Fplain');
    last.status=200;last.responseText=JSON.stringify({data:{token:'u1'}});
    last.onload?.();
    await expect(result).resolves.toEqual({token:'u1'});
  });
});
