import { DRAFT_ATTACHMENT_TTL_HOURS } from '@hpc-mail/shared';
import type { ComposeInitial } from './compose-init';

export interface SavedAttachment {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  token?: string;
  createdAt: number;
}
export interface ComposeDraft extends ComposeInitial {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  mailboxId?: number | null;
  localPart?: string;
  adminDomain?: string;
  attachments?: SavedAttachment[];
}

export const draftKeyForUser = (userId: number) => `hpc-compose-draft:${userId}`;
export const identityKeyForUser = (userId: number) => `hpc-default-identity:${userId}`;

export function attachmentExpired(attachment: Pick<SavedAttachment, 'createdAt'>, now = Date.now()): boolean {
  return !Number.isFinite(attachment.createdAt) || now - attachment.createdAt >= DRAFT_ATTACHMENT_TTL_HOURS * 3_600_000;
}

export function readDraft(key: string): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as ComposeDraft;
    if (!draft || !Array.isArray(draft.to) || !Array.isArray(draft.cc) || !Array.isArray(draft.bcc)
      || ![...draft.to, ...draft.cc, ...draft.bcc].every((value) => typeof value === 'string')
      || typeof draft.subject !== 'string' || typeof draft.body !== 'string' || typeof draft.isHtml !== 'boolean') return null;
    if ((draft.fromAddress !== undefined && typeof draft.fromAddress !== 'string')
      || (draft.localPart !== undefined && typeof draft.localPart !== 'string')
      || (draft.adminDomain !== undefined && typeof draft.adminDomain !== 'string')
      || (draft.mode !== undefined && !['reply', 'forward', 'resend'].includes(draft.mode))
      || [draft.replyToMessageId, draft.forwardAttachmentsFrom, draft.mailboxId].some((id) => id !== undefined && id !== null && (!Number.isInteger(id) || id <= 0))) return null;
    if (draft.attachments && (!Array.isArray(draft.attachments) || !draft.attachments.every((a) =>
      a && typeof a.filename === 'string' && typeof a.key === 'string' && typeof a.mimeType === 'string'
      && typeof a.size === 'number' && ['ready', 'uploading', 'error'].includes(a.status)))) return null;
    return draft;
  } catch {
    return null;
  }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

export interface SavedIdentity { mailboxId: number | null; localPart: string; domain: string }
export function readIdentity(userId: number): SavedIdentity | null {
  try {
    const identity = JSON.parse(localStorage.getItem(identityKeyForUser(userId)) ?? 'null') as SavedIdentity | null;
    return identity && (identity.mailboxId === null || Number.isInteger(identity.mailboxId))
      && typeof identity.localPart === 'string' && typeof identity.domain === 'string' ? identity : null;
  } catch { return null; }
}
