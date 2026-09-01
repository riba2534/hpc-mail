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
import { useMailboxesQuery } from '@/features/mailboxes/use-mailboxes';
import type { ComposeInitial } from './compose-init';
import { exceedsExternalLimit, hasExternalRecipient } from './compose-attachments';
import { IdentityPicker } from './identity-picker';
import { RecipientInput } from './recipient-input';

interface AttachmentUpload {
  key: string;
  file: File;
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

const LEGACY_DRAFT_KEY = 'hpc-compose-draft';
const draftKeyForUser = (userId: number) => `hpc-compose-draft:${userId}`;
interface ComposeDraft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
}

function readDraft(key: string): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ComposeDraft) : null;
  } catch {
    return null;
  }
}

function clearDraft(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function ComposePage() {
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
  const draftKey = useMemo(() => draftKeyForUser(user.id), [user.id]);

  const initial = useMemo<ComposeInitial>(() => (location.state as ComposeInitial | null) ?? {}, [location.state]);
  const initialIdentity = useMemo(() => splitLocalPart(initial.fromAddress), [initial.fromAddress]);
  // 全新写信（无回复/转发预填）时恢复本地草稿；回复/转发有 location.state 则不覆盖
  const savedDraft = useMemo(() => (location.state ? null : readDraft(draftKey)), [draftKey, location.state]);

  // 旧版本使用全站共享 key，无法判断内容属于哪个账户。为避免跨账户泄露，只清理、不迁移。
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_DRAFT_KEY);
    } catch {
      // ignore
    }
  }, []);

  const [mailboxId, setMailboxId] = useState<number | null>(null);
  const [localPart, setLocalPart] = useState(() => (isAdmin ? initialIdentity.localPart : ''));
  const [adminDomain, setAdminDomain] = useState(() => (isAdmin ? initialIdentity.domain : ''));
  const [to, setTo] = useState<string[]>(initial.to ?? savedDraft?.to ?? []);
  const [cc, setCc] = useState<string[]>(initial.cc ?? savedDraft?.cc ?? []);
  const [bcc, setBcc] = useState<string[]>(savedDraft?.bcc ?? []);
  const [showCc, setShowCc] = useState((initial.cc?.length ?? savedDraft?.cc?.length ?? 0) > 0);
  const [showBcc, setShowBcc] = useState((savedDraft?.bcc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(initial.subject ?? savedDraft?.subject ?? '');
  const [isHtml, setIsHtml] = useState(initial.isHtml ?? savedDraft?.isHtml ?? false);
  const [body, setBody] = useState(initial.body ?? savedDraft?.body ?? '');
  const [attachments, setAttachments] = useState<AttachmentUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const replyToMessageId = initial.replyToMessageId;

  const attachmentVersion = attachments
    .map((attachment) => `${attachment.token ?? attachment.key}:${attachment.status}`)
    .join('|');
  useEffect(() => {
    sendIdempotencyKeyRef.current = null;
  }, [mailboxId, localPart, adminDomain, to, cc, bcc, subject, body, isHtml, attachmentVersion]);

  // 预填了发件地址则选中匹配项；否则只有一个认领地址时自动选中（省一步手选）
  useEffect(() => {
    if (isAdmin || mailboxId !== null) return;
    const boxes = mailboxes ?? [];
    if (initial.fromAddress) {
      const match = boxes.find((box) => box.address === initial.fromAddress);
      if (match) setMailboxId(match.id);
    } else if (boxes.length === 1) {
      setMailboxId(boxes[0]!.id);
    }
  }, [mailboxes, isAdmin, mailboxId, initial.fromAddress]);

  // 草稿自动保存到 localStorage；有内容才存，清空则删；发送成功时清除
  useEffect(() => {
    const hasContent =
      to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() !== '' || body.trim() !== '';
    if (!hasContent) {
      clearDraft(draftKey);
      return;
    }
    try {
      localStorage.setItem(draftKey, JSON.stringify({ to, cc, bcc, subject, body, isHtml }));
    } catch {
      // 存储不可用时静默
    }
  }, [draftKey, to, cc, bcc, subject, body, isHtml]);

  // 有未发送内容时离开页面/刷新给出浏览器原生拦截
  useEffect(() => {
    const dirty = to.length > 0 || subject.trim() !== '' || body.trim() !== '';
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [to.length, subject, body]);

  const sendMutation = useMutation({
    mutationFn: (payload: InternalSendMailRequest) => {
      sendIdempotencyKeyRef.current ??= crypto.randomUUID();
      return messageApi.send(payload, sendIdempotencyKeyRef.current);
    },
    onSuccess: () => {
      sendIdempotencyKeyRef.current = null;
      toast({ title: '邮件已发送', variant: 'success' });
      clearDraft(draftKey);
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.root });
      navigate('/sent');
    },
    onError: (err) => {
      // 网络/超时可能发生在服务端已经发送之后，保留同一个 key 可安全查询/重放结果；
      // 明确的业务错误则允许用户修正后使用新 key。
      if (
        !(err instanceof ApiError) ||
        (err.code !== 'network' && err.code !== 'timeout' && err.code !== 'conflict')
      ) {
        sendIdempotencyKeyRef.current = null;
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

    if (isAdmin) {
      if (!localPart || !adminDomain) {
        setError('请填写发件地址');
        return;
      }
    } else if (!mailboxId) {
      setError('请选择发件地址');
      return;
    }

    // 有附件仍在上传 → 阻止发送
    if (attachments.some((a) => a.status === 'uploading')) {
      toast({ title: '附件仍在上传，请稍候', variant: 'error' });
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
      from: isAdmin ? { localPart, domain: adminDomain } : { mailboxId: mailboxId ?? undefined },
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
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
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

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">
              收件人<span className="ml-0.5 text-critical">*</span>
            </span>
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
          <RecipientInput value={to} onChange={setTo} placeholder="输入邮箱后回车" suggestions={contacts} />
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
            <span className="text-sm font-medium text-ink">正文</span>
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              HTML
              <Switch checked={isHtml} onCheckedChange={setIsHtml} aria-label="以 HTML 发送" />
            </label>
          </div>
          <Textarea
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
                    {attachment.status === 'error' && (
                      <button
                        type="button"
                        onClick={() => retryAttachment(attachment)}
                        className="self-start text-left text-xs text-critical hover:underline"
                      >
                        {attachment.error ?? '上传失败，点击重试'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && <p className="text-sm text-critical">{error}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => navigate(-1)}>
            取消
          </Button>
          <Button type="submit" loading={sendMutation.isPending} disabled={to.length === 0}>
            发送
          </Button>
        </div>
      </form>
    </div>
  );
}
