import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultScheduleTime, parseLocalInputValue, toLocalInputValue, toOffsetIsoString } from './schedule-time';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('定时发送时间', () => {
  it('datetime-local 的值按本地时区解析，转成带本地偏移的 ISO（东八区、西五区与半小时时区）', () => {
    for (const [tz, expected] of [
      ['Asia/Shanghai', '2026-11-18T09:00:00+08:00'],
      ['America/New_York', '2026-11-18T09:00:00-05:00'],
      ['Asia/Kolkata', '2026-11-18T09:00:00+05:30'],
    ] as const) {
      vi.stubEnv('TZ', tz);
      const at = parseLocalInputValue('2026-11-18T09:00')!;
      expect(toOffsetIsoString(at)).toBe(expected);
      expect(Date.parse(expected)).toBe(at.getTime());
      expect(toLocalInputValue(at)).toBe('2026-11-18T09:00');
    }
  });

  it('格式不对或日期不存在时为 null', () => {
    expect(parseLocalInputValue('')).toBeNull();
    expect(parseLocalInputValue('2026-11-18 09:00')).toBeNull();
    expect(parseLocalInputValue('2026-02-30T09:00')).toBeNull();
  });

  it('默认一小时后并取整到 5 分钟', () => {
    const now = Date.parse('2026-11-17T08:02:30Z');
    expect(defaultScheduleTime(now).toISOString()).toBe('2026-11-17T09:05:00.000Z');
  });
});
