import { LOCAL_PART_REGEX, DEFAULT_RESERVED_LOCAL_PARTS } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { randomLocalPart, unavailableMessage } from './claim-helpers';

describe('randomLocalPart', () => {
  it('生成 8 位、字母开头、符合 LOCAL_PART 规则且不含易混字符的前缀', () => {
    for (let i = 0; i < 200; i++) {
      const value = randomLocalPart();
      expect(value).toHaveLength(8);
      expect(value).toMatch(LOCAL_PART_REGEX);
      expect(value).toMatch(/^[a-z]/);
      expect(value).not.toMatch(/[01ilo]/);
      expect(DEFAULT_RESERVED_LOCAL_PARTS as readonly string[]).not.toContain(value);
    }
  });

  it('按注入的随机源取字符，长度可配置', () => {
    const zeros = (n: number) => new Uint32Array(n);
    expect(randomLocalPart(4, zeros)).toBe('aaaa');
  });
});

describe('unavailableMessage', () => {
  it('按后端 reason 给出准确提示', () => {
    expect(unavailableMessage({ available: false, reason: 'taken' })).toContain('已被占用');
    expect(unavailableMessage({ available: false, reason: 'reserved' })).toContain('系统保留');
    expect(unavailableMessage({ available: false, reason: 'quota' })).toContain('个人上限');
    expect(unavailableMessage({ available: false, reason: 'domain_limit' })).toContain('该域名下');
    expect(unavailableMessage({ available: false, reason: 'domain_unavailable' })).toContain('域名当前不可认领');
  });

  it('可认领时为空；旧后端缺 reason 时回退通用提示', () => {
    expect(unavailableMessage({ available: true })).toBeNull();
    expect(unavailableMessage({ available: false })).toBe('该地址暂不可认领');
  });
});
