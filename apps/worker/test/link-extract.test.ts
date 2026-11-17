import { describe, expect, it } from 'vitest';
import { extractVerificationLink, MAX_VERIFICATION_LINK_LENGTH } from '../src/services/link-extract.js';

const footer = `
  <p style="color:#999">
    <a href="https://example.com/unsubscribe?u=abc">Unsubscribe</a> ·
    <a href="https://example.com/privacy">Privacy Policy</a> ·
    <a href="https://help.example.com/">Help Center</a> ·
    <a href="mailto:support@example.com">Contact support</a>
  </p>
  <img src="https://track.example.com/open.gif?id=123" width="1" height="1">`;

describe('验证链接提取：常见服务样例', () => {
  it('GitHub 风格：按钮文字 + 路径含 confirm', () => {
    const html = `<p>Almost done, @octo! To complete your GitHub sign up, we just need to verify your email address: octo@hpc.email.</p>
      <a href="https://github.com/users/octo/emails/123/confirm_verification/6f1ed002ab5595859014ebf0951522d9?via_launch_code_email=true"
         style="background:#2ea44f;color:#fff">Verify email address</a>
      <p>Button not working? Paste the following link into your browser:<br>
      https://github.com/users/octo/emails/123/confirm_verification/6f1ed002ab5595859014ebf0951522d9?via_launch_code_email=true</p>
      <a href="https://github.com/settings/emails">Email settings</a>${footer}`;
    expect(extractVerificationLink({ subject: '[GitHub] Please verify your email address', html, fromAddress: 'noreply@github.com' }))
      .toBe('https://github.com/users/octo/emails/123/confirm_verification/6f1ed002ab5595859014ebf0951522d9?via_launch_code_email=true');
  });

  it('魔法登录链接：Notion 风格，HTML 实体 &amp; 解码', () => {
    const html = `<div>Click the button below to log in to Notion. This magic link expires in 10 minutes.</div>
      <a href="https://www.notion.so/loginwithemail?token=v02%3Aemail_token%3Aabcdefghijklmnopqrstuvwxyz0123&amp;state=xyz"><img alt="Log in to Notion" src="https://www.notion.so/images/button.png"></a>
      <a href="https://www.notion.so/help">Help</a>`;
    expect(extractVerificationLink({ subject: 'Your Notion login link', html, fromAddress: 'notify@mail.notion.so' }))
      .toBe('https://www.notion.so/loginwithemail?token=v02%3Aemail_token%3Aabcdefghijklmnopqrstuvwxyz0123&state=xyz');
  });

  it('密码重置：导航「Log in」与 CTA 并存时取 CTA', () => {
    const html = `<a href="https://app.example.com/login">Log in</a>
      <h1>Reset your password</h1><p>Someone requested a password reset for your account.</p>
      <a href="https://app.example.com/password/reset?token=Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4OTA">Reset password</a>${footer}`;
    expect(extractVerificationLink({ subject: 'Reset your password', html, fromAddress: 'no-reply@example.com' }))
      .toBe('https://app.example.com/password/reset?token=Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4OTA');
  });

  it('点击追踪域名包装的按钮仍按按钮文字识别', () => {
    const html = `<p>Thanks for signing up! Please confirm your email address to activate your account.</p>
      <a href="https://u1234567.ct.sendgrid.net/ls/click?upn=u001.abcDEF123456789ghiJKL-2BmnoPQR">Confirm email</a>${footer}`;
    expect(extractVerificationLink({ subject: 'Welcome to Acme', html, fromAddress: 'hello@acme.io' }))
      .toBe('https://u1234567.ct.sendgrid.net/ls/click?upn=u001.abcDEF123456789ghiJKL-2BmnoPQR');
  });

  it('订阅确认（Mailchimp 风格）', () => {
    const html = `<h2>Please Confirm Subscription</h2>
      <a href="https://example.us1.list-manage.com/subscribe/confirm?u=0123456789abcdef0123456&amp;id=abcdef1234&amp;e=1234567890">Yes, subscribe me to this list.</a>
      <p>If you received this email by mistake, simply delete it.</p>`;
    expect(extractVerificationLink({ subject: 'Example Newsletter: Please Confirm Subscription', html }))
      .toBe('https://example.us1.list-manage.com/subscribe/confirm?u=0123456789abcdef0123456&id=abcdef1234&e=1234567890');
  });

  it('「click here」型：链接文字无动作词，靠紧随其后的意图短语', () => {
    const html = `<p>Hi, please <a href="https://t.example.net/r/AbCdEfGhIjKlMnOpQrStUvWx">click here</a> to verify your email address.</p>`;
    expect(extractVerificationLink({ subject: 'Welcome!', html })).toBe('https://t.example.net/r/AbCdEfGhIjKlMnOpQrStUvWx');
  });

  it('中文纯文本激活链接，行尾无空格的汉字与标点不吞入 URL', () => {
    const text = `您好，感谢注册 XX！请点击下面的链接激活您的账号：
https://www.example.cn/user/activate?code=8f14e45fceea167a5a36dedd4bea2543。链接 24 小时内有效。
如果链接无法点击，请复制到浏览器打开。
退订：https://www.example.cn/unsubscribe?u=1`;
    expect(extractVerificationLink({ subject: '账号激活', text })).toBe('https://www.example.cn/user/activate?code=8f14e45fceea167a5a36dedd4bea2543');
  });

  it('中文 HTML 登录链接', () => {
    const html = `<p>你正在登录 示例平台，点击下方按钮完成登录：</p><a href="https://passport.example.cn/magic?ticket=AAAABBBBCCCCDDDDEEEEFFFF">立即登录</a>
      <p>如非本人操作请忽略。<a href="https://www.example.cn/help">帮助中心</a></p>`;
    expect(extractVerificationLink({ subject: '登录确认', html })).toBe('https://passport.example.cn/magic?ticket=AAAABBBBCCCCDDDDEEEEFFFF');
  });

  it('纯文本里的 Markdown 链接剥掉不配对的右括号与句末标点', () => {
    const text = 'Please verify your email: [Verify email](https://example.com/verify?token=abcdefghijklmnopqrstuvwxyz).';
    expect(extractVerificationLink({ subject: 'Verify your email', text })).toBe('https://example.com/verify?token=abcdefghijklmnopqrstuvwxyz');
  });

  it('同时有文本和 HTML 时结果一致，且无需 fromAddress', () => {
    const text = 'Sign in to Medium\n\nClick the link below to sign in:\nhttps://medium.com/m/callback/email?token=0123456789abcdef0123&operation=login\n\nIf you did not request this, ignore this email.';
    const html = '<a href="https://medium.com/m/callback/email?token=0123456789abcdef0123&amp;operation=login">Sign in to Medium</a>';
    expect(extractVerificationLink({ subject: 'Sign in to Medium', text, html })).toBe('https://medium.com/m/callback/email?token=0123456789abcdef0123&operation=login');
  });
});

/**
 * 仿造的 Claude 安全登录邮件（结构仿照真实模板，内容全部虚构）：主题只说 secure link、不含 verify/sign in，
 * 引导句在 to 与登录动词之间多一个词或用 -ing 形式，按钮包在 SES 点击追踪长链接里。
 */
describe('验证链接提取：Claude 安全登录链接', () => {
  const magic = 'https://click.mail.anthropic.com/CL0/https:%2F%2Fclaude.ai%2Fmagic-link%23Zm9vYmFyYmF6cXV4cXV1eDEyMzQ1Njc4OTA:c2FtcGxlQGhwYy5lbWFpbA==/1/0100019a2b3c4d5e-6f708192-a3b4-c5d6-e7f8-091a2b3c4d5e-000000/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789=412';
  const privacy = 'https://click.mail.anthropic.com/CL0/https:%2F%2Fwww.anthropic.com%2Flegal%2Fprivacy/1/0100019a2b3c4d5e-6f708192-a3b4-c5d6-e7f8-091a2b3c4d5e-000000/ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210=412';
  const template = (lead: string) => `<table role="presentation" width="100%"><tr><td align="center">
      <img src="https://cdn.mail.anthropic.com/claude-wordmark.png" alt="Claude" width="120">
      <h1 style="font-size:24px">Your secure link to Claude.ai</h1>
      <p>Hello,</p>
      <p>${lead} This link expires in 60 minutes and can only be used once.</p>
      <a href="${magic}" style="background:#c96442;color:#ffffff;padding:12px 24px;border-radius:8px">Sign in to Claude.ai</a>
      <p>If you didn't request this email, you can safely ignore it.</p>
      <p style="color:#999999">Anthropic · Example Street 1 · San Francisco</p>
      <a href="${privacy}">Privacy Policy</a>
    </td></tr></table>`;
  const subject = 'Your secure link to Claude.ai is here | 2026-11-17';
  const from = 'no-reply-q1@mail.anthropic.com';

  it.each([
    ['to 后插入一个词', 'Click the link below to securely sign in to Claude.ai.'],
    ['-ing 形式', 'Use the button below to continue signing in to Claude.ai.'],
  ])('引导句%s：取按钮的追踪链接，页脚隐私链接不入选', (_name, lead) => {
    const html = template(lead);
    const text = `Your secure link to Claude.ai\n\n${lead}\n\n${magic}\n\nIf you didn't request this email, you can safely ignore it.`;
    expect(extractVerificationLink({ subject, html, fromAddress: from })).toBe(magic);
    expect(extractVerificationLink({ subject, text, html, fromAddress: from })).toBe(magic);
  });

  it('弱意图要主题与正文同时具备：只有主题的 secure link、或主题与账号登录无关时都不放行', () => {
    expect(extractVerificationLink({ subject, html: template('Here it is.'), fromAddress: from })).toBe('');
    expect(extractVerificationLink({ subject: 'Claude.ai | 2026-11-17', html: template('Click the link below to securely sign in to Claude.ai.'), fromAddress: from })).toBe('');
  });

  /** 正文有弱意图句式、按钮与路径也像登录，但主题与账号登录无关：主干不认，这里同样不认 */
  it.each([
    ['周报', 'Your weekly report is ready',
      '<p>Your team report for Nov 10–16 is ready. Use the button below to quickly log in and review the numbers.</p><a href="https://app.metrics.example/login?next=/reports">Log in to dashboard</a>'],
    ['会议邀请', "You're invited: Product roadmap webinar, Nov 20",
      '<p>Seats are limited. Click the button below to quickly confirm your seat.</p><a href="https://events.example.com/webinars/42/confirm?attendee=a1b2c3d4e5f6">Confirm</a>'],
    ['促销', 'Last chance: 30% off ends tonight',
      '<p>Tap the button to continue signing in and claim your discount before midnight.</p><a href="https://shop.example.com/signin?promo=FALL30">Sign in to claim</a>'],
    ['账单', 'Your November invoice from Acme',
      '<p>Your invoice is ready. You can view it any time through this secure link.</p><a href="https://billing.example.com/login?invoice=INV-2026-11">Sign in to view invoice</a>'],
  ])('%s邮件不当作验证链接', (_name, mailSubject, html) => {
    expect(extractVerificationLink({ subject: mailSubject, html: `${html}${footer}` })).toBe('');
  });

  it('只凭弱意图时，按钮文字不含动作词的链接不入选（即使路径带 token 且与发件域相同）', () => {
    const html = `<p>Use the button below to continue signing in to Example.</p>
      <a href="https://app.example.com/login?next=%2Fhome&amp;ref=AbCdEfGhIjKlMnOpQrStUvWx">Open Example</a>${footer}`;
    expect(extractVerificationLink({ subject: 'Your secure link to Example is here', html, fromAddress: 'no-reply@app.example.com' })).toBe('');
  });

  it('只凭弱意图时，按钮是「登录」但路径没有验证特征的链接不入选', () => {
    const html = `<a href="https://app.example.com/account">Log in</a>
      <p>Use the button below to continue signing in to Example.</p>
      <a href="https://app.example.com/pricing?plan=pro">Start free trial</a>${footer}`;
    expect(extractVerificationLink({ subject: 'Your secure link to Example is here', html, fromAddress: 'news@app.example.com' })).toBe('');
  });
});

describe('验证链接提取：误判反例', () => {
  it('营销邮件导航栏的登录链接不算（整封无验证意图）', () => {
    const html = `<a href="https://shop.example.com/login">Log in</a> <a href="https://shop.example.com/sale">Shop the sale</a>
      <p>Our biggest sale of the year is here. Up to 50% off.</p>${footer}`;
    expect(extractVerificationLink({ subject: 'This week only: 50% off everything', html })).toBe('');
  });

  it('账单通知「登录查看」不算', () => {
    const text = 'Your statement is ready. Log in to view your statement: https://bank.example.com/login?ref=statement_2026_10';
    expect(extractVerificationLink({ subject: 'Your October statement is ready', text })).toBe('');
  });

  it('订单已确认邮件不把「查看订单」当验证链接', () => {
    const html = `<h1>Your order is confirmed</h1><p>Thanks for your purchase.</p>
      <a href="https://shop.example.com/orders/12345?token=abcdefghijklmnopqrstuvwxyz">View order</a>`;
    expect(extractVerificationLink({ subject: 'Order confirmation #12345', html })).toBe('');
    expect(extractVerificationLink({ subject: '订单已确认', html: '<p>您的订单已确认。</p><a href="https://shop.example.cn/order/1?token=abcdefghijklmnopqrstu">查看订单</a>' })).toBe('');
  });

  it('只有验证码的邮件：帮助/隐私等页脚链接不入选', () => {
    const html = `<p>Your verification code is <b>482913</b>. It expires in 10 minutes.</p>${footer}
      <a href="https://example.com/">Example Inc.</a>`;
    expect(extractVerificationLink({ subject: 'Your verification code', html })).toBe('');
  });

  it('退订、偏好设置、在浏览器查看即使靠近意图短语也排除', () => {
    const html = `<p>Please confirm your subscription preferences.</p>
      <a href="https://news.example.com/preferences?u=abcdefghijklmnopqrstuvwxyz">Manage preferences</a>
      <a href="https://news.example.com/view?id=abcdefghijklmnopqrstuvwxyz">View this email in your browser</a>
      <a href="https://news.example.com/u?action=unsubscribe&id=abcdefghijklmnopqrstuvwxyz">Confirm unsubscribe</a>`;
    expect(extractVerificationLink({ subject: 'Confirm your subscription', html })).toBe('');
  });

  it('非 http(s)、图片资源、追踪像素、IP 主机、带凭据的 URL 都排除', () => {
    const html = `<p>Click the button below to verify your email address.</p>
      <a href="javascript:alert(1)">Verify email</a>
      <a href="mailto:verify@example.com">Verify email</a>
      <a href="https://cdn.example.com/verify-button.png">Verify email</a>
      <a href="https://t.example.com/wf/open?upn=abcdefghijklmnopqrstuvwxyz">Verify email</a>
      <a href="https://192.168.1.10/verify?token=abcdefghijklmnopqrstuvwxyz">Verify email</a>
      <a href="https://example.com@evil.example/verify?token=abcdefghijklmnopqrstuvwxyz">Verify email</a>
      <a href="/verify?token=abcdefghijklmnopqrstuvwxyz">Verify email</a>`;
    expect(extractVerificationLink({ subject: 'Verify your email', html })).toBe('');
  });

  it('超长 URL 不输出', () => {
    const long = `https://example.com/verify?token=${'a'.repeat(MAX_VERIFICATION_LINK_LENGTH)}`;
    expect(extractVerificationLink({ subject: 'Verify your email', html: `<a href="${long}">Verify email</a>` })).toBe('');
  });

  it('意图存在但链接没有任何验证特征（无标签、无 token、远离意图短语）时宁缺毋滥', () => {
    const html = `<p>Please verify your email address.</p>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>'.repeat(8)}
      <a href="https://example.com/blog">Read our blog</a>`;
    expect(extractVerificationLink({ subject: 'Verify your email', html })).toBe('');
  });

  it('空输入与无链接邮件返回空串', () => {
    expect(extractVerificationLink({})).toBe('');
    expect(extractVerificationLink({ subject: 'Verify your email', text: 'Your code is 123456' })).toBe('');
  });
});
