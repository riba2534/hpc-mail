import { describe, expect, it } from 'vitest';
import { cleanMailLink, isKnownTrackingImage, protectMailText } from '../src/mail-privacy.js';

describe('mail privacy URLs', () => {
  it('blocks common opaque tracking and keeps exact direct authentication links', () => {
    const login = 'https://login.example/magic-link#code=example&state=hello%20there';
    expect(cleanMailLink(login)).toBe(login);
    expect(cleanMailLink('https://alerts.example/ls/click?upn=example')).toBeNull();
    expect(cleanMailLink('https://links.email.claude.com/s/c/example')).toBeNull();
    expect(protectMailText('//links.email.claude.com/s/c/example, links.email.claude.com./s/c/example')).not.toContain('example');
    expect(isKnownTrackingImage('https://mail.example/wf/open?upn=example')).toBe(true);
    expect(isKnownTrackingImage('https://provider.intercom-mail.com/via/o?h=example')).toBe(true);
    expect(cleanMailLink('https://login.example@other.example/a')).toBeNull();
  });

  it('extracts an explicit HTTPS redirect target without making a request', () => {
    const target = 'https://pay.stripe.com/invoice/example?s=em';
    const wrapped = 'https://58.email.stripe.com/CL0/' + encodeURIComponent(target) + '/opaque';
    expect(cleanMailLink(wrapped)).toBe(target);
    expect(protectMailText('(' + wrapped + ').')).toBe('(' + target + ').');
  });
});
