import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadWithAuth, openOrDownloadWithAuth } from './download';

const fetchMock = vi.fn<typeof fetch>();
const downloads: string[] = [];
let tab: { location: { href: string }; close: ReturnType<typeof vi.fn>; closed: boolean; opener: unknown };

/** 模拟一直不返回、只在 signal 中止时失败的请求（与真实 fetch 一致） */
function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

beforeEach(() => {
  downloads.length = 0;
  localStorage.clear();
  localStorage.setItem('token', 'session-jwt');
  tab = { location: { href: '' }, close: vi.fn(), closed: false, opener: window };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(new Blob(['bytes']), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:file');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openOrDownloadWithAuth', () => {
  it.each([
    ['image/png', 'image/png'],
    ['IMAGE/JPEG; name="a.jpg"', 'image/jpeg'],
    [' image/webp ', 'image/webp'],
  ])('opens whitelisted raster image %s in a new tab as the normalized type', async (mimeType, blobType) => {
    await openOrDownloadWithAuth('/api/attachments/1', 'file', mimeType);
    expect(tab.location.href).toBe('blob:file');
    expect(tab.opener).toBeNull();
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob;
    expect(blob.type).toBe(blobType);
    expect(downloads).toEqual([]);
  });

  // 来信可以声明任意 Content-Type：拼接值或非白名单类型一旦按声明内联，同源 blob 页面就能执行脚本读走登录凭据
  it.each([
    'image/png,text/html',
    'image/png,image/svg+xml',
    'image/svg+xml',
    'text/html',
    'application/pdf',
    'image/heic',
    'image/tiff',
    'image/x-foo',
    'application/octet-stream',
    '',
  ])('downloads %s under its original filename without opening a tab', async (mimeType) => {
    await openOrDownloadWithAuth('/api/attachments/1', '报告 原件.pdf', mimeType);
    expect(window.open).not.toHaveBeenCalled();
    expect(downloads).toEqual(['报告 原件.pdf']);
  });

  it('downloads instead when the pre-opened tab was blocked or closed', async () => {
    tab.closed = true;
    await openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png');
    expect(downloads).toEqual(['shot.png']);
    expect(tab.location.href).toBe('');
  });

  it('keeps a preview blob URL for 5 minutes and a download blob URL for 1 minute', async () => {
    vi.useFakeTimers();
    vi.mocked(URL.createObjectURL).mockReturnValueOnce('blob:preview').mockReturnValueOnce('blob:download');
    await openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png');
    await openOrDownloadWithAuth('/api/attachments/2', 'data.zip', 'application/zip');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:download']]);
    vi.advanceTimersByTime(4 * 60_000);
    expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([['blob:download'], ['blob:preview']]);
  });

  it('times out after 60 seconds without progress and closes the pre-opened tab', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangingFetch);
    const pending = openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png');
    const settled = pending.catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await settled as Error).message).toBe('下载超时，请检查网络后重试');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });

  it('does not time out a large download that keeps making progress', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_input, init) => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        // 与真实 fetch 一致：请求被中止时正文流随之出错
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
        async pull(controller) {
          // 每 40 秒到一块，总耗时 120 秒，超过单次 60 秒但从未空闲 60 秒
          await new Promise((resolve) => setTimeout(resolve, 40_000));
          if (sent++ < 3) controller.enqueue(new Uint8Array([sent]));
          else controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const pending = downloadWithAuth('/api/attachments/1', 'big.zip');
    await vi.advanceTimersByTimeAsync(170_000);
    await pending;
    expect(downloads).toEqual(['big.zip']);
    expect((vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob).size).toBe(3);
  });

  it('aborts with the caller: no download, no navigation, the tab is closed', async () => {
    fetchMock.mockImplementation(hangingFetch);
    const leave = new AbortController();
    const pending = openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png', leave.signal);
    leave.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(tab.close).toHaveBeenCalled();
    expect(downloads).toEqual([]);
    expect(tab.location.href).toBe('');
  });

  it('does not download when the caller left just as the body finished', async () => {
    const leave = new AbortController();
    fetchMock.mockImplementation(async () => {
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) return controller.enqueue(new Uint8Array([1]));
          leave.abort();
          controller.close();
        },
      }), { status: 200 });
    });
    await expect(downloadWithAuth('/api/attachments/1', 'a.zip', leave.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(downloads).toEqual([]);
  });

  it('clears the session on 401 like the API client, so the shell returns to login', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: 'unauthorized', message: '登录已过期' } }, { status: 401 }));
    await expect(downloadWithAuth('/api/attachments/1', 'a.zip')).rejects.toThrow('登录已过期');
    expect(localStorage.getItem('token')).toBeNull();
  });
});
