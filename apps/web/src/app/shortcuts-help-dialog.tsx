import { Dialog, DialogBody, DialogContent, DialogHeader } from '@/components/ui/dialog';

export interface ShortcutItem {
  /** 每个元素是一组按键；同一组内依次按下（如 g 然后 i），组之间是「或」 */
  keys: string[][];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: ShortcutItem[];
}

const one = (...alternatives: string[]): string[][] => alternatives.map((key) => [key]);

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '全局',
    items: [
      { keys: one('c'), label: '写邮件' },
      { keys: [['g', 'i']], label: '跳到收件箱' },
      { keys: [['g', 's']], label: '跳到已发送' },
      { keys: [['g', 't']], label: '跳到回收站' },
      { keys: [['g', 'r']], label: '跳到星标' },
      { keys: [['g', 'm']], label: '跳到我的邮箱' },
      { keys: one('/'), label: '聚焦搜索框' },
      { keys: one('?'), label: '打开快捷键帮助' },
    ],
  },
  {
    title: '邮件列表',
    items: [
      { keys: one('j', 'k'), label: '下移 / 上移' },
      { keys: one('o', 'Enter'), label: '打开邮件' },
      { keys: one('x'), label: '选中 / 取消选中' },
      { keys: one('s'), label: '星标' },
      { keys: one('e', '#'), label: '删除' },
      { keys: one('Shift+I'), label: '标为已读' },
      { keys: one('Shift+U'), label: '标为未读' },
    ],
  },
  {
    title: '邮件详情',
    items: [
      { keys: one('j', 'k'), label: '下一封 / 上一封' },
      { keys: one('r'), label: '回复' },
      { keys: one('a'), label: '全部回复' },
      { keys: one('f'), label: '转发' },
      { keys: one('t'), label: '翻译 / 显示原文（需启用 AI 翻译）' },
      { keys: one('s'), label: '星标' },
      { keys: one('e', '#'), label: '删除' },
      { keys: one('Shift+U'), label: '标为未读（共享邮件不可用）' },
      { keys: one('u', 'Esc'), label: '返回列表' },
    ],
  },
  {
    title: '写邮件',
    items: [{ keys: one('Ctrl/⌘+Enter'), label: '发送' }],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-sm border border-line-strong bg-canvas px-1.5 font-sans text-xs font-medium text-ink shadow-xs">
      {children}
    </kbd>
  );
}

function KeyCombo({ keys }: { keys: string[][] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1 text-xs text-ink-tertiary">
      {keys.map((sequence, index) => (
        <span key={sequence.join(' ')} className="flex items-center gap-1">
          {index > 0 && <span>或</span>}
          {sequence.map((key, keyIndex) => (
            <span key={key} className="flex items-center gap-1">
              {keyIndex > 0 && <span>然后</span>}
              <Kbd>{key}</Kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

export function ShortcutsHelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader title="键盘快捷键" description="在输入框中输入时快捷键不生效。" />
        <DialogBody className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-2 text-sm font-semibold text-ink-secondary">{group.title}</h3>
              <ul className="flex flex-col gap-2">
                {group.items.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span>{item.label}</span>
                    <KeyCombo keys={item.keys} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
