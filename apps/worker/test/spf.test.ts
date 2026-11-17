import { describe, expect, it } from 'vitest';
import { decodeTxtContent, isSpfContent, mergeCloudflareSpf } from '../src/lib/spf.js';

describe('SPF 解析与合并', () => {
  it('TXT 解码：多段字符串直接拼接、去引号、解开 RFC 1035 转义', () => {
    expect(decodeTxtContent('"v=sp" "f1 -all"')).toBe('v=spf1 -all');
    expect(decodeTxtContent('"\\118=spf1 ~all"')).toBe('v=spf1 ~all');
    expect(decodeTxtContent('v=spf1 mx -all')).toBe('v=spf1 mx -all');
    expect(isSpfContent('"v=spf1 include:_spf.google.com ~all"')).toBe(true);
    expect(isSpfContent('"google-site-verification=abc"')).toBe(false);
  });

  it('把本站 include 插在 v=spf1 之后，原机制与 all、redirect 的顺序不变', () => {
    const result = mergeCloudflareSpf('"v=spf1 include:_spf.google.com ~all"');
    expect(result).toMatchObject({ status: 'merged', merged: 'v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all', lookupEstimate: 2 });
    expect(mergeCloudflareSpf('v=spf1 mx redirect=_spf.example.com').merged)
      .toBe('v=spf1 include:_spf.mx.cloudflare.net mx redirect=_spf.example.com');
    expect(mergeCloudflareSpf('v=spf1 mx redirect=_spf.example.com').warnings.join()).toContain('redirect');
  });

  it('已包含本站 include（含 ~、? 修饰）时不再合并；-include 需要手动处理', () => {
    expect(mergeCloudflareSpf('v=spf1 include:_spf.mx.cloudflare.net ~all').status).toBe('present');
    expect(mergeCloudflareSpf('v=spf1 ~include:_SPF.MX.CLOUDFLARE.NET -all').status).toBe('present');
    expect(mergeCloudflareSpf('v=spf1 -include:_spf.mx.cloudflare.net ~all').status).toBe('manual');
  });

  it('宏、超过 10 次查询、超过 255 字符、非标准写法都交给管理员手动处理', () => {
    expect(mergeCloudflareSpf('v=spf1 exists:%{i}.spf.example.com -all')).toMatchObject({ status: 'manual' });
    const ten = `v=spf1 ${Array.from({ length: 10 }, (_, i) => `include:s${i}.example.com`).join(' ')} -all`;
    expect(mergeCloudflareSpf(ten)).toMatchObject({ status: 'manual', lookupEstimate: 11 });
    const nine = `v=spf1 ${Array.from({ length: 9 }, (_, i) => `include:s${i}.example.com`).join(' ')} -all`;
    const nearLimit = mergeCloudflareSpf(nine);
    expect(nearLimit).toMatchObject({ status: 'merged', lookupEstimate: 10 });
    expect(nearLimit.warnings.join()).toContain('接近 10 次上限');
    expect(mergeCloudflareSpf(`v=spf1 ip4:${'1.2.3.4 ip4:'.repeat(30)}5.6.7.8 -all`).status).toBe('manual');
    expect(mergeCloudflareSpf('spf1 -all').status).toBe('manual');
  });

  it('a、mx、ptr、exists、redirect 都计入查询次数；ip4 不计；+all 附警告', () => {
    expect(mergeCloudflareSpf('v=spf1 a mx:mail.example.com ptr exists:x.example.com ip4:1.2.3.4 redirect=r.example.com').lookupEstimate).toBe(6);
    expect(mergeCloudflareSpf('v=spf1 mx +all').warnings.join()).toContain('策略过宽');
    expect(mergeCloudflareSpf('v=spf1 mx all').warnings.join()).toContain('策略过宽');
    expect(mergeCloudflareSpf('v=spf1 mx -all').warnings).toEqual([]);
  });
});
