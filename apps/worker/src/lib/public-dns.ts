/**
 * 公共 DNS（Cloudflare DoH JSON）与 RDAP 查询：纯边缘子请求、不需要凭据。
 * 这里只做请求与解析，失败语义（抛错、未知、回落）由调用方决定。
 */

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
/** 单次 DoH / RDAP 请求的默认时限 */
export const PUBLIC_LOOKUP_TIMEOUT_MS = 5000;

/** 用到的 DNS 记录类型编号（应答里的 type 字段） */
export const RR = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28, DS: 43 } as const;

export interface DohAnswer { name?: string; type: number; data: string }
export interface DohResponse { Status?: number; Answer?: DohAnswer[] }

/**
 * DoH JSON 查询。HTTP 非 2xx 抛错（workerd 不支持 redirect: 'error'，用 manual 并把 3xx 也当失败）；
 * 网络错误、超时与响应解析错误原样抛出。
 */
export async function dohQuery(
  name: string,
  type: string | number,
  signal: AbortSignal = AbortSignal.timeout(PUBLIC_LOOKUP_TIMEOUT_MS),
): Promise<DohResponse> {
  const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' }, redirect: 'manual', signal,
  });
  if (!res.ok) throw new Error(`DoH ${type} HTTP ${res.status}`);
  return await res.json() as DohResponse;
}

/** 应答里指定记录类型的 data */
export function dohAnswers(body: DohResponse, type: number): string[] {
  return (body.Answer ?? []).filter((answer) => answer.type === type).map((answer) => answer.data);
}

/**
 * RDAP 域名查询 `<base>/domain/<domain>`：会跟随跳转（rdap.org 靠 302 转到注册局）。
 * HTTP 非 2xx 返回 null；网络错误、超时与响应解析错误原样抛出。
 */
export async function rdapDomain<T>(base: string, domain: string): Promise<T | null> {
  const res = await fetch(`${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`, {
    headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(PUBLIC_LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return await res.json() as T;
}
