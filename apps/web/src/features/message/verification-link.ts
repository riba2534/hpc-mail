export interface VerificationLinkInfo {
  href: string;
  hostname: string;
}

/** 解析验证链接，只接受 http/https；链接域名与发件人不同是常态（第三方发信、跳转服务），不据此提示 */
export function inspectVerificationLink(link: string | undefined): VerificationLinkInfo | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return { href: url.href, hostname: url.hostname };
}
