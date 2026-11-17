import { describe, expect, it, vi } from 'vitest';
import { constantTimeEqual, hashPassword, verifyPassword } from '../src/lib/password.js';
import { signToken, verifyToken } from '../src/lib/jwt.js';
import { decodeCursor, encodeCursor } from '../src/lib/pagination.js';
import {
  assertNoHeaderInjection,
  getEmailDomain,
  normalizeEmail,
  validateLocalPart,
} from '../src/lib/email-address.js';
import {
  CODE_SCAN_BODY_CHARS,
  extractCodeByRegex,
  resolveVerificationCode,
} from '../src/services/code-extract.js';
import { convertHtmlToText, HTML_TO_TEXT_MAX_CHARS, htmlToText, makePreview, PREVIEW_LIMIT } from '../src/lib/text.js';
import { injectAttachmentLinks } from '../src/services/outbound.js';
import { ipInAllowList } from '../src/lib/ip-allowlist.js';
import {
  encodeBodyBase64,
  foldBase64,
  sanitizeFilename,
  sanitizeMimeType,
} from '../src/lib/mime.js';
import { chunk, D1_ID_BATCH, D1_MAX_BOUND_PARAMS, D1_PAIR_BATCH } from '../src/lib/d1.js';
import { asciiFallbackFilename, buildSecureHeaders } from '../src/lib/attachment-security.js';
import { generateCode, generateTotpSecret, verifyTotp } from '../src/lib/totp.js';
import { AppError } from '../src/lib/errors.js';
import { signAttachment, verifyAttachmentSig } from '../src/lib/crypto.js';
import {
  DEFAULT_PUSHDEER_ENDPOINT,
  sendPushDeerNotification,
  validatePushDeerEndpoint,
} from '../src/services/pushdeer.js';

const SECRET = 'unit-test-secret-key-000000000000';

describe('password', () => {
  it('hash/verify 往返成功', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('pbkdf2-sha256$100000$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });
  it('非法哈希格式返回 false', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
  it('常量时间比较', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('jwt', () => {
  it('签发并校验通过', async () => {
    const token = await signToken(SECRET, { sub: 7, sid: 'abc', epoch: 0, uepoch: 1 });
    const claims = await verifyToken(SECRET, token);
    expect(claims?.sub).toBe(7);
    expect(claims?.sid).toBe('abc');
    expect(claims?.uepoch).toBe(1);
  });
  it('过期令牌返回 null', async () => {
    const token = await signToken(SECRET, { sub: 1, sid: 's', epoch: 0, uepoch: 0 }, -10);
    expect(await verifyToken(SECRET, token)).toBeNull();
  });
  it('篡改签名返回 null', async () => {
    const token = await signToken(SECRET, { sub: 1, sid: 's', epoch: 0, uepoch: 0 });
    const tampered = `${token.slice(0, -2)}xy`;
    expect(await verifyToken(SECRET, tampered)).toBeNull();
  });
  it('错误密钥返回 null', async () => {
    const token = await signToken(SECRET, { sub: 1, sid: 's', epoch: 0, uepoch: 0 });
    expect(await verifyToken('another-secret', token)).toBeNull();
  });
});

describe('pagination', () => {
  it('编解码往返', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });
  it('非法游标返回 null', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!not base64!!!')).toBeNull();
    expect(decodeCursor(btoa('-3'))).toBeNull();
    expect(decodeCursor(btoa('abc'))).toBeNull();
  });
});

describe('email-address', () => {
  it('归一化与取域名', () => {
    expect(normalizeEmail('  Foo@HPC.Email ')).toBe('foo@hpc.email');
    expect(getEmailDomain('a@b.com')).toBe('b.com');
  });
  it('头注入断言抛错', () => {
    expect(() => assertNoHeaderInjection('safe')).not.toThrow();
    expect(() => assertNoHeaderInjection('bad\r\nInjected: 1')).toThrow(AppError);
  });
  it('validateLocalPart 归一化并拒绝非法', () => {
    expect(validateLocalPart(' Test.User ')).toBe('test.user');
    expect(() => validateLocalPart('.bad')).toThrow(AppError);
    expect(() => validateLocalPart('a b')).toThrow(AppError);
  });
});

describe('code-extract 正则', () => {
  it('英文 code 关键词', () => {
    expect(extractCodeByRegex('', 'Your verification code is 482913. Thanks')).toBe('482913');
  });
  it('中文验证码', () => {
    expect(extractCodeByRegex('登录验证码', '您的验证码为 6391，请勿泄露')).toBe('6391');
  });
  it('多候选取最近关键词', () => {
    const body = '订单号 99887766 已生成。验证码：551203，五分钟内有效';
    expect(extractCodeByRegex('', body)).toBe('551203');
  });
  it('字母数字混合码', () => {
    expect(extractCodeByRegex('', 'Your OTP code: A1B2C3')).toBe('A1B2C3');
  });
  it('无关键词不误报', () => {
    expect(extractCodeByRegex('', '订单号 99887766 已发货')).toBe('');
  });
  it('无候选返回空', () => {
    expect(extractCodeByRegex('', 'your verification code is coming soon')).toBe('');
  });
  it('one-time link 邮件不把 URL token 识别为验证码', () => {
    const body = [
      'Continue verifying your identity',
      'To continue verifying your identity, please click the link below.',
      'https://withpersona.example/verify?code=VGHH62D',
      'This link will expire in 1 hour.',
      'Persona Identities, Inc. 981 Mission Street, San Francisco, CA 94103',
    ].join('\n');
    expect(extractCodeByRegex('Anthropic one-time link', body)).toBe('');
    // 收件时存的是空值；读取时按摘要重提同样不认 URL 里的 token
    expect(resolveVerificationCode('Anthropic one-time link', makePreview(body, ''), '')).toBe('');
  });

  /**
   * 主题像登录、开头是「Click the button below」、真码在第 160 字之后：摘要单看像 link-only，
   * 一度在读取时把收件时按全文存下的码清空，列表、wait、线程和详情都看不到。
   */
  it('已存验证码读取时原样返回，不按摘要的 link-only 文案清空', () => {
    const subject = 'Confirm your sign-in';
    const body = 'Click the button below to finish signing in to your account. If the button does not work on this device, '
      + 'you can also complete the sign-in from the app on your phone or computer.\nOr enter this code: 482913';
    const preview = makePreview(body, '');
    expect(body.indexOf('482913')).toBeGreaterThan(PREVIEW_LIMIT);
    expect(extractCodeByRegex(subject, body)).toBe('482913');
    expect(resolveVerificationCode(subject, preview, '482913', { bodyTruncated: true })).toBe('482913');
  });
  it('URL 内的 code 关键词不能激活附近邮编或年份', () => {
    const body = 'Click the link below: https://example.test/verify?code=A1B2C3\nAddress 94103, year 2026.';
    expect(extractCodeByRegex('Verification link', body)).toBe('');
  });
  it('generic verification 文案和长 ID 不产生截断误报', () => {
    expect(extractCodeByRegex('Verification completed', 'Completed on 2026-08-31.')).toBe('');
    expect(extractCodeByRegex('Account notice', 'Tracking ID ABCD1234567890XYZ')).toBe('');
  });
  it('同时提供链接和明确验证码时仍保留验证码', () => {
    const body = 'Your verification code is 482913. Or click the link below: https://example.test/verify/A1B2C3';
    expect(extractCodeByRegex('Verify your account', body)).toBe('482913');
    expect(resolveVerificationCode('Verify your account', body, '')).toBe('482913');
  });
  it('非 link-only 邮件保留无法被正则覆盖的历史/AI 验证码', () => {
    expect(resolveVerificationCode('Account alert', 'Use the password shown in the app.', '739204')).toBe('739204');
  });

  /** HTML 在码中间插入的标签或零宽字符一度把 6 位码切成 5 位（只剩较长的那一截） */
  it.each([
    ['行内加粗', '<p>Your verification code is <b>913</b>472</p>'],
    ['逐段 span', '<p>Your verification code is <span>91347</span><span>2</span></p>'],
    ['font 标签', '<p>Your verification code is 9134<font color="#000">72</font></p>'],
    ['wbr 断词', '<p>Your verification code is 913<wbr>472</p>'],
    ['零宽空格', '<p>Your verification code is 91347\u200B2</p>'],
    ['软连字符', '<p>Your verification code is 91347\u00AD2</p>'],
    ['方向控制符', '<p>Your verification code is 9134\u200E72</p>'],
    ['数字实体零宽空格', '<p>Your verification code is 91347&#8203;2</p>'],
    ['十六进制实体零宽空格', '<p>Your verification code is 91347&#x200B;2</p>'],
    ['命名实体 zwnj', '<p>Your verification code is 91347&zwnj;2</p>'],
    ['隐藏元素里的零宽空格', '<p>Your verification code is 91347<span style="display:none">&#8203;</span>2</p>'],
  ])('HTML 的 %s 不把 6 位码切断', (_name, html) => {
    expect(extractCodeByRegex('Verify your sign-in', htmlToText(html))).toBe('913472');
  });

  it('纯文本正文里的零宽字符不影响摘要重新校验提码', () => {
    const text = '您的验证码是 91347\u200B2，请勿泄露';
    expect(extractCodeByRegex('', text)).toBe('913472');
    expect(resolveVerificationCode('', makePreview(text, ''), '')).toBe('913472');
  });

  /**
   * 列表接口拿 160 字摘要重新校验提码：码跨在摘要边界上时只剩前几位，
   * 而 \d{4,8} 对 4-5 位的残码照样成立，一度盖掉收件时按完整正文存下的 6 位码。
   */
  describe('摘要边界上的验证码', () => {
    const filler = '你好，这是一封来自站点的通知邮件，感谢你注册账号并完成邮箱绑定。为了保护账号安全，请查收下面这次操作所需要的信息。';
    const bodyWithCodeAt = (pad: number) =>
      `${filler.repeat(3).slice(0, pad)}你的验证码：913472，五分钟内有效。`;

    it.each([
      ['切掉 1 位只剩 5 位', 149, '91347'],
      ['切掉 2 位只剩 4 位', 150, '9134'],
    ])('%s 的摘要不覆盖已存的完整码', (_name, pad, truncated) => {
      const body = bodyWithCodeAt(pad as number);
      const preview = makePreview(body, '');
      // 完整正文始终提得出 6 位；摘要单独看确实只剩残码
      expect(extractCodeByRegex('', body)).toBe('913472');
      expect(preview).toHaveLength(PREVIEW_LIMIT);
      expect(preview.endsWith(truncated as string)).toBe(true);
      expect(extractCodeByRegex('', preview, { bodyTruncated: true })).toBe('');
      expect(resolveVerificationCode('', preview, '913472', { bodyTruncated: true })).toBe('913472');
    });

    it('没取满上限的摘要末尾仍然正常提码', () => {
      const preview = makePreview('您的验证码是 913472', '');
      expect(preview.length).toBeLessThan(PREVIEW_LIMIT);
      expect(resolveVerificationCode('', preview, '')).toBe('913472');
    });

    it('摘要中间的候选不受截断影响', () => {
      const preview = makePreview(`你的验证码：913472，请在五分钟内使用。${filler.repeat(3)}`, '');
      expect(preview).toHaveLength(PREVIEW_LIMIT);
      expect(resolveVerificationCode('', preview, '', { bodyTruncated: true })).toBe('913472');
    });

    /**
     * 真实回归用例：Apple 的「Verify your Apple Account email address.」。
     * 它的前导句归一化后正好 154 字，6 位码落在第 155-161 字，摘要切在 160——
     * 列表接口拿摘要重新提码只剩 5 位，详情页走完整正文仍是 6 位。
     */
    it('Apple 验证码邮件的码正好跨在摘要边界上', () => {
      const body = [
        "You've chosen this email address for your Apple Account. To verify this email address",
        'belongs to you, enter the code below on the email verification page:',
        '',
        '472913',
        '',
        'This code will expire three hours after this email was sent.',
      ].join('\n');
      const subject = 'Verify your Apple Account email address.';
      const preview = makePreview(body, '');

      expect(extractCodeByRegex(subject, body)).toBe('472913');
      expect(preview).toHaveLength(PREVIEW_LIMIT);
      expect(preview.endsWith('47291')).toBe(true);
      expect(resolveVerificationCode(subject, preview, '472913', { bodyTruncated: true })).toBe('472913');
    });

    /**
     * 列表/wait 手里只有 160 字摘要：开头的日期、订单号离主题里的关键词更近，真码在摘要之外，
     * 一度用摘要里的年份/订单号盖掉收件时按完整正文存下的码。
     */
    it.each([
      ['年份', 'Signed in on November 17, 2026 from a new device.'],
      ['订单号', 'Order #20261117 is waiting for you to sign in on a new device.'],
    ])('摘要里的%s不覆盖第 160 字之后的已存验证码', (_name, lead) => {
      const subject = 'Your verification code';
      const body = `${lead}\nWe need to confirm it is really you before the checkout can continue, so please enter the code below within ten minutes.\nYour verification code is 482913.`;
      const preview = makePreview(body, '');
      expect(body.indexOf('482913')).toBeGreaterThan(PREVIEW_LIMIT);
      expect(extractCodeByRegex(subject, body)).toBe('482913');
      // 摘要单独看确实会提出日期或订单里的数字
      expect(extractCodeByRegex(subject, preview, { bodyTruncated: true })).not.toBe('');
      expect(resolveVerificationCode(subject, preview, '482913', { bodyTruncated: true })).toBe('482913');
    });

    it('正文超过提码扫描上限时贴着结尾的候选同样不可信', () => {
      expect(extractCodeByRegex('', `你的验证码：${'。'.repeat(CODE_SCAN_BODY_CHARS)}913472`)).toBe('');
    });
  });
});

describe('附件签名 URL', () => {
  const HOUR = 3600;
  const at = (seconds: number) => vi.spyOn(Date, 'now').mockReturnValue(seconds * 1000);

  it('站内详情的签名按小时对齐：同一小时内 URL 相同，有效期至少 1 小时', async () => {
    const base = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
    try {
      at(base);
      const first = await signAttachment(SECRET, 42);
      at(base + HOUR - 1);
      const last = await signAttachment(SECRET, 42);
      expect(last).toEqual(first);
      expect(first.exp).toBe(base + 2 * HOUR);
      expect(first.exp - (base + HOUR - 1)).toBeGreaterThanOrEqual(HOUR);
      at(base + HOUR);
      expect((await signAttachment(SECRET, 42)).exp).toBe(base + 3 * HOUR);

      // 打开详情 6 分钟后（旧版 5 分钟即过期）仍可下载；过了 exp 才失效
      at(base + HOUR - 1 + 6 * 60);
      expect(await verifyAttachmentSig(SECRET, 42, first.exp, first.sig)).toBe(true);
      at(first.exp);
      expect(await verifyAttachmentSig(SECRET, 42, first.exp, first.sig)).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('显式 TTL（外发 90 天链接）仍从当前时刻起算', async () => {
    const now = Math.floor(Date.now() / 1000);
    try {
      at(now);
      expect((await signAttachment(SECRET, 42, 90 * 86400)).exp).toBe(now + 90 * 86400);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('htmlToText', () => {
  it('行内文字标签不产生空白，结构标签仍然分隔', () => {
    expect(htmlToText('<p>Order <b>#12</b>345</p>')).toBe('Order #12345');
    expect(htmlToText('<table><tr><td>Hello</td><td>World</td></tr></table>')).toBe('Hello World');
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\n b');
  });

  it('不可见字符直接去掉，真正占位的空格仍折叠为普通空格', () => {
    expect(htmlToText('<p>ab\u200Bcd</p>')).toBe('abcd');
    expect(htmlToText('<p>ab\u00A0cd</p>')).toBe('ab cd');
    expect(htmlToText('<p>ab&#160;cd</p>')).toBe('ab cd');
    expect(htmlToText('<p>ab\u3000cd</p>')).toBe('ab cd');
    expect(htmlToText('<p>ab&nbsp;cd</p>')).toBe('ab cd');
  });

  it('解码数字与十六进制实体，非法码位丢弃', () => {
    expect(htmlToText('<p>&#72;&#105; &#x41;&#x42;</p>')).toBe('Hi AB');
    expect(htmlToText('<p>it&#39;s</p>')).toBe("it's");
    expect(htmlToText('<p>a&#x110000;b</p>')).toBe('ab');
  });

  it('&amp;#8203; 这类字面量不被当成零宽空格二次解码', () => {
    expect(htmlToText('<p>91347&amp;#8203;2</p>')).toBe('91347&#8203;2');
  });

  it('脚本、样式与既有实体行为不变', () => {
    expect(htmlToText('<head><style>.x{color:red}</style></head><body><p>hi</p></body>')).toBe('hi');
    expect(htmlToText('<p>a &lt;b&gt; &quot;c&quot; &amp; d</p>')).toBe('a <b> "c" & d');
    expect(htmlToText('<p>line1<br>line2</p>')).toBe('line1\nline2');
  });

  it('剥离整段时大小写不敏感、取第一个闭标签；没有闭标签的开标签按普通标签处理', () => {
    expect(htmlToText('<STYLE x>a</Style >b')).toBe('b');
    expect(htmlToText('<style>a<style>b</style>c</style>d')).toBe('c d');
    expect(htmlToText('x<style>never closed<p>hi</p>')).toBe('x never closed hi');
    expect(htmlToText('<script>a</script>b<script>c')).toBe('b c');
    // <header>、<scripts> 不是要整段丢弃的元素
    expect(htmlToText('<header>Brand</header><p>hi</p></head>')).toBe('Brand hi');
    expect(htmlToText('<scripts>a</script>b')).toBe('a b');
    expect(htmlToText('<a <a <br>')).toBe('<a <a');
  });

  it('只处理开头 512KB，超长输入的结尾不参与转换', () => {
    const text = htmlToText(`<p>${'a '.repeat(HTML_TO_TEXT_MAX_CHARS)}TAIL</p>`);
    expect(text.length).toBeLessThanOrEqual(HTML_TO_TEXT_MAX_CHARS);
    expect(text).not.toContain('TAIL');
  });

  it('开头的超大内嵌图片不占截断额度：后面的验证码仍能转换出来', () => {
    const image = 'A'.repeat(600 * 1024);
    for (const html of [
      `<p>hi</p><img src="data:image/png;base64,${image}"><p>Your code is 913472</p>`,
      `<img src='data:image/png;base64,${image}' alt=x><p>Your code is 913472</p>`,
      `<img src=data:image/png;base64,${image}><p>Your code is 913472</p>`,
      `<div style="background:url(data:image/png;base64,${image})">Your code is 913472</div>`,
    ]) {
      const converted = convertHtmlToText(html);
      expect(converted.text).toContain('Your code is 913472');
      expect(converted.text).not.toContain('AAAA');
      expect(converted.truncated).toBe(false);
    }
  });

  it('截断落在标签中间时丢掉残缺的标签；截断与实体留下的孤立代理字符去掉', () => {
    const cut = convertHtmlToText(`<p>start</p><div ${'a="x" '.repeat(100_000)}>tail</div>`);
    expect(cut).toEqual({ text: 'start', truncated: true });

    // 截断点正好在表情的代理对中间
    const emoji = htmlToText(`<p>${'a'.repeat(HTML_TO_TEXT_MAX_CHARS - 4)}${'😀'.repeat(8)}</p>`);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(htmlToText('<p>a&#xD800;b &#xDE00;c 😀</p>')).toBe('ab c 😀');
  });

  it('病态 HTML 耗时线性：没有 > 的长串、没闭合的 <style>、大量 <header> 不再平方退化', () => {
    // 修复前每种在 256KB 上耗时 1～12 秒（收件解析在 SMTP Ack 前同步执行，会耗尽 CPU）
    const size = 256 * 1024;
    const started = Date.now();
    for (const unit of ['<a ', '<b ', '<style>', '<style ', '<header>x', '</style  ', '="a', "='", 'data:', '= ']) {
      htmlToText(unit.repeat(Math.ceil(size / unit.length)));
      htmlToText(`${unit.repeat(Math.ceil(size / unit.length))}<br>`);
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('ip-allowlist', () => {
  it('空白名单放行', () => {
    expect(ipInAllowList('1.2.3.4', [])).toBe(true);
  });
  it('IPv4 精确匹配', () => {
    expect(ipInAllowList('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipInAllowList('1.2.3.5', ['1.2.3.4'])).toBe(false);
  });
  it('IPv4 CIDR', () => {
    expect(ipInAllowList('192.168.1.55', ['192.168.1.0/24'])).toBe(true);
    expect(ipInAllowList('192.168.2.55', ['192.168.1.0/24'])).toBe(false);
    expect(ipInAllowList('10.0.0.1', ['0.0.0.0/0'])).toBe(true);
  });
  it('IPv6 精确匹配（压缩与展开等价）', () => {
    expect(ipInAllowList('2001:db8::1', ['2001:db8::1'])).toBe(true);
    expect(ipInAllowList('2001:0db8:0000:0000:0000:0000:0000:0001', ['2001:db8::1'])).toBe(true);
    expect(ipInAllowList('::1', ['::1'])).toBe(true);
  });
  it('IPv6 CIDR（此前静默锁死的场景）', () => {
    expect(ipInAllowList('2001:db8::abcd', ['2001:db8::/32'])).toBe(true);
    expect(ipInAllowList('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipInAllowList('fe80::1', ['fe80::/10'])).toBe(true);
  });
  it('跨协议族不误匹配', () => {
    expect(ipInAllowList('1.2.3.4', ['2001:db8::/32'])).toBe(false);
    expect(ipInAllowList('2001:db8::1', ['192.168.0.0/16'])).toBe(false);
  });
});

describe('totp', () => {
  // RFC 6238 测试向量（seed=ascii "12345678901234567890" → base32）
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('匹配 RFC 6238 向量', async () => {
    expect(await generateCode(RFC_SECRET, 1)).toBe('287082');
    expect(await generateCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('当前时间码 verifyTotp 往返成功', async () => {
    const secret = generateTotpSecret();
    const counter = Math.floor(Date.now() / 1000 / 30);
    const code = await generateCode(secret, counter);
    expect(await verifyTotp(secret, code)).toBe(true);
  });
  it('非法/错误码被拒', async () => {
    const secret = generateTotpSecret();
    expect(await verifyTotp(secret, '000000')).toBe(false);
    expect(await verifyTotp(secret, 'abc')).toBe(false);
    expect(await verifyTotp(secret, '')).toBe(false);
  });
});

describe('foldBase64', () => {
  it('短串（≤76）原样返回', () => {
    expect(foldBase64('QUJD')).toBe('QUJD');
    expect(foldBase64('A'.repeat(76))).toBe('A'.repeat(76));
  });
  it('长串按 76 字符 CRLF 折行，每行不超限', () => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(10000).fill(7)));
    const folded = foldBase64(b64);
    const lines = folded.split('\r\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(76);
    expect(lines.slice(0, -1).every((l) => l.length === 76)).toBe(true);
  });
  it('折行后去掉 CRLF 与原串一致（内容无损）', () => {
    const b64 = btoa(String.fromCharCode(...new Uint8Array(5000).map((_, i) => i % 251)));
    expect(foldBase64(b64).replace(/\r\n/g, '')).toBe(b64);
  });
});

describe('injectAttachmentLinks', () => {
  const links = [{ filename: 'a.pdf', size: 9_500_000, url: 'https://hpc.email/api/attachments/1?exp=1&sig=x' }];

  it('纯文本邮件不生成 html part（否则收件端优先渲染 html，正文被链接块盖掉）', () => {
    const out = injectAttachmentLinks('很长的正文', '', links);
    expect(out.html).toBe('');
    expect(out.text).toContain('很长的正文');
    expect(out.text).toContain('a.pdf');
    expect(out.text).toContain('https://hpc.email/api/attachments/1?exp=1&sig=x');
  });

  it('HTML 邮件只追加到 html，不凭空造 text part', () => {
    const out = injectAttachmentLinks('', '<p>很长的正文</p>', links);
    expect(out.text).toBe('');
    expect(out.html).toContain('<p>很长的正文</p>');
    expect(out.html).toContain('<a href="https://hpc.email/api/attachments/1?exp=1&sig=x">a.pdf</a>');
  });

  it('text + html 都有时各追加一份；无链接时原样返回', () => {
    const both = injectAttachmentLinks('文本', '<p>富文本</p>', links);
    expect(both.text).toContain('文本');
    expect(both.text).toContain('a.pdf');
    expect(both.html).toContain('<p>富文本</p>');
    expect(both.html).toContain('a.pdf');
    expect(injectAttachmentLinks('文本', '', [])).toEqual({ text: '文本', html: '' });
  });
});

describe('chunk（D1 100 绑定参数上限）', () => {
  it('不超过 size 时原样一批；空数组返回空批次', () => {
    expect(chunk([1, 2, 3], 90)).toEqual([[1, 2, 3]]);
    expect(chunk([], 90)).toEqual([]);
  });
  it('按 size 切分，每批都不超上限', () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const batches = chunk(ids, D1_ID_BATCH);
    expect(batches.length).toBe(Math.ceil(500 / D1_ID_BATCH));
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(D1_ID_BATCH);
    expect(batches.flat()).toEqual(ids);
  });
  it('每批加上其他绑定值仍在 D1 上限内', () => {
    // 批内 id 数 + 若干附加绑定值（SET 字段、scope 子查询的 ownerId 等）
    expect(D1_ID_BATCH + 10).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    expect(D1_PAIR_BATCH * 2 + 10).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });
});

describe('附件下载文件名头', () => {
  it('filename= 兜底只含 ASCII 并保留扩展名，filename* 保留完整 UTF-8', () => {
    const disposition = buildSecureHeaders('application/pdf', '季度报告 2026.pdf').get('Content-Disposition')!;
    expect(disposition).toBe(`attachment; filename="_ 2026.pdf"; filename*=UTF-8''${encodeURIComponent('季度报告 2026.pdf')}`);
    expect(/^[\x20-\x7e]*$/.test(disposition)).toBe(true);
  });

  it('主干全是非 ASCII 时用 download 代替，扩展名照留；无扩展名也能兜底', () => {
    expect(asciiFallbackFilename('报告.pdf')).toBe('download.pdf');
    expect(asciiFallbackFilename('照片.JPG')).toBe('download.JPG');
    expect(asciiFallbackFilename('合同')).toBe('download');
    expect(asciiFallbackFilename('résumé-final.docx')).toBe('r_sum_-final.docx');
    expect(asciiFallbackFilename('invoice.发票')).toBe('invoice');
    expect(asciiFallbackFilename('.env')).toBe('.env');
    expect(asciiFallbackFilename('plain-ascii_v2.tar.gz')).toBe('plain-ascii_v2.tar.gz');
  });

  it("filename* 按 RFC 5987 转义 '()*，图片仍 inline", () => {
    const headers = buildSecureHeaders('image/png', "截图(1)*.png");
    expect(headers.get('Content-Disposition')).toBe(`inline; filename="_(1)*.png"; filename*=UTF-8''%E6%88%AA%E5%9B%BE%281%29%2A.png`);
    expect(headers.get('Content-Type')).toBe('image/png');
  });
});

describe('MIME 参数清洗', () => {
  it('剥掉 CRLF 与引号，堵住附件头注入', () => {
    const evil = 'x.png"\r\nContent-Type: text/html\r\n\r\n<h1>INJECTED</h1>';
    const cleaned = sanitizeFilename(evil);
    expect(cleaned).not.toMatch(/[\r\n"]/);
    expect(cleaned.startsWith('x.png')).toBe(true);
  });
  it('清洗后为空时给占位名，不产生 filename=""', () => {
    expect(sanitizeFilename('\r\n""')).toBe('attachment');
  });
  it('限长，避免撑出超 998 字节的头行', () => {
    expect(sanitizeFilename('a'.repeat(5000)).length).toBeLessThanOrEqual(200);
  });
  it('非法 MIME 类型退回通用二进制类型', () => {
    expect(sanitizeMimeType('image/png')).toBe('image/png');
    expect(sanitizeMimeType('image/png"\r\nX: y')).toBe('application/octet-stream');
    expect(sanitizeMimeType('不是类型')).toBe('application/octet-stream');
  });
});

describe('encodeBodyBase64（正文行长）', () => {
  it('长中文正文编码后每行都不超 76 字符', () => {
    const body = '这是一段很长的中文正文，没有任何换行。'.repeat(200);
    const lines = encodeBodyBase64(body).split('\r\n');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(76);
  });
  it('解码后与原文一致（无损）', () => {
    const body = '你好 world\n第二行\t制表符 🎉';
    const raw = encodeBodyBase64(body).replace(/\r\n/g, '');
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(body);
  });
});

describe('PushDeer 通知', () => {
  it('默认端点为官方 api2.pushdeer.com', () => {
    expect(validatePushDeerEndpoint('')).toBe(DEFAULT_PUSHDEER_ENDPOINT);
    expect(validatePushDeerEndpoint(undefined)).toBe(DEFAULT_PUSHDEER_ENDPOINT);
  });

  it('允许合法的第三方/自建 http(s) 端点', () => {
    expect(validatePushDeerEndpoint('https://push.my-domain.com/path')).toBe('https://push.my-domain.com');
  });

  it('阻止非法端点协议与内网地址（防 SSRF）', () => {
    expect(() => validatePushDeerEndpoint('ftp://example.com')).toThrow(AppError);
    expect(() => validatePushDeerEndpoint('http://localhost:8080')).toThrow(AppError);
    expect(() => validatePushDeerEndpoint('http://127.0.0.1')).toThrow(AppError);
    expect(() => validatePushDeerEndpoint('http://192.168.1.1')).toThrow(AppError);
    expect(() => validatePushDeerEndpoint('http://10.0.0.1')).toThrow(AppError);
  });

  it('未启用时不发送，force 时可触发', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 0, content: { result: [] } })),
    );

    // 未启用且非 force → 不调 fetch
    await sendPushDeerNotification(
      { enabled: false, pushkey: 'PDU_TEST', endpoint: '' },
      { subject: 'test', fromAddress: 'a@b.com', fromName: 'A', toAddress: 'c@d.com', body: 'hi' },
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // force → 调用 fetch
    await sendPushDeerNotification(
      { enabled: false, pushkey: 'PDU_TEST', endpoint: '' },
      { subject: 'test', fromAddress: 'a@b.com', fromName: 'A', toAddress: 'c@d.com', code: '654321', body: 'hi' },
      { force: true },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe('https://api2.pushdeer.com/message/push');
    const body = JSON.parse(call[1]?.body as string);
    expect(body.pushkey).toBe('PDU_TEST');
    expect(body.text).toContain('654321');
    expect(body.desp).toContain('a@b.com');

    fetchSpy.mockRestore();
  });
});
