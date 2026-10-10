import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/page-header';
import { MailList } from '@/features/inbox/mail-list';
import { SEARCH_SHORTCUT_ATTR } from '@/lib/use-keyboard-shortcuts';

export function SentPage() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="已发送" description="你通过认领地址发出的邮件。" />
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-tertiary" />
        <Input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          type="search"
          aria-label="搜索已发送邮件"
          placeholder="搜索主题、收件人、正文"
          className="pl-9"
          {...{ [SEARCH_SHORTCUT_ATTR]: '' }}
        />
      </div>
      <MailList
        query={{ direction: 'outbound', scope: 'mine', q: debouncedQ || undefined }}
        hasActiveFilters={debouncedQ !== ''}
        activeFilterLabels={debouncedQ ? [`关键词“${debouncedQ}”`] : undefined}
        onClearFilters={() => setQ('')}
        emptyTitle="还没有发送记录"
        emptyDescription="在写邮件页发送后，记录会显示在这里。"
      />
    </div>
  );
}
