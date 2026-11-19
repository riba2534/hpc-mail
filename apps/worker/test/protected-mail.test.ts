import { describe, expect, it } from 'vitest';
import { protectMailBody } from '../src/services/protected-mail.js';

describe('protected forwarding body', () => {
  it('keeps direct login links and matching CID but strips remote requests from both MIME variants', async () => {
    const clickable = 'https://alerts.example/ls/click?upn=example';
    const direct = 'https://login.example/magic-link#token=value';
    const result = await protectMailBody({
      text: 'Login (' + clickable + '), backup ' + direct,
      html: '<style>p{background:url(https://tracker.example/background)}</style>'
        + '<table background="https://tracker.example/legacy"><tr><td>'
        + '<img src="https://tracker.example/wf/open" width="1" height="1">'
        + '<img src="cid:logo@example" srcset="https://tracker.example/resize 2x">'
        + '<img src="cid:other@example">'
        + '<a href="' + clickable + '" ping="https://tracker.example/ping">' + clickable + '</a>'
        + '<a href="' + direct + '">Direct sign in</a>'
        + '</td></tr></table>',
      inlineContentIds: ['logo@example'],
    });
    expect(result.text).toBe('Login (（追踪链接已移除，请在 HPC Mail 查看原信）), backup ' + direct);
    expect(result.html).toContain('src="cid:logo@example"');
    expect(result.html).toContain('href="' + direct + '"');
    expect(result.html).toContain('<table>');
    for (const value of ['tracker.example', 'alerts.example', 'srcset', 'background=', '<style', 'cid:other', ' ping=']) {
      expect(result.html).not.toContain(value);
    }
  });

  it('works for HTML-only messages and ignores conditional comments and embedded documents', async () => {
    const result = await protectMailBody({
      text: '', html: '<!--[if mso]><img src="https://example.com/p"><![endif]-->'
        + '<svg><image href="https://example.com/x"></image></svg>'
        + '<iframe src="https://example.com/f"></iframe><p>Verification code <b>182903</b></p>',
    });
    expect(result.text).toBe('Verification code 182903');
    expect(result.html).toBe('<p>Verification code <b>182903</b></p>');
  });
});
