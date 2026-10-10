import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldIgnoreShortcut, useKeyboardShortcuts } from './use-keyboard-shortcuts';

function Location() {
  return <p data-testid="path">{useLocation().pathname}</p>;
}

/** 模拟列表页：冒泡阶段监听 s 星标 */
function PageHandler({ onStar }: { onStar: () => void }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;
      if (event.key === 's') onStar();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onStar]);
  return null;
}

function Harness({ onHelp, onStar = () => {} }: { onHelp?: () => void; onStar?: () => void }) {
  useKeyboardShortcuts({ onHelp });
  return (
    <>
      <PageHandler onStar={onStar} />
      <input aria-label="普通输入" />
      <input aria-label="搜索" data-shortcut-search="" defaultValue="旧关键词" />
      <Location />
    </>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="*" element={<Harness {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, bubbles: true, ...init });

afterEach(() => vi.useRealTimers());

describe('全局快捷键', () => {
  it('? 打开帮助', () => {
    const onHelp = vi.fn();
    renderHarness({ onHelp });
    press('?', { shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('c 写信；g 后接 i/s/t/r/m 跳转，且第二个键不再传给页面处理器', () => {
    const onStar = vi.fn();
    renderHarness({ onStar });
    press('g');
    press('s');
    expect(screen.getByTestId('path')).toHaveTextContent('/sent');
    expect(onStar).not.toHaveBeenCalled();
    press('g');
    press('m');
    expect(screen.getByTestId('path')).toHaveTextContent('/mailboxes');
    press('c');
    expect(screen.getByTestId('path')).toHaveTextContent('/compose');
    // 不在 g 序列里时 s 交给页面
    press('s');
    expect(onStar).toHaveBeenCalledTimes(1);
  });

  it('g 序列超时后失效', () => {
    vi.useFakeTimers();
    const onStar = vi.fn();
    renderHarness({ onStar });
    press('g');
    vi.advanceTimersByTime(1300);
    press('s');
    expect(screen.getByTestId('path')).toHaveTextContent('/inbox');
    expect(onStar).toHaveBeenCalledTimes(1);
  });

  it('/ 聚焦标记的搜索框并全选', () => {
    renderHarness();
    press('/');
    const search = screen.getByLabelText('搜索') as HTMLInputElement;
    expect(search).toHaveFocus();
    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe(search.value.length);
  });

  it('输入框内与带修饰键时不触发', () => {
    const onHelp = vi.fn();
    renderHarness({ onHelp });
    const input = screen.getByLabelText('普通输入');
    press('c', {}, input);
    press('?', { shiftKey: true }, input);
    press('c', { metaKey: true });
    expect(screen.getByTestId('path')).toHaveTextContent('/inbox');
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('有打开的对话框时页面快捷键让位', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.dataset.state = 'open';
    document.body.append(dialog);
    const event = new KeyboardEvent('keydown', { key: 'j' });
    expect(shouldIgnoreShortcut(event)).toBe(true);
    dialog.remove();
    expect(shouldIgnoreShortcut(event)).toBe(false);
  });
});
