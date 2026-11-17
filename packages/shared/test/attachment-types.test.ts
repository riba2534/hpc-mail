import { describe, expect, it } from 'vitest';
import { isSafeInlineImageType, normalizeMimeType } from '../src/attachment-types.js';

describe('attachment-types', () => {
  it('规范化只取分号前的主类型并转小写', () => {
    expect(normalizeMimeType(' IMAGE/PNG ; name="a.png"')).toBe('image/png');
    expect(normalizeMimeType(undefined)).toBe('');
  });

  it('只有精确命中白名单的光栅图片可内联', () => {
    expect(isSafeInlineImageType('image/png')).toBe(true);
    expect(isSafeInlineImageType('Image/JPEG; charset=binary')).toBe(true);
    expect(isSafeInlineImageType('image/svg+xml')).toBe(false);
    expect(isSafeInlineImageType('text/html')).toBe(false);
    expect(isSafeInlineImageType('application/pdf')).toBe(false);
    expect(isSafeInlineImageType('image/heic')).toBe(false);
  });

  it('拼接类型（浏览器可能取最后一个）一律拒绝', () => {
    expect(isSafeInlineImageType('image/png,text/html')).toBe(false);
    expect(isSafeInlineImageType('image/png,image/svg+xml')).toBe(false);
    expect(isSafeInlineImageType('image/png text/html')).toBe(false);
  });
});
