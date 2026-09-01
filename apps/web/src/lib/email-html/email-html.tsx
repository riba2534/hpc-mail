import { useLayoutEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { sanitizeEmailHtml } from '../sanitize-email-html'

export interface EmailHtmlProps {
  html: string
  trustedImageOrigins?: string[]
  allowRemoteImages?: boolean
  className?: string
}

const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const MAX_FRAME_HEIGHT_PX = 50_000

const frameCsp = (allowRemoteImages: boolean) => [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  allowRemoteImages ? 'img-src https: data:' : "img-src 'self' data:",
  "font-src 'none'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const FRAME_BASE_STYLES = `
  :root { color-scheme: light; }
  html, body { margin: 0; min-width: 0; color: #0f172a; background: transparent; }
  #email-content { min-width: 0; overflow-wrap: anywhere; }
  #email-content img { max-width: 100%; height: auto; }
  #email-content table { max-width: 100%; }
  #email-content pre { max-width: 100%; overflow: auto; white-space: pre-wrap; }
  #email-content .remote-image-blocked { display: none !important; }
`

export function EmailHtml({
  html,
  trustedImageOrigins = [],
  allowRemoteImages = true,
  className,
}: EmailHtmlProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const trustedOriginsKey = trustedImageOrigins.join('\n')

  useLayoutEffect(() => {
    const iframe = frameRef.current
    const frameDocument = iframe?.contentDocument
    if (!iframe || !frameDocument) return

    // 先创建可信骨架，再用 DOM API 写入正文，避免把邮件字符串插进 raw-text 上下文。
    frameDocument.open()
    frameDocument.write('<!doctype html><html><head></head><body></body></html>')
    frameDocument.close()

    const csp = frameDocument.createElement('meta')
    csp.httpEquiv = 'Content-Security-Policy'
    csp.content = frameCsp(allowRemoteImages)
    const referrer = frameDocument.createElement('meta')
    referrer.name = 'referrer'
    referrer.content = 'no-referrer'
    const style = frameDocument.createElement('style')
    style.textContent = FRAME_BASE_STYLES
    frameDocument.head.replaceChildren(csp, referrer, style)

    const content = frameDocument.createElement('div')
    content.id = 'email-content'
    content.innerHTML = sanitizeEmailHtml(html, {
      window,
      trustedImageOrigins,
      allowRemoteImages,
    })
    frameDocument.body.replaceChildren(content)

    let animationFrame = 0
    let previousHeight = 0
    let observer: ResizeObserver | null = null
    const resize = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        const contentHeight = Math.ceil(Math.max(
          content.getBoundingClientRect().height,
          content.scrollHeight,
          frameDocument.body.scrollHeight,
        ))
        const height = Math.min(contentHeight, MAX_FRAME_HEIGHT_PX)
        if (height === previousHeight) return
        previousHeight = height
        if (height > 0) iframe.style.height = `${height}px`
        else iframe.style.removeProperty('height')
        const isCapped = contentHeight > MAX_FRAME_HEIGHT_PX
        frameDocument.documentElement.style.overflowY = isCapped ? 'auto' : 'hidden'
        iframe.setAttribute('scrolling', isCapped ? 'auto' : 'no')
        if (isCapped) observer?.disconnect()
      })
    }
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(content)
    frameDocument.addEventListener('load', resize, true)
    resize()

    return () => {
      observer?.disconnect()
      frameDocument.removeEventListener('load', resize, true)
      cancelAnimationFrame(animationFrame)
      iframe.style.removeProperty('height')
    }
    // The key intentionally tracks array contents rather than its reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, allowRemoteImages, trustedOriginsKey])

  return (
    <iframe
      ref={frameRef}
      title="邮件正文"
      src="about:blank"
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      scrolling="no"
      className={cn('block min-w-0 w-full border-0', className)}
      data-email-html-host
    />
  )
}
