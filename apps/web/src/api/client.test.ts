import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/api';
import { ApiError } from '@/api/errors';
import { setAuthToken, TOKEN_STORAGE_KEY } from '@/lib/auth-token';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client（新信封）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('解析成功信封，附带 Bearer token、query 与 JSON body', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'session-token');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { saved: true } }, 200));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.post<{ saved: boolean }, { name: string }>('/settings', { name: 'HPC Mail' }, { query: { dryRun: true } }),
    ).resolves.toEqual({ saved: true });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings?dryRun=true');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer session-token');
    expect(new Headers(request.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(request.body))).toEqual({ name: 'HPC Mail' });
  });

  it('解析错误信封为 ApiError，保留 code 与 requestId', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'forbidden', message: '无权限' }, requestId: 'req-1' }, 403)),
    );

    const error = await api.get('/admin/users').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'forbidden', httpStatus: 403, requestId: 'req-1', forbidden: true });
  });

  it('401 时清除本地 token', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, 'expired');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'unauthorized', message: '失效' }, requestId: 'r' }, 401)),
    );

    const error = await api.get('/auth/me').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).unauthorized).toBe(true);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('late 401 from an old account cannot remove a replacement token', async () => {
    setAuthToken('old');
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = api.get('/messages').catch((error: unknown) => error);
    setAuthToken('new');
    finish(jsonResponse({ error: { code: 'unauthorized', message: 'expired' } }, 401));
    await pending;
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('new');
  });

  it('anonymous login failure does not clear another tab’s authenticated account', async () => {
    setAuthToken('new');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'bad_credentials', message: 'wrong password' } }, 401)));
    await api.post('/auth/login', {}, { token: null }).catch(() => {});
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('new');
  });

  it('late success from an old account is discarded', async () => {
    setAuthToken('old');
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const pending = api.get('/messages');
    setAuthToken('new');
    finish(jsonResponse({ data: { private: 'old body' } }, 200));
    await expect(pending).rejects.toMatchObject({ code: 'session_changed' });
  });

  it('非 JSON 错误响应也映射为带状态码的 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })),
    );

    await expect(api.get('/config')).rejects.toMatchObject({ httpStatus: 502 });
  });
});
