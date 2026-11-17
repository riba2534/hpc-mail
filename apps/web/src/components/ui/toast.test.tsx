import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, toast } from './toast';

afterEach(() => vi.useRealTimers());

describe('Toast', () => {
  it('操作按钮执行回调并关闭通知', () => {
    const undo = vi.fn();
    render(<ToastProvider>app</ToastProvider>);
    act(() => {
      toast({ title: '已删除 1 封', action: { label: '撤销', onClick: undo } });
    });
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('已删除 1 封')).toBeNull();
  });

  it('失败提示把请求 ID 作为小字附注展示，ID 本身可整段选中', () => {
    render(<ToastProvider>app</ToastProvider>);
    act(() => {
      toast({ title: '删除失败', description: '操作过于频繁', requestId: 'req-123', variant: 'error' });
    });
    expect(screen.getByText('操作过于频繁')).toBeInTheDocument();
    expect(screen.getByText('req-123')).toHaveClass('select-all');
    expect(screen.getByText(/请求 ID/)).toHaveTextContent('请求 ID：req-123');
  });

  it('到期自动关闭，悬停时暂停计时', () => {
    vi.useFakeTimers();
    render(<ToastProvider>app</ToastProvider>);
    act(() => {
      toast({ title: '可撤销', duration: 5000, action: { label: '撤销', onClick: vi.fn() } });
    });
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByText('可撤销')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText('可撤销')).toBeNull();
  });
});
