import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { AVATAR_MAX_BYTES, type UploadAvatarRequest, uploadAvatarRequestSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { queryKeys } from '@/api/query-keys';
import { authApi } from '@/api/resources';
import { ChangePasswordDialog } from '@/app/change-password-dialog';
import { PageHeader } from '@/components/page-header';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { stripDataUrlPrefix } from '@/lib/data-url';
import { useCurrentUser } from '@/lib/use-session';
import { ForwardingSection } from './forwarding-section';
import { TwoFactorSection } from './two-factor-section';
import { NotificationHealthPanel } from './notification-health';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

const SECTIONS = [
  { id: 'profile-avatar', label: '头像' },
  { id: 'profile-account', label: '账户' },
  { id: 'profile-2fa', label: '两步验证' },
  { id: 'profile-notify', label: '转发与通知' },
  { id: 'profile-delivery', label: '投递结果' },
] as const;

/** 页内分区导航：滚动到对应区块并把焦点交给它，不改 URL */
function SectionNav() {
  const jump = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  };
  return (
    <nav aria-label="设置分区" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          onClick={() => jump(section.id)}
          className="h-8 shrink-0 rounded-full border border-line bg-surface px-3 text-[13px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
type AllowedType = (typeof ALLOWED_TYPES)[number];

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

export function ProfilePage() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const invalidateSession = () => queryClient.invalidateQueries({ queryKey: queryKeys.session });

  const upload = useMutation({
    mutationFn: (body: UploadAvatarRequest) => authApi.uploadAvatar(body),
    onSuccess: () => {
      void invalidateSession();
      setPreview(null);
      toast({ title: '头像已更新', variant: 'success' });
    },
    onError: (err) => {
      setPreview(null);
      toast({ title: err instanceof ApiError ? err.message : '上传失败，请重试', variant: 'error' });
    },
  });

  const remove = useMutation({
    mutationFn: () => authApi.deleteAvatar(),
    onSuccess: () => {
      void invalidateSession();
      setPreview(null);
      toast({ title: '头像已删除', variant: 'success' });
    },
    onError: () => toast({ title: '删除失败，请重试', variant: 'error' }),
  });

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type as AllowedType)) {
      toast({ title: '仅支持 PNG / JPG / WebP 格式', variant: 'error' });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast({ title: '头像图片不能超过 2MB', variant: 'error' });
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    const image = stripDataUrlPrefix(dataUrl);
    const body = { contentType: file.type as AllowedType, image };
    const parsed = uploadAvatarRequestSchema.safeParse(body);
    if (!parsed.success) {
      toast({ title: parsed.error.issues[0]?.message ?? '图片无效', variant: 'error' });
      return;
    }
    setPreview(dataUrl);
    upload.mutate(parsed.data);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const displayUrl = preview ?? user.avatarUrl;
  const busy = upload.isPending || remove.isPending;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="个人设置" description="管理你的头像、账户安全，以及邮件的转发与通知。" />
      <SectionNav />

      <div className="flex flex-col gap-4">
        <section id="profile-avatar" tabIndex={-1} className="scroll-mt-20 rounded-lg border border-line bg-surface p-5 focus:outline-none">
          <h2 className="mb-4 text-sm font-semibold text-ink">头像</h2>
          <div className="flex items-center gap-5">
            <Avatar avatarUrl={displayUrl} name={user.username} className="size-20 text-2xl" />
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={upload.isPending}
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {user.avatarUrl ? '更换头像' : '上传头像'}
                </Button>
                {user.avatarUrl && (
                  <Button variant="ghost" size="sm" loading={remove.isPending} disabled={busy} onClick={() => remove.mutate()}>
                    删除
                  </Button>
                )}
              </div>
              <p className="text-xs text-ink-tertiary">支持 PNG / JPG / WebP，不超过 2MB。</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </div>
        </section>

        <section id="profile-account" tabIndex={-1} className="scroll-mt-20 rounded-lg border border-line bg-surface p-5 focus:outline-none">
          <h2 className="mb-4 text-sm font-semibold text-ink">账户</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-ink-secondary">用户名</dt>
              <dd className="font-medium text-ink">{user.username}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-secondary">角色</dt>
              <dd className="font-medium text-ink">{user.role === 'admin' ? '管理员' : '普通用户'}</dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-line pt-4">
            <Button variant="secondary" size="sm" onClick={() => setPasswordOpen(true)}>
              修改密码
            </Button>
          </div>
        </section>

        <TwoFactorSection id="profile-2fa" />

        <ForwardingSection id="profile-notify" />
        <div id="profile-delivery" tabIndex={-1} className="scroll-mt-20 focus:outline-none">
          <NotificationHealthPanel />
        </div>
      </div>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
