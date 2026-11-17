import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteZone, type CloudflareCredentials } from '../src/services/cloudflare.js';

const creds: CloudflareCredentials = { token: 'test-token', accountId: 'acct-test', workerName: 'hpc-cloud-mail' };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 假 Cloudflare：GET /zones/:id 返回给定 zone，记录每次调用 */
function stubZone(zone: { id: string; name: string; created_on: string } | null) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname.replace('/client/v4', '')}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === 'GET' && url.pathname.endsWith(`/zones/${zone?.id ?? 'gone'}`) && zone) {
      return json({ success: true, errors: [], result: { ...zone, status: 'active' } });
    }
    // 按名称列不到；不带名称时（可见性自检）账户里还有别的 zone
    if (method === 'GET' && url.pathname.endsWith('/zones')) {
      return json({ success: true, errors: [], result: [], result_info: { total_count: url.searchParams.has('name') ? 0 : 3 } });
    }
    if (method === 'DELETE') return json({ success: true, errors: [], result: { id: zone?.id } });
    return json({ success: false, errors: [{ code: 7003, message: 'Could not route' }], result: null }, 404);
  }));
  return calls;
}

describe('删除 zone 前核对身份', () => {
  it('名称与记录一致、创建时间不早于记录时才删除', async () => {
    const calls = stubZone({ id: 'z1', name: 'ok.example', created_on: new Date().toISOString() });
    await deleteZone(creds, 'z1', 'ok.example', { notBefore: new Date(Date.now() - 1000) });
    expect(calls).toEqual(['GET /zones/z1', 'DELETE /zones/z1']);
  });

  it('zone_id 指向别的域名时拒绝删除', async () => {
    const calls = stubZone({ id: 'z2', name: 'hpc.email', created_on: new Date().toISOString() });
    await expect(deleteZone(creds, 'z2', 'victim.example')).rejects.toThrow(/不符/);
    expect(calls).toEqual(['GET /zones/z2']);
  });

  it('早于本站记录创建的 zone（不是本站建的）拒绝删除', async () => {
    const calls = stubZone({ id: 'z3', name: 'old.example', created_on: '2020-01-01T00:00:00Z' });
    await expect(deleteZone(creds, 'z3', 'old.example', { notBefore: new Date() })).rejects.toThrow(/早于本站记录/);
    expect(calls).toEqual(['GET /zones/z3']);
  });

  it('系统域名一律不删，也不调用 Cloudflare', async () => {
    const calls = stubZone({ id: 'z4', name: 'hpc.email', created_on: new Date().toISOString() });
    await expect(deleteZone(creds, 'z4', 'hpc.email', { protectedNames: ['hpc.email'] })).rejects.toThrow(/系统域名/);
    expect(calls).toEqual([]);
  });

  it('zone 已不存在视为删除成功', async () => {
    const calls = stubZone(null);
    await deleteZone(creds, 'gone', 'gone.example');
    expect(calls).toEqual(['GET /zones/gone', 'GET /zones', 'GET /zones']);
  });
});
