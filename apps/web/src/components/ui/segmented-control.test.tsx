import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './segmented-control';

function Harness() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return (
    <SegmentedControl
      aria-label="视图"
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'a', label: '全部' },
        { value: 'b', label: '未读' },
        { value: 'c', label: '星标' },
      ]}
    />
  );
}

describe('SegmentedControl', () => {
  it('只有选中项可 Tab 聚焦，文字居中', () => {
    render(<Harness />);
    const [a, b] = screen.getAllByRole('radio');
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');
    expect(a).toHaveClass('justify-center');
  });

  it('方向键/Home/End 切换选中并移动焦点，首尾循环', () => {
    render(<Harness />);
    const radio = (name: string) => screen.getByRole('radio', { name });
    radio('全部').focus();
    fireEvent.keyDown(radio('全部'), { key: 'ArrowRight' });
    expect(radio('未读')).toHaveAttribute('aria-checked', 'true');
    expect(radio('未读')).toHaveFocus();
    fireEvent.keyDown(radio('未读'), { key: 'End' });
    expect(radio('星标')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radio('星标'), { key: 'ArrowDown' });
    expect(radio('全部')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radio('全部'), { key: 'ArrowLeft' });
    expect(radio('星标')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(radio('星标'), { key: 'Home' });
    expect(radio('全部')).toHaveFocus();
    expect(radio('全部')).toHaveAttribute('tabindex', '0');
  });
});
