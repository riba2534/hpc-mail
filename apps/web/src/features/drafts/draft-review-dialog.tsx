import { useQuery } from '@tanstack/react-query';
import type { Draft, MailAddress, Mailbox } from '@hpc-mail/shared';
import { ImageOff, Paperclip } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { QueryErrorState } from '@/components/query-error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { countRemoteImages } from '@/features/message/count-remote-images';
import { EmailHtml } from '@/lib/email-html';
import { PlainTextBody } from '@/lib/email-html/plain-text-body';
import { formatBytes, formatDateTime } from '@/lib/format';
import { draftKeys, draftsApi } from './drafts-api';
import { DRAFT_STATUS_META, draftFromLabel, draftSourceLabel, draftStatusLabel } from './draft-format';

const EDITABLE = new Set<Draft['status']>(['draft', 'scheduled', 'failed']);

export interface DraftActionHandlers {
  onSend: (draft: Draft) => void;
  onEdit: (draft: Draft) => void;
  onCancelSchedule: (draft: Draft) => void;
  onDelete: (draft: Draft) => void;
}

const addressList = (items: MailAddress[]) => items.map((item) => (item.name ? `${item.name} <${item.address}>` : item.address)).join('、');

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-sm">
      <dt className="w-16 shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink">{children}</dd>
    </div>
  );
}

/**
 * 正文：HTML 用邮件详情同一个沙箱 iframe 渲染（不直接注入页面），远程图片默认拦截；源码折叠可查。
 * 同时有纯文本版本时折叠在下面，便于核对两份内容一致。
 */
function DraftBody({ draft }: { draft: Draft }) {
  const [showImages, setShowImages] = useState(false);
  const remoteImages = useMemo(() => countRemoteImages(draft.html), [draft.html]);
  if (!draft.html) return <PlainTextBody text={draft.text || '（无正文）'} />;
  return (
    <div className="flex flex-col gap-3">
      {remoteImages > 0 && !showImages && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-ink-secondary">
            <ImageOff className="size-4 shrink-0 text-ink-tertiary" />
            已阻止 {remoteImages} 张远程图片
          </span>
          <Button variant="secondary" size="sm" onClick={() => setShowImages(true)}>
            显示图片
          </Button>
        </div>
      )}
      <EmailHtml html={draft.html} allowRemoteImages={showImages} trustedImageOrigins={[globalThis.location.origin]} />
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-tertiary hover:text-ink">HTML 源码</summary>
        <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-canvas p-3 font-mono text-xs text-ink-secondary">
          {draft.html}
        </pre>
      </details>
      {draft.text && (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-tertiary hover:text-ink">纯文本版本</summary>
          <PlainTextBody text={draft.text} className="mt-2" />
        </details>
      )}
    </div>
  );
}

function DraftDetail({ draft, mailboxes }: { draft: Draft; mailboxes: Mailbox[] | undefined }) {
  const meta = DRAFT_STATUS_META[draft.status];
  const headers = Object.entries(draft.headers);
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-1.5">
        <Field label="状态">
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone}>{draftStatusLabel(draft)}</Badge>
            {draft.messageId !== null && (
              <Link to={`/mail/${draft.messageId}`} className="text-accent hover:underline">
                {draft.status === 'failed' ? '查看失败记录' : '查看发件记录'}
              </Link>
            )}
          </span>
          {draft.errorDetail && (
            <p className={draft.status === 'failed' ? 'mt-1 text-critical' : 'mt-1 text-caution'}>{draft.errorDetail}</p>
          )}
        </Field>
        <Field label="来源">{draftSourceLabel(draft)}</Field>
        <Field label="发件地址">{draftFromLabel(draft.from, mailboxes) ?? <span className="text-critical">未设置</span>}</Field>
        <Field label="收件人">{draft.to.length ? addressList(draft.to) : <span className="text-ink-tertiary">（未填写）</span>}</Field>
        {draft.cc.length > 0 && <Field label="抄送">{addressList(draft.cc)}</Field>}
        {draft.bcc.length > 0 && <Field label="密送">{addressList(draft.bcc)}</Field>}
        {draft.replyTo.length > 0 && <Field label="回复地址">{addressList(draft.replyTo)}</Field>}
        {draft.replyToMessageId !== null && (
          <Field label="回复">
            <Link to={`/mail/${draft.replyToMessageId}`} className="text-accent hover:underline">邮件 #{draft.replyToMessageId}</Link>
          </Field>
        )}
        {draft.forwardAttachmentsFrom !== null && <Field label="转发">带上邮件 #{draft.forwardAttachmentsFrom} 的附件</Field>}
        {headers.length > 0 && (
          <Field label="邮件头">
            {headers.map(([name, value]) => (
              <span key={name} className="block font-mono text-xs">{name}: {value}</span>
            ))}
          </Field>
        )}
        <Field label="更新时间">{formatDateTime(draft.updatedAt)}</Field>
      </dl>
      <div className="border-t border-line pt-4">
        <DraftBody draft={draft} />
      </div>
      {draft.attachments.length > 0 && (
        <div className="border-t border-line pt-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
            <Paperclip className="size-4" />
            {draft.attachments.length} 个附件
          </p>
          <ul className="flex flex-col gap-1.5">
            {draft.attachments.map((attachment) => (
              <li key={attachment.token} className="flex items-center gap-3 rounded-md border border-line px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{attachment.filename}</span>
                {attachment.disposition === 'inline' && <Badge>内嵌</Badge>}
                <span className="shrink-0 text-xs text-ink-tertiary">{formatBytes(attachment.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 审阅一份草稿：完整收件人、主题、正文与附件，确认无误后在这里发送（人审后再发） */
export function DraftReviewDialog({
  draftId,
  mailboxes,
  busy,
  onClose,
  ...actions
}: DraftActionHandlers & { draftId: number | null; mailboxes: Mailbox[] | undefined; busy: boolean; onClose: () => void }) {
  const { data: draft, isLoading, isError, error, refetch } = useQuery({
    queryKey: draftKeys.detail(draftId ?? 0),
    queryFn: ({ signal }) => draftsApi.get(draftId!, signal),
    enabled: draftId !== null,
  });
  const editable = draft ? EDITABLE.has(draft.status) : false;

  return (
    <Dialog open={draftId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader title={draft ? draft.subject || '（无主题）' : '草稿'} description={draft ? `草稿 #${draft.id}` : undefined} />
        <DialogBody>
          {isLoading ? (
            <Skeleton className="h-48 w-full rounded-lg" />
          ) : isError ? (
            <QueryErrorState error={error} onRetry={() => void refetch()} />
          ) : draft ? (
            <DraftDetail draft={draft} mailboxes={mailboxes} />
          ) : null}
        </DialogBody>
        {draft && (
          <DialogFooter className="flex-wrap">
            {draft.status !== 'sending' && (
              <Button variant="ghost" className="mr-auto text-critical" disabled={busy} onClick={() => actions.onDelete(draft)}>
                删除
              </Button>
            )}
            {draft.status === 'scheduled' && (
              <Button variant="secondary" disabled={busy} onClick={() => actions.onCancelSchedule(draft)}>
                取消定时
              </Button>
            )}
            {editable && (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => actions.onEdit(draft)}>
                  编辑
                </Button>
                <Button disabled={busy} onClick={() => actions.onSend(draft)}>
                  发送…
                </Button>
              </>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
