import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(async (patch) => ({ domains: patch.domains })), toast: vi.fn(), stats: vi.fn(async () => [] as unknown[]), apiGet: vi.fn() }));
vi.mock('@/api/resources', () => ({ adminApi: { getSettings: mocks.get, updateSettings: mocks.update, domainStatus: vi.fn(async () => ({resolved:false})), domainClaudeStats: mocks.stats } }));
vi.mock('@/api/client', () => ({api: {get: mocks.apiGet}}));
vi.mock('@/components/ui/toast', () => ({toast: mocks.toast}));
import { DomainsPage } from './domains-page';
import { ApiError } from '@/api/errors';
import { fakeAdminMailboxesApi } from '@/features/admin/addresses/fake-admin-mailboxes';

const boxesOn = (domain: string, count: number) => Array.from({length: count}, (_, i) => ({address: `u${i}@${domain}`, domain, ownerUsername: 'owner'}));

describe('domain configuration safety', () => {
  it('blocks adding until a failed GET is successfully retried', async () => {
    mocks.get.mockRejectedValueOnce(new Error('settings network error'));
    mocks.get.mockResolvedValue({domains:{revision:7,list:[{domain:'old.example',public:true,perUserLimit:2}]}});
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByRole('button', {name:'重新加载'});
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name:'重新加载'}));
    await screen.findByText('old.example');
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:7,domains:{list:[{domain:'old.example',public:true,perUserLimit:2},{domain:'new.example',public:false,perUserLimit:0,random:true}]}}));
    client.clear();
  });
  it('blocks adding while settings are still pending', () => {
    mocks.get.mockImplementation(() => new Promise(() => {})); mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('button', {name:'添加'})).toBeDisabled();
    expect(screen.getByPlaceholderText('example.com')).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', {name:'添加'}).closest('form')!);
    expect(mocks.update).not.toHaveBeenCalled();
    client.clear();
  });
  it('reloads configuration on concurrent revision conflicts', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[]}});
    mocks.update.mockRejectedValueOnce(new ApiError('changed', {code:'conflict',httpStatus:409}));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('还没有配置收件域名');
    const calls = mocks.get.mock.calls.length;
    fireEvent.change(screen.getByPlaceholderText('example.com'), {target:{value:'new.example'}});
    fireEvent.click(screen.getByRole('button', {name:'添加'}));
    await waitFor(() => expect(mocks.get.mock.calls.length).toBeGreaterThan(calls));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:expect.stringContaining('重新加载')}));
    client.clear();
  });
  it('已有域名时接入指南默认折叠，可手动展开', async () => {
    mocks.get.mockResolvedValue({domains:{revision:2,list:[{domain:'old.example',public:false,perUserLimit:0}]}});
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('old.example');
    const toggle = screen.getByRole('button', {name:/如何接入一个新域名/});
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('在 Cloudflare 为该域开启 Email Routing')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('在 Cloudflare 为该域开启 Email Routing')).toBeInTheDocument();
    client.clear();
  });
  it('还没有域名时接入指南默认展开', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[]}});
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('还没有配置收件域名');
    expect(screen.getByRole('button', {name:/如何接入一个新域名/})).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('在 Cloudflare 为该域开启 Email Routing')).toBeInTheDocument();
    client.clear();
  });
  it('参与随机生成开关：带当前 revision 提交完整列表，只改这一个域名', async () => {
    mocks.get.mockResolvedValue({domains:{revision:5,list:[{domain:'a.example',public:true,perUserLimit:2,random:true},{domain:'b.example',public:false,perUserLimit:0}]}});
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('a.example');
    // 旧数据没有 random 字段时按参与随机显示
    expect(screen.getByRole('switch', {name:'b.example 参与随机生成'})).toBeChecked();
    fireEvent.click(screen.getByRole('switch', {name:'a.example 参与随机生成'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:5,domains:{list:[{domain:'a.example',public:true,perUserLimit:2,random:false},{domain:'b.example',public:false,perUserLimit:0}]}}));
    client.clear();
  });
  it('显示每个域名的 Claude 统计与风险标记，不参与随机的域名有标记', async () => {
    mocks.get.mockResolvedValue({domains:{revision:3,list:[
      {domain:'suspended.example',public:false,perUserLimit:0,random:true},
      {domain:'wiped.example',public:false,perUserLimit:0,random:true},
      {domain:'paid.example',public:false,perUserLimit:0,random:true},
      {domain:'rate.example',public:false,perUserLimit:0,random:true},
      {domain:'busy.example',public:false,perUserLimit:0,random:true},
      {domain:'off.example',public:false,perUserLimit:0,random:false},
    ]},claim_random:{paidSuspendedLimit:2,pendingDays:7,suspendedPercent:50,dailyLimit:3}});
    mocks.stats.mockResolvedValueOnce([
      {domain:'suspended.example',accounts:100,suspended:1,paid:0,paidSuspended:0,pending:0,recent:3,risk:'suspended'},
      {domain:'wiped.example',accounts:3,suspended:3,paid:1,paidSuspended:1,pending:0,recent:0,risk:'wiped'},
      {domain:'paid.example',accounts:5,suspended:2,paid:3,paidSuspended:2,pending:1,recent:1,risk:'paid_suspended'},
      {domain:'rate.example',accounts:4,suspended:2,paid:0,paidSuspended:0,pending:0,recent:0,risk:'suspended_rate'},
      {domain:'busy.example',accounts:2,suspended:0,paid:2,paidSuspended:0,pending:1,recent:3,risk:null},
      {domain:'off.example',accounts:0,suspended:0,paid:0,paidSuspended:0,pending:0,recent:0,risk:null},
    ]);
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    const excluded = await screen.findAllByText('有封号记录，已排除');
    expect(excluded).toHaveLength(4);
    expect(excluded[0]).toHaveAttribute('title', '该域名有历史 Claude 封号记录，Claude 0 封号模式禁止认领');
    expect(screen.queryByText(/达阈值，已排除/)).not.toBeInTheDocument();
    expect(screen.getAllByText('今日新增已满')).toHaveLength(1);
    expect(screen.getByText('Claude：账号 5 · 封 2 · 付费 3 · 付费封 2 · 未注册 1 · 24 小时新增 1')).toBeInTheDocument();
    expect(screen.getByText('Claude：暂无记录')).toBeInTheDocument();
    expect(screen.getByText('不参与随机')).toBeInTheDocument();
    expect(screen.getByRole('switch', {name:'off.example 参与随机生成'})).not.toBeChecked();
    client.clear();
  });
  it('Claude 统计加载失败不影响域名管理', async () => {
    mocks.get.mockResolvedValue({domains:{revision:1,list:[{domain:'old.example',public:false,perUserLimit:0}]}});
    mocks.stats.mockRejectedValueOnce(new Error('stats down'));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('old.example');
    expect(await screen.findByText(/Claude 统计暂时加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'添加'})).toBeEnabled();
    client.clear();
  });
  it('进入页面不拉全站邮箱；确认移除时只按该域取第一页，超过一页说「至少」', async () => {
    mocks.get.mockResolvedValue({domains:{revision:4,list:[
      {domain:'big.example',public:true,perUserLimit:0},{domain:'small.example',public:true,perUserLimit:0},{domain:'empty.example',public:true,perUserLimit:0},
    ]}});
    mocks.apiGet.mockReset();
    mocks.apiGet.mockImplementation(fakeAdminMailboxesApi([...boxesOn('big.example', 130), ...boxesOn('small.example', 3)]));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('big.example');
    expect(mocks.apiGet).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', {name:'移除 big.example'}));
    expect(await screen.findByText(/该域至少有 100 个已认领地址。/)).toBeInTheDocument();
    expect(mocks.apiGet.mock.calls).toEqual([['/mailboxes', {query:{all:1,q:undefined,domain:'big.example',cursor:'',limit:100},signal:expect.any(AbortSignal)}]]);
    fireEvent.click(screen.getByRole('button', {name:'取消'}));

    fireEvent.click(screen.getByRole('button', {name:'移除 small.example'}));
    expect(await screen.findByText(/该域当前有 3 个已认领地址。/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'取消'}));

    fireEvent.click(screen.getByRole('button', {name:'移除 empty.example'}));
    expect(await screen.findByText(/当前该域下暂无已认领地址/)).toBeInTheDocument();
    expect(mocks.apiGet).toHaveBeenCalledTimes(3);
    client.clear();
  });
  it('影响面读取失败时不编造数量，仍可确认移除', async () => {
    mocks.get.mockResolvedValue({domains:{revision:6,list:[{domain:'gone.example',public:true,perUserLimit:0}]}});
    mocks.apiGet.mockReset();
    mocks.apiGet.mockRejectedValue(new Error('mailboxes down'));
    mocks.update.mockClear();
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><MemoryRouter><DomainsPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', {name:'移除 gone.example'}));
    expect(await screen.findByText(/该域的认领地址数暂时无法读取/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'移除'}));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({expectedDomainsRevision:6,domains:{list:[]}}));
    client.clear();
  });
});
