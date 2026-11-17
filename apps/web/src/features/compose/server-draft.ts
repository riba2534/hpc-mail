import type { AttachmentDisposition, AttachmentTokenRef, Draft } from '@hpc-mail/shared';
import { addressInputText, draftFromAddress } from '@/features/drafts/draft-format';
import type { ComposeInitial } from './compose-init';

/**
 * 服务端草稿 → 写信页的预填：收件人保留显示名，正文 HTML 优先（否则纯文本）。
 * 发件地址写成 localPart@domain 时放进 fromAddress，供匹配自己的邮箱或给管理员预填自定义地址；{mailboxId} 由写信页按 id 选择。
 */
export function composeInitialFromDraft(draft: Draft): ComposeInitial {
  const fromAddress = draft.from?.mailboxId ? undefined : draftFromAddress(draft.from, undefined) ?? undefined;
  return {
    fromAddress,
    to: draft.to.map(addressInputText),
    cc: draft.cc.map(addressInputText),
    bcc: draft.bcc.map(addressInputText),
    subject: draft.subject,
    body: draft.html || draft.text,
    isHtml: Boolean(draft.html),
    replyToMessageId: draft.replyToMessageId ?? undefined,
    forwardAttachmentsFrom: draft.forwardAttachmentsFrom ?? undefined,
    serverDraftId: draft.id,
  };
}

/** 附件引用：草稿里的内嵌图片要带上 contentId（及非默认的 disposition），否则保存后正文里的 cid: 图片会断 */
export function attachmentTokenRef(attachment: { token: string; contentId?: string; disposition?: AttachmentDisposition }): string | AttachmentTokenRef {
  const { token, contentId } = attachment;
  const disposition = attachment.disposition && attachment.disposition !== (contentId ? 'inline' : 'attachment') ? attachment.disposition : undefined;
  if (!contentId && !disposition) return token;
  return { token, ...(contentId ? { contentId } : {}), ...(disposition ? { disposition } : {}) };
}

/** 草稿内容的指纹（不含状态、版本与时间）：判断两次读取之间内容是否被别处改过 */
export function draftContentKey(draft: Draft): string {
  return JSON.stringify([
    draft.from, draft.to, draft.cc, draft.bcc, draft.replyTo, draft.subject, draft.text, draft.html, draft.headers,
    draft.replyToMessageId, draft.forwardAttachmentsFrom, draft.attachments.map((item) => [item.token, item.contentId, item.disposition]),
  ]);
}
