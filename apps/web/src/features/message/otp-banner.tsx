import { CopyButton, useCopy } from '@/components/ui/copy-button';

export function OtpBanner({ code }: { code: string }) {
  const { copied, copy } = useCopy('验证码已复制');
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-otp-border bg-otp-bg px-4 py-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-otp-ink">验证码{copied && ' · 已复制'}</p>
        {/* 数字本身也可点击复制 */}
        <button
          type="button"
          title="点击复制验证码"
          aria-label={`复制验证码 ${code}`}
          onClick={() => void copy(code)}
          className="rounded-sm font-mono text-[22px] font-semibold tracking-wider text-otp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {code}
        </button>
      </div>
      <CopyButton value={code} label="复制" ariaLabel="复制验证码" size="sm" />
    </div>
  );
}
