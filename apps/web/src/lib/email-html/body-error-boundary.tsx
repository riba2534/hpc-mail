import { Component, type ReactNode } from 'react'

const BLOCK_SELECTOR = 'p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table'

/** HTML 正文的文字（不执行脚本、不加载资源）：没有纯文本正文时的降级显示用 */
export function htmlToPlainText(html: string): string {
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    parsed.querySelectorAll('script, style, template, noscript').forEach((node) => node.remove())
    parsed.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
    parsed.querySelectorAll(BLOCK_SELECTOR).forEach((node) => node.append('\n'))
    return (parsed.body?.textContent ?? '')
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

export interface EmailBodyBoundaryProps {
  /** 换一封邮件时重新按原格式渲染 */
  resetKey: unknown
  /** 纯文本正文；为空时从 HTML 正文提取文字 */
  text: string
  html?: string | null
  /** 有原始邮件时提供下载 .eml 的入口 */
  onDownloadRaw?: () => void
  children: ReactNode
}

interface EmailBodyBoundaryState {
  failed: boolean
  resetKey: unknown
}

/**
 * 邮件正文的错误边界：畸形邮件让正文渲染（消毒、写入 iframe、纯文本链接化）抛错时，
 * 只把正文区降级为纯文本并给出下载原始邮件的入口，页头、操作栏与附件照常可用。
 */
export class EmailBodyBoundary extends Component<EmailBodyBoundaryProps, EmailBodyBoundaryState> {
  state: EmailBodyBoundaryState = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<EmailBodyBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: EmailBodyBoundaryProps, state: EmailBodyBoundaryState) {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey }
  }

  render() {
    if (!this.state.failed) return this.props.children
    const { text, html, onDownloadRaw } = this.props
    const fallback = text.trim() || (html ? htmlToPlainText(html) : '')
    return (
      <div className="flex flex-col gap-3">
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-caution/40 bg-caution-soft px-3 py-2 text-sm"
        >
          <span className="text-ink-secondary">正文无法按原格式显示，已改为纯文本。</span>
          {onDownloadRaw && (
            <button type="button" className="font-medium text-accent hover:underline" onClick={onDownloadRaw}>
              下载原始邮件 (.eml)
            </button>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
          {fallback || '（无法提取正文文字）'}
        </div>
      </div>
    )
  }
}
