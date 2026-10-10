import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
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
  SINGLE_UPLOAD_THRESHOLD_BYTES,
  type InternalSendMailRequest,
  type UploadedPart,
  internalSendMailSchema,
} from '@hpc-mail/shared';
import { ApiError, isUncertainSendError } from '@/api/errors';
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
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { useDomains } from '@/lib/use-config';
import { useCurrentUser } from '@/lib/use-session';
import { getAuthToken } from '@/lib/auth-token';
import { rememberedFilterAddress } from '@/features/inbox/use-inbox-filters';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
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
import { clearSendAttempt, hashSendPayload, persistSendAttempt, readSendAttempt } from './send-attempt';

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
}

type FieldKey = 'identity' | 'to' | 'subject' | 'body' | 'attachments';
type FieldErrors = Partial<Record<FieldKey, string>>;

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
  const user = useCurrentUser();
  const location = useLocation();
  const state = location.state as ComposeInitial | null;
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
}

function ComposeEditor({ initial, restored, draftKey, autosave }: ComposeEditorProps) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isAdmin = user.role === 'admin';
  const { data: visibleDomains } = useDomains();
  const { data: mailboxes } = useMailboxesQuery(false);
  const { data: contactsData } = useQuery({
    queryKey: ['messages', 'contacts'],
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

  // 旧版本使用全站共享 key，无法判断内容属于哪个账户。为避免跨账户泄露，只清理、不迁移。
  useEffect(() => {
    try {
      localStorage.removeItem('hpc-compose-draft');
    } catch {
      // ignore
    }
  }, []);

  const [mailboxId, setMailboxId] = useState<number | null>(null);
  const [localPart, setLocalPart] = useState(() => (isAdmin ? initialIdentity.localPart || draft?.localPart || defaultIdentity?.localPart || lastIdentity?.localPart || '' : ''));
  const [adminDomain, setAdminDomain] = useState(() => (isAdmin ? initialIdentity.domain || draft?.adminDomain || defaultIdentity?.domain || lastIdentity?.domain || '' : ''));
  const [to, setTo] = useState<string[]>(initial.to ?? []);
  const [cc, setCc] = useState<string[]>(initial.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(initial.bcc ?? []);
  const [showCc, setShowCc] = useState((initial.cc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((initial.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [isHtml, setIsHtml] = useState(initial.isHtml ?? false);
  const [body, setBody] = useState(initial.body ?? '');
  const [attachments, setAttachments] = useState<AttachmentUpload[]>(() => (draft?.attachments ?? []).map((attachment) => {
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
  const [sendError, setSendError] = useState<{ message: string; uncertain: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const replyToMessageId = initial.replyToMessageId;

  const clearFieldError = (key: FieldKey) =>
    setFieldErrors((current) => (current[key] ? { ...current, [key]: undefined } : current));

  // 发件身份：回复/转发固定用原邮件地址；否则依次取草稿 → 设为默认 → 上次使用 → 收件箱筛选地址 → 第一个已认领地址
  useEffect(() => {
    if (!mailboxes || identityInitializedRef.current) return;
    identityInitializedRef.current = true;
    const byId = (id: number | null | undefined) => (id ? mailboxes.find((box) => box.id === id) : undefined);
    const byAddress = (address: string | null | undefined) => (address ? mailboxes.find((box) => box.address === address) : undefined);
    if (initial.fromAddress && !draft) {
      const matching = byAddress(initial.fromAddress);
      if (matching) setMailboxId(matching.id);
      return;
    }
    const sources: Array<SavedIdentity | { mailboxId?: number | null; localPart?: string; address?: string } | null> = [
      draft ? { mailboxId: draft.mailboxId, localPart: draft.localPart, address: draft.fromAddress } : null,
      defaultIdentity,
      lastIdentity,
    ];
    for (const source of sources) {
      if (!source) continue;
      const box = byId(source.mailboxId) ?? byAddress('address' in source ? source.address : undefined);
      if (box) {
        setMailboxId(box.id);
        return;
      }
      // 管理员自定义地址：localPart/域名已在初始状态里预填
      if (isAdmin && source.mailboxId === null && source.localPart) return;
    }
    const fallback = byAddress(rememberedFilterAddress()) ?? mailboxes[0];
    if (fallback) setMailboxId(fallback.id);
  }, [mailboxes, initial.fromAddress, draft, defaultIdentity, lastIdentity, isAdmin]);

  const validMailbox = (mailboxes ?? []).some((box) => box.id === mailboxId);
  const validCustomIdentity = isAdmin && Boolean(localPart) && (visibleDomains ?? []).includes(adminDomain);
  const identityValid = validMailbox || validCustomIdentity;
  const currentIdentity = (): SavedIdentity => ({ mailboxId: validMailbox ? mailboxId : null, localPart, domain: adminDomain });
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
  const [initialSnapshot] = useState(contentSnapshot);
  const dirty = contentSnapshot !== initialSnapshot;
  const hasContent =
    to.length > 0 || cc.length > 0 || bcc.length > 0 || attachments.length > 0 || Boolean(initial.forwardAttachmentsFrom) || subject.trim() !== '' || body.trim() !== '';

  const persistDraft = () => {
    if (sentRef.current || discardedRef.current) return;
    if (!hasContent) {
      clearDraft(draftKey);
      return;
    }
    const savedAttachments: SavedAttachment[] = attachments.map(({ key, filename, mimeType, size, token, status, createdAt }) => ({ key, filename, mimeType, size, token, status, createdAt }));
    writeDraft(draftKey, {
      ...initial,
      fromAddress: validMailbox ? mailboxes?.find((box) => box.id === mailboxId)?.address : isAdmin ? `${localPart}@${adminDomain}` : undefined,
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
  }, [autosave, dirty, restored, draftKey, contentSnapshot, mailboxId, localPart, adminDomain]);

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
    else navigate('/inbox');
  };
  const handleCancel = () => {
    if (dirty || restored) setCancelPrompt(true);
    else leavePage();
  };
  const finishLeave = (keep: boolean) => {
    if (keep) persistDraftRef.current();
    else {
      discardedRef.current = true;
      clearDraft(draftKey);
    }
    setCancelPrompt(false);
    if (blocker.state === 'blocked') blocker.proceed();
    else leavePage();
  };
  const stayOnPage = () => {
    setCancelPrompt(false);
    if (blocker.state === 'blocked') blocker.reset();
  };

  const sendMutation = useMutation({
    mutationFn: async (payload: InternalSendMailRequest) => {
      const payloadHash = await hashSendPayload(payload);
      if (composeSessionTokenRef.current !== getAuthToken()) {
        throw new ApiError('登录账户已变化，请重新操作', { code: 'session_changed' });
      }
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
    onSuccess: (result) => {
      sentRef.current = true;
      clearSendAttempt(user.id, sendIdempotencyKeyRef.current);
      setRecoveredSendPending(false);
      sendIdempotencyKeyRef.current = null;
      sendPayloadHashRef.current = null;
      writeLastIdentity(user.id, currentIdentity());
      const failures = result.recipientOutcomes?.filter((outcome) => outcome.status === 'failed') ?? [];
      const issue = failures.length > 0 || Boolean(result.errorDetail) || result.status === 'failed';
      toast({ title: issue ? failures.length ? `${failures.length} 个收件人发送失败，请查看并重试失败目标` : '邮件发送有异常，请查看详情' : result.status === 'delivered' ? '站内邮件已送达' : '邮件已提交发送', variant: issue ? 'error' : 'success' });
      clearDraft(draftKey);
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
      navigate(result.errorDetail || result.status === 'failed' || result.recipientOutcomes?.some((outcome) => outcome.status === 'failed') ? `/mail/${result.id}` : '/sent');
    },
    onError: (err) => {
      // 网络/超时可能发生在服务端已经发送之后，保留同一个 key 可安全查询/重放结果；
      // 明确的业务错误则允许用户修正后使用新 key。
      const unresolved = isUncertainSendError(err);
      if (!unresolved) {
        clearSendAttempt(user.id, sendIdempotencyKeyRef.current);
        setRecoveredSendPending(false);
        sendIdempotencyKeyRef.current = null;
        sendPayloadHashRef.current = null;
      }
      const sessionChanged = err instanceof ApiError && err.code === 'session_changed';
      setSendError({ message: err instanceof ApiError ? err.message : '发送失败，请重试', uncertain: unresolved && !sessionChanged });
    },
  });

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
    if (!files || files.length === 0 || sendMutation.isPending) return;
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

  const retryAttachment = (att: AttachmentUpload) => {
    if (!att.file) return;
    if (att.token) void uploadsApi.remove(att.token).catch(() => {});
    void uploadOne(att.file);
    setAttachments((prev) => prev.filter((a) => a.key !== att.key));
  };

  const removeAttachment = (key: string) => {
    const att = attachments.find((a) => a.key === key);
    att?.abort?.abort();
    if (att?.token) void uploadsApi.remove(att.token).catch(() => {});
    setAttachments((prev) => prev.filter((a) => a.key !== key));
    clearFieldError('attachments');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSendError(null);

    const errors: FieldErrors = {};
    if (!identityValid) {
      errors.identity = !isAdmin && (mailboxes ?? []).length === 0 ? '请先认领一个邮箱地址' : '请选择有效的发件地址';
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
      return;
    }
    const ready = attachments.filter((a) => a.status === 'ready' && a.token);
    const attachmentTokens = ready.map((a) => a.token!);

    // 外发超大附件：后端会自动转成下载链接注入正文（绕过 send_email 5MiB 硬限）。
    // 这里只提示用户，不阻止发送。
    if (
      hasExternalRecipient([...to, ...cc, ...bcc], visibleDomains ?? []) &&
      exceedsExternalLimit(ready.reduce((s, a) => s + a.size, 0), new Blob([body]).size)
    ) {
      toast({ title: '附件较大，将以下载链接形式发给外部收件人' });
    }

    const payload = {
      from: validMailbox ? { mailboxId: mailboxId! } : { localPart, domain: adminDomain },
      to,
      cc,
      bcc,
      subject,
      ...(isHtml ? { html: body } : { text: body }),
      attachmentTokens,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(initial.forwardAttachmentsFrom ? { forwardAttachmentsFrom: initial.forwardAttachmentsFrom } : {}),
    };

    const parsed = internalSendMailSchema.safeParse(payload);
    if (!parsed.success) {
      const issueErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = fieldOfIssue(issue.path);
        if (field && !issueErrors[field]) issueErrors[field] = issue.message;
      }
      if (Object.keys(issueErrors).length > 0) {
        setFieldErrors(issueErrors);
        focusField(issueErrors);
      } else {
        setSendError({ message: parsed.error.issues[0]?.message ?? '请检查输入', uncertain: false });
      }
      return;
    }
    setFieldErrors({});
    attemptedRef.current = true;
    persistDraftRef.current();
    sendMutation.mutate(parsed.data);
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
  const title =
    initial.mode === 'reply'
      ? '回复邮件'
      : initial.mode === 'forward'
        ? '转发邮件'
        : initial.mode === 'resend'
          ? '重新发送'
          : '写邮件';

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={title} />
      {recoveredSendPending && <p role="status" className="mb-4 rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
        上次发送结果待确认，可用原内容重试查询；修改内容前请核对已发送邮件。
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
        <fieldset disabled={sendMutation.isPending} className="contents">
        <IdentityPicker
          id="compose-identity"
          error={fieldErrors.identity}
          isAdmin={isAdmin}
          mailboxes={mailboxes ?? []}
          domains={visibleDomains ?? []}
          mailboxId={mailboxId}
          onMailboxId={(id) => {
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
          {initial.forwardAttachmentsFrom && (
            <p className="text-sm text-ink-secondary">将保留原邮件附件（来源邮件 #{initial.forwardAttachmentsFrom}）。</p>
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
          sendError.uncertain ? (
            <div role="alert" className="rounded-md border border-caution/40 bg-caution-soft p-3 text-sm text-ink-secondary">
              <p className="font-medium text-caution">发送结果不确定：{sendError.message}</p>
              <p className="mt-1">
                重试会使用同一个幂等键，服务器若已投递不会重复发送；也可以先到
                <Link to="/sent" className="mx-0.5 font-medium text-accent hover:underline">已发送</Link>
                确认。
              </p>
              <Button type="submit" size="sm" variant="secondary" className="mt-2" loading={sendMutation.isPending}>
                重试发送
              </Button>
            </div>
          ) : (
            <p role="alert" className="text-sm text-critical">{sendError.message}</p>
          )
        )}

        {/* 吸底操作栏：写信页不显示底部导航，小屏贴底并让出安全区 */}
        <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-auto flex items-center justify-end gap-2 rounded-b-lg border-t border-line bg-surface px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:pb-3">
          <span className="mr-auto hidden text-xs text-ink-tertiary sm:inline">Ctrl/⌘ + Enter 发送</span>
          <Button type="button" variant="secondary" onClick={handleCancel}>
            取消
          </Button>
          <Button type="submit" loading={sendMutation.isPending}>
            发送
          </Button>
        </div>
        </fieldset>
      </form>

      <Dialog open={leavePromptOpen} onOpenChange={(open) => !open && stayOnPage()}>
        <DialogContent className="max-w-md" showClose={false}>
          <DialogHeader title="保存这封邮件的草稿？" description="草稿保存在本机浏览器，下次打开同一封邮件的写信页时可以继续编辑。" />
          <DialogFooter className="flex-wrap">
            <Button variant="ghost" className="mr-auto" onClick={stayOnPage}>
              继续编辑
            </Button>
            <Button variant="secondary" onClick={() => finishLeave(false)}>
              丢弃
            </Button>
            <Button onClick={() => finishLeave(true)}>保存草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
