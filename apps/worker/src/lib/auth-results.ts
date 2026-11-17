import { MAIL_AUTH_RESULTS, type MailAuthResult, type MessageAuth } from '@hpc-mail/shared';

/**
 * Cloudflare Email Routing 的 authserv-id。它在调用 Worker 之前校验 SPF/DKIM/DMARC，并把结果写成
 * 一条 Authentication-Results 加在邮件最上方（https://developers.cloudflare.com/email-service/api/route-emails/email-handler/）：
 * 只有最上面那条、且 authserv-id 是它时才可信，发件人可以在邮件里自带任意多条同名头。
 * ARC-Authentication-Results 不采信：Cloudflare 直接调用 Worker，不需要 ARC；没有验证 ARC-Seal 的
 * ARC 记录同样可以由发件人伪造，验证了也只说明链条完整，不说明封印方可信。
 */
export const TRUSTED_AUTHSERV_ID = 'mx.cloudflare.net';

/** 只解析头值开头这么多字符：可信头由 Cloudflare 生成，正常不到 2KB */
const MAX_HEADER_CHARS = 16 * 1024;

/** 这些头出现多次时，显示的值可能不是 DKIM 签名的那一个（验签取最下面一个，解析取最上面一个） */
const SINGLE_HEADERS = ['from', 'to', 'subject'] as const;

const RESULTS = new Set<string>(MAIL_AUTH_RESULTS);

interface Header { key: string; value: string }

/** 每条结果：method=result 及其 ptype.property=value 属性（键小写） */
interface ResInfo {
  method: string;
  result: MailAuthResult;
  props: Map<string, string>;
}

/** 收件时的认证结果来源：trusted 已采信；untrusted 最上方的头不是 Cloudflare 的；missing 没有该头 */
export type AuthSource = 'trusted' | 'untrusted' | 'missing';

/**
 * 去掉 RFC 5322 注释（可嵌套的圆括号，支持反斜杠转义），保留引号串原样。
 * 注释里常带发件人可控的文字（SPF 的 "domain of x designates ..."），去掉后才按分号切分。
 */
function stripComments(input: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\\' && (quoted || depth > 0)) {
      if (depth === 0) out += ch + (input[i + 1] ?? '');
      i++;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) out += ' ';
      continue;
    }
    if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '(') depth = 1;
    else {
      if (ch === '"') quoted = true;
      out += ch;
    }
  }
  return out;
}

/** 按引号外的分隔符切分 */
function splitOutsideQuotes(input: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '\\' && quoted) { i++; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && separator.test(ch)) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;
}

function parseResInfo(segment: string): ResInfo | null {
  // `dkim = pass` 与 `dkim=pass` 等价；之后按空白切出 method=result 与各个属性。
  // 先把空白折成单个空格，`\s*=\s*` 在长空白串上会平方回溯
  const tokens = splitOutsideQuotes(segment.replace(/\s+/g, ' ').replace(/ ?= ?/g, '='), / /);
  const [method, result] = (tokens[0] ?? '').split('=', 2);
  if (!method || result === undefined) return null;
  const props = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const at = token.indexOf('=');
    if (at > 0) props.set(token.slice(0, at).toLowerCase(), unquote(token.slice(at + 1)));
  }
  const normalized = unquote(result).toLowerCase();
  return {
    method: method.split('/')[0]!.toLowerCase(),
    result: RESULTS.has(normalized) ? normalized as MailAuthResult : 'none',
    props,
  };
}

/** 地址或域名取域名部分（小写、去掉末尾的点）；`@example.com` 形式的 header.i 同样适用 */
function domainOf(value: string | undefined): string {
  if (!value) return '';
  return value.slice(value.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
}

/** 两个域名相同或互为子域（不查公共后缀表的宽松对齐近似；DMARC 通过时以 Cloudflare 的判定为准） */
export function domainsAligned(a: string, b: string): boolean {
  if (!a.includes('.') || !b.includes('.')) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * 解析 Authentication-Results 头值；authserv-id 不是 Cloudflare 时返回 null。
 * fromDomain 是解析出的 From 域（小写）；duplicated 为 true 时 aligned 一律 false。
 */
export function parseAuthenticationResults(value: string, fromDomain: string, duplicated = false): MessageAuth | null {
  const [head = '', ...segments] = splitOutsideQuotes(stripComments(value.slice(0, MAX_HEADER_CHARS)), /;/);
  if ((head.split(/\s+/)[0] ?? '').toLowerCase() !== TRUSTED_AUTHSERV_ID) return null;
  const infos = segments.map(parseResInfo).filter((info): info is ResInfo => info !== null);

  // SPF 取校验 MAIL FROM 的那条（Cloudflare 可能另给一条 HELO 的结果）
  const spfs = infos.filter((info) => info.method === 'spf');
  const spf = spfs.find((info) => info.props.has('smtp.mailfrom')) ?? spfs[0];
  const spfDomain = domainOf(spf?.props.get('smtp.mailfrom'));
  const dkims = infos.filter((info) => info.method === 'dkim')
    .map((info) => ({ result: info.result, domain: domainOf(info.props.get('header.d') ?? info.props.get('header.i')) }));
  const dmarc = infos.find((info) => info.method === 'dmarc');
  const dmarcFrom = domainOf(dmarc?.props.get('header.from'));

  const passing = dkims.filter((dkim) => dkim.result === 'pass');
  const alignedDkim = passing.find((dkim) => domainsAligned(dkim.domain, fromDomain));
  const chosen = alignedDkim ?? passing[0] ?? dkims[0];
  const aligned = !duplicated && fromDomain !== '' && (
    (dmarc?.result === 'pass' && (!dmarcFrom || dmarcFrom === fromDomain))
    || alignedDkim !== undefined
    || (spf?.result === 'pass' && domainsAligned(spfDomain, fromDomain)));
  return {
    spf: spf?.result ?? 'none',
    dkim: passing.length ? 'pass' : chosen?.result ?? 'none',
    dkimDomain: chosen?.domain ?? '',
    dmarc: dmarc?.result ?? 'none',
    aligned,
  };
}

/**
 * 由解析后的邮件头（按原文顺序）得到可信认证结果：只看最上方的 Authentication-Results，
 * 它不是 Cloudflare 的就不再往下找（下面的同名头都可能是发件人写的）。
 */
export function inboundAuth(headers: readonly Header[], fromAddress: string): { auth: MessageAuth | null; source: AuthSource } {
  let first: Header | undefined;
  const counts = new Map<string, number>();
  for (const header of headers) {
    const key = header.key.trim();
    if (!first && key === 'authentication-results') first = header;
    if ((SINGLE_HEADERS as readonly string[]).includes(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (!first) return { auth: null, source: 'missing' };
  const duplicated = [...counts.values()].some((count) => count > 1);
  const auth = parseAuthenticationResults(first.value, domainOf(fromAddress.includes('@') ? fromAddress : ''), duplicated);
  return { auth, source: auth ? 'trusted' : 'untrusted' };
}
