import createDOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
  'button', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'h1',
  'form', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input',
  'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'ol', 'optgroup',
  'option', 'p', 'pre', 'q', 's', 'samp', 'section', 'select', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot',
  'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr',
]

const ALLOWED_ATTR = [
  'abbr', 'align', 'alt', 'aria-label', 'aria-labelledby', 'bgcolor', 'checked',
  'class', 'cols', 'colspan', 'dir', 'disabled', 'for', 'height', 'href', 'id', 'lang',
  'label', 'max', 'maxlength', 'min', 'minlength', 'multiple', 'name', 'placeholder',
  'readonly', 'rel', 'required', 'role', 'rows', 'rowspan', 'scope', 'selected',
  'size', 'span', 'src', 'srcset', 'start', 'step', 'style', 'summary', 'target',
  'title', 'type', 'valign', 'value', 'width', 'wrap',
]

const FORBIDDEN_TAGS = [
  'applet', 'audio', 'base', 'canvas', 'embed', 'frame', 'frameset', 'iframe',
  'link', 'math', 'meta', 'noscript', 'object', 'script', 'source', 'style',
  'svg', 'template', 'video',
]

const MAX_INLINE_IMAGE_LENGTH = 2_000_000

// Email markup needs layout CSS, but never network-loading or app-overlay capabilities.
const SAFE_CSS_PROPERTIES = new Set([
  'align-content', 'align-items', 'align-self', 'background', 'background-color',
  'border', 'border-block', 'border-block-color', 'border-block-end',
  'border-block-end-color', 'border-block-end-style', 'border-block-end-width',
  'border-block-start', 'border-block-start-color', 'border-block-start-style',
  'border-block-start-width', 'border-bottom', 'border-bottom-color',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'border-bottom-style',
  'border-bottom-width', 'border-collapse', 'border-color', 'border-inline',
  'border-inline-color', 'border-inline-end', 'border-inline-end-color',
  'border-inline-end-style', 'border-inline-end-width', 'border-inline-start',
  'border-inline-start-color', 'border-inline-start-style', 'border-inline-start-width',
  'border-left', 'border-left-color', 'border-left-style', 'border-left-width',
  'border-radius', 'border-right', 'border-right-color', 'border-right-style',
  'border-right-width', 'border-spacing', 'border-style', 'border-top',
  'border-top-color', 'border-top-left-radius', 'border-top-right-radius',
  'border-top-style', 'border-top-width', 'border-width', 'box-sizing',
  'caption-side', 'clear', 'color', 'column-gap', 'direction', 'display',
  'empty-cells', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'float', 'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-size', 'font-stretch', 'font-style', 'font-variant',
  'font-variant-caps', 'font-weight', 'gap', 'grid', 'grid-area', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end',
  'grid-column-gap', 'grid-column-start', 'grid-gap', 'grid-row', 'grid-row-end',
  'grid-row-gap', 'grid-row-start', 'grid-template', 'grid-template-areas',
  'grid-template-columns', 'grid-template-rows', 'height', 'hyphens',
  'justify-content', 'justify-items', 'justify-self', 'letter-spacing',
  'line-height', 'list-style', 'list-style-position', 'list-style-type',
  'margin', 'margin-block', 'margin-block-end', 'margin-block-start',
  'margin-bottom', 'margin-inline', 'margin-inline-end', 'margin-inline-start',
  'margin-left', 'margin-right', 'margin-top', 'max-height', 'max-width',
  'min-height', 'min-width', 'object-fit', 'object-position', 'opacity', 'order',
  'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width',
  'overflow', 'overflow-wrap', 'overflow-x', 'overflow-y', 'padding',
  'padding-block', 'padding-block-end', 'padding-block-start', 'padding-bottom',
  'padding-inline', 'padding-inline-end', 'padding-inline-start', 'padding-left',
  'padding-right', 'padding-top', 'row-gap', 'table-layout', 'text-align',
  'text-align-last', 'text-decoration', 'text-decoration-color',
  'text-decoration-line', 'text-decoration-style', 'text-indent', 'text-overflow',
  'text-shadow', 'text-transform', 'unicode-bidi', 'vertical-align', 'visibility',
  'white-space', 'width', 'word-break', 'word-spacing', 'word-wrap',
])

const UNSAFE_CSS_VALUE = /(?:\b(?:expression|javascript|vbscript|behavior)\b|@import|(?:url|image-set|cross-fade|paint)\s*\(|-moz-binding)/i
const HEIGHT_DEPENDENT_VALUE = /(?:^|[^a-z\d_-])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:[dls]?v(?:h|b|min|max)|cq(?:h|b|min|max))\b/i
const SAFE_CUSTOM_PROPERTY = /^--[a-z_][a-z\d_-]{0,127}$/i
const MAX_CUSTOM_PROPERTY_VALUE_LENGTH = 4_096

export interface SanitizeEmailHtmlOptions {
  window?: Window
  baseOrigin?: string
  trustedImageOrigins?: readonly string[]
  allowRemoteImages?: boolean
}

function decodeCssEscapes(value: string): string {
  return value
    .replace(/\\(?:\r\n|[\n\r\f])/g, '')
    .replace(/\\([\da-f]{1,6})(?:\r\n|[ \t\n\r\f])?|\\(.)/gi, (_, hex: string | undefined, character: string | undefined) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16)
        return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ''
      }
      return character || ''
    })
}

function normalizeCssValueForInspection(value: string): string {
  return decodeCssEscapes(value).replace(/\/\*[\s\S]*?\*\//g, '')
}

function isSafeCssValue(value: string): boolean {
  return !UNSAFE_CSS_VALUE.test(normalizeCssValueForInspection(value))
}

function sanitizeStyleDeclaration(windowObject: Window, cssText: string | null | undefined): string {
  if (!cssText || cssText.length > 100_000) return ''
  const parser = windowObject.document.createElement('span')
  parser.style.cssText = cssText
  const safe = windowObject.document.createElement('span')

  for (const property of Array.from(parser.style)) {
    const normalizedProperty = property.toLowerCase()
    const value = parser.style.getPropertyValue(property)
    const isCustomProperty = SAFE_CUSTOM_PROPERTY.test(property)
    if (!isCustomProperty && !SAFE_CSS_PROPERTIES.has(normalizedProperty)) continue
    if (!isSafeCssValue(value)) continue
    if (isCustomProperty && value.length > MAX_CUSTOM_PROPERTY_VALUE_LENGTH) continue
    const inspectionValue = normalizeCssValueForInspection(value)
    if (HEIGHT_DEPENDENT_VALUE.test(inspectionValue)) continue
    // CSS 自定义属性区分大小写；保留原名，避免 var(--ButtonColor) 失配。
    safe.style.setProperty(isCustomProperty ? property : normalizedProperty, value, parser.style.getPropertyPriority(property))
  }
  return safe.style.cssText
}

/**
 * `<style>` 是 raw-text 元素，序列化时**不转义**内容——CSS 文本里只要出现 `</style`，
 * HTML 解析器就会在那里提前闭合 style 块，其后的标记变成未经 DOMPurify 处理的活元素。
 * 而 extractStyleBlocks 的正则要求 `</style\s*>`，认不出 `</style/>`、`</style foo>`
 * 这些解析器同样接受的变体，于是载荷能以「合法 CSS 值」的身份活过消毒。
 * 消毒结果最终会序列化回字符串再被 innerHTML 二次解析，所以带终止符的规则整条丢弃。
 */
function hasStyleTerminator(css: string): boolean {
  return /<\/style/i.test(css)
}

function sanitizeCssRules(windowObject: Window, rules: CSSRuleList | undefined, depth = 0): string {
  if (!rules || depth > 4) return ''
  const output: string[] = []

  for (const rule of Array.from(rules).slice(0, 2_000)) {
    if (rule.type === 1) {
      const styleRule = rule as CSSStyleRule
      const selector = String(styleRule.selectorText || '')
      if (!selector || /:host|::slotted|@|[\u0000-\u001f\u007f]/i.test(selector)) continue
      const declarations = sanitizeStyleDeclaration(windowObject, styleRule.style?.cssText)
      if (!declarations) continue
      const rendered = `${selector}{${declarations}}`
      if (!hasStyleTerminator(rendered)) output.push(rendered)
      continue
    }
    if (rule.type === 4) {
      const mediaRule = rule as CSSMediaRule
      const mediaQuery = String(mediaRule.conditionText || '')
      if (mediaQuery.length <= 500
        && !/\b(?:min-|max-)?height\b/i.test(mediaQuery)
        && /^[a-z\d\s():.,/%<>=_-]+$/i.test(mediaQuery)) {
        const nested = sanitizeCssRules(windowObject, mediaRule.cssRules, depth + 1)
        if (nested) output.push(`@media ${mediaQuery}{${nested}}`)
      }
    }
  }
  return output.join('')
}

function sanitizeStylesheet(windowObject: Window, cssText: string): string {
  if (!cssText || cssText.length > 250_000) return ''
  try {
    const CssStyleSheet = (windowObject as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet
    const constructedSheet = new CssStyleSheet()
    constructedSheet.replaceSync(cssText)
    return sanitizeCssRules(windowObject, constructedSheet.cssRules)
  } catch {
    // Fall through for browsers without constructable stylesheets.
  }

  const detachedDocument = windowObject.document.implementation.createHTMLDocument('email-style')
  let style = detachedDocument.createElement('style')
  style.textContent = cssText
  detachedDocument.head.append(style)
  if (!style.sheet && /jsdom/i.test(windowObject.navigator?.userAgent || '')) {
    style = windowObject.document.createElement('style')
    style.media = 'not all'
    style.textContent = cssText
    windowObject.document.head.append(style)
  }
  try {
    return sanitizeCssRules(windowObject, style.sheet?.cssRules)
  } catch {
    return ''
  } finally {
    style.remove()
  }
}

function extractStyleBlocks(html: string): string[] {
  const styles: string[] = []
  const pattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
  let match: RegExpExecArray | null
  while (styles.length < 100 && (match = pattern.exec(html))) styles.push(match[1] ?? '')
  return styles
}

function isSafeLink(value: string | null, baseOrigin: string): boolean {
  const source = String(value || '').trim()
  if (!source) return false
  if (source.startsWith('#')) return true
  if (!/^[a-z][a-z\d+.-]*:/i.test(source)) return false
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(source, baseOrigin).protocol)
  } catch {
    return false
  }
}

function isSafeImage(
  value: string | null,
  baseOrigin: string,
  trustedOrigins: ReadonlySet<string>,
  allowRemoteImages: boolean,
): boolean {
  const source = String(value || '').trim()
  if (!source) return false
  if (/^cid:/i.test(source)) return true
  if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(source)) {
    return source.length <= MAX_INLINE_IMAGE_LENGTH
  }
  if (!/^(?:https:|\/)/i.test(source)) return false
  try {
    const parsed = new URL(source, baseOrigin)
    if (parsed.protocol !== 'https:') return false
    if (allowRemoteImages) return true
    if (parsed.origin === baseOrigin) return parsed.pathname.startsWith('/api/attachments/')
    return trustedOrigins.has(parsed.origin)
  } catch {
    return false
  }
}

function sanitizeSourceSet(
  value: string | null,
  baseOrigin: string,
  trustedOrigins: ReadonlySet<string>,
  allowRemoteImages: boolean,
): string {
  const candidates = String(value || '').split(',').map((candidate) => candidate.trim()).filter(Boolean)
  if (!candidates.length) return ''
  const safeCandidates = candidates.filter((candidate) => {
    const [source = '', descriptor = ''] = candidate.split(/\s+/, 2)
    return isSafeImage(source, baseOrigin, trustedOrigins, allowRemoteImages)
      && (!descriptor || /^(?:\d+(?:\.\d+)?x|\d+w)$/i.test(descriptor))
  })
  return safeCandidates.length === candidates.length ? safeCandidates.join(', ') : ''
}

/**
 * 邮件里的表单常被当作布局容器，直接删除会连同按钮布局一起破坏。参考 Roundcube：
 * 先由 DOMPurify 清掉 action/事件等危险属性，再把 form 降级成保留 class/style/子节点的 div。
 * 这里显式调用原型方法，避免敌对 name/id 触发 DOM clobbering。
 */
function neutralizeForms(windowObject: Window, root: ParentNode): void {
  const elementPrototype = (windowObject as Window & typeof globalThis).Element.prototype
  const nodePrototype = (windowObject as Window & typeof globalThis).Node.prototype
  root.querySelectorAll<HTMLFormElement>('form').forEach((form) => {
    const replacement = windowObject.document.createElement('div')
    for (const name of elementPrototype.getAttributeNames.call(form)) {
      const value = elementPrototype.getAttribute.call(form, name)
      if (value !== null) replacement.setAttribute(name, value)
    }
    replacement.classList.add('email-form')
    const childNodesGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'childNodes')?.get
    const childNodes = childNodesGetter?.call(form) as NodeListOf<ChildNode> | undefined
    replacement.replaceChildren(...Array.from(childNodes || []))
    elementPrototype.replaceWith.call(form, replacement)
  })
}

/**
 * Sanitizes hostile email markup for an isolated rendering surface.
 * HTTPS images render by default without a referrer; callers may disable
 * third-party images while retaining CID, data, blob and trusted-origin media.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeEmailHtmlOptions = {}): string {
  const windowObject = options.window || globalThis.window
  if (!windowObject?.document) throw new TypeError('A DOM window is required to sanitize email HTML')
  const baseOrigin = options.baseOrigin || windowObject.location?.origin || 'https://localhost'
  const allowRemoteImages = options.allowRemoteImages !== false
  const trustedOrigins = new Set((options.trustedImageOrigins || []).map((value) => {
    try { return new URL(value, baseOrigin).origin } catch { return '' }
  }).filter(Boolean))
  const sourceHtml = String(html || '')
  const safeStyles = extractStyleBlocks(sourceHtml)
    .map((cssText) => sanitizeStylesheet(windowObject, cssText))
    .filter(Boolean)
  const purifier = createDOMPurify(windowObject as unknown as Parameters<typeof createDOMPurify>[0])
  const clean = purifier.sanitize(sourceHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['action', 'autofocus', 'form', 'formaction', 'formenctype',
      'formmethod', 'formnovalidate', 'formtarget', 'method', 'xlink:href'],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  })

  const template = windowObject.document.createElement('template')
  template.innerHTML = String(clean)
  neutralizeForms(windowObject, template.content)
  if (safeStyles.length) {
    const style = windowObject.document.createElement('style')
    // 二次兜底：任何带 `</style` 的内容都不允许进入 raw-text 元素
    style.textContent = safeStyles.filter((css) => !hasStyleTerminator(css)).join('\n')
    template.content.prepend(style)
  }

  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const safeStyle = sanitizeStyleDeclaration(windowObject, element.getAttribute('style'))
    if (safeStyle) element.setAttribute('style', safeStyle)
    else element.removeAttribute('style')
  })

  // image 类型 input 会绕过 img 的远程资源策略；保留其 CTA 外观/文案但不主动加载资源。
  template.content.querySelectorAll<HTMLInputElement>('input[type="image"]').forEach((input) => {
    input.removeAttribute('src')
    input.type = 'button'
    if (!input.value && input.alt) input.value = input.alt
  })

  // 文件选择器在邮件正文中没有合法提交路径，禁用以免制造无效或钓鱼式交互。
  template.content.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
    input.disabled = true
  })

  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    if (!isSafeLink(link.getAttribute('href'), baseOrigin)) {
      link.removeAttribute('href')
      link.removeAttribute('target')
      return
    }
    if (!String(link.getAttribute('href') || '').startsWith('#')) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    } else {
      link.removeAttribute('target')
      link.removeAttribute('rel')
    }
  })

  template.content.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    if (!isSafeImage(image.getAttribute('src'), baseOrigin, trustedOrigins, allowRemoteImages)) {
      image.removeAttribute('src')
      image.classList.add('remote-image-blocked')
    }
    const sourceSet = sanitizeSourceSet(
      image.getAttribute('srcset'),
      baseOrigin,
      trustedOrigins,
      allowRemoteImages,
    )
    if (sourceSet) image.setAttribute('srcset', sourceSet)
    else image.removeAttribute('srcset')
    image.setAttribute('loading', 'lazy')
    image.setAttribute('decoding', 'async')
    image.setAttribute('referrerpolicy', 'no-referrer')
  })

  return template.innerHTML
}
