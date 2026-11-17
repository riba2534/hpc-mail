import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOrDownloadWithAuth } from './download';

const fetchMock = vi.fn<typeof fetch>();
const downloads: string[] = [];
let tab: { location: { href: string }; close: () => void; closed: boolean; opener: unknown };

beforeEach(() => {
  downloads.length = 0;
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
    ['application/pdf', 'application/pdf'],
  ])('opens %s in a new tab', async (mimeType, blobType) => {
    await openOrDownloadWithAuth('/api/attachments/1', 'file', mimeType);
    expect(tab.location.href).toBe('blob:file');
    expect(vi.mocked(URL.createObjectURL).mock.calls[0]![0]).toMatchObject({ type: blobType });
    expect(downloads).toEqual([]);
  });

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream', 'application/zip', ''])('downloads %s without opening a tab', async (mimeType) => {
    await openOrDownloadWithAuth('/api/attachments/1', 'file.bin', mimeType);
    expect(window.open).not.toHaveBeenCalled();
    expect(downloads).toEqual(['file.bin']);
  });

  it('downloads instead when the pre-opened tab was blocked or closed', async () => {
    tab.closed = true;
    await openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png');
    expect(downloads).toEqual(['shot.png']);
    expect(tab.location.href).toBe('');
  });

  it('revokes blob URLs once the tab or download has had time to read them', async () => {
    vi.useFakeTimers();
    await openOrDownloadWithAuth('/api/attachments/1', 'shot.png', 'image/png');
    await openOrDownloadWithAuth('/api/attachments/2', 'data.zip', 'application/zip');
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
