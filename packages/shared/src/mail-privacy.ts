const TRACKING_LINK_PLACEHOLDER = '（追踪链接已移除，请在 HPC Mail 查看原信）';

function mailUrl(value: string): URL | null {
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function isKnownTrackingImage(value: string): boolean {
  const url = mailUrl(value.trim());
  if (!url) return false;
  const path = url.pathname.toLowerCase();
  if (/(?:^|\/)(?:wf\/open|open-pixel|tracking-pixel)(?:\/|$)/.test(path)) return true;
  return (url.hostname.endsWith('.intercom-mail.com') || url.hostname === 'clicks.e.link.com')
    && (path === '/via/o' || path.startsWith('/q/'));
}

function recognizedClick(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return /(?:^|\/)ls\/click(?:\/|$)/.test(path)
    || ((host === 'links.email.claude.com' || host === 'ilinks.anthropic.com'
      || /(?:^|\.)iterable\.com$/.test(host)) && /^\/(?:s\/[cu]|a\/sc)(?:\/|$)/.test(path))
    || /(?:^|\.)(?:intercom-clicks\.com|awstrack\.me)$/.test(host)
    || (/(?:^|\.)email\.stripe\.com$/.test(host) && /^\/cl[01]\//.test(path))
    || host === 'clicks.e.link.com';
}

export function isKnownTrackingLink(value: string): boolean {
  const url = mailUrl(value.trim());
  return url !== null && (recognizedClick(url) || isKnownTrackingImage(value));
}

/** Resolve only wrapper formats whose destination is explicitly present in the received URL. */
function explicitDestination(url: URL): string | null {
  if (!/(?:^|\.)(?:awstrack\.me|email\.stripe\.com)$/.test(url.hostname)) return null;
  const match = /^\/CL[01]\/([^/]+)(?:\/|$)/i.exec(url.pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]!);
    return /^https:\/\//i.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** This runs offline. Direct links retain their original encodings and authentication tokens. */
export function cleanMailLink(value: string): string | null {
  const source = value.trim();
  const url = mailUrl(source);
  if (!url || !['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
  if (isKnownTrackingImage(source)) return null;
  if (!recognizedClick(url)) return source.startsWith('//') ? url.href : source;
  const target = explicitDestination(url);
  if (!target) return null;
  const destination = mailUrl(target);
  return destination && !recognizedClick(destination) && !isKnownTrackingImage(target) ? target : null;
}

/** Mail clients may auto-link URLs in either text/plain or visible HTML text. */
export function protectMailText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"'\u0000-\u001f]+/gi, (match) => {
    const original = match.replace(/[.,;!]+$/, '');
    let url = original;
    const imbalance = (url.match(/\)/g)?.length ?? 0) - (url.match(/\(/g)?.length ?? 0);
    const trailing = /\)+$/.exec(url)?.[0].length ?? 0;
    const remove = Math.min(Math.max(imbalance, 0), trailing);
    if (remove) url = url.slice(0, -remove);
    const cleaned = cleanMailLink(url);
    return (cleaned ?? TRACKING_LINK_PLACEHOLDER) + match.slice(url.length);
  });
}
