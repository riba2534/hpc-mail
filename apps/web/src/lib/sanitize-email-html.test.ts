import { describe, expect, it } from 'vitest'
import { sanitizeEmailHtml } from './sanitize-email-html'

/** 复刻 email-html.tsx 的用法：消毒结果被 innerHTML 二次解析 */
function reparse(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = sanitizeEmailHtml(html)
  return host
}

describe('sanitizeEmailHtml：<style> 提前闭合绕过', () => {
  // HTML 解析器把 </style/> 和 </style foo> 也当结束标签，而 extractStyleBlocks 的
  // 正则只认 </style\s*>，两边对「CSS 文本到哪结束」的认定不一致即可夹带活元素
  const payloads: Record<string, string> = {
    'font-family 值': `<style>p{font-family:"</style/><img src=q onerror=alert(1)>"}</style>`,
    '属性选择器': `<style>a[href="</style/><img src=q onerror=alert(1)>"]{color:red}</style>`,
    'grid-template-areas': `<style>p{grid-template-areas:"</style/><img src=q onerror=alert(1)>"}</style>`,
    '带属性的结束标签': `<style>p{font-family:"</style foo><img src=q onerror=alert(1)>"}</style>`,
    '大小写混写': `<style>p{font-family:"</StYlE/><img src=q onerror=alert(1)>"}</style>`,
  }

  // 注意：DOMPurify 解析原始 HTML 时同样会在 </style/> 处闭合，因而必然留下一个
  // **已被清洗**的 img（src 被剥、无事件处理器）。那个是无害的，这里断言的是
  // 「不存在带事件处理器或活 src 的元素」，而不是「一个 img 都没有」。
  for (const [name, payload] of Object.entries(payloads)) {
    it(`${name} 不产生活元素`, () => {
      const host = reparse(payload)
      expect(host.innerHTML).not.toContain('onerror')
      for (const img of host.querySelectorAll('img')) {
        expect(img.getAttribute('src')).toBeNull()
      }
    })
  }

  it('消毒输出里不残留 </style 终止符', () => {
    for (const payload of Object.values(payloads)) {
      expect(sanitizeEmailHtml(payload).toLowerCase()).not.toContain('</style/')
    }
  })
})

describe('sanitizeEmailHtml：正常内容不被误伤', () => {
  it('保留白名单 CSS 与安全链接', () => {
    const host = reparse(
      `<style>p{color:red;font-size:14px}</style><p style="color:blue">正文</p><a href="https://example.com">链接</a>`,
    )
    expect(host.textContent).toContain('正文')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(host.querySelector('style')?.textContent).toContain('color: red')
  })

  it('照常拦截脚本与事件处理器', () => {
    const host = reparse(`<p onclick="alert(1)">x</p><script>alert(2)</script><img src="javascript:alert(3)">`)
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('p')?.getAttribute('onclick')).toBeNull()
    expect(host.querySelector('img')?.getAttribute('src')).toBeNull()
  })

  it('二次解析后仍拦截嵌套表单与命名空间 mXSS 载荷', () => {
    const host = reparse(`
      <form id="outer"><math><mtext></form><form><mglyph><style></math>
      <img src="x" onerror="globalThis.pwned=true">
      <noscript><iframe srcdoc="<script>globalThis.pwned=true</script>"></iframe></noscript>
    `)

    expect(host.querySelector('form, math, svg, script, iframe, noscript')).toBeNull()
    expect(host.innerHTML).not.toMatch(/onerror|srcdoc|globalThis\.pwned/i)
    for (const element of host.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.toLowerCase().startsWith('on')).toBe(false)
      }
    }
  })
})
