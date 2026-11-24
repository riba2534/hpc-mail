import createDOMPurify from 'dompurify'
import { cleanMailLink, isKnownTrackingImage, protectMailText } from '@hpc-mail/shared/mail-privacy'

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
  'class', 'cols', 'colspan', 'dir', 'disabled', 'for', 'height', 'hidden', 'href', 'id', 'lang',
  'label', 'max', 'maxlength', 'min', 'minlength', 'multiple', 'name', 'placeholder',
  'readonly', 'rel', 'required', 'role', 'rows', 'rowspan', 'scope', 'selected',
  'size', 'span', 'src', 'srcset', 'start', 'step', 'style', 'summary', 'target',
  'title', 'translate', 'type', 'valign', 'value', 'width', 'wrap',
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

/**
 * 简写里带 var() 时解析期无法展开，各长属性处于 pending-substitution 状态：CSSOM 只列出长属性，
 * 逐项读到的都是空串，来信里的 `padding: var(--p)` 就会整条丢失。只有声明过的简写本身还能读回原值，
 * 所以对下表里的简写整条写回。只收不会触发网络加载、展开后的长属性全部在 SAFE_CSS_PROPERTIES 里的
 * 盒模型类简写，经简写写入等价于逐个长属性写 var()，不新增能力。background、list-style 能带图片，
 * font 会引用字体且包含白名单外的长属性，都不收。border 还会把 border-image 重置为初始值，但无法经它赋值。
 */
const BOX_SIDES = ['top', 'right', 'bottom', 'left']
const LOGICAL_AXES = ['block', 'inline']
const LOGICAL_SIDES = ['start', 'end']
const BORDER_PARTS = ['width', 'style', 'color']
const VAR_SHORTHANDS: ReadonlyArray<readonly [string, readonly string[]]> = ([
  ['padding', BOX_SIDES.map((side) => `padding-${side}`)],
  ['padding-block', ['padding-block-start', 'padding-block-end']],
  ['padding-inline', ['padding-inline-start', 'padding-inline-end']],
  ['margin', BOX_SIDES.map((side) => `margin-${side}`)],
  ['margin-block', ['margin-block-start', 'margin-block-end']],
  ['margin-inline', ['margin-inline-start', 'margin-inline-end']],
  ['border', BOX_SIDES.flatMap((side) => BORDER_PARTS.map((part) => `border-${side}-${part}`))],
  ...BOX_SIDES.map((side) => [`border-${side}`, BORDER_PARTS.map((part) => `border-${side}-${part}`)] as const),
  ...BORDER_PARTS.map((part) => [`border-${part}`, BOX_SIDES.map((side) => `border-${side}-${part}`)] as const),
  ...LOGICAL_AXES.map((axis) => [`border-${axis}`,
    LOGICAL_SIDES.flatMap((side) => BORDER_PARTS.map((part) => `border-${axis}-${side}-${part}`))] as const),
  ...LOGICAL_AXES.flatMap((axis) => LOGICAL_SIDES.map((side) =>
    [`border-${axis}-${side}`, BORDER_PARTS.map((part) => `border-${axis}-${side}-${part}`)] as const)),
  ...LOGICAL_AXES.flatMap((axis) => BORDER_PARTS.map((part) =>
    [`border-${axis}-${part}`, LOGICAL_SIDES.map((side) => `border-${axis}-${side}-${part}`)] as const)),
  ['border-radius', ['border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius']],
  ['gap', ['row-gap', 'column-gap']],
  ['outline', ['outline-color', 'outline-style', 'outline-width']],
  ['overflow', ['overflow-x', 'overflow-y']],
] as const).filter(([, longhands]) => longhands.every((longhand) => SAFE_CSS_PROPERTIES.has(longhand)))

const UNSAFE_CSS_VALUE = /(?:\b(?:expression|javascript|vbscript|behavior)\b|@import|(?:url|image-set|cross-fade|paint)\s*\(|-moz-binding)/i
const HEIGHT_DEPENDENT_VALUE = /(?:^|[^a-z\d_-])[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:[dls]?v(?:h|b|min|max)|cq(?:h|b|min|max))\b/i
const SAFE_CUSTOM_PROPERTY = /^--[a-z_][a-z\d_-]{0,127}$/i
// 自定义属性和带 var() 的简写在解析期都不按属性语法校验，值是任意记号序列，额外限制长度。
const MAX_UNVALIDATED_VALUE_LENGTH = 4_096

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

// 长属性、自定义属性和找回的简写共用这一道检查，不留绕过路径。
function isAllowedCssValue(value: string, maxLength: number): boolean {
  if (value.length > maxLength) return false
  const inspectionValue = normalizeCssValueForInspection(value)
  return !UNSAFE_CSS_VALUE.test(inspectionValue) && !HEIGHT_DEPENDENT_VALUE.test(inspectionValue)
}

/**
 * 找回长属性所属的 var() 简写及其原值。简写的全部长属性都还处于 pending-substitution 时它才读得出原值；
 * 其中某个长属性被后续声明单独覆盖过时读出空串（浏览器与 jsdom 一致），这时宁可丢掉也不整条写回，
 * 以免盖掉那条后续声明。
 */
function declaredVarShorthand(style: CSSStyleDeclaration, longhand: string) {
  for (const [shorthand, longhands] of VAR_SHORTHANDS) {
    if (!longhands.includes(longhand)) continue
    const value = style.getPropertyValue(shorthand)
    if (value && longhands.every((part) => !style.getPropertyValue(part))) return { shorthand, longhands, value }
  }
  return undefined
}

function sanitizeStyleDeclaration(windowObject: Window, cssText: string | null | undefined): string {
  if (!cssText || cssText.length > 100_000) return ''
  const parser = windowObject.document.createElement('span')
  parser.style.cssText = cssText
  const safe = windowObject.document.createElement('span')
  // 已找回过简写的长属性：其余长属性不再重复查找，保证每个简写只写一次
  const coveredLonghands = new Set<string>()

  for (const property of Array.from(parser.style)) {
    const isCustomProperty = SAFE_CUSTOM_PROPERTY.test(property)
    // CSS 自定义属性区分大小写；保留原名，避免 var(--ButtonColor) 失配。
    let name = isCustomProperty ? property : property.toLowerCase()
    let value = parser.style.getPropertyValue(property)
    let maxLength = isCustomProperty ? MAX_UNVALIDATED_VALUE_LENGTH : Infinity
    if (!isCustomProperty && !SAFE_CSS_PROPERTIES.has(name)) continue
    if (!value && !isCustomProperty) {
      if (coveredLonghands.has(name)) continue
      const found = declaredVarShorthand(parser.style, name)
      if (!found) continue
      // 在简写第一个长属性的位置整条写回，与其他声明（如逻辑/物理属性）的先后顺序不变。
      found.longhands.forEach((longhand) => coveredLonghands.add(longhand))
      name = found.shorthand
      value = found.value
      maxLength = MAX_UNVALIDATED_VALUE_LENGTH
    }
    if (!isAllowedCssValue(value, maxLength)) continue
    safe.style.setProperty(name, value, parser.style.getPropertyPriority(name))
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

function isSafeImage(
  value: string | null,
  baseOrigin: string,
  trustedOrigins: ReadonlySet<string>,
  allowRemoteImages: boolean,
  pixel: boolean,
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
    if (parsed.username || parsed.password) return false
    if (parsed.origin === baseOrigin) return /^\/api\/attachments\/\d+$/.test(parsed.pathname)
    if (parsed.protocol !== 'https:' || pixel || isKnownTrackingImage(parsed.href)) return false
    return allowRemoteImages || trustedOrigins.has(parsed.origin)
  } catch {
    return false
  }
}

function sanitizeSourceSet(
  value: string | null,
  baseOrigin: string,
  trustedOrigins: ReadonlySet<string>,
  allowRemoteImages: boolean,
  pixel: boolean,
): string {
  const candidates = String(value || '').split(',').map((candidate) => candidate.trim()).filter(Boolean)
  if (!candidates.length) return ''
  const safeCandidates = candidates.filter((candidate) => {
    const [source = '', descriptor = '', ...extra] = candidate.split(/\s+/)
    return extra.length === 0 && isSafeImage(source, baseOrigin, trustedOrigins, allowRemoteImages, pixel)
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

function pixelDimension(value: string | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(value ?? '')
  return match ? Number(match[1]) : null
}

/**
 * 被拦截的图片换成同尺寸的占位框并显示 alt，版式不塌陷；1–2px 的跟踪像素直接移除。
 * 沿用图片已消毒的内联样式（如 display:block），尺寸只取纯数字的 width/height 属性。
 */
function replaceWithPlaceholder(windowObject: Window, image: HTMLImageElement): void {
  const width = pixelDimension(image.getAttribute('width'))
  const height = pixelDimension(image.getAttribute('height'))
  if ((width !== null && width <= 2) || (height !== null && height <= 2)) {
    image.remove()
    return
  }
  const placeholder = windowObject.document.createElement('span')
  const style = image.getAttribute('style')
  if (style) placeholder.setAttribute('style', style)
  if (width !== null) placeholder.style.width = `${width}px`
  if (height !== null) placeholder.style.height = `${height}px`
  placeholder.className = 'remote-image-blocked'
  placeholder.setAttribute('role', 'img')
  const alt = (image.getAttribute('alt') ?? '').trim()
  placeholder.setAttribute('aria-label', alt || '已拦截的图片')
  placeholder.textContent = alt
  image.replaceWith(placeholder)
}

/**
 * Sanitizes hostile email markup for an isolated rendering surface.
 * The default retains embedded images and blocks ordinary remote images.
 * Known tracking images stay blocked when the reader allows remote content.
 */
export function sanitizeEmailHtml(html: string, options: SanitizeEmailHtmlOptions = {}): string {
  const windowObject = options.window || globalThis.window
  if (!windowObject?.document) throw new TypeError('A DOM window is required to sanitize email HTML')
  const baseOrigin = options.baseOrigin || windowObject.location?.origin || 'https://localhost'
  const allowRemoteImages = options.allowRemoteImages === true
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
    const original = link.getAttribute('href')?.trim() ?? ''
    if (original.startsWith('#')) {
      link.removeAttribute('target')
      link.removeAttribute('rel')
      return
    }
    // Permit only absolute URLs and local fragment links in an email body.
    const href = /^[a-z][a-z\d+.-]*:/i.test(original) ? cleanMailLink(original) : null
    if (href) {
      link.setAttribute('href', href)
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    } else {
      link.removeAttribute('href')
      link.removeAttribute('target')
      link.removeAttribute('rel')
    }
    if (link.textContent?.trim() === original && href !== original) link.textContent = protectMailText(original)
  })

  template.content.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const dimensions = [image.getAttribute('width'), image.getAttribute('height'),
      image.style.width, image.style.height, image.style.maxWidth, image.style.maxHeight]
    const pixel = dimensions.some((value) => {
      const size = pixelDimension(value)
      return size !== null && size <= 2
    })
    const concealed = image.hasAttribute('hidden') || image.style.display === 'none' || image.style.visibility === 'hidden'
      || (image.style.opacity !== '' && Number(image.style.opacity) === 0)
    const tracking = pixel || concealed
    const sourceAllowed = isSafeImage(image.getAttribute('src'), baseOrigin, trustedOrigins, allowRemoteImages, tracking)
    const sourceSet = sanitizeSourceSet(
      image.getAttribute('srcset'),
      baseOrigin,
      trustedOrigins,
      allowRemoteImages,
      tracking,
    )
    if (!sourceAllowed && !sourceSet) {
      replaceWithPlaceholder(windowObject, image)
      return
    }
    if (!sourceAllowed) image.removeAttribute('src')
    if (sourceSet) image.setAttribute('srcset', sourceSet)
    else image.removeAttribute('srcset')
    image.setAttribute('loading', 'lazy')
    image.setAttribute('decoding', 'async')
    image.setAttribute('referrerpolicy', 'no-referrer')
  })

  return template.innerHTML
}
