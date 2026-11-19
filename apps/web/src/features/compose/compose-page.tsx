import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Paperclip, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_SEND_AT_DELAY_MS,
  MIN_SEND_AT_DELAY_MS,
  SINGLE_UPLOAD_THRESHOLD_BYTES,
  type ApiErrorDetails,
  type AttachmentDisposition,
  type Draft,
  type DraftRequestBody,
  type InternalSendMailRequest,
  type SendFrom,
  type UploadedPart,
  draftInputSchema,
  internalSendMailSchema,
  sendAtProblem,
} from '@hpc-mail/shared';
import { ApiError, toApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { messageApi, uploadsApi } from '@/api/resources';
import { Progress } from '@/components/ui/progress';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/lib/format';
import { useDomains } from '@/lib/use-config';
import { useCurrentUser } from '@/lib/use-session';
import { getAuthToken } from '@/lib/auth-token';
import { ownedAddressSet, syncAfterSend, syncSentMessage } from '@/features/inbox/message-cache';
import { rememberedFilterAddress } from '@/features/inbox/use-inbox-filters';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import { draftDetailQueryOptions, markDraftSent, refreshDraft, storeDraft } from '@/features/drafts/draft-cache';
import { draftsApi } from '@/features/drafts/drafts-api';
import { draftFromAddress, draftSourceLabel } from '@/features/drafts/draft-format';
import { PageLoader } from '@/app/page-loader';
import { QueryErrorState } from '@/components/query-error-state';
import type { ComposeInitial } from './compose-init';
import {
  attachmentExpired,
  clearDraft,
  type ComposeDraft,
  draftKeyForUser,
  draftSceneFor,
  identityKeyForUser,
  migrateLegacyDraft,
  readDraft,
  readIdentity,
  readLastIdentity,
  type SavedAttachment,
  type SavedIdentity,
  writeDraft,
  writeLastIdentity,
} from './compose-draft';
import { exceedsExternalLimit, hasExternalRecipient } from './compose-attachments';
import { IdentityPicker } from './identity-picker';
import { RecipientInput } from './recipient-input';
import { useHostedSendDomains } from './use-send-identities';
import {
  classifySendError, clearSendAttempt, hashSendPayload, missingSendSource, persistSendAttempt, readSendAttempt, type SendSource,
} from './send-attempt';
import { notifySendResult } from './send-result';
import { defaultScheduleTime, parseLocalInputValue, toLocalInputValue, toOffsetIsoString } from './schedule-time';
import { attachmentTokenRef, composeInitialFromDraft, draftContentKey } from './server-draft';

/** 回复或转发引用的原邮件不可用时的提示文案与去掉来源后的确认 */
const SOURCE_GONE: Record<SendSource, { title: string; hint: string; action: string; detached: string }> = {
  reply: {
    title: '原邮件已不存在，无法关联回复线程',
    hint: '可以去掉与原邮件的关联，作为一封新邮件发送。',
    action: '作为新邮件发送',
    detached: '已改为新邮件，确认后点击发送',
  },
  forward: {
    title: '原邮件的附件已不可用，无法一起转发',
    hint: '可以去掉原邮件附件，只发送正文和新添加的附件。',
    action: '去掉原邮件附件',
    detached: '已去掉原邮件附件，确认后点击发送',
  },
};

interface AttachmentUpload {
  key: string;
  file?: File;
  createdAt: number;
  filename: string;
  mimeType: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  loaded: number;
  total: number;
  token?: string;
  error?: string;
  abort?: AbortController;
  /** 服务端草稿里的内嵌图片：保存时原样带回，正文的 cid: 引用才不会断 */
  contentId?: string;
  disposition?: AttachmentDisposition;
}

type FieldKey = 'identity' | 'to' | 'subject' | 'body' | 'attachments';
type FieldErrors = Partial<Record<FieldKey, string>>;

/** recipient_suppressed 的抑制原因 */
const SUPPRESSION_REASON_TEXT: Record<string, string> = {
  hard_bounce: '此前退信（地址或域名不可用）',
  soft_bounce: '此前临时退信且重试耗尽',
  complaint: '收件人曾把来信标记为垃圾邮件',
};

/** 提交失败时按表单顺序聚焦第一个出错字段 */
const FIELD_ORDER: FieldKey[] = ['identity', 'to', 'subject', 'body', 'attachments'];
const FIELD_IDS: Record<FieldKey, string[]> = {
  identity: ['compose-identity-local', 'compose-identity'],
  to: ['compose-to'],
  subject: ['compose-subject'],
  body: ['compose-body'],
  attachments: ['compose-attach'],
};

function fieldOfIssue(path: readonly PropertyKey[]): FieldKey | null {
  const head = String(path[0] ?? '');
  if (head === 'from') return 'identity';
  if (head === 'to' || head === 'cc' || head === 'bcc') return 'to';
  if (head === 'subject') return 'subject';
  if (head === 'body' || head === 'text' || head === 'html') return 'body';
  if (head === 'attachments' || head === 'attachmentTokens') return 'attachments';
  return null;
}

function focusField(errors: FieldErrors): void {
  const first = FIELD_ORDER.find((key) => errors[key]);
  if (!first) return;
  for (const id of FIELD_IDS[first]) {
    const element = document.getElementById(id);
    if (element) {
      element.focus();
      return;
    }
  }
}

function splitLocalPart(address: string | undefined): { localPart: string; domain: string } {
  if (!address) return { localPart: '', domain: '' };
  const at = address.lastIndexOf('@');
  return at > 0 ? { localPart: address.slice(0, at), domain: address.slice(at + 1) } : { localPart: '', domain: '' };
}

const hasDraggedFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

export function ComposePage() {
  const location = useLocation();
  return <ComposeSession key={location.key} />;
}

/**
 * 一次写信会话：按来源场景（新建 / 回复 / 转发 / 重发某封）读取各自的草稿。
 * 已有草稿时先问「继续编辑 / 丢弃」，决定之前不自动保存，避免空白或预填内容覆盖草稿。
 */
function ComposeSession() {
  const location = useLocation();
  const state = location.state as ComposeInitial | null;
  if (state?.serverDraftId) return <ServerDraftSession id={state.serverDraftId} />;
  return <LocalDraftSession state={state} />;
}

/**
 * 编辑草稿箱里的一份服务端草稿：每次进入都重新读取（不用缓存里可能过时的版本），读到后再初始化表单。
 * 这种模式不读写本机草稿；保存用 PATCH 带 expectedVersion，别处（如 Agent）同时改过时 409 提示重新载入。
 */
function ServerDraftSession({ id }: { id: number }) {
  const user = useCurrentUser();
  const { data: draft, error, isError, isFetchedAfterMount, refetch } = useQuery({
    ...draftDetailQueryOptions(id),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="编辑草稿" />
        {error instanceof ApiError && error.code === 'not_found' ? (
          <p className="text-sm text-ink-secondary">
            这份草稿不存在或已删除。
            <Link to="/drafts" className="ml-1 font-medium text-accent hover:underline">返回草稿箱</Link>
          </p>
        ) : (
          <QueryErrorState error={error} onRetry={() => void refetch()} />
        )}
      </div>
    );
  }
  if (!draft || !isFetchedAfterMount) return <PageLoader />;
  if (draft.status === 'sent' || draft.status === 'sending') {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="编辑草稿" />
        <p className="text-sm text-ink-secondary">
          {draft.status === 'sent' ? '这份草稿已经发送，不能再编辑。' : '这份草稿正在发送，不能编辑。'}
          {draft.messageId !== null && (
            <Link to={`/mail/${draft.messageId}`} className="ml-1 font-medium text-accent hover:underline">查看发件记录</Link>
          )}
          <Link to="/drafts" className="ml-2 font-medium text-accent hover:underline">返回草稿箱</Link>
        </p>
      </div>
    );
  }
  return (
    <ComposeEditor
      initial={composeInitialFromDraft(draft)}
      restored={false}
      draftKey={draftKeyForUser(user.id, 'new')}
      autosave={false}
      serverDraft={draft}
    />
  );
}

function LocalDraftSession({ state }: { state: ComposeInitial | null }) {
  const user = useCurrentUser();
  const scene = draftSceneFor(state);
  const draftKey = draftKeyForUser(user.id, scene);
  const [savedDraft] = useState(() => {
    if (scene === 'new') migrateLegacyDraft(user.id);
    return readDraft(draftKey);
  });
  const [choice, setChoice] = useState<'pending' | 'resume' | 'fresh'>(savedDraft ? 'pending' : 'fresh');
  const resumed = choice === 'resume' && savedDraft ? savedDraft : null;
  const fresh = useMemo<ComposeInitial>(() => state ?? {}, [state]);

  return (
    <>
      <ComposeEditor
        key={resumed ? 'draft' : 'fresh'}
        initial={resumed ?? fresh}
        restored={Boolean(resumed)}
        draftKey={draftKey}
        autosave={choice !== 'pending'}
      />
      <Dialog open={choice === 'pending'} onOpenChange={(open) => !open && setChoice('resume')}>
        <DialogContent className="max-w-md" showClose={false}>
          <DialogHeader
            title="继续编辑上次的草稿？"
            description={scene === 'new' ? '你有一封未发送的新邮件草稿。' : '你对这封邮件有一份未发送的草稿。'}
          />
          {savedDraft && (
            <DialogBody className="flex flex-col gap-1 text-sm text-ink-secondary">
              <p className="truncate">
                主题：<span className="text-ink">{savedDraft.subject || '（无主题）'}</span>
              </p>
              {savedDraft.savedAt && <p>保存于 {formatRelativeTime(savedDraft.savedAt)}</p>}
            </DialogBody>
          )}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                clearDraft(draftKey);
                setChoice('fresh');
              }}
            >
              丢弃草稿
            </Button>
            <Button onClick={() => setChoice('resume')}>继续编辑</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ComposeEditorProps {
  initial: ComposeInitial | ComposeDraft;
  /** initial 来自本机保存的草稿（而非回复/转发预填或空白） */
  restored: boolean;
  draftKey: string;
  /** 草稿恢复提示未决时不自动保存 */
  autosave: boolean;
  /** 编辑草稿箱里的服务端草稿：不读写本机草稿，保存与发送都经过这份草稿 */
  serverDraft?: Draft;
}

/** 发送失败、保存失败的提示种类；draft_conflict 为服务端草稿已在别处被改过（版本冲突） */
type SendErrorKind = 'uncertain' | 'in_progress' | 'key_mismatch' | 'delivery_failed' | 'recipient_suppressed' | 'draft_conflict' | 'error' | SendSource;

interface SendVariables {
  /** 校验后的发信请求：直接发信时提交它；服务端草稿用它判断来源与是否发给了自己 */
  payload: InternalSendMailRequest;
  /** 编辑服务端草稿时，发送前先保存的内容 */
  serverRequest?: DraftRequestBody;
  /** 点发送时的表单快照：服务端草稿保存成功后作为新的「未改动」基准 */
  snapshot: string;
  /** 这次发送对应的页面内容；服务端草稿结果不明后重试，内容没变才直接查询原结果 */
  attemptKey: string;
}

function ComposeEditor({ initial, restored, draftKey, autosave, serverDraft }: ComposeEditorProps) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isAdmin = user.role === 'admin';
  const { data: visibleDomains } = useDomains();
  const { data: mailboxes } = useMailboxesQuery();
  const hostedDomains = useHostedSendDomains();
  // 可用任意前缀的域名：管理员是系统域名加自己的托管域名，普通用户只有自己的托管域名
  const customDomains = useMemo(
    () => (isAdmin ? [...new Set([...(visibleDomains ?? []), ...(hostedDomains ?? [])])] : hostedDomains ?? []),
    [isAdmin, visibleDomains, hostedDomains],
  );
  const customAllowed = isAdmin || customDomains.length > 0;
  const { data: contactsData } = useQuery({
    queryKey: queryKeys.messages.contacts,
    queryFn: () => messageApi.contacts(),
    staleTime: 5 * 60_000,
  });
  const contacts = contactsData?.contacts;
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendIdempotencyKeyRef = useRef<string | null>(null);
  const sendPayloadHashRef = useRef<string | null>(null);
  const sendPersistenceWarningRef = useRef(false);
  const composeSessionTokenRef = useRef(getAuthToken());
  const [recoveredSendPending, setRecoveredSendPending] = useState(() => Boolean(readSendAttempt(user.id)));

  const draft = restored ? (initial as ComposeDraft) : null;
  const initialIdentity = useMemo(() => splitLocalPart(initial.fromAddress), [initial.fromAddress]);
  const defaultIdentity = useMemo(() => readIdentity(user.id), [user.id]);
  const lastIdentity = useMemo(() => readLastIdentity(user.id), [user.id]);
  const sentRef = useRef(false);
  const discardedRef = useRef(false);
  /** 点过发送：结果确认前内容必须留存，刷新后可用同一幂等键重试 */
  const attemptedRef = useRef(false);
  const allowLeaveRef = useRef(false);
  const identityInitializedRef = useRef(false);
  /**
   * 服务端草稿最后一次保存（或读取）的结果：PATCH 带它的版本；它引用的附件 token 移除时只从列表去掉，
   * 由下次保存时服务端释放（DELETE /uploads 对被引用的 token 返回 409）。
   */
  const savedServerDraftRef = useRef<Draft | null>(serverDraft ?? null);
  const referencedTokens = () => new Set(savedServerDraftRef.current?.attachments.map((item) => item.token) ?? []);
  /** 本页对服务端草稿发起过发送时所提交的内容；结果不明后重试时用来判断能否直接查询原结果 */
  const triedServerSendRef = useRef<string | null>(null);
  /** 新建服务端草稿的幂等键：同一内容重试（网络错误后）沿用，不会多建一份 */
  const createAttemptRef = useRef<{ body: string; key: string } | null>(null);

  // 旧版本使用全站共享 key，无法判断内容属于哪个账户。为避免跨账户泄露，只清理、不迁移。
  useEffect(() => {
    try {
      localStorage.removeItem('hpc-compose-draft');
    } catch {
      // ignore
    }
  }, []);

  const [mailboxId, setMailboxId] = useState<number | null>(null);
  // 普通用户是否有托管域名要等身份接口返回，先按同样来源预填；没有可用域名时这两项不参与发信
  const [localPart, setLocalPart] = useState(() => initialIdentity.localPart || draft?.localPart || defaultIdentity?.localPart || lastIdentity?.localPart || '');
  const [adminDomain, setAdminDomain] = useState(() => initialIdentity.domain || draft?.adminDomain || defaultIdentity?.domain || lastIdentity?.domain || '');
  const [to, setTo] = useState<string[]>(initial.to ?? []);
  const [cc, setCc] = useState<string[]>(initial.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(initial.bcc ?? []);
  const [showCc, setShowCc] = useState((initial.cc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((initial.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [isHtml, setIsHtml] = useState(initial.isHtml ?? false);
  const [body, setBody] = useState(initial.body ?? '');
  const [attachments, setAttachments] = useState<AttachmentUpload[]>(() => serverDraft
    // 服务端草稿引用的附件不按 24 小时过期，一律可用
    ? serverDraft.attachments.map((attachment) => ({
      key: attachment.token, token: attachment.token, createdAt: Date.now(), filename: attachment.filename, mimeType: attachment.mimeType,
      size: attachment.size, status: 'ready', loaded: attachment.size, total: attachment.size,
      contentId: attachment.contentId || undefined, disposition: attachment.disposition,
    }))
    : (draft?.attachments ?? []).map((attachment) => {
      const ready = attachment.status === 'ready' && attachment.token && !attachmentExpired(attachment);
      return { ...attachment, status: ready ? 'ready' : 'error', loaded: ready ? attachment.size : 0, total: attachment.size,
        error: ready ? undefined : '附件已过期或上传未完成，请移除后重新选择文件' };
    }));
  const attachmentRefs = useRef(attachments);
  attachmentRefs.current = attachments;
  useEffect(() => () => {
    for (const attachment of attachmentRefs.current) attachment.abort?.abort();
  }, []);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // kind 为 reply / forward：回复或转发引用的原邮件已不可用
  const [sendError, setSendError] = useState<{
    message: string;
    kind: SendErrorKind;
    /** delivery_failed：已记录的失败发件与逐收件人原因；recipient_suppressed：抑制名单里的收件人 */
    details?: ApiErrorDetails;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 原邮件已删除或不可见时，用户可以去掉回复关联 / 原邮件附件，再作为新邮件发送
  const [replyToMessageId, setReplyToMessageId] = useState(initial.replyToMessageId);
  const [forwardAttachmentsFrom, setForwardAttachmentsFrom] = useState(initial.forwardAttachmentsFrom);
  const forwardSourceDetached = useRef(draft?.forwardSourceDetached === true);

  const clearFieldError = (key: FieldKey) =>
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));

  // 发件身份：回复/转发与服务端草稿固定用指定的地址（回复/转发的原地址不是自己的邮箱时留在自定义前缀，localPart/域名已预填）；
  // 否则依次取草稿 → 设为默认 → 上次使用 → 收件箱筛选地址 → 第一个已认领地址
  const serverMailboxId = serverDraft?.from?.mailboxId;
  useEffect(() => {
    if (!mailboxes || identityInitializedRef.current) return;
    const byId = (id: number | null | undefined) => (id ? mailboxes.find((box) => box.id === id) : undefined);
    const byAddress = (address: string | null | undefined) => (address ? mailboxes.find((box) => box.address === address) : undefined);
    // 指定的邮箱已不归自己（释放或过户）时不自动换成别的地址，由用户重新选择
    if (serverMailboxId) {
      identityInitializedRef.current = true;
      const box = byId(serverMailboxId);
      if (box) setMailboxId(box.id);
      return;
    }
    if (initial.fromAddress && !draft) {
      identityInitializedRef.current = true;
      const matching = byAddress(initial.fromAddress);
      if (matching) setMailboxId(matching.id);
      return;
    }
    const sources: Array<SavedIdentity | { mailboxId?: number | null; localPart?: string; domain?: string; address?: string } | null> = [
      draft ? { mailboxId: draft.mailboxId, localPart: draft.localPart, domain: draft.adminDomain, address: draft.fromAddress } : null,
      defaultIdentity,
      lastIdentity,
    ];
    for (const source of sources) {
      if (!source) continue;
      const box = byId(source.mailboxId) ?? byAddress('address' in source ? source.address : undefined);
      if (box) {
        identityInitializedRef.current = true;
        setMailboxId(box.id);
        return;
      }
      // 自定义地址：localPart/域名已在初始状态里预填。管理员恒可用；普通用户等托管域名读完，域名仍可用才沿用
      if (source.mailboxId === null && source.localPart) {
        if (!isAdmin && hostedDomains === undefined) return;
        if (isAdmin || hostedDomains?.includes(source.domain ?? '')) {
          identityInitializedRef.current = true;
          return;
        }
      }
    }
    identityInitializedRef.current = true;
    const fallback = byAddress(rememberedFilterAddress()) ?? mailboxes[0];
    if (fallback) setMailboxId(fallback.id);
  }, [mailboxes, initial.fromAddress, draft, defaultIdentity, lastIdentity, isAdmin, hostedDomains, serverMailboxId]);

  const validMailbox = (mailboxes ?? []).some((box) => box.id === mailboxId);
  const validCustomIdentity = Boolean(localPart) && customDomains.includes(adminDomain);
  const identityValid = validMailbox || validCustomIdentity;
  const currentIdentity = (): SavedIdentity => ({ mailboxId: validMailbox ? mailboxId : null, localPart, domain: adminDomain });
  const currentFromAddress = validMailbox
    ? mailboxes?.find((box) => box.id === mailboxId)?.address.toLowerCase() ?? null
    : validCustomIdentity ? `${localPart}@${adminDomain}`.toLowerCase() : null;
  // 服务端草稿原来的发件地址；邮箱列表加载前无法解析 {mailboxId}
  const serverFrom = savedServerDraftRef.current?.from ?? null;
  const serverFromAddress = serverDraft && mailboxes ? draftFromAddress(serverFrom, mailboxes)?.toLowerCase() ?? null : null;
  /** 发件人：服务端草稿的显示名只在地址没换时保留（换了地址，原来的名称未必还对） */
  const sendFrom = (): SendFrom => ({
    ...(validMailbox ? { mailboxId: mailboxId! } : { localPart, domain: adminDomain }),
    ...(serverFrom?.displayName && currentFromAddress === serverFromAddress ? { displayName: serverFrom.displayName } : {}),
  });
  const saveDefaultIdentity = () => {
    if (!identityValid) return;
    try {
      localStorage.setItem(identityKeyForUser(user.id), JSON.stringify(currentIdentity()));
      toast({ title: '默认发件地址已保存', variant: 'success' });
    } catch { toast({ title: '无法保存默认发件地址', variant: 'error' }); }
  };

  // 是否改动过：与打开时的内容比较（发件身份由程序自动选择，不计入）。
  // 回复/转发的预填内容在用户编辑前不落盘；改回原样也视为未改动。
  const contentSnapshot = JSON.stringify([to, cc, bcc, subject, body, isHtml, attachments.map((a) => [a.key, a.status, a.token ?? ''])]);
  const [initialSnapshot, setInitialSnapshot] = useState(contentSnapshot);
  // 服务端草稿换了发件地址也算改动（原来没有发件地址时，自动选上的不算）
  const serverIdentityChanged = Boolean(serverFromAddress && currentFromAddress && currentFromAddress !== serverFromAddress);
  const dirty = contentSnapshot !== initialSnapshot || serverIdentityChanged;
  const hasContent =
    to.length > 0 || cc.length > 0 || bcc.length > 0 || attachments.length > 0 || Boolean(forwardAttachmentsFrom) || subject.trim() !== '' || body.trim() !== '';

  const persistDraft = () => {
    if (sentRef.current || discardedRef.current || serverDraft) return;
    if (!hasContent) {
      clearDraft(draftKey);
      return;
    }
    const savedAttachments: SavedAttachment[] = attachments.map(({ key, filename, mimeType, size, token, status, createdAt }) => ({ key, filename, mimeType, size, token, status, createdAt }));
    writeDraft(draftKey, {
      ...initial,
      replyToMessageId,
      forwardAttachmentsFrom,
      ...(forwardSourceDetached.current ? { forwardSourceDetached: true } : {}),
      fromAddress: validMailbox ? mailboxes?.find((box) => box.id === mailboxId)?.address : customAllowed ? `${localPart}@${adminDomain}` : undefined,
      to, cc, bcc, subject, body, isHtml, mailboxId, localPart, adminDomain, attachments: savedAttachments, savedAt: Date.now(),
    });
  };
  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

  // 草稿自动保存到 localStorage：仅在用户改动后保存；未改动的新开内容不保留旧场景草稿
  useEffect(() => {
    if (!autosave || sentRef.current || discardedRef.current) return;
    if (!dirty && !attemptedRef.current) {
      if (!restored) clearDraft(draftKey);
      return;
    }
    persistDraftRef.current();
  }, [autosave, dirty, restored, draftKey, contentSnapshot, mailboxId, localPart, adminDomain, replyToMessageId, forwardAttachmentsFrom]);

  // 用户继续编辑后，上一次发送错误已不对应当前内容
  const editKey = `${contentSnapshot}|${mailboxId}|${localPart}|${adminDomain}`;
  const errorEditKeyRef = useRef(editKey);
  useEffect(() => {
    if (errorEditKeyRef.current === editKey) return;
    errorEditKeyRef.current = editKey;
    setSendError(null);
  }, [editKey]);

  // 有未发送改动时离开页面/刷新给出浏览器原生拦截
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // 站内跳转：有改动时拦下，询问保存草稿还是丢弃
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker(useCallback(() => dirtyRef.current && !allowLeaveRef.current && !sentRef.current, []));
  const [cancelPrompt, setCancelPrompt] = useState(false);
  const leavePromptOpen = cancelPrompt || blocker.state === 'blocked';

  const leavePage = () => {
    allowLeaveRef.current = true;
    if (location.key !== 'default') navigate(-1);
    else navigate(serverDraft ? '/drafts' : '/inbox');
  };
  const handleCancel = () => {
    if (dirty || restored) setCancelPrompt(true);
    else leavePage();
  };
  const finishLeave = (keep: boolean) => {
    // 服务端草稿：保存到草稿箱成功后才离开，失败时留在本页显示原因
    if (keep && serverDraft) {
      saveToServer({ leave: true });
      return;
    }
    if (keep) persistDraftRef.current();
    else {
      discardedRef.current = true;
      if (!serverDraft) clearDraft(draftKey);
    }
    setCancelPrompt(false);
    if (blocker.state === 'blocked') blocker.proceed();
    else leavePage();
  };
  const stayOnPage = () => {
    setCancelPrompt(false);
    if (blocker.state === 'blocked') blocker.reset();
  };

  /** 服务端草稿上次保存的正文：没改时保存不带正文，原来的纯文本与 HTML 两个版本都保留 */
  const savedBodyRef = useRef({ body: initial.body ?? '', isHtml: initial.isHtml ?? false });
  /** 服务端草稿保存成功：记下新版本与它引用的附件，此后的改动以它为基准 */
  const afterServerSave = (saved: Draft, snapshot: string) => {
    savedServerDraftRef.current = saved;
    savedBodyRef.current = { body: saved.html || saved.text, isHtml: Boolean(saved.html) };
    setInitialSnapshot(snapshot);
    storeDraft(queryClient, saved);
  };
  /**
   * 发送失败后服务端草稿的版本会变（认领与结算都会加 1）。读回最新状态：内容与本页最后保存的一致才接受新版本；
   * 不一致说明别处也改过，保留旧版本，下次保存时 409 提示重新载入。
   */
  const resyncServerVersion = async () => {
    const last = savedServerDraftRef.current;
    if (!last) return;
    const latest = await refreshDraft(queryClient, last.id);
    if (latest && draftContentKey(latest) === draftContentKey(last)) savedServerDraftRef.current = latest;
  };
  const reloadServerDraft = () => {
    if (!serverDraft) return;
    allowLeaveRef.current = true;
    navigate('/compose', { replace: true, state: { serverDraftId: serverDraft.id } satisfies ComposeInitial });
  };

  /**
   * 存到草稿箱的请求体。新建时缺省字段为空；服务端草稿正文没改时不带，改了只留当前这一种（另一种清空），
   * 发件身份无效时不改原值，回复与转发来源去掉时写 null 清空。
   */
  const draftRequestBody = (): DraftRequestBody => {
    const bodyUnchanged = serverDraft && body === savedBodyRef.current.body && isHtml === savedBodyRef.current.isHtml;
    const bodyFields = bodyUnchanged ? {}
      : isHtml ? { html: body, ...(serverDraft ? { text: '' } : {}) } : { text: body, ...(serverDraft ? { html: '' } : {}) };
    return {
      ...(identityValid ? { from: sendFrom() } : {}),
      to,
      cc,
      bcc,
      subject,
      ...bodyFields,
      attachmentTokens: attachments.filter((a) => a.status === 'ready' && a.token)
        .map((a) => attachmentTokenRef({ token: a.token!, contentId: a.contentId, disposition: a.disposition })),
      ...(serverDraft
        ? { replyToMessageId: replyToMessageId ?? null, forwardAttachmentsFrom: forwardAttachmentsFrom ?? null }
        : { ...(replyToMessageId ? { replyToMessageId } : {}), ...(forwardAttachmentsFrom ? { forwardAttachmentsFrom } : {}) }),
    };
  };
  /** 打开写信页之后换了登录账户（其他标签页登出再登录）时不发出任何写请求 */
  const assertSameSession = () => {
    if (composeSessionTokenRef.current !== getAuthToken()) {
      throw new ApiError('登录账户已变化，请重新操作', { code: 'session_changed' });
    }
  };
  const patchServerDraft = (id: number, request: DraftRequestBody) =>
    draftsApi.update(id, { ...request, expectedVersion: savedServerDraftRef.current?.version });

  /** 存到草稿箱与定时发送：新建用 POST（带幂等键），编辑服务端草稿用 PATCH（带版本）；成功后清掉本机草稿、去草稿箱 */
  const saveMutation = useMutation({
    mutationFn: async ({ request }: { request: DraftRequestBody; scheduled: boolean; leave: boolean }) => {
      assertSameSession();
      if (serverDraft) return patchServerDraft(serverDraft.id, request);
      const json = JSON.stringify(request);
      if (createAttemptRef.current?.body !== json) createAttemptRef.current = { body: json, key: crypto.randomUUID() };
      return draftsApi.create(request, createAttemptRef.current.key);
    },
    onSuccess: (saved, { scheduled, leave }) => {
      sentRef.current = true;
      if (!serverDraft) clearDraft(draftKey);
      storeDraft(queryClient, saved);
      const at = saved.status === 'scheduled' && saved.sendAt ? formatDateTime(saved.sendAt) : null;
      toast({ title: at ? scheduled ? `已安排在 ${at} 发送` : `已保存，仍将在 ${at} 发送` : '已存到草稿箱', variant: 'success' });
      setCancelPrompt(false);
      if (leave && blocker.state === 'blocked') blocker.proceed();
      else if (leave) leavePage();
      else {
        allowLeaveRef.current = true;
        navigate('/drafts');
      }
    },
    onError: (err, { leave }) => {
      if (leave) stayOnPage();
      const error = toApiError(err);
      setSendError({ message: error.message, kind: error.code === 'draft_state_conflict' ? 'draft_conflict' : 'error', details: error.details });
    },
  });

  /**
   * 发送服务端草稿：先 PATCH（带版本）保存当前内容，再用保存后的版本发送，发出的就是此刻页面上的内容。
   * 草稿只会发出一次，不需要 Idempotency-Key。上次发送结果不明时草稿可能已在发送或已发出，PATCH 会因状态冲突被拒：
   * 页面内容没再改过就直接查询原结果（已发送的重放，不会重复投递）。
   */
  const sendServerDraft = async (id: number, request: DraftRequestBody, snapshot: string, attemptKey: string) => {
    assertSameSession();
    let saved: Draft;
    try {
      saved = await patchServerDraft(id, request);
    } catch (error) {
      const settled = error instanceof ApiError && error.code === 'draft_state_conflict'
        && (error.details?.draftStatus === 'sent' || error.details?.draftStatus === 'sending');
      if (settled && triedServerSendRef.current === attemptKey) return draftsApi.send(id);
      throw error;
    }
    afterServerSave(saved, snapshot);
    triedServerSendRef.current = attemptKey;
    return draftsApi.send(id, saved.version);
  };

  const sendMutation = useMutation({
    mutationFn: async ({ payload, serverRequest, snapshot, attemptKey }: SendVariables) => {
      if (serverDraft && serverRequest) return sendServerDraft(serverDraft.id, serverRequest, snapshot, attemptKey);
      const payloadHash = await hashSendPayload(payload);
      assertSameSession();
      const savedAttempt = readSendAttempt(user.id);
      const currentKey = sendPayloadHashRef.current === payloadHash ? sendIdempotencyKeyRef.current : null;
      sendIdempotencyKeyRef.current = currentKey ?? (savedAttempt?.payloadHash === payloadHash ? savedAttempt.key : crypto.randomUUID());
      sendPayloadHashRef.current = payloadHash;
      const persisted = persistSendAttempt(user.id, { key: sendIdempotencyKeyRef.current, payloadHash });
      if (!persisted && !sendPersistenceWarningRef.current) {
        sendPersistenceWarningRef.current = true;
        toast({ title: '无法保存发送凭据', description: '本次可在当前页面重试；刷新前请先检查已发送，避免重复投递。' });
      }
      return messageApi.send(payload, sendIdempotencyKeyRef.current);
    },
    onSuccess: (result, { payload }) => {
      sentRef.current = true;
      clearSendAttempt(user.id, sendIdempotencyKeyRef.current);
      setRecoveredSendPending(false);
      sendIdempotencyKeyRef.current = null;
      sendPayloadHashRef.current = null;
      writeLastIdentity(user.id, currentIdentity());
      const needsReview = notifySendResult(result);
      if (serverDraft) markDraftSent(queryClient, savedServerDraftRef.current ?? serverDraft, result.id);
      else clearDraft(draftKey);
      const owned = ownedAddressSet(mailboxes);
      // 普通用户用托管域名的新前缀发信时，服务端已把这个地址认领给自己
      const { localPart: sentLocalPart, domain: sentDomain } = payload.from;
      if (!isAdmin && sentLocalPart && sentDomain && !owned.has(`${sentLocalPart}@${sentDomain}`)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.root });
      }
      syncAfterSend(queryClient, {
        sourceIds: [payload.replyToMessageId, payload.forwardAttachmentsFrom, initial.sourceMessageId].filter((id) => id !== undefined),
        recipients: [...payload.to, ...payload.cc, ...payload.bcc],
        owned,
      });
      navigate(needsReview ? `/mail/${result.id}` : serverDraft ? '/drafts' : '/sent');
    },
    onError: (err, { payload }) => {
      // 网络/超时可能发生在服务端已经发送之后、服务端也可能仍在处理：保留同一个 key，再次发送只会查询/重放原结果。
      // 明确的业务错误，或 key 已绑定其他内容（当前内容一定没用它发出）：换新 key，由用户修正或确认后再发。
      const failure = classifySendError(err);
      if (failure === 'rejected' || failure === 'key_mismatch') {
        clearSendAttempt(user.id, sendIdempotencyKeyRef.current);
        setRecoveredSendPending(false);
        sendIdempotencyKeyRef.current = null;
        sendPayloadHashRef.current = null;
      }
      const conflict = err instanceof ApiError && err.code === 'draft_state_conflict';
      // 服务端草稿明确没发出（4xx、422 全部拒收）时版本已变，读回最新版本，修正后可以直接再发
      if (serverDraft && failure !== 'uncertain' && !conflict) void resyncServerVersion();
      const message = err instanceof ApiError ? err.message : '发送失败，请重试';
      if (conflict) {
        setSendError({ message, kind: 'draft_conflict', details: err.details });
        return;
      }
      if (err instanceof ApiError && err.code === 'delivery_failed') {
        // 服务端已记下一封全部失败的外发，已发送列表要显示它
        syncSentMessage(queryClient, { sourceIds: [], selfDelivered: false });
        setSendError({ message, kind: 'delivery_failed', details: err.details });
        return;
      }
      if (err instanceof ApiError && err.code === 'recipient_suppressed') {
        setSendError({ message, kind: 'recipient_suppressed', details: err.details });
        return;
      }
      const sessionChanged = err instanceof ApiError && err.code === 'session_changed';
      const fallback = failure === 'in_progress' || failure === 'key_mismatch' ? failure
        : failure === 'uncertain' && !sessionChanged ? 'uncertain' : 'error';
      setSendError({ message, kind: missingSendSource(err, payload) ?? fallback });
    },
  });
  const busy = sendMutation.isPending || saveMutation.isPending;

  const updateAttachment = (
    key: string,
    patch: Partial<AttachmentUpload> | ((a: AttachmentUpload) => Partial<AttachmentUpload>),
  ) =>
    setAttachments((prev) =>
      prev.map((a) => {
        if (a.key !== key) return a;
        const p = typeof patch === 'function' ? patch(a) : patch;
        return { ...a, ...p };
      }),
    );

  // 单个文件上传：< 阈值单片直传，否则分片（每片带真实进度，累加显示）
  const uploadOne = async (file: File) => {
    const key = crypto.randomUUID();
    const mimeType = file.type || 'application/octet-stream';
    const abort = new AbortController();
    setAttachments((prev) => [
      ...prev,
      {
        key,
        file,
        createdAt: Date.now(),
        filename: file.name,
        mimeType,
        size: file.size,
        status: 'uploading',
        loaded: 0,
        total: file.size,
        abort,
      },
    ]);
    try {
      let token: string;
      if (file.size < SINGLE_UPLOAD_THRESHOLD_BYTES) {
        const res = await uploadsApi.single(
          file,
          file.name,
          mimeType,
          (p) => updateAttachment(key, { loaded: p.loaded, total: p.total }),
          abort.signal,
        );
        token = res.token;
      } else {
        const init = await uploadsApi.initMultipart({
          filename: file.name,
          mimeType,
          size: file.size,
        });
        if (abort.signal.aborted) {
          void uploadsApi.remove(init.token).catch(() => {});
          return;
        }
        // 记录 token：上传中取消也能调 DELETE 回收（abort multipart + 删行）
        updateAttachment(key, { token: init.token });
        const parts: UploadedPart[] = [];
        for (let i = 0; i < init.partCount; i++) {
          const start = i * init.partBytes;
          const blob = file.slice(start, Math.min(start + init.partBytes, file.size));
          const part = await uploadsApi.uploadPart(
            init.token,
            i + 1,
            blob,
            (p) => updateAttachment(key, { loaded: i * init.partBytes + p.loaded }),
            abort.signal,
          );
          parts.push({ partNumber: i + 1, etag: part.etag });
        }
        const done = await uploadsApi.completeMultipart(init.token, parts);
        token = done.token;
      }
      if (abort.signal.aborted) { void uploadsApi.remove(token).catch(() => {}); return; }
      updateAttachment(key, { status: 'ready', token, loaded: file.size, total: file.size });
    } catch (e) {
      // 用户主动取消：removeAttachment 已移除列表，此处不置错
      if (abort.signal.aborted) return;
      updateAttachment(key, {
        status: 'error',
        error: e instanceof ApiError ? e.message : '上传失败，点击重试',
      });
    }
  };

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0 || busy) return;
    const incoming = Array.from(files);
    if (attachments.length + incoming.length > MAX_ATTACHMENTS) {
      toast({ title: `最多添加 ${MAX_ATTACHMENTS} 个附件`, variant: 'error' });
      return;
    }
    const prospectiveTotal =
      attachments.reduce((s, a) => s + a.size, 0) + incoming.reduce((s, f) => s + f.size, 0);
    if (prospectiveTotal > MAX_ATTACHMENT_TOTAL_BYTES) {
      toast({
        title: `附件合计超过 ${Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB 上限`,
        variant: 'error',
      });
      return;
    }
    for (const f of incoming) {
      if (f.size > MAX_ATTACHMENT_FILE_BYTES) {
        toast({
          title: `${f.name} 超过单文件 ${Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB 上限`,
          variant: 'error',
        });
        continue;
      }
      void uploadOne(f);
    }
    clearFieldError('attachments');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** 上传附件的回收：服务端草稿正引用的 token 不调 DELETE（会 409），只从列表去掉，下次保存时由服务端释放 */
  const releaseUpload = (token: string | undefined) => {
    if (token && !referencedTokens().has(token)) void uploadsApi.remove(token).catch(() => {});
  };

  const retryAttachment = (att: AttachmentUpload) => {
    if (!att.file) return;
    releaseUpload(att.token);
    void uploadOne(att.file);
    setAttachments((prev) => prev.filter((a) => a.key !== att.key));
  };

  const removeAttachment = (key: string) => {
    const att = attachments.find((a) => a.key === key);
    att?.abort?.abort();
    releaseUpload(att?.token);
    setAttachments((prev) => prev.filter((a) => a.key !== key));
    clearFieldError('attachments');
  };

  /** 校验失败的 issue 标到对应字段；对不上字段的显示在表单底部 */
  const showIssues = (issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>) => {
    const issueErrors: FieldErrors = {};
    for (const issue of issues) {
      const field = fieldOfIssue(issue.path);
      if (field && !issueErrors[field]) issueErrors[field] = issue.message;
    }
    if (Object.keys(issueErrors).length > 0) {
      setFieldErrors(issueErrors);
      focusField(issueErrors);
    } else {
      setSendError({ message: issues[0]?.message ?? '请检查输入', kind: 'error' });
    }
  };

  /** 发送与定时发送前按完整发信请求校验：不通过时标出字段并聚焦，返回 null */
  const validateSend = (): InternalSendMailRequest | null => {
    const errors: FieldErrors = {};
    if (!identityValid) {
      errors.identity = !customAllowed && (mailboxes ?? []).length === 0 ? '请先认领一个邮箱地址' : '请选择有效的发件地址';
    }
    if (to.length + cc.length + bcc.length === 0) errors.to = '至少需要一个收件人';
    if (!subject.trim()) errors.subject = '请填写主题';
    if (body.length === 0) errors.body = '正文不能为空';
    if (attachments.some((a) => a.status !== 'ready' || !a.token || attachmentExpired(a))) {
      errors.attachments = '附件尚未准备完成：请等待上传，重试失败附件，或移除过期附件后重新添加';
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusField(errors);
      return null;
    }
    const payload = {
      from: sendFrom(),
      to,
      cc,
      bcc,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      attachmentTokens: attachments.map((a) => attachmentTokenRef({ token: a.token!, contentId: a.contentId, disposition: a.disposition })),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(forwardAttachmentsFrom ? { forwardAttachmentsFrom } : {}),
    };
    const parsed = internalSendMailSchema.safeParse(payload);
    if (!parsed.success) {
      showIssues(parsed.error.issues);
      return null;
    }
    setFieldErrors({});
    return parsed.data;
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSendError(null);
    const payload = validateSend();
    if (!payload) return;

    // 外发超大附件：后端会自动转成下载链接注入正文（绕过 send_email 5MiB 硬限）。
    // 这里只提示用户，不阻止发送。
    if (
      hasExternalRecipient([...to, ...cc, ...bcc], visibleDomains ?? []) &&
      exceedsExternalLimit(attachments.reduce((s, a) => s + a.size, 0), new Blob([body]).size)
    ) {
      toast({ title: '附件较大，将以下载链接形式发给外部收件人' });
    }

    attemptedRef.current = true;
    persistDraftRef.current();
    sendMutation.mutate({
      payload,
      serverRequest: serverDraft ? draftRequestBody() : undefined,
      snapshot: contentSnapshot,
      attemptKey: JSON.stringify([editKey, replyToMessageId ?? null, forwardAttachmentsFrom ?? null]),
    });
  };

  /** 存到草稿箱（可选带定时）：内容可以不完整，但附件要上传完成、格式要合法 */
  const saveToServer = ({ leave = false, sendAt }: { leave?: boolean; sendAt?: string } = {}) => {
    setSendError(null);
    if (attachments.some((a) => a.status !== 'ready' || !a.token)) {
      const errors: FieldErrors = { attachments: '附件尚未准备完成：请等待上传，或移除失败的附件后再保存' };
      setFieldErrors(errors);
      focusField(errors);
      if (leave) stayOnPage();
      return;
    }
    const request: DraftRequestBody = { ...draftRequestBody(), ...(sendAt ? { sendAt } : {}) };
    const parsed = draftInputSchema.safeParse(request);
    if (!parsed.success) {
      showIssues(parsed.error.issues);
      if (leave) stayOnPage();
      return;
    }
    setFieldErrors({});
    saveMutation.mutate({ request, scheduled: Boolean(sendAt), leave });
  };

  // 定时发送：到点由服务器直接发出，所以先按完整发信请求检查，缺什么现在就补上
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const openSchedule = () => {
    setSendError(null);
    if (!validateSend()) return;
    const current = savedServerDraftRef.current?.sendAt ? new Date(savedServerDraftRef.current.sendAt) : null;
    setScheduleValue(toLocalInputValue(current && current.getTime() > Date.now() ? current : defaultScheduleTime()));
    setScheduleError(null);
    setScheduleOpen(true);
  };
  const confirmSchedule = () => {
    const at = parseLocalInputValue(scheduleValue);
    const problem = at ? sendAtProblem(at.getTime()) : '请选择发送时间';
    if (problem || !at) {
      setScheduleError(problem);
      return;
    }
    setScheduleOpen(false);
    saveToServer({ sendAt: toOffsetIsoString(at) });
  };

  // 只去掉失效的来源，不自动重发：由用户确认后再点发送（内容变了，会用新的幂等键）
  const goneSource = sendError?.kind === 'reply' || sendError?.kind === 'forward' ? sendError.kind : null;
  const detachSource = (source: SendSource) => {
    if (source === 'reply') setReplyToMessageId(undefined);
    else {
      forwardSourceDetached.current = true;
      setForwardAttachmentsFrom(undefined);
    }
    setSendError(null);
    toast({ title: SOURCE_GONE[source].detached });
  };

  // Ctrl/⌘+Enter 发送；等收件人输入框把回车前的地址提交进状态后再提交表单
  const handleFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    globalThis.setTimeout(() => formRef.current?.requestSubmit(), 0);
  };

  const handlePaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    handleFiles(files);
  };

  const attachmentTotal = attachments.reduce((sum, item) => sum + item.size, 0);
  // 去掉了与原邮件的回复关联（原邮件已不存在）就是一封新邮件
  const title = serverDraft
    ? '编辑草稿'
    : initial.mode === 'reply'
      ? replyToMessageId ? '回复邮件' : '写邮件'
      : initial.mode === 'forward'
        ? '转发邮件'
        : initial.mode === 'resend'
          ? '重新发送'
          : '写邮件';

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={title} />
      {serverDraft && (
        <div className="mb-4 rounded-md border border-line bg-surface p-3 text-sm text-ink-secondary">
          <p>
            正在编辑草稿箱里的草稿 #{serverDraft.id}（来源：{draftSourceLabel(serverDraft)}）。
            点「存到草稿箱」保存修改，点「发送」立即发出。
          </p>
          {serverDraft.status === 'scheduled' && serverDraft.sendAt && (
            <p className="mt-1 text-accent">已安排在 {formatDateTime(serverDraft.sendAt)} 定时发送，保存修改后仍按这个时间发送。</p>
          )}
          {serverDraft.errorDetail && <p className="mt-1 break-words text-critical">上次发送：{serverDraft.errorDetail}</p>}
        </div>
      )}
      {!serverDraft && recoveredSendPending && <p role="status" className="mb-4 rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
        上次发送结果待确认，可用原内容重试查询；修改内容前请核对已发送邮件。
      </p>}
      {(initial.unconfirmed?.length ?? 0) > 0 && <p role="status" className="mb-4 break-words rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
        这些收件人的投递结果未确认，可能已经收到，没有自动加入：{initial.unconfirmed!.join('、')}。确认对方没收到后再手动添加，避免重复投递。
      </p>}
      <form
        ref={formRef}
        noValidate
        onSubmit={handleSubmit}
        onKeyDown={handleFormKeyDown}
        onPaste={handlePaste}
        onDragOver={(event) => {
          if (!hasDraggedFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasDraggedFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          'relative flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 transition-shadow',
          dragging && 'border-accent ring-2 ring-accent/30',
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-accent-soft/80 text-sm font-medium text-accent">
            松开鼠标添加附件
          </div>
        )}
        <fieldset disabled={busy} className="contents">
        <IdentityPicker
          id="compose-identity"
          error={fieldErrors.identity}
          isAdmin={isAdmin}
          mailboxes={mailboxes ?? []}
          domains={customDomains}
          hostedDomains={hostedDomains}
          mailboxId={mailboxId}
          onMailboxId={(id) => {
            // 托管域名还没读完时用户已手动选择，之后不再自动改选
            identityInitializedRef.current = true;
            setMailboxId(id);
            clearFieldError('identity');
          }}
          localPart={localPart}
          onLocalPart={(value) => {
            setLocalPart(value);
            clearFieldError('identity');
          }}
          domain={adminDomain}
          onDomain={(value) => {
            setAdminDomain(value);
            clearFieldError('identity');
          }}
        />
        <Button type="button" variant="ghost" size="sm" className="self-start" disabled={!identityValid} onClick={saveDefaultIdentity}>
          设为默认发件地址
        </Button>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="compose-to" className="text-sm font-medium text-ink">
              收件人<span className="ml-0.5 text-critical">*</span>
            </label>
            {(!showCc || !showBcc) && (
              <div className="flex gap-3 text-sm">
                {!showCc && (
                  <button type="button" onClick={() => setShowCc(true)} className="text-accent hover:underline">
                    抄送
                  </button>
                )}
                {!showBcc && (
                  <button type="button" onClick={() => setShowBcc(true)} className="text-accent hover:underline">
                    密送
                  </button>
                )}
              </div>
            )}
          </div>
          <RecipientInput
            id="compose-to"
            value={to}
            onChange={(value) => {
              setTo(value);
              clearFieldError('to');
            }}
            placeholder="输入邮箱后回车"
            suggestions={contacts}
            aria-invalid={fieldErrors.to ? true : undefined}
            aria-describedby={fieldErrors.to ? 'compose-to-error' : undefined}
          />
          {fieldErrors.to && <p id="compose-to-error" role="alert" className="text-xs text-critical">{fieldErrors.to}</p>}
        </div>

        {showCc && (
          <FormField label="抄送">
            {(field) => (
              <RecipientInput {...field} value={cc} onChange={(value) => {
                setCc(value);
                clearFieldError('to');
              }} placeholder="抄送收件人" suggestions={contacts} />
            )}
          </FormField>
        )}

        {showBcc && (
          <FormField label="密送">
            {(field) => (
              <RecipientInput {...field} value={bcc} onChange={(value) => {
                setBcc(value);
                clearFieldError('to');
              }} placeholder="密送收件人" suggestions={contacts} />
            )}
          </FormField>
        )}

        <FormField label="主题" htmlFor="compose-subject" error={fieldErrors.subject} required>
          {(field) => (
            <Input
              {...field}
              invalid={Boolean(fieldErrors.subject)}
              maxLength={998}
              placeholder="邮件主题"
              value={subject}
              onChange={(event) => {
                setSubject(event.target.value);
                clearFieldError('subject');
              }}
            />
          )}
        </FormField>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label htmlFor="compose-body" className="text-sm font-medium text-ink">正文</label>
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              HTML
              <Switch checked={isHtml} onCheckedChange={setIsHtml} aria-label="以 HTML 发送" />
            </label>
          </div>
          <Textarea
            id="compose-body"
            rows={10}
            invalid={Boolean(fieldErrors.body)}
            aria-describedby={fieldErrors.body ? 'compose-body-error' : undefined}
            placeholder={isHtml ? '支持简单 HTML 标记' : '纯文本正文'}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              clearFieldError('body');
            }}
            className="font-sans"
          />
          {fieldErrors.body && <p id="compose-body-error" role="alert" className="text-xs text-critical">{fieldErrors.body}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button id="compose-attach" type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="size-4" />
              添加附件
            </Button>
            <span className="text-xs text-ink-tertiary">
              可拖拽或粘贴文件；最多 {MAX_ATTACHMENTS} 个，单文件 {Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB，
              合计 {Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB；已用 {formatBytes(attachmentTotal)}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => handleFiles(event.target.files)}
            />
          </div>
          {forwardAttachmentsFrom && (
            <p className="text-sm text-ink-secondary">
              转发来源为邮件 #{forwardAttachmentsFrom}。发送时会处理追踪内容并带上可转发的原附件。
            </p>
          )}
          {attachments.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {attachments.map((attachment) => {
                const pct =
                  attachment.total > 0 ? Math.round((attachment.loaded / attachment.total) * 100) : 0;
                return (
                  <li
                    key={attachment.key}
                    className="flex flex-col gap-1.5 rounded-md border border-line px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-ink">{attachment.filename}</span>
                      <span className="shrink-0 text-xs text-ink-tertiary">
                        {formatBytes(attachment.size)}
                      </span>
                      {attachment.status === 'uploading' && (
                        <span className="shrink-0 text-xs text-ink-tertiary">{pct}%</span>
                      )}
                      {attachment.status === 'ready' && (
                        <span className="shrink-0 text-xs font-medium text-positive">已上传</span>
                      )}
                      <button
                        type="button"
                        aria-label={`移除 ${attachment.filename}`}
                        onClick={() => removeAttachment(attachment.key)}
                        className="shrink-0 text-ink-tertiary hover:text-ink"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    {attachment.status === 'uploading' && (
                      <Progress value={attachment.loaded} max={attachment.total} />
                    )}
                    {attachment.status === 'error' && attachment.file && (
                      <button
                        type="button"
                        onClick={() => retryAttachment(attachment)}
                        className="self-start text-left text-xs text-critical hover:underline"
                      >
                        {attachment.error ?? '上传失败，点击重试'}
                      </button>
                    )}
                    {attachment.status === 'error' && !attachment.file && <p className="text-xs text-critical">{attachment.error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {fieldErrors.attachments && <p role="alert" className="text-xs text-critical">{fieldErrors.attachments}</p>}
        </div>

        {sendError && (
          sendError.kind === 'uncertain' ? (
            <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-caution">发送结果不确定：{sendError.message}</p>
              {serverDraft ? (
                <p className="mt-1">
                  草稿只会发出一次，重试不会重复投递；也可以先到
                  <Link to="/drafts" className="mx-0.5 font-medium text-accent hover:underline">草稿箱</Link>
                  查看它的状态。
                </p>
              ) : (
                <p className="mt-1">
                  重试会使用同一个幂等键，服务器若已投递不会重复发送；也可以先到
                  <Link to="/sent" className="mx-0.5 font-medium text-accent hover:underline">已发送</Link>
                  确认。
                </p>
              )}
              <Button type="submit" size="sm" variant="secondary" className="mt-2" loading={sendMutation.isPending}>
                重试发送
              </Button>
            </div>
          ) : goneSource ? (
            <div role="alert" className="rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-critical">{SOURCE_GONE[goneSource].title}</p>
              <p className="mt-1">{SOURCE_GONE[goneSource].hint}</p>
              <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => detachSource(goneSource)}>
                {SOURCE_GONE[goneSource].action}
              </Button>
            </div>
          ) : sendError.kind === 'in_progress' ? (
            // 服务端仍在处理或结果待确认：不提供重试按钮，避免反复提交；先去已发送核对
            <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-caution">发送结果待确认</p>
              {serverDraft ? (
                <p className="mt-1">
                  这份草稿正在发送。请稍后到
                  <Link to="/drafts" className="mx-0.5 font-medium text-accent hover:underline">草稿箱</Link>
                  查看结果，不要换别的方式重发。
                </p>
              ) : (
                <p className="mt-1">
                  服务器仍在处理这封邮件，或上次发送的结果尚未确认。请到
                  <Link to="/sent" className="mx-0.5 font-medium text-accent hover:underline">已发送</Link>
                  查看是否已经发出；内容不变时再次点击发送只会查询原结果，不会重复投递，修改内容则会作为一封新邮件发送。
                </p>
              )}
            </div>
          ) : sendError.kind === 'delivery_failed' ? (
            <div role="alert" className="rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-critical">发送失败：所有收件人都没有收到</p>
              {(sendError.details?.recipientOutcomes?.length ?? 0) > 0 ? (
                <ul className="mt-1 list-disc pl-4">
                  {sendError.details!.recipientOutcomes!.map((outcome) => (
                    <li key={outcome.address} className="break-words">{outcome.address}：{outcome.error || '发送失败'}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 break-words">{sendError.message}</p>
              )}
              <p className="mt-1">
                {serverDraft ? '按原因修正后可以再次发送这份草稿。' : '按原因修正后可以再次发送，会作为一封新邮件发出。'}
                {sendError.details?.messageId !== undefined && (
                  <Link to={`/mail/${sendError.details.messageId}`} className="ml-0.5 font-medium text-accent hover:underline">查看失败记录</Link>
                )}
              </p>
            </div>
          ) : sendError.kind === 'recipient_suppressed' ? (
            <div role="alert" className="rounded-md border border-critical/40 bg-critical-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-critical">没有发送：收件人都在抑制名单中</p>
              {(sendError.details?.suppressed?.length ?? 0) > 0 ? (
                <ul className="mt-1 list-disc pl-4">
                  {sendError.details!.suppressed!.map((item) => (
                    <li key={item.address} className="break-words">
                      {item.address}：{SUPPRESSION_REASON_TEXT[item.reason] ?? item.reason}，
                      {item.expiresAt ? `${new Date(item.expiresAt).toLocaleString()} 自动解除` : '需管理员解除'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 break-words">{sendError.message}</p>
              )}
              <p className="mt-1">从 {sendError.details?.suppressed?.[0]?.sendingDomain ?? '该域名'} 发给这些地址会直接失败，请换用其他收件人。</p>
            </div>
          ) : sendError.kind === 'draft_conflict' ? (
            <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
              {sendError.details?.draftStatus === 'sent' || sendError.details?.draftStatus === 'sending' ? (
                <>
                  <p className="font-medium text-caution">这份草稿已经发出或正在发送，本页的修改没有保存</p>
                  <p className="mt-1 break-words">
                    {sendError.message}。到
                    <Link to="/drafts" className="mx-0.5 font-medium text-accent hover:underline">草稿箱</Link>
                    查看发送结果。
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-caution">草稿已在别处被修改</p>
                  <p className="mt-1 break-words">
                    {sendError.message}。重新载入会显示最新内容，本页没保存的修改会丢失，需要的话先复制下来。
                  </p>
                  <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={reloadServerDraft}>
                    重新载入草稿
                  </Button>
                </>
              )}
            </div>
          ) : sendError.kind === 'key_mismatch' ? (
            <p role="alert" className="text-sm text-critical">
              发送凭据已用于其他内容，已为这封邮件更换新凭据。请先到
              <Link to="/sent" className="mx-0.5 font-medium text-accent hover:underline">已发送</Link>
              确认没有重复，再点击发送。
            </p>
          ) : (
            <p role="alert" className="text-sm text-critical">{sendError.message}</p>
          )
        )}

        {/* 吸底操作栏：写信页不显示底部导航，小屏贴底并让出安全区 */}
        <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-auto flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-line bg-surface px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:pb-3">
          <span className="mr-auto hidden text-xs text-ink-tertiary sm:inline">Ctrl/⌘ + Enter 发送</span>
          <Button type="button" variant="secondary" onClick={handleCancel}>
            取消
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!serverDraft && !hasContent}
            loading={saveMutation.isPending && !saveMutation.variables?.scheduled}
            onClick={() => saveToServer()}
          >
            存到草稿箱
          </Button>
          <Button type="button" variant="secondary" loading={saveMutation.isPending && saveMutation.variables?.scheduled} onClick={openSchedule}>
            <Clock className="size-4" />
            定时发送
          </Button>
          <Button type="submit" loading={sendMutation.isPending}>
            发送
          </Button>
        </div>
        </fieldset>
      </form>

      <Dialog open={leavePromptOpen} onOpenChange={(open) => !open && !saveMutation.isPending && stayOnPage()}>
        <DialogContent className="max-w-md" showClose={false}>
          {serverDraft ? (
            <DialogHeader title="保存对草稿的修改？" description="修改还没有保存到草稿箱。" />
          ) : (
            <DialogHeader title="保存这封邮件的草稿？" description="草稿保存在本机浏览器，下次打开同一封邮件的写信页时可以继续编辑。" />
          )}
          <DialogFooter className="flex-wrap">
            <Button variant="ghost" className="mr-auto" disabled={saveMutation.isPending} onClick={stayOnPage}>
              继续编辑
            </Button>
            <Button variant="secondary" disabled={saveMutation.isPending} onClick={() => finishLeave(false)}>
              {serverDraft ? '放弃修改' : '丢弃'}
            </Button>
            <Button loading={saveMutation.isPending} onClick={() => finishLeave(true)}>
              {serverDraft ? '保存到草稿箱' : '保存草稿'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader title="定时发送" description="到点后由服务器发出（1 分钟内）；发出前可以在草稿箱修改、取消或提前发送。" />
          <DialogBody className="flex flex-col gap-1.5">
            <label htmlFor="compose-send-at" className="text-sm font-medium text-ink">发送时间</label>
            <Input
              id="compose-send-at"
              type="datetime-local"
              value={scheduleValue}
              min={toLocalInputValue(new Date(Date.now() + MIN_SEND_AT_DELAY_MS))}
              max={toLocalInputValue(new Date(Date.now() + MAX_SEND_AT_DELAY_MS))}
              invalid={Boolean(scheduleError)}
              aria-describedby={scheduleError ? 'compose-send-at-error' : 'compose-send-at-hint'}
              onChange={(event) => {
                setScheduleValue(event.target.value);
                setScheduleError(null);
              }}
            />
            <p id="compose-send-at-hint" className="text-xs text-ink-tertiary">
              按本机时区（{Intl.DateTimeFormat().resolvedOptions().timeZone}）；最早 1 分钟后，最晚 30 天内。
            </p>
            {scheduleError && <p id="compose-send-at-error" role="alert" className="text-xs text-critical">{scheduleError}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setScheduleOpen(false)}>
              取消
            </Button>
            <Button onClick={confirmSchedule}>安排发送</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
