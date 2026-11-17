import type { DomainOnboardingStatus } from '@hpc-mail/shared';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const CF_MX_SUFFIX = '.mx.cloudflare.net';
const CF_SPF_INCLUDE = '_spf.mx.cloudflare.net';

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}
interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

/** DNS-over-HTTPS JSON 查询（Cloudflare 公共 resolver，纯边缘子请求，不需任何凭据） */
async function dohQuery(name: string, type: 'MX' | 'TXT' | 'DS'): Promise<DohAnswer[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`DoH ${type} ${res.status}`);
  const body = (await res.json()) as DohResponse;
  return body.Answer ?? [];
}

/** MX 记录 data 形如 "10 route1.mx.cloudflare.net."，取末段 exchange 主机名（去优先级、去末尾点） */
function parseMxHost(data: string): string {
  const parts = data.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? '').replace(/\.$/, '').toLowerCase();
}

/** TXT data 会带引号，长串可能被拆成多段引号拼接 */
function parseTxt(data: string): string {
  return data
    .replace(/^"|"$/g, '')
    .replace(/"\s*"/g, '')
    .toLowerCase();
}

/**
 * 探测域名是否已在 Cloudflare Email Routing 接入。
 * 判据：MX 指向 *.mx.cloudflare.net 即视为已开启 Email Routing。
 * 注意：catch-all → 本 Worker 属 Cloudflare 内部路由配置，DNS 层不可见，
 * 无法探测——最终是否真能落到本系统仍需发一封真实邮件验证。
 * 全程仅公共 DNS 查询，不依赖任何 Cloudflare API Token。
 */
export async function checkDomainOnboarding(
  domain: string,
  inList: boolean,
): Promise<DomainOnboardingStatus> {
  let mxRecords: string[] = [];
  let spfReady = false;
  let resolved = false;
  try {
    const [mxAnswers, txtAnswers] = await Promise.all([
      dohQuery(domain, 'MX'),
      dohQuery(domain, 'TXT').catch(() => [] as DohAnswer[]),
    ]);
    resolved = true;
    mxRecords = mxAnswers
      .filter((a) => a.type === 15)
      .map((a) => parseMxHost(a.data))
      .filter(Boolean);
    spfReady = txtAnswers
      .filter((a) => a.type === 16)
      .map((a) => parseTxt(a.data))
      .some((t) => t.includes('v=spf1') && t.includes(CF_SPF_INCLUDE));
  } catch {
    resolved = false;
  }
  const mxReady = mxRecords.some((host) => host.endsWith(CF_MX_SUFFIX));
  return { domain, inList, mxReady, spfReady, mxRecords, resolved };
}

/** 父域仍发布 DS 记录即 DNSSEC 已开启：此时切换 NS 会让解析校验失败，需先在注册商关闭 */
export async function hasDnssec(domain: string): Promise<boolean> {
  return (await dohQuery(domain, 'DS')).some((answer) => answer.type === 43);
}

const normalizeNs = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

/**
 * 域名在注册局的 NS 委派（不需要凭据）：先查 RDAP（rdap.org 跳转到注册局，给出的就是父域委派），
 * 失败再用 DoH 查 NS。返回 null 表示无法确定——NS 仍指向某个已删除的 zone 时递归解析通常是 SERVFAIL，
 * 所以查询失败不能当成「没有指向本站」。
 */
export async function lookupDelegation(domain: string): Promise<string[] | null> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = (await res.json()) as { nameservers?: { ldhName?: string }[] };
      if (Array.isArray(body.nameservers)) {
        return body.nameservers.map((ns) => normalizeNs(ns.ldhName ?? '')).filter(Boolean);
      }
    }
  } catch {
    // 回落到 DoH
  }
  try {
    const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=NS`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as DohResponse;
    if (body.Status !== 0) return null;
    return (body.Answer ?? []).filter((answer) => answer.type === 2).map((answer) => normalizeNs(answer.data)).filter(Boolean);
  } catch {
    return null;
  }
}
