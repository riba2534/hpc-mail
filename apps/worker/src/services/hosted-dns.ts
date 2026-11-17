import {
  HOSTED_DNS_CAA_TAGS, HOSTED_DNS_RECORD_TYPES, MAX_HOSTED_DNS_RECORDS, MAX_HOSTED_DNS_REQUESTS_PER_MINUTE, hostedDnsConflictReason, hostedDnsFqdn,
  hostedDnsMailReason, hostedDnsRelativeName, type HostedDnsCaaData, type HostedDnsRecord, type HostedDnsRecordKind,
  type HostedDnsRecordParsed,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { AuthUser, Env } from '../types.js';
import { logAdminAction } from './audit.js';
import {
  CloudflareApiError, cloudflareCredentials, createDnsRecord, deleteDnsRecord, getDnsRecord, listDnsRecords, updateDnsRecord,
  type CfDnsRecord, type CloudflareCredentials,
} from './cloudflare.js';
import { meterHostedCall, requireManage } from './hosted-domain.js';

/**
 * 托管域名的 DNS 解析：直接读写站长 Cloudflare 账户里该域名的 zone，不在 D1 落记录。
 * 邮箱收发占用的记录只读，新增与修改在调用 Cloudflare 写接口之前做冲突校验；只做 DNS 解析，不开代理。
 */

type Viewer = Pick<AuthUser, 'id' | 'username' | 'role'>;

/** 每位用户每分钟的解析请求计数（四个接口共用，管理员也计） */
export const HOSTED_DNS_RATE_SCOPE = 'hosted_dns';
/** 每种操作的 Cloudflare 调用次数：列表 1；新增先列表再 POST；修改、删除先 GET 再写入 */
const CF_CALLS = { list: 1, create: 2, update: 2, delete: 2 } as const;
type DnsOperation = keyof typeof CF_CALLS;
const AUDIT_VALUE_MAX = 80;
const SUPPORTED = new Set<string>(HOSTED_DNS_RECORD_TYPES);
const CAA_TAGS = new Set<string>(HOSTED_DNS_CAA_TAGS);
const CAA_FLAGS = new Set([0, 128]);

interface DnsZone {
  creds: CloudflareCredentials;
  zoneId: string;
  domain: string;
}

/** 凭据、限流、权限与域名状态；限流计数和读取域名并行，无权访问的请求同样计入个人限额 */
async function openZone(env: Env, viewer: Viewer, id: number, op: DnsOperation): Promise<DnsZone> {
  const creds = cloudflareCredentials(env);
  if (!creds) throw new AppError('forbidden', '本站未开启域名托管');
  const write = op !== 'list';
  const admin = viewer.role === 'admin' ? 1 : 0;
  // 全站只计能走到 Cloudflare 的请求：域名存在、zone 已建好、不在删除中，调用者是所有者或管理员，
  // 暂停的域名只有管理员能写；无关用户、成员与其他被拒绝的请求占不了全站额度
  const { row, access } = await meterHostedCall(env, viewer, id, {
    scope: HOSTED_DNS_RATE_SCOPE, limit: MAX_HOSTED_DNS_REQUESTS_PER_MINUTE, calls: CF_CALLS[op],
    eligible: {
      sql: `EXISTS (SELECT 1 FROM hosted_domains WHERE id = ? AND zone_id IS NOT NULL AND status <> 'deleting'
        AND (user_id = ? OR ? = 1) AND (? = 0 OR ? = 1 OR status <> 'suspended'))`,
      params: [id, viewer.id, admin, write ? 1 : 0, admin],
    },
    userBusy: '解析操作过于频繁，请稍后再试',
    siteBusy: '当前解析操作较多，请稍后再试',
  });
  requireManage(access);
  if (row.status === 'deleting') throw new AppError('conflict', '域名正在删除');
  if (write && row.status === 'suspended' && viewer.role !== 'admin') throw new AppError('forbidden', '域名已被管理员暂停，解析只读');
  if (!row.zoneId) throw new AppError('conflict', '域名还在创建中，请稍后再试');
  return { creds, zoneId: row.zoneId, domain: row.domain };
}

function dnsError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // 超时、5xx，以及 2xx 但响应体读不出来（写入可能已生效）：结果都不确定
  if (!(error instanceof CloudflareApiError) || error.status === 0 || error.status >= 500 || error.status < 400) {
    return new AppError('internal', 'Cloudflare 没有返回明确结果，请刷新列表确认是否已生效');
  }
  if (error.status === 429) return new AppError('rate_limited', 'Cloudflare 接口繁忙，请稍后再试');
  if (error.has(81053, 81054, 81056, 81057, 81058)) return new AppError('conflict', '已存在冲突的记录：同名下已有相同或不能共存的记录');
  // 不存在的 zone 返回 403/9109 或 404/7003；凭据失效同样只能由站长处理
  if (error.has(9109, 7003) || error.status === 401 || error.status === 403) {
    return new AppError('conflict', 'Cloudflare 中的域名已不可用，请联系管理员');
  }
  if (error.has(81044) || error.status === 404) return new AppError('not_found', '解析记录不存在');
  return new AppError('validation_failed', `Cloudflare 校验未通过：${error.message}`);
}

async function cfCall<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw dnsError(error);
  }
}

function classify(record: CfDnsRecord, fqdn: string, domain: string): { kind: HostedDnsRecordKind; lockedReason: string } {
  const type = record.type.toUpperCase();
  const mail = hostedDnsMailReason({ type, fqdn, content: record.content ?? '' }, domain);
  if (mail) return { kind: 'mail', lockedReason: mail };
  if (record.meta?.email_routing) return { kind: 'mail', lockedReason: '由 Cloudflare 邮件服务自动维护' };
  // 只有 read_only 的记录来自 Worker 自定义域名等其他服务
  if (record.meta?.read_only) return { kind: 'readonly', lockedReason: '由 Cloudflare 其他服务自动维护' };
  if (!SUPPORTED.has(type)) return { kind: 'readonly', lockedReason: `本站暂不支持编辑 ${type} 记录` };
  // 控制台建的根域 CNAME 等冲突记录仍为 user：可以删除，修改保存时由 checkInput 给出冲突原因
  // 表单只支持这几种 tag 与 flags，其他 CAA 记录无法回填编辑
  if (type === 'CAA' && !(CAA_TAGS.has(String(record.data?.tag)) && CAA_FLAGS.has(Number(record.data?.flags)))) {
    return { kind: 'readonly', lockedReason: '本站暂不支持编辑该 CAA 记录' };
  }
  if (record.proxied) return { kind: 'readonly', lockedReason: '已开启 Cloudflare 代理，请联系管理员修改' };
  return { kind: 'user', lockedReason: '' };
}

const num = (value: unknown) => Number(value ?? 0) || 0;

function toRecord(record: CfDnsRecord, domain: string): HostedDnsRecord {
  const type = record.type.toUpperCase();
  const fqdn = record.name.toLowerCase().replace(/\.$/, '');
  const data = record.data ?? {};
  return {
    id: record.id,
    type,
    name: hostedDnsRelativeName(fqdn, domain),
    fqdn,
    content: record.content ?? '',
    ttl: record.ttl ?? 1,
    priority: type === 'MX' ? (record.priority ?? null) : null,
    srv: type === 'SRV' ? {
      priority: num(data.priority ?? record.priority), weight: num(data.weight), port: num(data.port),
      target: String(data.target ?? '').replace(/\.$/, ''),
    } : null,
    caa: type === 'CAA' ? { flags: num(data.flags), tag: String(data.tag ?? '') as HostedDnsCaaData['tag'], value: String(data.value ?? '') } : null,
    proxied: record.proxied === true,
    comment: record.comment ?? '',
    ...classify(record, fqdn, domain),
    modifiedAt: record.modified_on ?? null,
  };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** @ 在最前，其余按名称、类型、记录值 */
function byName(a: HostedDnsRecord, b: HostedDnsRecord): number {
  return Number(b.name === '@') - Number(a.name === '@') || compare(a.name, b.name) || compare(a.type, b.type) || compare(a.content, b.content);
}

/** 校验名称与邮箱冲突，返回完整域名；全部是本地判断，不调用 Cloudflare */
function checkInput(input: HostedDnsRecordParsed, domain: string): string {
  const fqdn = hostedDnsFqdn(input.name, domain);
  if (fqdn.length > 253) throw new AppError('validation_failed', '记录名过长');
  const content = 'content' in input ? input.content : '';
  if (input.type === 'CNAME' && content === fqdn) throw new AppError('validation_failed', 'CNAME 不能指向自身');
  const conflict = hostedDnsConflictReason({ type: input.type, fqdn, content }, domain);
  if (conflict) throw new AppError('validation_failed', conflict);
  return fqdn;
}

/** 请求体转 Cloudflare 记录；新增时空备注不写入，修改时传空串即清除 */
function cfBody(input: HostedDnsRecordParsed, fqdn: string, create: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { type: input.type, name: fqdn, ttl: input.ttl };
  if (!create || input.comment) body.comment = input.comment;
  switch (input.type) {
    case 'A':
    case 'AAAA':
    case 'CNAME':
      return { ...body, content: input.content, proxied: false };
    case 'TXT':
      return { ...body, content: input.content };
    case 'MX':
      return { ...body, content: input.content, priority: input.priority };
    case 'SRV':
      return { ...body, data: { ...input.srv } };
    case 'CAA':
      return { ...body, data: { ...input.caa } };
  }
}

function requireEditable(record: HostedDnsRecord): void {
  if (record.kind !== 'user') throw new AppError('forbidden', record.lockedReason);
}

/** 审计里展示的记录值，超长截断 */
function shown(record: HostedDnsRecord): string {
  const value = record.srv ? `${record.srv.priority} ${record.srv.weight} ${record.srv.port} ${record.srv.target}`
    : record.priority !== null ? `${record.priority} ${record.content}` : record.content;
  return value.length > AUDIT_VALUE_MAX ? `${value.slice(0, AUDIT_VALUE_MAX - 1)}…` : value;
}

export async function listHostedDnsRecords(env: Env, viewer: Viewer, id: number): Promise<HostedDnsRecord[]> {
  const zone = await openZone(env, viewer, id, 'list');
  const records = await cfCall(() => listDnsRecords(zone.creds, zone.zoneId));
  return records.map((record) => toRecord(record, zone.domain)).sort(byName);
}

export async function createHostedDnsRecord(
  env: Env, viewer: Viewer, id: number, input: HostedDnsRecordParsed, ip = '',
): Promise<HostedDnsRecord> {
  const zone = await openZone(env, viewer, id, 'create');
  const fqdn = checkInput(input, zone.domain);
  const existing = await cfCall(() => listDnsRecords(zone.creds, zone.zoneId));
  const used = existing.filter((record) => toRecord(record, zone.domain).kind !== 'mail').length;
  if (used >= MAX_HOSTED_DNS_RECORDS) throw new AppError('forbidden', `每个域名最多 ${MAX_HOSTED_DNS_RECORDS} 条解析记录`);
  const created = toRecord(await cfCall(() => createDnsRecord(zone.creds, zone.zoneId, cfBody(input, fqdn, true))), zone.domain);
  await logAdminAction(env, viewer, 'hosted_domain.dns', zone.domain, `新增 ${created.type} ${created.name} → ${shown(created)}`, ip);
  return created;
}

export async function updateHostedDnsRecord(
  env: Env, viewer: Viewer, id: number, recordId: string, input: HostedDnsRecordParsed, ip = '',
): Promise<HostedDnsRecord> {
  const zone = await openZone(env, viewer, id, 'update');
  // 先确认记录存在且可编辑（404/403），再校验类型与新内容（400）
  const before = toRecord(await cfCall(() => getDnsRecord(zone.creds, zone.zoneId, recordId)), zone.domain);
  requireEditable(before);
  if (before.type !== input.type) throw new AppError('validation_failed', '不能修改记录类型，请删除后重新添加');
  const fqdn = checkInput(input, zone.domain);
  const after = toRecord(await cfCall(() => updateDnsRecord(zone.creds, zone.zoneId, recordId, cfBody(input, fqdn, false))), zone.domain);
  const name = before.name === after.name ? after.name : `${before.name}→${after.name}`;
  await logAdminAction(env, viewer, 'hosted_domain.dns', zone.domain, `修改 ${after.type} ${name}：${shown(before)} → ${shown(after)}`, ip);
  return after;
}

export async function deleteHostedDnsRecord(env: Env, viewer: Viewer, id: number, recordId: string, ip = ''): Promise<void> {
  const zone = await openZone(env, viewer, id, 'delete');
  const record = toRecord(await cfCall(() => getDnsRecord(zone.creds, zone.zoneId, recordId)), zone.domain);
  requireEditable(record);
  await cfCall(() => deleteDnsRecord(zone.creds, zone.zoneId, recordId));
  await logAdminAction(env, viewer, 'hosted_domain.dns', zone.domain, `删除 ${record.type} ${record.name} → ${shown(record)}`, ip);
}
