/**
 * 常见的二级公共后缀（不引入完整 PSL，覆盖主流国家/地区注册域）。
 * 只用于「链接域名与发件人是否同源」的提示，判断错误的代价是多一条或少一条提醒。
 */
const MULTI_LEVEL_SUFFIXES = new Set([
  'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.mo',
  'ac.jp', 'co.jp', 'ne.jp', 'or.jp', 'ac.kr', 'co.kr', 'or.kr',
  'ac.uk', 'co.uk', 'gov.uk', 'me.uk', 'org.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'com.sg', 'com.my', 'co.in', 'co.id', 'com.ph', 'co.th', 'com.vn',
  'com.br', 'com.mx', 'com.ar', 'co.za', 'com.tr', 'com.ru',
]);

/** 主机名 → 可注册域（example.co.uk、github.com）；IP 原样返回 */
export function registrableDomain(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.includes(':')) return normalized;
  const labels = normalized.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  return labels.slice(MULTI_LEVEL_SUFFIXES.has(suffix) ? -3 : -2).join('.');
}

export interface VerificationLinkInfo {
  href: string;
  hostname: string;
  /** 链接的可注册域与发件人域名不同：可能是钓鱼，也可能是第三方发信服务 */
  mismatch: boolean;
}

/** 解析验证链接（仅 http/https），并与发件地址的域名比对 */
export function inspectVerificationLink(link: string | undefined, fromAddress: string): VerificationLinkInfo | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const senderDomain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
  const mismatch = !fromAddress.includes('@') || registrableDomain(url.hostname) !== registrableDomain(senderDomain);
  return { href: url.href, hostname: url.hostname, mismatch };
}
