import { describe, expect, it } from 'vitest';
import { inspectVerificationLink, registrableDomain } from './verification-link';

describe('registrableDomain', () => {
  it('keeps the last two labels, or three under a known second-level suffix', () => {
    expect(registrableDomain('accounts.google.com')).toBe('google.com');
    expect(registrableDomain('login.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('www.taobao.com.cn')).toBe('taobao.com.cn');
    expect(registrableDomain('192.168.1.10')).toBe('192.168.1.10');
  });
});

describe('inspectVerificationLink', () => {
  it('matches subdomains of the sender domain', () => {
    expect(inspectVerificationLink('https://github.com/login/verify?code=1', 'noreply@github.com')).toEqual({
      href: 'https://github.com/login/verify?code=1',
      hostname: 'github.com',
      mismatch: false,
    });
    expect(inspectVerificationLink('https://id.example.com/v', 'no-reply@mail.example.com')?.mismatch).toBe(false);
  });

  it('flags a different registrable domain and rejects non-http links', () => {
    expect(inspectVerificationLink('https://examp1e-login.com/v', 'security@example.com')?.mismatch).toBe(true);
    expect(inspectVerificationLink('javascript:alert(1)', 'a@example.com')).toBeNull();
    expect(inspectVerificationLink('', 'a@example.com')).toBeNull();
  });
});
