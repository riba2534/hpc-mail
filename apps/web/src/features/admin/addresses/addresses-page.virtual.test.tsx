import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_HEIGHT = 57;
const TOTAL = 625;
const mocks = vi.hoisted(() => ({ mobile: false, listShares: vi.fn(), get: vi.fn() }));
const boxes = Array.from({ length: TOTAL }, (_, i) => ({
  id: 1000 + i,
  address: `user${i}@example.com`,
  domain: 'example.com',
  userId: 10 + (i % 7),
  ownerUsername: `owner${i % 7}`,
  displayName: '',
  messageCount: i,
  createdAt: '2026-10-06T00:00:00Z',
}));
vi.mock('@/api/resources', () => ({
  adminApi: { searchUsers: vi.fn(), transferMailbox: vi.fn(), listMailboxShares: mocks.listShares, listUsers: vi.fn(async () => []) },
  mailboxApi: { release: vi.fn() },
}));
vi.mock('@/lib/use-media-query', () => ({ useIsMobile: () => mocks.mobile }));
vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));

import { AddressesPage } from './addresses-page';
import { AlwaysVisibleObserver, fakeAdminMailboxesApi } from './fake-admin-mailboxes';

// jsdom 未实现 scrollTo：窗口虚拟列表挂载时会把滚动位置同步一次
window.scrollTo = vi.fn() as typeof window.scrollTo;

/** 列表末尾一直在视口里：自动加载一页接一页把 625 个地址取完（每页 100 个） */
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><AddressesPage /></MemoryRouter></QueryClientProvider>);
  await loadedAll();
  return { client, view };
}

/** 还有下一页时末尾有「加载更多」；等首屏出现且再没有下一页 */
async function loadedAll() {
  await screen.findAllByRole('link');
  await waitFor(() => expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull());
}

/** 等按新搜索词请求过、且新结果已替换旧列表 */
async function searched(q: string, first: string) {
  await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/mailboxes', expect.objectContaining({ query: expect.objectContaining({ q }) })));
  await waitFor(() => expect(renderedAddresses()[0]).toBe(first));
  await loadedAll();
}

/** 页面实际渲染出来的地址（只算对读屏可见的行，不含占位） */
const renderedAddresses = () => screen.getAllByRole('link').map((link) => link.textContent);

function scrollWindowTo(y: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mobile = false;
  mocks.get.mockImplementation(fakeAdminMailboxesApi(boxes));
  vi.stubGlobal('IntersectionObserver', AlwaysVisibleObserver);
  mocks.listShares.mockImplementation(async (mailboxId: number) => {
    const box = boxes.find((item) => item.id === mailboxId)!;
    return [{ mailboxId, address: box.address, domain: box.domain, displayName: '', ownerUserId: box.userId,
      ownerUsername: box.ownerUsername, grantees: [] }];
  });
  // jsdom 不做布局：给每个被虚拟列表测量的行一个固定高度，视口高度沿用 jsdom 默认的 768
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-index') ? ROW_HEIGHT : 0;
  });
  scrollWindowTo(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  scrollWindowTo(0);
});

describe('全站地址：大量地址时只渲染视口附近的行', () => {
  it(`${TOTAL} 个地址分 7 页自动加载完，只渲染首屏附近的行，表格仍声明总行数`, async () => {
    const { client, view } = await mount();
    expect(mocks.get).toHaveBeenCalledTimes(7);
    expect(mocks.get.mock.calls.map(([, options]) => options.query.cursor)).toEqual(['', '100', '200', '300', '400', '500', '600']);
    const addresses = renderedAddresses();
    expect(addresses.length).toBeGreaterThan(10);
    expect(addresses.length).toBeLessThan(40);
    expect(addresses[0]).toBe('user0@example.com');
    expect(screen.queryByRole('link', { name: 'user600@example.com' })).toBeNull();
    const table = screen.getByRole('table');
    expect(table).toHaveAttribute('aria-rowcount', String(TOTAL + 1));
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveAttribute('aria-rowindex', '2');
    view.unmount(); client.clear();
  });

  it('实测行高与估计不同（如窄屏时间折行）时，未渲染部分按实测行高撑开，总高度准确', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-index') ? 65 : 0;
    });
    const { client, view } = await mount();
    const rendered = renderedAddresses().length;
    const spacer = view.container.querySelector<HTMLElement>('tbody tr[aria-hidden="true"] td')!;
    expect(spacer.style.height).toBe(`${(TOTAL - rendered) * 65}px`);
    view.unmount(); client.clear();
  });

  it('行高按邮箱缓存：搜索过滤后同一下标换了邮箱，不沿用别的邮箱量出的高度', async () => {
    // user0..user99 的行高 200，其余 57
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute('data-index')) return 0;
      return Number(this.querySelector('a')?.textContent?.match(/\d+/)?.[0]) < 100 ? 200 : 57;
    });
    const { client, view } = await mount();
    // 先滚到中段再回顶部：下标 0..36 附近都量过（200）
    scrollWindowTo(200 * 20);
    scrollWindowTo(0);
    // 滚动中新挂载的行不即时测量（线上由 ResizeObserver 补量）：等滚动状态结束
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    // 过滤后：user6、user60..69 高 200，下标 11 起是 user600..624（57），未渲染部分不能套用旧下标的 200
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'user6' } });
    await searched('user6', 'user6@example.com');
    const rendered = renderedAddresses();
    expect(rendered.slice(0, 2)).toEqual(['user6@example.com', 'user60@example.com']);
    const spacer = view.container.querySelector<HTMLElement>('tbody tr[aria-hidden="true"]:last-child td')!;
    expect(spacer.style.height).toBe(`${(36 - rendered.length) * 57}px`);
    view.unmount(); client.clear();
  });

  it('列表上方布局变化（没有 resize 事件）后，过滤结果变化时重测列表起点，滚动定位不偏移', async () => {
    let listTop = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.tagName === 'TBODY' ? listTop : 0;
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    const { client, view } = await mount();
    // 例如上方说明文字换行把列表推下去 5700px，但没有触发 resize
    listTop = 5700;
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'user6' } });
    await searched('user6', 'user6@example.com');
    // 过滤后 36 行：第 20 行是 user609；不重测起点时这个滚动位置会越过列表末尾
    scrollWindowTo(5700 + ROW_HEIGHT * 20);
    expect(renderedAddresses()).toContain('user609@example.com');
    view.unmount(); client.clear();
  });

  it('滚动后渲染新位置附近的行，离开视口的行被回收', async () => {
    const { client, view } = await mount();
    scrollWindowTo(ROW_HEIGHT * 300);
    const addresses = renderedAddresses();
    expect(addresses).toContain('user300@example.com');
    expect(addresses).not.toContain('user0@example.com');
    expect(addresses.length).toBeLessThan(40);
    const row = screen.getByRole('link', { name: 'user300@example.com' }).closest('tr')!;
    expect(row).toHaveAttribute('aria-rowindex', '302');
    view.unmount(); client.clear();
  });

  it('搜索交给服务端，能找到首屏外的地址，行内操作作用于该地址', async () => {
    const { client, view } = await mount();
    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: ' User600@ ' } });
    await searched('user600@', 'user600@example.com');
    expect(screen.getByRole('link', { name: 'user600@example.com' })).toHaveAttribute('href', '/admin/addresses/1600/mail');
    // 输入停止后只按最终的词请求一次（去空格、转小写）
    expect(mocks.get.mock.calls.filter(([, options]) => options.query.q !== undefined).map(([, options]) => options.query.q)).toEqual(['user600@']);
    expect(renderedAddresses()).toEqual(['user600@example.com']);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '2');
    fireEvent.click(screen.getByRole('button', { name: '强制释放' }));
    const dialog = await screen.findByRole('dialog', { name: '强制释放地址' });
    expect(within(dialog).getByText('user600@example.com')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'owner3' } });
    await searched('owner3', 'user3@example.com');
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', String(Math.ceil((TOTAL - 3) / 7) + 1));
    expect(renderedAddresses().every((address) => Number(address!.match(/\d+/)![0]) % 7 === 3)).toBe(true);
    view.unmount(); client.clear();
  });

  it('滚到下方后共享某行，读取的是该邮箱的共享名单', async () => {
    const { client, view } = await mount();
    scrollWindowTo(ROW_HEIGHT * 500);
    fireEvent.click(screen.getByRole('button', { name: '共享邮箱 user500@example.com' }));
    expect(await screen.findByText('邮箱所有者：owner3')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog', { name: '共享邮箱' })).getByText('user500@example.com')).toBeInTheDocument();
    expect(mocks.listShares.mock.calls).toEqual([[1500]]);
    view.unmount(); client.clear();
  });

  it('窄屏卡片同样只渲染视口附近的卡片，搜索后更多菜单作用于该地址', async () => {
    mocks.mobile = true;
    const { client, view } = await mount();
    expect(screen.queryByRole('table')).toBeNull();
    const cards = screen.getAllByRole('listitem');
    expect(cards.length).toBeGreaterThan(5);
    expect(cards.length).toBeLessThan(40);
    expect(cards[0]).toHaveAttribute('aria-posinset', '1');
    expect(cards[0]).toHaveAttribute('aria-setsize', String(TOTAL));
    expect(screen.queryByRole('link', { name: 'user600@example.com' })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('搜索地址或用户名'), { target: { value: 'user600@' } });
    await searched('user600@', 'user600@example.com');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '强制释放' }));
    const dialog = await screen.findByRole('dialog', { name: '强制释放地址' });
    expect(within(dialog).getByText('user600@example.com')).toBeInTheDocument();
    view.unmount(); client.clear();
  });
});
