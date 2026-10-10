import { useMemo, useState } from 'react'
import { cn } from '@/lib/cn'
import { linkify, splitQuoteBlocks } from './linkify'

function LinkifiedText({ text }: { text: string }) {
  const segments = useMemo(() => linkify(text), [text])
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'link' ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-accent underline underline-offset-2 hover:text-accent-hover"
          >
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </>
  )
}

function QuoteBlock({ lines }: { lines: string[] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="rounded-sm text-[13px] text-ink-tertiary hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {expanded ? '收起引用内容' : `显示引用内容（${lines.length} 行）`}
      </button>
      {expanded && (
        <blockquote className="mt-1 border-l-2 border-line-strong pl-3 text-ink-secondary">
          <LinkifiedText text={lines.join('\n')} />
        </blockquote>
      )}
    </div>
  )
}

/** 纯文本正文：自动识别 http/https/mailto 链接，连续「>」引用默认折叠。只生成 React 元素。 */
export function PlainTextBody({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => splitQuoteBlocks(text), [text])
  return (
    <div className={cn('whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink', className)}>
      {blocks.map((block, index) =>
        block.type === 'quote' ? (
          <QuoteBlock key={index} lines={block.lines} />
        ) : (
          <div key={index}>
            <LinkifiedText text={block.text} />
          </div>
        ),
      )}
    </div>
  )
}
