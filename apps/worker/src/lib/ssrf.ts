/**
 * 出站请求目标的 SSRF 判定（纯函数）：URL 附件拉取、Webhook 与 PushDeer 端点共用一套规则。
 * 只判断地址与主机名本身；协议、端口、本站主机与 DNS 解析后的复查由调用方按各自场景处理。
 */

/** 点分十进制 IPv4 → 4 个八位组；不是严格的点分十进制返回 null（URL 解析器已把 0x7f.1 等写法规范成点分十进制） */
export function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : null;
}

/**
 * 内网、回环、链路本地（含云元数据 169.254.169.254）、CGNAT、保留（整个 192.0.0.0/16）、6to4 中继、文档、
 * 基准测试、组播与广播网段
 */
export function isForbiddenIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/** IPv6 文本（可带方括号、可含末尾点分 IPv4）→ 8 个 16 位组；非法返回 null */
export function parseIPv6(value: string): number[] | null {
  let text = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (text.includes('%')) return null; // 带 zone id 的链路本地地址
  const tail: number[] = [];
  const v4Match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[2]!);
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    text = v4Match[1]!.endsWith('::') ? v4Match[1]! : v4Match[1]!.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...rest].some((group) => Number.isNaN(group))) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  return [...head, ...Array(8 - explicit).fill(0), ...rest, ...tail];
}

/**
 * 只放行全球单播 2000::/3 中的公网段；IPv4 映射（::ffff:0:0/96）、IPv4 兼容（::/96）、NAT64（64:ff9b::/96）
 * 与 6to4（2002::/16）按其中嵌入的 IPv4 判断。Teredo、ORCHID 等 2001::/23 协议段与文档段 2001:db8::/32 一律拒绝。
 */
export function isForbiddenIPv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const embedded = (hi: number, lo: number) => isForbiddenIPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return embedded(g6, g7);
    if (g5 === 0) return (g6 === 0 && g7 <= 1) || embedded(g6, g7);
    return true;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
  if (g0 === 0x2002) return embedded(g1, g2);
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && g1 < 0x0200) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  return false;
}

/** IP 文本落在禁止网段（或无法解析）时为 true */
export function isForbiddenAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isForbiddenIPv4(v4);
  const v6 = parseIPv6(ip);
  return v6 ? isForbiddenIPv6(v6) : true;
}

/** 内网专用后缀，以及把子域名解析到任意（含内网）IP 的通配 DNS 服务；后缀本身（去掉开头的点）同样拒绝 */
const INTERNAL_SUFFIXES = [
  '.localhost', '.local', '.internal', '.home', '.home.arpa', '.lan', '.intranet',
  '.nip.io', '.sslip.io', '.localtest.me', '.lvh.me', '.vcap.me',
];

/** 主机名是否内网名：localhost、单标签名（没有点）与内网后缀；host 须已小写、去掉末尾的点 */
export function isInternalHostname(host: string): boolean {
  return !host.includes('.') || host === 'localhost'
    || INTERNAL_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/** 主机（URL.hostname，可带方括号与末尾点）是禁止的 IP 字面量或内网主机名 */
export function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.replace(/\.$/, '').toLowerCase();
  if (host.includes(':') || parseIPv4(host)) return isForbiddenAddress(host);
  return isInternalHostname(host);
}
