/** SPF 解析与合并（纯函数）：系统域名接入时把 Cloudflare Email Routing 的 include 合并进已有的唯一一条 SPF */

export const CF_SPF_INCLUDE = '_spf.mx.cloudflare.net';
/** 单个 TXT 字符串上限；超过时 Cloudflare 是否自动拆段未经验证，保守交给管理员处理 */
const SPF_MAX_LENGTH = 255;
/** RFC 7208：一条 SPF 求值最多 10 次 DNS 查询 */
const SPF_MAX_LOOKUPS = 10;

/** TXT 内容解码：多段字符串直接拼接（"v=sp" "f1 -all"），解开 RFC 1035 转义（\118 即 v），去掉引号 */
export function decodeTxtContent(content: string): string {
  const trimmed = content.trim();
  const segments = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]!);
  const joined = segments.length ? segments.join('') : trimmed;
  return joined
    .replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code) % 256))
    .replace(/\\(.)/g, '$1');
}

/** 保守判断 SPF：解码、去掉空白后以 v=spf1 开头的 TXT 一律算作 SPF（与 shared hosted-dns 的口径一致） */
export function isSpfContent(content: string): boolean {
  return decodeTxtContent(content).replace(/\s/g, '').toLowerCase().startsWith('v=spf1');
}

export interface SpfMergeResult {
  /** present 已含本站 include；merged 可以合并；manual 需要管理员手动处理 */
  status: 'present' | 'merged' | 'manual';
  /** merged 时的新内容（单个字符串，不带引号） */
  merged: string | null;
  /** 顶层 include / a / mx / ptr / exists / redirect 各 1 次，合并时再加本站 1 次；不展开嵌套 include，所以是下限 */
  lookupEstimate: number;
  warnings: string[];
  /** manual 的原因 */
  reason?: string;
}

const LOOKUP_TERM = /^[+?~-]?(include:|exists:|a$|a[:/]|mx$|mx[:/]|ptr$|ptr:)|^redirect=/i;
const CF_INCLUDE_TERM = /^([+?~-]?)include:_spf\.mx\.cloudflare\.net\.?$/i;

/** 把 include:_spf.mx.cloudflare.net 合并进一条已有的 SPF：插在 v=spf1 之后，排在所有机制与 redirect 之前，原有机制的匹配结果不变 */
export function mergeCloudflareSpf(content: string): SpfMergeResult {
  const terms = decodeTxtContent(content).trim().split(/\s+/).filter(Boolean);
  const lookups = terms.filter((term) => LOOKUP_TERM.test(term)).length;
  const manual = (reason: string, estimate = lookups): SpfMergeResult => ({ status: 'manual', merged: null, lookupEstimate: estimate, warnings: [], reason });
  if (terms[0]?.toLowerCase() !== 'v=spf1') return manual('不是标准的 SPF 写法（第一个词应为 v=spf1）');
  const existing = terms.find((term) => CF_INCLUDE_TERM.test(term));
  if (existing) {
    if (CF_INCLUDE_TERM.exec(existing)![1] === '-') return manual('SPF 显式拒绝了 Cloudflare 的转发服务器（-include），请先手动修改');
    return { status: 'present', merged: null, lookupEstimate: lookups, warnings: [] };
  }
  if (terms.some((term) => term.includes('%{'))) return manual('SPF 含宏（%{…}），无法安全估算查询次数，请手动合并');
  const estimate = lookups + 1;
  if (estimate > SPF_MAX_LOOKUPS) return manual(`合并后至少需要 ${estimate} 次 DNS 查询，超过 SPF 的 10 次上限，请先精简`, estimate);
  const merged = ['v=spf1', `include:${CF_SPF_INCLUDE}`, ...terms.slice(1)].join(' ');
  if (merged.length > SPF_MAX_LENGTH) return manual(`合并后超过 ${SPF_MAX_LENGTH} 个字符，请手动拆分或精简`, estimate);
  const warnings: string[] = [];
  if (estimate >= SPF_MAX_LOOKUPS - 1) warnings.push(`合并后至少需要 ${estimate} 次 DNS 查询，接近 10 次上限（嵌套 include 未计入）`);
  if (terms.some((term) => /^[+?]?all$/i.test(term))) warnings.push('SPF 以 +all 或 ?all 结尾，策略过宽');
  if (terms.some((term) => /^redirect=/i.test(term))) warnings.push('新增的 include 在 redirect= 之前生效，原 redirect 语义不变');
  return { status: 'merged', merged, lookupEstimate: estimate, warnings };
}
