import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterBar } from './filter-bar';

const filters = { domain: null, address: null, unread: false, q: '' };

function renderBar(onQueryChange = vi.fn()) {
  render(
    <FilterBar
      filters={filters}
      domains={[]}
      addressOptions={[]}
      onDomainChange={vi.fn()}
      onAddressChange={vi.fn()}
      onUnreadChange={vi.fn()}
      onQueryChange={onQueryChange}
    />,
  );
  return { onQueryChange, search: screen.getByRole('searchbox', { name: '搜索邮件' }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('FilterBar 搜索框', () => {
  it('停止输入约 400ms 后才搜索，连续输入只搜最后的词', () => {
    const { onQueryChange, search } = renderBar();
    fireEvent.change(search, { target: { value: 'inv' } });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(search, { target: { value: 'invoice' } });
    act(() => vi.advanceTimersByTime(399));
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onQueryChange).toHaveBeenCalledOnce();
    expect(onQueryChange).toHaveBeenCalledWith('invoice');
  });

  it('输入法组字期间不搜索，选字上屏后再按去抖时间触发', () => {
    const { onQueryChange, search } = renderBar();
    fireEvent.compositionStart(search);
    fireEvent.change(search, { target: { value: 'fa' } });
    act(() => vi.advanceTimersByTime(1000));
    fireEvent.change(search, { target: { value: 'fa piao' } });
    act(() => vi.advanceTimersByTime(1000));
    expect(onQueryChange).not.toHaveBeenCalled();

    // 上屏时浏览器把输入框的值换成选中的汉字
    (search as HTMLInputElement).value = '发票';
    fireEvent.compositionEnd(search);
    act(() => vi.advanceTimersByTime(399));
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onQueryChange).toHaveBeenCalledOnce();
    expect(onQueryChange).toHaveBeenCalledWith('发票');
  });
});
