import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken, setAuthToken, subscribeAuthToken } from './auth-token';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('setAuthToken', () => {
  it('存储写满或被禁用时不抛错，保持原有登录状态', () => {
    setAuthToken('old-token');
    const listener = vi.fn();
    const unsubscribe = subscribeAuthToken(listener);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => setAuthToken('new-token')).not.toThrow();
    expect(getAuthToken()).toBe('old-token');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
