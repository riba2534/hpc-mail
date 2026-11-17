import type { DomainOnboardingStatus } from '@hpc-mail/shared';
import { dohAnswers, dohQuery, rdapDomain, RR } from '../lib/public-dns.js';

const CF_MX_SUFFIX = '.mx.cloudflare.net';
const CF_SPF_INCLUDE = '_spf.mx.cloudflare.net';

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
    const [mx, txt] = await Promise.all([
      dohQuery(domain, 'MX'),
      dohQuery(domain, 'TXT').catch(() => ({})),
    ]);
    resolved = true;
    mxRecords = dohAnswers(mx, RR.MX).map(parseMxHost).filter(Boolean);
    spfReady = dohAnswers(txt, RR.TXT)
      .map(parseTxt)
      .some((t) => t.includes('v=spf1') && t.includes(CF_SPF_INCLUDE));
  } catch {
    resolved = false;
  }
  const mxReady = mxRecords.some((host) => host.endsWith(CF_MX_SUFFIX));
  return { domain, inList, mxReady, spfReady, mxRecords, resolved };
}

/** 父域仍发布 DS 记录即 DNSSEC 已开启：此时切换 NS 会让解析校验失败，需先在注册商关闭 */
export async function hasDnssec(domain: string): Promise<boolean> {
  return dohAnswers(await dohQuery(domain, 'DS'), RR.DS).length > 0;
}

const normalizeNs = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

/**
 * 域名在注册局的 NS 委派（不需要凭据）：先查 RDAP（rdap.org 跳转到注册局，给出的就是父域委派），
 * 失败再用 DoH 查 NS。返回 null 表示无法确定——NS 仍指向某个已删除的 zone 时递归解析通常是 SERVFAIL，
 * 所以查询失败不能当成「没有指向本站」。
 */
export async function lookupDelegation(domain: string): Promise<string[] | null> {
  try {
    const body = await rdapDomain<{ nameservers?: { ldhName?: string }[] }>('https://rdap.org', domain);
    if (Array.isArray(body?.nameservers)) {
      return body.nameservers.map((ns) => normalizeNs(ns.ldhName ?? '')).filter(Boolean);
    }
  } catch {
    // 回落到 DoH
  }
  try {
    const body = await dohQuery(domain, 'NS');
    if (body.Status !== 0) return null;
    return dohAnswers(body, RR.NS).map(normalizeNs).filter(Boolean);
  } catch {
    return null;
  }
}
