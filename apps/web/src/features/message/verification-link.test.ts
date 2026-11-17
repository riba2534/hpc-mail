import { describe, expect, it } from 'vitest';
import { inspectVerificationLink } from './verification-link';

describe('inspectVerificationLink', () => {
  it('parses http/https links, whatever the sender domain', () => {
    expect(inspectVerificationLink('https://github.com/login/verify?code=1')).toEqual({
      href: 'https://github.com/login/verify?code=1',
      hostname: 'github.com',
    });
    expect(inspectVerificationLink('http://links.mailer.example/v?t=1')?.hostname).toBe('links.mailer.example');
  });

  it('rejects empty, malformed and non-http links', () => {
    expect(inspectVerificationLink('javascript:alert(1)')).toBeNull();
    expect(inspectVerificationLink('not a url')).toBeNull();
    expect(inspectVerificationLink('')).toBeNull();
    expect(inspectVerificationLink(undefined)).toBeNull();
  });
});
