import { cleanMailLink, isKnownTrackingLink } from '@hpc-mail/shared/mail-privacy'

const BLOCK_SELECTOR = 'p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table'

/** A template stays inert while extracting visible text from untrusted email. */
export function htmlToPlainText(html: string, includeLinks = false): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const body = template.content
  body.querySelectorAll('script, style, template, noscript, title, textarea').forEach((node) => node.remove())
  if (includeLinks) {
    body.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') ?? ''
      const direct = cleanMailLink(href)
      if (direct && direct !== link.textContent?.trim()) link.append(` (${direct})`)
      if (!direct && isKnownTrackingLink(href)) link.append('（追踪链接已移除，请在 HPC Mail 查看原信）')
    })
  }
  body.querySelectorAll('br').forEach((node) => node.replaceWith('\n'))
  body.querySelectorAll(BLOCK_SELECTOR).forEach((node) => node.append('\n'))
  return (body.textContent ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
