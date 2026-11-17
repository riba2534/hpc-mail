import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailHtml } from './email-html'

let frames: FrameRequestCallback[] = []
const flushFrames = () => {
  const pending = frames
  frames = []
  pending.forEach((callback) => callback(0))
}

/** jsdom 不做排版：按真实浏览器在给定视口下的测量结果改写 iframe 文档的尺寸 */
function layout(iframe: HTMLIFrameElement, sizes: { viewportWidth: number; viewportHeight: number; contentWidth: number; contentHeight: number; scrollbar: number }) {
  const frameDocument = iframe.contentDocument!
  const root = frameDocument.documentElement
  const content = frameDocument.getElementById('email-content')!
  const define = (target: object, values: Record<string, number>) => {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { configurable: true, get: () => value })
  }
  const horizontal = sizes.contentWidth > sizes.viewportWidth
  define(root, {
    scrollWidth: Math.max(sizes.contentWidth, sizes.viewportWidth),
    clientWidth: sizes.viewportWidth,
    clientHeight: sizes.viewportHeight - (horizontal ? sizes.scrollbar : 0),
  })
  define(frameDocument.defaultView!, { innerHeight: sizes.viewportHeight })
  define(content, { scrollHeight: sizes.contentHeight })
  define(frameDocument.body, { scrollHeight: sizes.contentHeight })
  content.getBoundingClientRect = () => ({ height: sizes.contentHeight }) as DOMRect
}

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

const WIDE_TEMPLATE = '<table style="min-width:600px"><tr><td>订单金额</td><td>¥ 1,280.00</td></tr></table>'

describe('EmailHtml', () => {
  it('写死最小宽度的模板在窄屏上可以横向滚动，不被裁掉', () => {
    const { container } = render(<EmailHtml html={WIDE_TEMPLATE} />)
    const iframe = container.querySelector('iframe')!
    // 不再禁止 iframe 滚动；文档允许横向滚动、纵向由外层撑开
    expect(iframe).not.toHaveAttribute('scrolling')
    const styles = iframe.contentDocument!.head.querySelector('style')!.textContent!
    expect(styles).toMatch(/html \{ overflow-x: auto; overflow-y: hidden; \}/)
    // 消毒保留模板的 min-width，表格按设计宽度排版、靠横向滚动查看右侧
    expect(iframe.contentDocument!.querySelector('table')!.style.minWidth).toBe('600px')
  })

  it('横向滚动条的高度计入测高，末行不被滚动条挡住', () => {
    const { container } = render(<EmailHtml html={WIDE_TEMPLATE} />)
    const iframe = container.querySelector('iframe')!
    layout(iframe, { viewportWidth: 375, viewportHeight: 150, contentWidth: 600, contentHeight: 400, scrollbar: 15 })
    flushFrames()
    expect(iframe.style.height).toBe('415px')
    expect(iframe.contentDocument!.documentElement.style.overflowY).toBe('hidden')
  })

  it('自适应模板（不超出视口宽度）按内容高度显示，不多留滚动条的位置', () => {
    const { container } = render(<EmailHtml html="<table style='width:100%'><tr><td>hi</td></tr></table>" />)
    const iframe = container.querySelector('iframe')!
    layout(iframe, { viewportWidth: 375, viewportHeight: 150, contentWidth: 375, contentHeight: 400, scrollbar: 15 })
    flushFrames()
    expect(iframe.style.height).toBe('400px')
  })

  it('超长正文封顶后改为在 iframe 内纵向滚动', () => {
    const { container } = render(<EmailHtml html="<p>long</p>" />)
    const iframe = container.querySelector('iframe')!
    layout(iframe, { viewportWidth: 375, viewportHeight: 150, contentWidth: 375, contentHeight: 80_000, scrollbar: 15 })
    flushFrames()
    expect(iframe.style.height).toBe('50000px')
    expect(iframe.contentDocument!.documentElement.style.overflowY).toBe('auto')
  })
})
