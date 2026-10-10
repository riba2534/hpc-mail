import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SHORTCUT_GROUPS, ShortcutsHelpDialog } from './shortcuts-help-dialog';

const flatten = (title: string) =>
  SHORTCUT_GROUPS.find((group) => group.title === title)!.items.map(
    (item) => `${item.keys.map((seq) => seq.join(' ')).join('|')}=${item.label}`,
  );

describe('ShortcutsHelpDialog', () => {
  it('完整列出全局、列表、详情、写信四组键位', () => {
    expect(flatten('全局')).toEqual([
      'c=写邮件',
      'g i=跳到收件箱',
      'g s=跳到已发送',
      'g t=跳到回收站',
      'g r=跳到星标',
      'g m=跳到我的邮箱',
      '/=聚焦搜索框',
      '?=打开快捷键帮助',
    ]);
    expect(flatten('邮件列表')).toEqual([
      'j|k=下移 / 上移',
      'o|Enter=打开邮件',
      'x=选中 / 取消选中',
      's=星标',
      'e|#=删除',
      'Shift+I=标为已读',
      'Shift+U=标为未读',
    ]);
    expect(flatten('邮件详情')).toEqual([
      'j|k=下一封 / 上一封',
      'r=回复',
      'a=全部回复',
      'f=转发',
      's=星标',
      'e|#=删除',
      'Shift+U=标为未读（共享邮件不可用）',
      'u|Esc=返回列表',
    ]);
    expect(flatten('写邮件')).toEqual(['Ctrl/⌘+Enter=发送']);
  });

  it('打开时按分组渲染键帽', () => {
    render(<ShortcutsHelpDialog open onOpenChange={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: '键盘快捷键' });
    const global = within(dialog).getByRole('region', { name: '全局' });
    expect(within(global).getByText('跳到收件箱').parentElement).toHaveTextContent('g然后i');
    const compose = within(dialog).getByRole('region', { name: '写邮件' });
    expect(within(compose).getByText('Ctrl/⌘+Enter').tagName).toBe('KBD');
  });
});
