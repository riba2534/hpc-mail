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
