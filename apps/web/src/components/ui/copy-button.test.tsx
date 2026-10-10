import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';

describe('CopyButton', () => {
  it('复制文本并切换为已复制状态', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<CopyButton value="ABC123" />);
    await user.click(screen.getByRole('button', { name: '复制' }));

    expect(writeText).toHaveBeenCalledWith('ABC123');
    expect(await screen.findByRole('button', { name: '已复制' })).toBeInTheDocument();
  });

  it('带可见文字时无障碍名称不重复，可单独指定上下文名称', () => {
    render(
      <>
        <CopyButton value="1" label="复制" />
        <CopyButton value="2" label="复制" ariaLabel="复制验证码" />
      </>,
    );
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制验证码' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制复制' })).toBeNull();
  });
});
