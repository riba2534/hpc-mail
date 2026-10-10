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
  /** 最后保存时间（ms），用于恢复提示 */
  savedAt?: number;
}

/** 草稿按场景隔离：新建、回复/转发/重发某封邮件各自一份，互不覆盖 */
export type DraftScene = 'new' | `reply:${number}` | `forward:${number}` | `resend:${number}`;

/** 旧版单 key（同一用户所有场景共用一份）；读取一次迁移到 new 后删除 */
export const legacyDraftKeyForUser = (userId: number) => `hpc-compose-draft:${userId}`;
export const draftKeyForUser = (userId: number, scene: DraftScene = 'new') => `hpc-compose-draft:${userId}:${scene}`;
export const identityKeyForUser = (userId: number) => `hpc-default-identity:${userId}`;
export const lastIdentityKeyForUser = (userId: number) => `hpc-last-identity:${userId}`;

/** 写信页的场景：由来源邮件决定；没有来源（直接点写邮件）即新建 */
export function draftSceneFor(initial: ComposeInitial | null | undefined): DraftScene {
  const source = initial?.sourceMessageId ?? initial?.replyToMessageId ?? initial?.forwardAttachmentsFrom;
  if (!initial?.mode || !source) return 'new';
  return `${initial.mode}:${source}`;
}

export function attachmentExpired(attachment: Pick<SavedAttachment, 'createdAt'>, now = Date.now()): boolean {
  return !Number.isFinite(attachment.createdAt) || now - attachment.createdAt >= DRAFT_ATTACHMENT_TTL_HOURS * 3_600_000;
}

function parseDraft(raw: string | null): ComposeDraft | null {
  try {
    if (!raw) return null;
    const draft = JSON.parse(raw) as ComposeDraft;
    if (!draft || !Array.isArray(draft.to) || !Array.isArray(draft.cc) || !Array.isArray(draft.bcc)
      || ![...draft.to, ...draft.cc, ...draft.bcc].every((value) => typeof value === 'string')
      || typeof draft.subject !== 'string' || typeof draft.body !== 'string' || typeof draft.isHtml !== 'boolean') return null;
    if ((draft.fromAddress !== undefined && typeof draft.fromAddress !== 'string')
      || (draft.localPart !== undefined && typeof draft.localPart !== 'string')
      || (draft.adminDomain !== undefined && typeof draft.adminDomain !== 'string')
      || (draft.mode !== undefined && !['reply', 'forward', 'resend'].includes(draft.mode))
      || (draft.savedAt !== undefined && !Number.isFinite(draft.savedAt))
      || [draft.replyToMessageId, draft.forwardAttachmentsFrom, draft.sourceMessageId, draft.mailboxId]
        .some((id) => id !== undefined && id !== null && (!Number.isInteger(id) || id <= 0))) return null;
    if (draft.attachments && (!Array.isArray(draft.attachments) || !draft.attachments.every((a) =>
      a && typeof a.filename === 'string' && typeof a.key === 'string' && typeof a.mimeType === 'string'
      && typeof a.size === 'number' && ['ready', 'uploading', 'error'].includes(a.status)))) return null;
    return draft;
  } catch {
    return null;
  }
}

export function readDraft(key: string): ComposeDraft | null {
  try {
    return parseDraft(localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeDraft(key: string, draft: ComposeDraft): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // 存储不可用时静默
  }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

/**
 * 旧版单 key 草稿迁移到 new 场景（保留其中的回复/转发上下文，发送时线程关系不丢）。
 * new 已有内容时不覆盖；无论是否迁移，旧 key 都删除，之后不再读取。
 */
export function migrateLegacyDraft(userId: number): void {
  try {
    const legacyKey = legacyDraftKeyForUser(userId);
    const raw = localStorage.getItem(legacyKey);
    if (raw === null) return;
    const legacy = parseDraft(raw);
    const target = draftKeyForUser(userId, 'new');
    if (legacy && localStorage.getItem(target) === null) localStorage.setItem(target, JSON.stringify(legacy));
    localStorage.removeItem(legacyKey);
  } catch {
    // 存储不可用：保持原样，下次再试
  }
}

export interface SavedIdentity { mailboxId: number | null; localPart: string; domain: string }

function readIdentityKey(key: string): SavedIdentity | null {
  try {
    const identity = JSON.parse(localStorage.getItem(key) ?? 'null') as SavedIdentity | null;
    return identity && (identity.mailboxId === null || Number.isInteger(identity.mailboxId))
      && typeof identity.localPart === 'string' && typeof identity.domain === 'string' ? identity : null;
  } catch { return null; }
}

/** 用户显式「设为默认」的发件身份 */
export function readIdentity(userId: number): SavedIdentity | null {
  return readIdentityKey(identityKeyForUser(userId));
}

/** 上次成功发送使用的发件身份 */
export function readLastIdentity(userId: number): SavedIdentity | null {
  return readIdentityKey(lastIdentityKeyForUser(userId));
}

export function writeLastIdentity(userId: number, identity: SavedIdentity): void {
  try { localStorage.setItem(lastIdentityKeyForUser(userId), JSON.stringify(identity)); } catch { /* ignore */ }
}
