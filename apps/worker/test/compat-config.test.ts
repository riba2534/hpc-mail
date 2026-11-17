import { afterEach, describe, expect, it, vi } from 'vitest';
import prodToml from '../wrangler.toml?raw';
import testToml from '../wrangler.test.toml?raw';
import { CloudflareApiError, getRouting } from '../src/services/cloudflare.js';

// 2026-08-04 起 nodejs_compat 随 compatibility_date 默认开启。测试插件总会给运行器强开 nodejs_compat_v2，
// 集成测试测不出生产缺了显式关闭会怎样，只能在配置层守住。
const NODEJS_COMPAT_DEFAULT_ON = '2026-08-04';

function compat(toml: string): { date: string | undefined; flags: string[] } {
  const date = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const list = /^compatibility_flags\s*=\s*\[([^\]]*)\]/m.exec(toml)?.[1] ?? '';
  return { date, flags: [...list.matchAll(/"([^"]+)"/g)].map(match => match[1]!) };
}

describe('compatibility_date 与 flags', () => {
  it('生产配置与测试配置一致', () => {
    expect(compat(prodToml).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(compat(testToml)).toEqual(compat(prodToml));
  });

  it('日期跨过 nodejs_compat 默认开启日时显式关闭 Node 兼容', () => {
    const { date, flags } = compat(prodToml);
    if (date! >= NODEJS_COMPAT_DEFAULT_ON) {
      expect(flags).toEqual(expect.arrayContaining(['no_nodejs_compat', 'no_nodejs_compat_v2']));
    }
    expect(flags).not.toContain('nodejs_compat');
    expect(flags).not.toContain('nodejs_compat_v2');
  });
});

// strip_authorization_on_cross_origin_redirect（2025-09-01）只影响自动跟随的重定向。带凭据的出站请求
// （AI 模型、通知 Webhook、Cloudflare API）一律 redirect: 'manual' 且把 3xx 当失败，前两者已有用例，这里补 Cloudflare API。
describe('带凭据的出站请求不跟随重定向', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Cloudflare API 返回 302 视为失败，只请求一次', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: 'https://collector.example/steal' } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await getRouting({ token: 'synthetic-token', accountId: 'acct', workerName: 'w' }, 'zone-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe('manual');
  });
});
