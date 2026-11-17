import type { Env } from '../types.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_TIMEOUT_MS = 10_000;

/** 托管域名使用的站长 Cloudflare 凭据；Worker 未配置 cf_api_token / cf_account_id 时为 null（功能关闭） */
export interface CloudflareCredentials {
  token: string;
  accountId: string;
  /** catch-all 投递目标：本 Worker 的脚本名 */
  workerName: string;
}

export function cloudflareCredentials(env: Env): CloudflareCredentials | null {
  const token = env.cf_api_token?.trim();
  const accountId = env.cf_account_id?.trim();
  if (!token || !accountId) return null;
  return { token, accountId, workerName: env.worker_name?.trim() || 'hpc-cloud-mail' };
}

/** Cloudflare API 失败：status 为 HTTP 状态（0 表示网络错误或超时），codes 为响应里的错误码 */
export class CloudflareApiError extends Error {
  constructor(readonly status: number, readonly codes: number[], message: string) {
    super(message);
    this.name = 'CloudflareApiError';
  }

  has(...codes: number[]): boolean {
    return codes.some((code) => this.codes.includes(code));
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { total_count?: number; page?: number; total_pages?: number };
}

async function cfFetch<T>(creds: CloudflareCredentials, method: string, path: string, body?: unknown): Promise<CfEnvelope<T>> {
  let res: Response;
  try {
    // workerd 不支持 redirect: 'error'，用 manual 并把 3xx 当失败；凭据只发往 api.cloudflare.com
    res = await fetch(`${CF_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(CF_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CloudflareApiError(0, [], `Cloudflare API 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let payload: CfEnvelope<T> | undefined;
  try {
    payload = await res.json() as CfEnvelope<T>;
  } catch {
    payload = undefined;
  }
  if (!res.ok || !payload?.success) {
    const errors = payload?.errors ?? [];
    const detail = errors.map((e) => `${e.code} ${e.message}`).join('; ');
    throw new CloudflareApiError(res.status, errors.map((e) => Number(e.code)), detail || `HTTP ${res.status}`);
  }
  return payload;
}

async function cf<T>(creds: CloudflareCredentials, method: string, path: string, body?: unknown): Promise<T> {
  return (await cfFetch<T>(creds, method, path, body)).result;
}

export interface CfZone {
  id: string;
  name: string;
  status: 'initializing' | 'pending' | 'active' | 'moved';
  name_servers?: string[];
  original_name_servers?: string[] | null;
  original_registrar?: string | null;
  activated_on?: string | null;
  created_on?: string;
}

export interface CfRouting {
  enabled: boolean;
  status: 'ready' | 'unconfigured' | 'misconfigured' | 'misconfigured/locked' | 'unlocked';
}

export interface CfCatchAll {
  enabled?: boolean;
  actions?: { type: string; value?: string[] }[];
}

export interface CfSendingSubdomain {
  tag: string;
  name: string;
  enabled?: boolean;
}

export interface CfSendingDnsStatus {
  status: 'ready' | 'unconfigured' | 'unlocked' | 'misconfigured';
  errors?: { code: string }[];
}

/**
 * 「可能不存在」：不存在的 zone 返回 403/9109（与无权限难以区分）或 404/7003，
 * 所以对 zone 的结论一律再按名称列一次账户里的 zone 确认，不凭单次报错做破坏性判断。
 */
const maybeMissing = (error: unknown) => error instanceof CloudflareApiError
  && (error.status === 403 || error.status === 404 || error.has(1001, 7003, 9109));

/** 超时、网络错误、5xx 与限流：结果不确定，调用方应保留原状态稍后重试 */
export function isTransientCloudflareError(error: unknown): boolean {
  return !(error instanceof CloudflareApiError) || error.status === 0 || error.status === 429 || error.status >= 500;
}

async function confirmMissing(creds: CloudflareCredentials, zoneId: string, name: string, error: unknown): Promise<void> {
  if (!maybeMissing(error)) throw error;
  if ((await findZone(creds, name))?.id === zoneId) throw error;
}

/** 账户内同名 zone（含 pending）；不存在返回 null */
export async function findZone(creds: CloudflareCredentials, name: string): Promise<CfZone | null> {
  const query = new URLSearchParams({ name, 'account.id': creds.accountId, per_page: '5' });
  const zones = await cf<CfZone[]>(creds, 'GET', `/zones?${query}`);
  return zones.find((zone) => zone.name === name) ?? null;
}

export function createZone(creds: CloudflareCredentials, name: string): Promise<CfZone> {
  return cf<CfZone>(creds, 'POST', '/zones', { name, account: { id: creds.accountId }, type: 'full' });
}

/** zone 已被删除（账户里按名称也找不到该 id）时返回 null */
export async function getZone(creds: CloudflareCredentials, zoneId: string, name: string): Promise<CfZone | null> {
  try {
    return await cf<CfZone>(creds, 'GET', `/zones/${zoneId}`);
  } catch (error) {
    await confirmMissing(creds, zoneId, name, error);
    return null;
  }
}

/** 删除前核对的 zone 身份：不能是系统域名；创建时间不早于本站记录（留 1 分钟时钟误差） */
export interface ZoneDeleteGuard {
  notBefore?: Date | null;
  protectedNames?: readonly string[];
}

/**
 * 先读出 zone 核对身份再删除：名称须与记录一致，身份不符时抛错且不删除（D1 里的 zone_id 被人工改错时
 * 不会删到别的 zone）。已不存在视为成功。
 */
export async function deleteZone(creds: CloudflareCredentials, zoneId: string, name: string, guard: ZoneDeleteGuard = {}): Promise<void> {
  if (guard.protectedNames?.includes(name)) throw new Error(`拒绝删除：${name} 是本站的系统域名`);
  const zone = await getZone(creds, zoneId, name);
  if (!zone) return;
  if (zone.name !== name) throw new Error(`拒绝删除：zone ${zoneId} 的名称为 ${zone.name}，与记录的 ${name} 不符`);
  if (guard.notBefore && zone.created_on && new Date(zone.created_on).getTime() < guard.notBefore.getTime() - 60_000) {
    throw new Error(`拒绝删除：zone ${zoneId} 创建于 ${zone.created_on}，早于本站记录`);
  }
  try {
    await cf(creds, 'DELETE', `/zones/${zoneId}`);
  } catch (error) {
    await confirmMissing(creds, zoneId, name, error);
  }
}

/** 请 Cloudflare 立即复查 NS（Free 计划每小时限一次），失败不影响后续状态核对 */
export async function requestActivationCheck(creds: CloudflareCredentials, zoneId: string): Promise<void> {
  try {
    await cf(creds, 'PUT', `/zones/${zoneId}/activation_check`);
  } catch (error) {
    console.warn('activation_check 未执行:', error instanceof Error ? error.message : error);
  }
}

export function getRouting(creds: CloudflareCredentials, zoneId: string): Promise<CfRouting> {
  return cf<CfRouting>(creds, 'GET', `/zones/${zoneId}/email/routing`);
}

/**
 * 在 zone 根域开启 Email Routing 并写入锁定的 MX / SPF / DKIM（替代已弃用的 /email/routing/enable）。
 * 请求体的 name 只用于子域，传根域名会返回 2007「must be a subdomains of …」，根域必须传空对象。
 */
export function enableRouting(creds: CloudflareCredentials, zoneId: string): Promise<CfRouting> {
  return cf<CfRouting>(creds, 'POST', `/zones/${zoneId}/email/routing/dns`, {});
}

export function getCatchAll(creds: CloudflareCredentials, zoneId: string): Promise<CfCatchAll> {
  return cf<CfCatchAll>(creds, 'GET', `/zones/${zoneId}/email/routing/rules/catch_all`);
}

export function putCatchAll(creds: CloudflareCredentials, zoneId: string): Promise<CfCatchAll> {
  return cf<CfCatchAll>(creds, 'PUT', `/zones/${zoneId}/email/routing/rules/catch_all`, {
    name: `Catch-all → ${creds.workerName}`,
    enabled: true,
    matchers: [{ type: 'all' }],
    actions: [{ type: 'worker', value: [creds.workerName] }],
  });
}

export function catchAllTargetsWorker(rule: CfCatchAll | undefined, workerName: string): boolean {
  const action = rule?.actions?.[0];
  return rule?.enabled === true && action?.type === 'worker' && action.value?.[0] === workerName;
}

export function listSendingSubdomains(creds: CloudflareCredentials, zoneId: string): Promise<CfSendingSubdomain[]> {
  return cf<CfSendingSubdomain[]>(creds, 'GET', `/zones/${zoneId}/email/sending/subdomains`);
}

/** 接入 Email Sending（创建或重新启用），平台自动写入 cf-bounce 与 DKIM / DMARC 记录 */
export function createSendingSubdomain(creds: CloudflareCredentials, zoneId: string, name: string): Promise<CfSendingSubdomain> {
  return cf<CfSendingSubdomain>(creds, 'POST', `/zones/${zoneId}/email/sending/subdomains`, { name });
}

export function getSendingDnsStatus(creds: CloudflareCredentials, zoneId: string, tag: string): Promise<CfSendingDnsStatus> {
  return cf<CfSendingDnsStatus>(creds, 'GET', `/zones/${zoneId}/email/sending/subdomains/${tag}/dns/status`);
}

/** 补写缺失的发信记录（幂等）；遇到外来冲突记录时 Cloudflare 返回 409 */
export function repairSendingDns(creds: CloudflareCredentials, zoneId: string, tag: string): Promise<CfSendingDnsStatus> {
  return cf<CfSendingDnsStatus>(creds, 'POST', `/zones/${zoneId}/email/sending/subdomains/${tag}/dns`);
}

export async function deleteSendingSubdomain(creds: CloudflareCredentials, zoneId: string, tag: string): Promise<void> {
  await cf(creds, 'DELETE', `/zones/${zoneId}/email/sending/subdomains/${tag}`);
}

/** 发信接入标签失效（被删除或重建）：清掉标签，下次重新接入，不涉及破坏性操作 */
export function isCloudflareNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 404 || error.has(1001, 7003));
}

/** 校验凭据：账户级 Token 走账户接口，用户级 Token 走用户接口 */
export async function verifyToken(creds: CloudflareCredentials): Promise<void> {
  try {
    await cf(creds, 'GET', `/accounts/${creds.accountId}/tokens/verify`);
  } catch (accountError) {
    try {
      await cf(creds, 'GET', '/user/tokens/verify');
    } catch {
      throw accountError;
    }
  }
}

/** 账户 zone 总数与其中 pending 的数量 */
export async function countZones(creds: CloudflareCredentials): Promise<{ total: number; pending: number }> {
  const count = async (extra: Record<string, string>) => {
    const query = new URLSearchParams({ 'account.id': creds.accountId, per_page: '5', ...extra });
    return (await cfFetch<unknown[]>(creds, 'GET', `/zones?${query}`)).result_info?.total_count ?? 0;
  };
  const [total, pending] = await Promise.all([count({}), count({ status: 'pending' })]);
  return { total, pending };
}

// ---------------------------------------------------------------------------
// DNS 记录

export interface CfDnsRecord {
  id: string;
  type: string;
  /** 完整域名 */
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
  proxiable?: boolean;
  ttl: number;
  /** 邮件服务写入的记录带 read_only / email_routing 标记 */
  meta?: { read_only?: boolean; email_routing?: boolean } & Record<string, unknown>;
  comment?: string | null;
  tags?: string[];
  modified_on?: string;
  /** SRV、CAA 等结构化记录的字段 */
  data?: Record<string, unknown>;
}

const DNS_PAGE_SIZE = 100;
/** 分页上限，防止 result_info 异常时死循环 */
const DNS_MAX_PAGES = 20;

export async function listDnsRecords(creds: CloudflareCredentials, zoneId: string): Promise<CfDnsRecord[]> {
  const records: CfDnsRecord[] = [];
  for (let page = 1; page <= DNS_MAX_PAGES; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: String(DNS_PAGE_SIZE) });
    const res = await cfFetch<CfDnsRecord[]>(creds, 'GET', `/zones/${zoneId}/dns_records?${query}`);
    records.push(...(res.result ?? []));
    if (!res.result?.length || page >= (res.result_info?.total_pages ?? 1)) break;
  }
  return records;
}

export function getDnsRecord(creds: CloudflareCredentials, zoneId: string, recordId: string): Promise<CfDnsRecord> {
  return cf<CfDnsRecord>(creds, 'GET', `/zones/${zoneId}/dns_records/${recordId}`);
}

export function createDnsRecord(creds: CloudflareCredentials, zoneId: string, body: Record<string, unknown>): Promise<CfDnsRecord> {
  return cf<CfDnsRecord>(creds, 'POST', `/zones/${zoneId}/dns_records`, body);
}

/** PATCH 只改传入的字段 */
export function updateDnsRecord(
  creds: CloudflareCredentials, zoneId: string, recordId: string, body: Record<string, unknown>,
): Promise<CfDnsRecord> {
  return cf<CfDnsRecord>(creds, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, body);
}

export async function deleteDnsRecord(creds: CloudflareCredentials, zoneId: string, recordId: string): Promise<void> {
  await cf(creds, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
}
