import { TriangleAlert } from 'lucide-react';
import type { MessageAuth } from '@hpc-mail/shared';
import { senderAuthFailed } from './sender-auth';

export { senderAuthFailed };

export function SenderAuthBanner({ auth, fromAddress }: { auth: MessageAuth | null | undefined; fromAddress: string }) {
  if (!senderAuthFailed(auth)) return null;
  return (
    <div role="alert" className="rounded-lg border border-caution/40 bg-caution-soft px-4 py-3 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-caution">
        <TriangleAlert className="size-4 shrink-0" />
        发件人身份未通过验证
      </p>
      <p className="mt-1 text-ink-secondary">
        显示的发件地址 <span className="break-all font-medium text-ink">{fromAddress || '（空）'}</span>{' '}
        没有通过其域名的发件认证，可能是伪造的。不要轻信邮件里的链接、附件或转账、改密等要求。
      </p>
      <p className="mt-1 text-xs text-ink-tertiary">
        SPF {auth.spf} · DKIM {auth.dkim}{auth.dkimDomain && `（${auth.dkimDomain}）`} · DMARC {auth.dmarc}
      </p>
    </div>
  );
}
