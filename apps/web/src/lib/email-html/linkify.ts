export type TextSegment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string }

export type TextBlock = { type: 'text'; text: string } | { type: 'quote'; lines: string[] }

/** 只识别 http/https/mailto；URL 字符限定为 ASCII，避免把紧跟的中文吞进链接 */
const LINK_PATTERN = /\b(?:https?:\/\/|mailto:)[\w\-.~:/?#[\]@!$&'()*+,;=%]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 去掉句末标点，以及没有配对左括号的右括号（如「（见 https://a.com/x)」） */
function trimLink(raw: string): string {
  let link = raw
  for (;;) {
    const trimmed = link.replace(TRAILING_PUNCTUATION, '')
    if (trimmed.endsWith(')') && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)) {
      link = trimmed.slice(0, -1)
      continue
    }
    if (trimmed === link) return link
    link = trimmed
  }
}

function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate)
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
    if (url.protocol === 'mailto:' ? url.pathname.length === 0 : !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

/** 纯文本 → 文本/链接片段。只产出数据，由调用方渲染为 React 元素，不拼 HTML。 */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0
    const raw = trimLink(match[0])
    const href = safeHref(raw)
    if (!href) continue
    if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) })
    segments.push({ type: 'link', text: raw, href })
    cursor = start + raw.length
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })
  return segments
}

const QUOTE_LINE = /^[ \t]*>/

/** 把连续以「>」开头的行归为引用块（去掉一层「> 」前缀），其余保持原文 */
export function splitQuoteBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  let plain: string[] = []
  let quote: string[] = []
  const flushPlain = () => {
    if (plain.length) blocks.push({ type: 'text', text: plain.join('\n') })
    plain = []
  }
  const flushQuote = () => {
    if (quote.length) blocks.push({ type: 'quote', lines: quote })
    quote = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (QUOTE_LINE.test(line)) {
      flushPlain()
      quote.push(line.replace(/^[ \t]*> ?/, ''))
    } else {
      flushQuote()
      plain.push(line)
    }
  }
  flushPlain()
  flushQuote()
  return blocks
}
