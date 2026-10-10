import { fireEvent, render, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { shortcutKey, useMailShortcuts } from './use-mail-shortcuts';

describe('useMailShortcuts', () => {
  it('maps letters, Shift+letter and symbols', () => {
    expect(shortcutKey({ key: 'J', shiftKey: false })).toBe('j');
    expect(shortcutKey({ key: 'U', shiftKey: true })).toBe('Shift+U');
    expect(shortcutKey({ key: '#', shiftKey: true })).toBe('#');
  });

  it('fires outside inputs, ignores typing, modifiers and open dialogs', () => {
    const star = vi.fn();
    const unread = vi.fn();
    renderHook(() => useMailShortcuts({ s: star, 'Shift+U': unread }));
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.keyDown(window, { key: 'U', shiftKey: true });
    expect(star).toHaveBeenCalledOnce();
    expect(unread).toHaveBeenCalledOnce();

    const { getByRole, unmount } = render(<><input aria-label="search" /><div role="dialog" data-state="open" /></>);
    fireEvent.keyDown(getByRole('textbox'), { key: 's' });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's' });
    expect(star).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps the browser default when a handler declines', () => {
    renderHook(() => useMailShortcuts({ Enter: () => false }));
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
