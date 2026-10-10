import { describe, expect, it } from 'vitest';
import { hanRatio, messageNeedsTranslation, needsTranslation, roughHtmlText } from './detect';

describe('hanRatio / needsTranslation', () => {
  it('按汉字在字母类字符中的占比判断，数字、标点与空白不计', () => {
    expect(hanRatio('Your order 123 has shipped!')).toBe(0);
    expect(hanRatio('订单 123 已发货！')).toBe(1);
    expect(hanRatio('1234 —— !!!')).toBeNull();
    expect(needsTranslation('Your order has shipped')).toBe(true);
    expect(needsTranslation('您的订单已发货，单号 SF1234567')).toBe(false);
    expect(needsTranslation('')).toBe(false);
    expect(needsTranslation('2026-10-10 12:00')).toBe(false);
  });

  it('低于 30% 才算需要翻译', () => {
    // 3 个汉字 / 10 个字母 = 30%：视为中文
    expect(needsTranslation('中文字abcdefg')).toBe(false);
    // 2 / 9 ≈ 22%：英文为主，提供翻译
    expect(needsTranslation('中文abcdefg')).toBe(true);
  });

  it('假名与谚文不计入汉字：日文、韩文邮件照常可译', () => {
    expect(needsTranslation('ご注文ありがとうございます。商品を発送しました。')).toBe(true);
    expect(needsTranslation('주문해 주셔서 감사합니다')).toBe(true);
  });
});

describe('messageNeedsTranslation', () => {
  it('HTML 正文按可见文字判断，忽略样式、脚本与实体', () => {
    const css = `<style>${'body { font-family: Arial; color: red; } '.repeat(50)}</style>`;
    expect(roughHtmlText(`${css}<p>你好&nbsp;世界</p>`)).not.toMatch(/Arial|nbsp/);
    expect(messageNeedsTranslation({ bodyHtml: `${css}<p>您的验证码已发送，请在十分钟内完成验证。</p>`, bodyText: '' })).toBe(false);
    expect(messageNeedsTranslation({ bodyHtml: '<p>Your verification code was sent.</p>', bodyText: '中文纯文本' })).toBe(true);
  });

  it('纯文本正文直接判断；正文为空不提供翻译', () => {
    expect(messageNeedsTranslation({ bodyHtml: '', bodyText: 'Hello there' })).toBe(true);
    expect(messageNeedsTranslation({ bodyHtml: '', bodyText: '' })).toBe(false);
    expect(messageNeedsTranslation({ bodyHtml: '<img src="cid:logo">', bodyText: '' })).toBe(false);
  });
});
