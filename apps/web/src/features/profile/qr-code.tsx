import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/** 二维码点阵的最小读取接口（与 lean-qr 的 Bitmap2D 一致） */
export interface QrMatrix {
  readonly size: number;
  get(x: number, y: number): boolean;
}

/** 扫码器要求的四模块静区 */
const QUIET_ZONE = 4;

/** 把点阵合并成单条 SVG path：每行连续的深色模块合成一个矩形，体积远小于逐点 <rect> */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.get(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < matrix.size && matrix.get(x, y)) x++;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }
  return parts.join('');
}

type QrState = { value: string; size: number; path: string } | { value: string; error: true };

/**
 * 本地生成的二维码（SVG）。编码库按需动态加载，内容不会发往任何第三方服务。
 * 深色模块用主文字色、底色用表面色，保证扫码所需的高对比。
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<QrState | null>(null);

  useEffect(() => {
    let cancelled = false;
    import('lean-qr/nano')
      .then(({ generate, correction }) => {
        const matrix = generate(value, { minCorrectionLevel: correction.M });
        if (!cancelled) setState({ value, size: matrix.size, path: qrPath(matrix) });
      })
      .catch(() => {
        if (!cancelled) setState({ value, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const current = state?.value === value ? state : null;
  if (!current) return <Skeleton className={cn('aspect-square', className)} />;
  if ('error' in current) {
    return (
      <div
        role="img"
        aria-label={`${label}（生成失败）`}
        className={cn('grid aspect-square place-items-center rounded-md border border-dashed border-line p-3 text-center text-xs text-ink-tertiary', className)}
      >
        二维码生成失败，请手动输入密钥
      </div>
    );
  }

  const full = current.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${full} ${full}`}
      shapeRendering="crispEdges"
      className={cn('aspect-square rounded-md border border-line', className)}
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={full} height={full} className="fill-surface" />
      <path d={current.path} className="fill-ink" />
    </svg>
  );
}
