import { describe, expect, it } from 'vitest';
import { codeScanBody, extractCodeByRegex, wantsAiCode } from '../src/services/code-extract.js';

/** 仿造样本，结构仿照常见的误判来源，不含真实邮件内容 */
describe('正则提码不把邮编、年份、编号当成验证码（R08）', () => {
  it.each([
    ['邮编：「ZIP code」不是验证码说法', 'Find a store near you', 'Enter your ZIP code to see stores near you: 94103'],
    ['邮编：验证码邮件页脚的地址', 'Your verification code', 'Your verification code is shown in the app.\nExample Inc, 500 Howard Street, San Francisco, CA 94105'],
    ['营销截止日期的年份', 'Spring sale', 'Use code SPRING at checkout to save 20%. Offer ends March 31, 2026.'],
    ['有验证语境的营销信里的年份', 'Confirm your subscription', 'Thanks for confirming. Use the code below at checkout: SPRING. Offer ends March 31, 2026.'],
    ['PR 编号', '[org/repo] Fix login code path (PR #4821)', 'alice requested your review on pull request #4821: Fix login code path\nhttps://github.example/org/repo/pull/4821'],
    ['订单与工单编号', 'Your verification code', 'Order No. 55012345 shipped. Ticket 77120931 is closed.'],
    ['电话号码', 'Your verification code', 'Your verification code is in the app. Questions? Call 1-800-555-0199'],
    ['空格分段的电话号码', 'Your verification code', 'Your verification code is in the app. Phone: 415 555 0123'],
    ['邮编标注', 'Your verification code', 'Your verification code is in the app. Postal code: 100080'],
    ['纯字母码与版权年份', 'Your verification code', 'Your verification code is QWERTZ\n\nThis code expires in 10 minutes.\n© 2026 Example Inc.'],
  ])('%s', (_name, subject, body) => {
    expect(extractCodeByRegex(subject, body)).toBe('');
  });

  it.each([
    ['紧贴关键词的年份形状验证码', '', 'Your verification code is 2048', '2048'],
    ['码在说法之前', '', '1987 is your verification code', '1987'],
    ['验证语境里的裸 code', 'Sign in to Example', 'Enter this code to finish signing in: 482913', '482913'],
    ['your … code', 'Confirm your email', '482913 is your Example code', '482913'],
    ['PIN code', 'Card activation', 'Your PIN code is 7391', '7391'],
    ['订单号与验证码并存时取验证码', '', '订单号 99887766 已生成。验证码：551203', '551203'],
    ['「address」紧挨着真码', 'Verify your email', 'Your verification code for this email address: 482913', '482913'],
    ['电话标注之后不是号码分段', 'Sign in', 'Enter this verification code on your phone: 731904', '731904'],
  ])('真码照常提取：%s', (_name, subject, body, code) => {
    expect(extractCodeByRegex(subject, body)).toBe(code);
  });

  it('没有验证语境时裸 code 不算关键词：「Your code: SAVE20」这类优惠码不提', () => {
    expect(extractCodeByRegex('Weekend deal', 'Your code: SAVE2026 is good for 20% off.')).toBe('');
    expect(extractCodeByRegex('Verify your email', 'Your code: AB12CD34 expires soon.')).toBe('AB12CD34');
  });
});

describe('AI 兜底前置过滤的 code 词边界（R08）', () => {
  it('barcode、encode 不触发；德语合成词与独立的 code 照常触发', () => {
    expect(wantsAiCode({ subject: 'Your pickup barcode', text: 'Show the barcode at the counter.', html: '' })).toBe(false);
    expect(wantsAiCode({ subject: 'Encoding tips', text: 'How to encode and decode Unicode text.', html: '' })).toBe(false);
    expect(wantsAiCode({ subject: 'Ihr Bestätigungscode', text: '', html: '' })).toBe(true);
    expect(wantsAiCode({ subject: 'Your code', text: '', html: '' })).toBe(true);
  });
});

describe('纯文本段是占位文案时提码看 HTML（R08）', () => {
  const placeholder = 'Please view this email in an HTML-capable client.';
  const html = '<p>Hello,</p><p>Your verification code is <b>482913</b>.</p>';

  it('占位或很短的 text 段改看 HTML 转出的文本；正常 text 段原样使用', () => {
    expect(codeScanBody(placeholder, html, placeholder)).toContain('482913');
    expect(codeScanBody('Hi', html, 'Hi')).toContain('482913');
    const real = 'Your verification code is 731904. It expires in ten minutes.';
    expect(codeScanBody(real, html, real)).toBe(real);
    expect(codeScanBody('', html, 'converted')).toBe('converted');
  });
});
