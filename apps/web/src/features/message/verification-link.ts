import { cleanMailLink, isKnownTrackingImage, isKnownTrackingLink } from '@hpc-mail/shared';

export interface VerificationLinkInfo {
  href: string;
  hostname: string;
}

function httpLink(value: string): VerificationLinkInfo | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return { href: url.href, hostname: url.hostname };
}

/** 链接域名与发件人不同是常态。只在可直达或可离线解出安全目标时提供点击入口。 */
export function inspectVerificationLink(link: string | undefined): VerificationLinkInfo | null {
  const direct = link && cleanMailLink(link);
  return direct ? httpLink(direct) : null;
}

/** 仅供详情页提示后复制，列表与正文都不渲染这些 URL。 */
export function inspectOpaqueVerificationLink(link: string | undefined): VerificationLinkInfo | null {
  if (!link || !isKnownTrackingLink(link) || isKnownTrackingImage(link) || cleanMailLink(link)) return null;
  return httpLink(link.trim());
}
