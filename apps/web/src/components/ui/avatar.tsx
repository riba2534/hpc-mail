import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

export interface AvatarProps {
  avatarUrl?: string | null;
  name: string;
  /** 含尺寸与字号的 Tailwind 类，例如 "size-7 text-xs" */
  className?: string;
}

/** 有 avatarUrl 显示图片（加载失败回退首字母），无则显示用户名首字母。 */
export function Avatar({ avatarUrl, name, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        onError={() => setFailed(true)}
        className={cn('shrink-0 rounded-full object-cover', className)}
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold uppercase text-accent',
        className,
      )}
    >
      {name.slice(0, 2)}
    </span>
  );
}
