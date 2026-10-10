import { Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { MessageTranslationState } from './use-message-translation';

/** 译文模式的顶部标注：进度、失败重试与「显示原文」 */
export function TranslationBar({ translation }: { translation: MessageTranslationState }) {
  const { snapshot } = translation;
  const running = !snapshot || snapshot.running;
  const failure = snapshot && !snapshot.running && snapshot.failed > 0 ? `${snapshot.failed} 批翻译失败：${snapshot.error ?? '请重试'}` : null;
  return (
    <div role="status" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-ink-secondary">
          {running ? <Spinner className="size-4 shrink-0 text-ink-tertiary" aria-hidden /> : <Languages className="size-4 shrink-0 text-ink-tertiary" />}
          AI 翻译 · 仅供参考
          {running && <span className="tabular-nums text-ink-tertiary">翻译中 {snapshot?.done ?? 0}/{snapshot?.total ?? '…'}</span>}
        </span>
        {failure && <span className="text-critical">{failure}</span>}
      </div>
      <div className="flex items-center gap-2">
        {failure && (
          <Button variant="secondary" size="sm" onClick={translation.retry}>
            重试
          </Button>
        )}
        <button type="button" className="text-sm text-ink-tertiary hover:text-ink hover:underline" onClick={translation.toggle}>
          显示原文
        </button>
      </div>
    </div>
  );
}
