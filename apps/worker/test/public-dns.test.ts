import { afterEach, describe, expect, it, vi } from 'vitest';
import { dohAnswers, dohQuery, rdapDomain, RR } from '../src/lib/public-dns.js';
import { hasDnssec, lookupDelegation } from '../src/services/domain-check.js';
import { dnssecState } from '../src/services/mail-provisioning.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    return handler(url, init);
  }));
  return calls;
}

describe('dohQuery / dohAnswers', () => {
  it('带 type 查询、不跟随跳转；HTTP 非 2xx（含 3xx）抛错', async () => {
    const calls = stubFetch((url) => (url.searchParams.get('name') === 'ok.test'
      ? Response.json({ Status: 0, Answer: [{ type: 43, data: 'ds' }, { type: 46, data: 'rrsig' }] })
      : url.searchParams.get('name') === 'moved.test'
        ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
        : new Response('down', { status: 503 })));
    const body = await dohQuery('ok.test', 'DS');
    expect(calls[0]!.url).toBe('https://cloudflare-dns.com/dns-query?name=ok.test&type=DS');
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(dohAnswers(body, RR.DS)).toEqual(['ds']);
    await expect(dohQuery('moved.test', 'DS')).rejects.toThrow('HTTP 302');
    await expect(dohQuery('down.test', 'DS')).rejects.toThrow('HTTP 503');
  });

  it('调用方语义：hasDnssec 只认 DS、失败抛错；dnssecState 失败为 unknown', async () => {
    stubFetch((url) => {
      const name = url.searchParams.get('name');
      if (name === 'signed.test') return Response.json({ Status: 0, Answer: [{ type: 43, data: 'ds' }] });
      if (name === 'rrsig-only.test') return Response.json({ Status: 0, Answer: [{ type: 46, data: 'rrsig' }] });
      if (name === 'nx.test') return Response.json({ Status: 3 });
      return new Response('down', { status: 500 });
    });
    expect(await hasDnssec('signed.test')).toBe(true);
    expect(await hasDnssec('rrsig-only.test')).toBe(false);
    await expect(hasDnssec('down.test')).rejects.toThrow();
    expect(await dnssecState('signed.test')).toBe('on');
    expect(await dnssecState('rrsig-only.test')).toBe('off');
    expect(await dnssecState('nx.test')).toBe('off');
    expect(await dnssecState('down.test')).toBe('unknown');
  });
});

describe('rdapDomain', () => {
  it('拼接 <base>/domain/<域名>；HTTP 非 2xx 返回 null', async () => {
    const calls = stubFetch((url) => (url.pathname.endsWith('/found.test')
      ? Response.json({ nameservers: [{ ldhName: 'NS1.Example.NET.' }] })
      : new Response('not found', { status: 404 })));
    expect(await rdapDomain('https://rdap.example/v1', 'found.test')).toEqual({ nameservers: [{ ldhName: 'NS1.Example.NET.' }] });
    expect(await rdapDomain('https://rdap.example/v1/', 'missing.test')).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(['https://rdap.example/v1/domain/found.test', 'https://rdap.example/v1/domain/missing.test']);
    expect(calls[0]!.init?.redirect).toBeUndefined(); // rdap.org 靠 302 转到注册局，必须跟随
  });

  it('lookupDelegation：RDAP 拿到 NS 即返回；RDAP 失败回落 DoH，DoH 失败或非 NOERROR 为 null', async () => {
    stubFetch((url) => {
      if (url.hostname === 'rdap.org') {
        return url.pathname === '/domain/rdap.test' ? Response.json({ nameservers: [{ ldhName: 'NS1.Example.NET.' }] }) : new Response('', { status: 404 });
      }
      const name = url.searchParams.get('name');
      if (name === 'doh.test') return Response.json({ Status: 0, Answer: [{ type: 2, data: 'ns2.example.net.' }, { type: 46, data: 'sig' }] });
      if (name === 'servfail.test') return Response.json({ Status: 2 });
      return new Response('', { status: 500 });
    });
    expect(await lookupDelegation('rdap.test')).toEqual(['ns1.example.net']);
    expect(await lookupDelegation('doh.test')).toEqual(['ns2.example.net']);
    expect(await lookupDelegation('servfail.test')).toBeNull();
    expect(await lookupDelegation('down.test')).toBeNull();
  });
});
