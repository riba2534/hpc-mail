import { describe, expect, it } from 'vitest';
import { domainsAligned, inboundAuth, parseAuthenticationResults } from '../src/lib/auth-results.js';

/**
 * 夹具按 Cloudflare Email Routing 的真实格式仿造（authserv-id mx.cloudflare.net；SPF 注释里带发件人可控的地址；
 * 字段与官方博客 ARC 样例、文档 email-handler 的示例一致），域名与签名都是假的。
 */
const CF_PASS = 'mx.cloudflare.net;\n\tdkim=pass header.d=mail.example.com header.s=s1 header.b=AbCdEf12;\n'
  + '\tdmarc=pass header.from=mail.example.com policy.dmarc=reject;\n'
  + '\tspf=pass (mx.cloudflare.net: domain of bounce@em.mail.example.com designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@em.mail.example.com;\n'
  + '\tarc=none smtp.remote-ip=192.0.2.10';

const headers = (...entries: [string, string][]) => entries.map(([key, value]) => ({ key, value }));

describe('Authentication-Results 解析', () => {
  it('Cloudflare 的通过结果：三项 pass，签名域与 From 对齐', () => {
    expect(parseAuthenticationResults(CF_PASS, 'mail.example.com')).toEqual({
      spf: 'pass', dkim: 'pass', dkimDomain: 'mail.example.com', dmarc: 'pass', aligned: true,
    });
  });

  it('官方文档的简化示例也能解析', () => {
    expect(parseAuthenticationResults('mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass', 'example.com'))
      .toEqual({ spf: 'pass', dkim: 'pass', dkimDomain: '', dmarc: 'pass', aligned: true });
  });

  it('authserv-id 不是 mx.cloudflare.net 时不采信', () => {
    expect(parseAuthenticationResults(CF_PASS.replace('mx.cloudflare.net;', 'mx.evil.example;'), 'mail.example.com')).toBeNull();
    expect(parseAuthenticationResults('mx.cloudflare.net.evil.example; dkim=pass header.d=a.com', 'a.com')).toBeNull();
  });

  it('多个 DKIM 签名：取与 From 对齐的通过签名；ESP 自己的签名不算对齐', () => {
    const value = 'mx.cloudflare.net; dkim=pass header.d=sendgrid.example header.s=s1; dkim=fail header.d=shop.example header.s=s2; '
      + 'dmarc=fail header.from=shop.example; spf=pass smtp.mailfrom=bounces@sendgrid.example';
    expect(parseAuthenticationResults(value, 'shop.example')).toEqual({
      spf: 'pass', dkim: 'pass', dkimDomain: 'sendgrid.example', dmarc: 'fail', aligned: false,
    });
    const both = 'mx.cloudflare.net; dkim=pass header.d=sendgrid.example; dkim=pass header.d=shop.example; dmarc=none';
    expect(parseAuthenticationResults(both, 'news.shop.example')).toMatchObject({ dkimDomain: 'shop.example', aligned: true });
  });

  it('SPF 取 MAIL FROM 那条，HELO 的结果不参与；DKIM 只有 header.i 时取其域名', () => {
    const value = 'mx.cloudflare.net; dkim=neutral (no key) header.i=@other.example; '
      + 'spf=none (mx.cloudflare.net: no SPF record found for postmaster@example.com) smtp.helo=smtp.example.com; '
      + 'spf=pass smtp.mailfrom=joe@example.com; arc=none';
    expect(parseAuthenticationResults(value, 'example.com')).toEqual({
      spf: 'pass', dkim: 'neutral', dkimDomain: 'other.example', dmarc: 'none', aligned: true,
    });
  });

  it('伪造：发件人把结果藏在注释或引号里、或 DMARC 的 header.from 与显示的 From 不同，都不算通过', () => {
    const comment = 'mx.cloudflare.net; spf=fail (mx.cloudflare.net: x; dkim=pass header.d=bank.example) smtp.mailfrom=a@evil.example; dkim=none';
    expect(parseAuthenticationResults(comment, 'bank.example')).toEqual({
      spf: 'fail', dkim: 'none', dkimDomain: '', dmarc: 'none', aligned: false,
    });
    const quoted = 'mx.cloudflare.net; spf=fail smtp.mailfrom="x;dkim=pass header.d=bank.example"@evil.example; dkim=none';
    expect(parseAuthenticationResults(quoted, 'bank.example')).toMatchObject({ dkim: 'none', aligned: false });
    const otherFrom = 'mx.cloudflare.net; dmarc=pass header.from=evil.example; dkim=pass header.d=evil.example';
    expect(parseAuthenticationResults(otherFrom, 'bank.example')).toMatchObject({ dmarc: 'pass', aligned: false });
  });

  it('未知取值记作 none；版本号、大小写与等号两侧空白都能识别', () => {
    expect(parseAuthenticationResults('MX.Cloudflare.NET 1; DKIM = PASS header.d=A.Example; spf=bestguesspass; dmarc/1=Fail', 'a.example'))
      .toEqual({ spf: 'none', dkim: 'pass', dkimDomain: 'a.example', dmarc: 'fail', aligned: true });
    expect(parseAuthenticationResults('mx.cloudflare.net; none', 'a.example'))
      .toEqual({ spf: 'none', dkim: 'none', dkimDomain: '', dmarc: 'none', aligned: false });
  });

  it('对齐只认相同域名或互为子域，单标签与无关的同后缀域名不算', () => {
    expect(domainsAligned('anthropic.com', 'mail.anthropic.com')).toBe(true);
    expect(domainsAligned('em.mail.example.com', 'mail.example.com')).toBe(true);
    expect(domainsAligned('evilanthropic.com', 'anthropic.com')).toBe(false);
    expect(domainsAligned('com', 'anthropic.com')).toBe(false);
    expect(domainsAligned('', 'anthropic.com')).toBe(false);
  });

  // workerd 里 Date.now() 在纯 CPU 段不前进，耗时由用例超时兜住：回溯爆炸会远超 2 秒
  it('超长或病态输入线性完成', () => {
    expect(parseAuthenticationResults(`mx.cloudflare.net; dkim=pass${' '.repeat(200_000)}x${'('.repeat(100_000)}`, 'a.example'))
      .toMatchObject({ dkim: 'pass' });
    expect(parseAuthenticationResults(`mx.cloudflare.net; spf=pass${' \t '.repeat(100_000)}=x`, 'a.example')).toMatchObject({ spf: 'pass' });
  }, 2000);
});

describe('inboundAuth：只信最上方的认证头', () => {
  it('Cloudflare 的头在最上方时采信，下面发件人自带的同名头忽略', () => {
    const result = inboundAuth(headers(
      ['authentication-results', 'mx.cloudflare.net; dkim=fail header.d=bank.example; dmarc=fail header.from=bank.example; spf=softfail smtp.mailfrom=x@evil.example'],
      ['from', 'Bank <no-reply@bank.example>'],
      ['authentication-results', 'mx.cloudflare.net; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example; spf=pass smtp.mailfrom=x@bank.example'],
      ['to', 'a@site.example'],
      ['subject', 'hi'],
    ), 'no-reply@bank.example');
    expect(result).toEqual({ source: 'trusted', auth: { spf: 'softfail', dkim: 'fail', dkimDomain: 'bank.example', dmarc: 'fail', aligned: false } });
  });

  it('最上方的认证头不是 Cloudflare 的：不再往下找，结果为 null', () => {
    const result = inboundAuth(headers(
      ['authentication-results', 'mx.evil.example; dkim=pass header.d=bank.example'],
      ['authentication-results', CF_PASS],
    ), 'a@mail.example.com');
    expect(result).toEqual({ auth: null, source: 'untrusted' });
  });

  it('没有 Authentication-Results 时为 null；ARC-Authentication-Results 不采信', () => {
    expect(inboundAuth(headers(['arc-authentication-results', `i=1; ${CF_PASS}`], ['from', 'a@mail.example.com']), 'a@mail.example.com'))
      .toEqual({ auth: null, source: 'missing' });
  });

  it('From、To 或 Subject 重复时 aligned 为 false（显示的值可能不是被签名的那个）', () => {
    for (const duplicated of ['from', 'to', 'subject', 'Subject ']) {
      const result = inboundAuth(headers(
        ['authentication-results', CF_PASS], ['from', 'a@mail.example.com'], ['to', 'x@site.example'], ['subject', 'Your account has been suspended'],
        [duplicated.toLowerCase(), 'again'],
      ), 'a@mail.example.com');
      expect(result.auth, duplicated).toMatchObject({ dkim: 'pass', aligned: false });
    }
    const single = inboundAuth(headers(['authentication-results', CF_PASS], ['from', 'a@mail.example.com'], ['to', 'x@site.example']), 'a@mail.example.com');
    expect(single.auth).toMatchObject({ aligned: true });
  });

  it('From 解析失败（空地址）时不对齐', () => {
    expect(inboundAuth(headers(['authentication-results', CF_PASS]), '').auth).toMatchObject({ dkim: 'pass', aligned: false });
  });
});
