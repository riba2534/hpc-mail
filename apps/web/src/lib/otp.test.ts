import { describe, expect, it } from 'vitest';
import { extractOtp } from './otp';

describe('extractOtp', () => {
  it('提取中文关键词附近的数字验证码', () => {
    const result = extractOtp('登录提醒', '您的验证码是 482913，请在 5 分钟内使用。');
    expect(result).toEqual({ code: '482913', source: 'body' });
  });

  it('提取英文关键词附近的验证码', () => {
    const result = extractOtp('', 'Your verification code is 903215.');
    expect(result?.code).toBe('903215');
  });

  it('多个候选时取距离关键词最近的一个', () => {
    const result = extractOtp('', '订单号 100200 已创建，你的验证码是 445566。');
    expect(result?.code).toBe('445566');
  });

  it('识别大写字母数字混合验证码', () => {
    const result = extractOtp('', 'Your code: A1B2C3 expires soon.');
    expect(result?.code).toBe('A1B2C3');
  });

  it('没有关键词时不提取', () => {
    expect(extractOtp('Hello', 'The tracking number is 123456.')).toBeNull();
  });

  it('主题命中时标记来源为 subject', () => {
    const result = extractOtp('验证码 246810 请查收', '正文无关内容');
    expect(result).toEqual({ code: '246810', source: 'subject' });
  });

  it('one-time link 邮件不把 URL token 或页脚数字识别为验证码', () => {
    const body = [
      'Continue verifying your identity',
      'Please click the link below.',
      'https://withpersona.example/verify?code=VGHH62D',
      'This link will expire in 1 hour.',
      '981 Mission Street, San Francisco, CA 94103',
    ].join('\n');
    expect(extractOtp('Anthropic one-time link', body)).toBeNull();
  });

  it('URL 内的 code 关键词不能激活附近数字', () => {
    expect(extractOtp('Verification link', 'Open https://example.test/?code=A1B2C3 then visit ZIP 94103.')).toBeNull();
  });

  it('generic verification 文案和长 ID 不产生截断误报', () => {
    expect(extractOtp('Verification completed', 'Completed on 2026-08-31.')).toBeNull();
    expect(extractOtp('Account notice', 'Tracking ID ABCD1234567890XYZ')).toBeNull();
  });

  it('同时提供链接和明确验证码时仍提取验证码', () => {
    const body = 'Your verification code is 482913. Or click https://example.test/verify/A1B2C3';
    expect(extractOtp('Verify your account', body)).toEqual({ code: '482913', source: 'body' });
  });
});
