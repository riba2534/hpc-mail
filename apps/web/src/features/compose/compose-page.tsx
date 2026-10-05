import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  SINGLE_UPLOAD_THRESHOLD_BYTES,
  type InternalSendMailRequest,
  type UploadedPart,
  internalSendMailSchema,
} from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { messageApi, uploadsApi } from '@/api/resources';
import { Progress } from '@/components/ui/progress';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { formatBytes } from '@/lib/format';
import { useDomains } from '@/lib/use-config';
import { useCurrentUser } from '@/lib/use-session';
import { getAuthToken } from '@/lib/auth-token';
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import type { ComposeInitial } from './compose-init';
import { attachmentExpired, clearDraft, draftKeyForUser, identityKeyForUser, readDraft, readIdentity, type SavedAttachment } from './compose-draft';
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

function splitLocalPart(address: string | undefined): { localPart: string; domain: string } {
  if (!address) return { localPart: '', domain: '' };
  const at = address.lastIndexOf('@');
  return at > 0 ? { localPart: address.slice(0, at), domain: address.slice(at + 1) } : { localPart: '', domain: '' };
}

export function ComposePage() {
  const location = useLocation();
  return <ComposeEditor key={location.key} />;
}

function ComposeEditor() {
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendIdempotencyKeyRef = useRef<string | null>(null);
  const sendPayloadHashRef = useRef<string | null>(null);
  const sendPersistenceWarningRef = useRef(false);
  const composeSessionTokenRef = useRef(getAuthToken());
  const [recoveredSendPending, setRecoveredSendPending] = useState(() => Boolean(readSendAttempt(user.id)));
  const draftKey = useMemo(() => draftKeyForUser(user.id), [user.id]);

  const savedDraft = useMemo(() => (location.state ? null : readDraft(draftKey)), [draftKey, location.state]);
  const initial = useMemo<ComposeInitial>(() => (location.state as ComposeInitial | null) ?? savedDraft ?? {}, [location.state, savedDraft]);
  const initialIdentity = useMemo(() => splitLocalPart(initial.fromAddress), [initial.fromAddress]);
  const defaultIdentity = useMemo(() => readIdentity(user.id), [user.id]);
  const sentRef = useRef(false);
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
  const [localPart, setLocalPart] = useState(() => (isAdmin ? initialIdentity.localPart || savedDraft?.localPart || defaultIdentity?.localPart || '' : ''));
  const [adminDomain, setAdminDomain] = useState(() => (isAdmin ? initialIdentity.domain || savedDraft?.adminDomain || defaultIdentity?.domain || '' : ''));
  const [to, setTo] = useState<string[]>(initial.to ?? savedDraft?.to ?? []);
  const [cc, setCc] = useState<string[]>(initial.cc ?? savedDraft?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(initial.bcc ?? savedDraft?.bcc ?? []);
  const [showCc, setShowCc] = useState((initial.cc?.length ?? savedDraft?.cc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((initial.bcc?.length ?? savedDraft?.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(initial.subject ?? savedDraft?.subject ?? '');
  const [isHtml, setIsHtml] = useState(initial.isHtml ?? savedDraft?.isHtml ?? false);
  const [body, setBody] = useState(initial.body ?? savedDraft?.body ?? '');
  const [attachments, setAttachments] = useState<AttachmentUpload[]>(() => (savedDraft?.attachments ?? []).map((attachment) => {
    const ready = attachment.status === 'ready' && attachment.token && !attachmentExpired(attachment);
    return { ...attachment, status: ready ? 'ready' : 'error', loaded: ready ? attachment.size : 0, total: attachment.size,
      error: ready ? undefined : '附件已过期或上传未完成，请移除后重新选择文件' };
  }));
  const attachmentRefs = useRef(attachments);
  attachmentRefs.current = attachments;
  useEffect(() => () => {
    for (const attachment of attachmentRefs.current) attachment.abort?.abort();
  }, []);
  const [error, setError] = useState<string | null>(null);
  const replyToMessageId = initial.replyToMessageId;

  // Reply identity wins over the saved draft/default; only choose owned mailboxes.
  useEffect(() => {
    if (!mailboxes || identityInitializedRef.current) return;
    identityInitializedRef.current = true;
    const matching = initial.fromAddress ? mailboxes.find((box) => box.address === initial.fromAddress) : undefined;
    const preferredId = savedDraft?.mailboxId ?? defaultIdentity?.mailboxId;
    const preferred = mailboxes.find((box) => box.id === preferredId);
    const selected = matching ?? (!initial.fromAddress ? preferred ?? (mailboxes.length === 1 ? mailboxes[0] : undefined) : undefined);
    if (selected) setMailboxId(selected.id);
  }, [mailboxes, mailboxId, initial.fromAddress, savedDraft?.mailboxId, defaultIdentity?.mailboxId]);

  const validMailbox = (mailboxes ?? []).some((box) => box.id === mailboxId);
  const validCustomIdentity = isAdmin && Boolean(localPart) && (visibleDomains ?? []).includes(adminDomain);
  const identityValid = validMailbox || validCustomIdentity;
  const saveDefaultIdentity = () => {
    if (!identityValid) return;
    try {
      localStorage.setItem(identityKeyForUser(user.id), JSON.stringify({ mailboxId: validMailbox ? mailboxId : null, localPart, domain: adminDomain }));
      toast({ title: '默认发件地址已保存', variant: 'success' });
    } catch { toast({ title: '无法保存默认发件地址', variant: 'error' }); }
  };

  // 草稿自动保存到 localStorage；有内容才存，清空则删；发送成功时清除
  useEffect(() => {
    if (sentRef.current) return;
    const hasContent =
      to.length > 0 || cc.length > 0 || bcc.length > 0 || attachments.length > 0 || Boolean(initial.forwardAttachmentsFrom) || subject.trim() !== '' || body.trim() !== '';
    if (!hasContent) {
      clearDraft(draftKey);
      return;
    }
    try {
      const savedAttachments: SavedAttachment[] = attachments.map(({ key, filename, mimeType, size, token, status, createdAt }) => ({ key, filename, mimeType, size, token, status, createdAt }));
      localStorage.setItem(draftKey, JSON.stringify({ ...initial, fromAddress: validMailbox ? mailboxes?.find((box) => box.id === mailboxId)?.address : isAdmin ? `${localPart}@${adminDomain}` : undefined,
        to, cc, bcc, subject, body, isHtml, mailboxId, localPart, adminDomain, attachments: savedAttachments }));
    } catch {
      // 存储不可用时静默
    }
  }, [draftKey, to, cc, bcc, subject, body, isHtml, mailboxId, localPart, adminDomain, attachments, initial, validMailbox, mailboxes, isAdmin]);

  // 有未发送内容时离开页面/刷新给出浏览器原生拦截
  useEffect(() => {
    const dirty = to.length + cc.length + bcc.length + attachments.length > 0 || Boolean(initial.forwardAttachmentsFrom) || subject.trim() !== '' || body.trim() !== '';
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [to.length, cc.length, bcc.length, attachments.length, initial.forwardAttachmentsFrom, subject, body]);

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
      const unresolved = !(err instanceof ApiError) ||
        ['network', 'timeout', 'conflict', 'malformed', 'session_changed'].includes(err.code) ||
        err.httpStatus === 408 || (err.httpStatus !== null && err.httpStatus >= 500);
      if (!unresolved) {
        clearSendAttempt(user.id, sendIdempotencyKeyRef.current);
        setRecoveredSendPending(false);
        sendIdempotencyKeyRef.current = null;
        sendPayloadHashRef.current = null;
      }
      setError(err instanceof ApiError ? err.message : '发送失败，请重试');
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

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
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
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!identityValid) {
      setError('请选择有效的发件地址');
      return;
    }
    if (attachments.some((a) => a.status !== 'ready' || !a.token || attachmentExpired(a))) {
      setError('附件尚未准备完成：请等待上传，重试失败附件，或移除过期附件后重新添加');
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
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    sendMutation.mutate(parsed.data);
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
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <fieldset disabled={sendMutation.isPending} className="contents">
        <IdentityPicker
          isAdmin={isAdmin}
          mailboxes={mailboxes ?? []}
          domains={visibleDomains ?? []}
          mailboxId={mailboxId}
          onMailboxId={setMailboxId}
          localPart={localPart}
          onLocalPart={setLocalPart}
          domain={adminDomain}
          onDomain={setAdminDomain}
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
          <RecipientInput id="compose-to" value={to} onChange={setTo} placeholder="输入邮箱后回车" suggestions={contacts} />
        </div>

        {showCc && (
          <FormField label="抄送">
            {(field) => (
              <RecipientInput {...field} value={cc} onChange={setCc} placeholder="抄送收件人" suggestions={contacts} />
            )}
          </FormField>
        )}

        {showBcc && (
          <FormField label="密送">
            {(field) => (
              <RecipientInput {...field} value={bcc} onChange={setBcc} placeholder="密送收件人" suggestions={contacts} />
            )}
          </FormField>
        )}

        <FormField label="主题" required>
          {(field) => (
            <Input
              {...field}
              maxLength={998}
              placeholder="邮件主题"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
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
            placeholder={isHtml ? '支持简单 HTML 标记' : '纯文本正文'}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="font-sans"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Paperclip className="size-4" />
              添加附件
            </Button>
            <span className="text-xs text-ink-tertiary">
              最多 {MAX_ATTACHMENTS} 个，单文件 {Math.floor(MAX_ATTACHMENT_FILE_BYTES / 1024 / 1024)}MB，
              合计 {Math.floor(MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024)}MB；已用 {formatBytes(attachmentTotal)}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void handleFiles(event.target.files)}
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
                        <span className="shrink-0 text-xs text-accent">已上传</span>
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
                    {attachment.status === 'error' && !attachment.file && <p role="alert" className="text-xs text-critical">{attachment.error}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && <p role="alert" className="text-sm text-critical">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
            取消
          </Button>
          <Button type="submit" loading={sendMutation.isPending} disabled={to.length + cc.length + bcc.length === 0}>
            发送
          </Button>
        </div>
        </fieldset>
      </form>
    </div>
  );
}
