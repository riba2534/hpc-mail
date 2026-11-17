/**
 * 系统域名接入的 Cloudflare 邮件配置：inspect（只读，不吞错）→ plan（纯函数，确认项与指纹）→ apply（带前置复核的写入）。
 * 与托管域名的 ensureMailConfig 完全独立：读取失败一律是 unknown 并停止相关写入，绝不推断为「不存在」；
 * 已有配置（第三方 MX、catch-all、SPF）只在管理员确认后才改；不调用 deleteZone、关闭 Routing 或删除发信子域。
 *
 * 【接口契约（PR5h 负责人定义，实现者不得改签名；需要改时先找负责人）】
 */
import {
  SYSTEM_DOMAIN_ACKS, SYSTEM_DOMAIN_WRITE_STEPS, type DnssecState, type SystemDomainAck, type SystemDomainCheck, type SystemDomainCheckKey,
  type SystemDomainCheckState, type SystemDomainRecordBrief, type SystemDomainRegistrar, type SystemDomainSeverity, type SystemDomainStepState,
  type SystemDomainVerdict, type SystemDomainWriteStep,
} from '@hpc-mail/shared';
import type { OnboardingAcceptance, OnboardingChangeEvent } from '../db/schema.js';
import { CF_SPF_INCLUDE, decodeTxtContent, isSpfContent, mergeCloudflareSpf } from '../lib/spf.js';
import {
  CloudflareApiError, createSendingSubdomain, deleteDnsRecord, enableRouting, getCatchAll, getDnsRecord, getRouting, getSendingDnsStatus,
  isOutcomeUnknown, listRoutingRules, listSendingSubdomains, putCatchAllWorker, queryDnsRecords, repairSendingDns, updateDnsRecord,
  type CfCatchAll, type CfDnsRecord, type CfPage, type CfRouting, type CfRoutingRule, type CfSendingDnsStatus, type CfSendingSubdomain,
  type CfZone, type CloudflareCredentials,
} from './cloudflare.js';

/** 一次读取：成功带值，失败带原始错误（调用方据此归类为 unknown，绝不当作不存在） */
export type CfRead<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** inspect 的原始读取结果（zone 已由调用方确认可见；zone 未激活时邮件相关读取可以跳过，记为 null） */
export interface MailInspection {
  domain: string;
  zone: CfZone;
  /** 本站 catch-all 的目标 Worker */
  workerName: string;
  routing: CfRead<CfRouting> | null;
  catchAll: CfRead<CfCatchAll> | null;
  rules: CfRead<CfPage<CfRoutingRule>> | null;
  /** 根域全部记录（name.exact=domain，MX / TXT / CNAME 等） */
  apex: CfRead<CfPage<CfDnsRecord>> | null;
  /** _dmarc.<domain> */
  dmarc: CfRead<CfPage<CfDnsRecord>> | null;
  /** *._domainkey.<domain> */
  dkim: CfRead<CfPage<CfDnsRecord>> | null;
  /** cf-bounce.<domain> 及其子域 */
  bounce: CfRead<CfPage<CfDnsRecord>> | null;
  /** 发信子域（按 name === domain 匹配）及其 DNS 状态；子域数量用于 30 个上限判断 */
  sending: CfRead<{ subdomain: CfSendingSubdomain | null; dnsStatus: CfSendingDnsStatus | null; count: number }> | null;
}

export interface ProvisionPolicy {
  /** created：本站新建的 zone（catch-all 属于本站，直接改写不需要确认）；linked / unknown：已有 zone */
  origin: 'created' | 'linked' | 'unknown';
}

/** 分项状态快照，供 D1 落库（routing_state / catch_all_state / sending_state 及 CF 原始状态） */
export interface MailStepSnapshot {
  routing: { state: SystemDomainStepState; status: string };
  catchAll: { state: SystemDomainStepState };
  sending: { state: SystemDomainStepState; status: string; tag: string | null };
}

export interface MailPlan {
  /** zone、token、mx、spf、routing、catchAll、rules、sending、sendingRecords、dmarc、dkim 等检查项（不含 D1 的 occupancy / capacity） */
  checks: SystemDomainCheck[];
  /** 计划执行的写入，已按执行顺序排列（SPF → catch-all → 删除已确认的第三方 MX → Routing → 发信子域 → 发信 DNS） */
  steps: { kind: SystemDomainWriteStep; detail: string }[];
  requiredAcks: SystemDomainAck[];
  /** 每个需确认项的观察值哈希（相关远端状态变化则不同） */
  observed: OnboardingAcceptance[];
  /** 只看 checks 得出的结论（调用方合并 D1 检查后可能变为 blocked） */
  verdict: SystemDomainVerdict;
  /** fingerprintOf(observed) */
  fingerprint: string;
  /** 远端已全部就绪，无需写入 */
  ready: boolean;
  snapshot: MailStepSnapshot;
}

// ---------------------------------------------------------------------------
// 通用小工具

const CF_MX_SUFFIX = '.mx.cloudflare.net';
/** Email Routing 写入的 DKIM selector */
const ROUTING_DKIM_SELECTOR = 'cf2024-1';
/** 每个 zone 中 Routing 与 Sending 的域名合计上限（Cloudflare 文档）；Routing 子域数量无法统计，只按发信子域判断 */
const SENDING_SUBDOMAIN_LIMIT = 30;

const read = <T>(promise: Promise<T>): Promise<CfRead<T>> =>
  promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const normHost = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');
const sameName = (a: string, b: string) => normHost(a) === normHost(b);

function apiError(error: unknown): CloudflareApiError | null {
  return error instanceof CloudflareApiError ? error : null;
}

/** 键排序后的 JSON，作为观察值与指纹的规范化输入 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const brief = (record: CfDnsRecord): SystemDomainRecordBrief => ({
  type: record.type, name: record.name, content: record.content, priority: record.priority ?? null, ttl: record.ttl ?? null,
});

const isCloudflareMx = (record: CfDnsRecord) => normHost(record.content).endsWith(CF_MX_SUFFIX);
/** RFC 7505 null MX：交换主机为 "." */
const isNullMx = (record: CfDnsRecord) => normHost(record.content) === '';
const mxLabel = (record: CfDnsRecord) => (isNullMx(record) ? `${record.priority ?? 0} .（null MX，声明不收信）` : `${record.priority ?? 0} ${normHost(record.content)}`);

/** catch-all 的目标描述 */
function catchAllTarget(rule: CfCatchAll | undefined): { action: 'worker' | 'forward' | 'drop' | 'other'; targets: string[] } {
  const action = rule?.actions?.[0];
  const type = action?.type;
  return { action: type === 'worker' || type === 'forward' || type === 'drop' ? type : 'other', targets: action?.value ?? [] };
}

function targetsWorker(rule: CfCatchAll | undefined, workerName: string): boolean {
  const action = rule?.actions?.[0];
  return rule?.enabled === true && action?.type === 'worker' && action.value?.[0] === workerName;
}

function describeAction(action: { type: string; value?: string[] } | undefined): string {
  const targets = (action?.value ?? []).join('、');
  if (action?.type === 'worker') return `交给 Worker ${targets}`;
  if (action?.type === 'forward') return `转发到 ${targets}`;
  if (action?.type === 'drop') return '丢弃';
  return action?.type ? `${action.type} ${targets}`.trim() : '未配置动作';
}

/** 读取失败的检查项：一律 unknown + blocker，停止写入 */
function readFailure(key: SystemDomainCheckKey, label: string, error: unknown): SystemDomainCheck {
  const api = apiError(error);
  let title = `读取${label}失败`;
  let impact = '读取失败时不做任何写入（不能把读取失败当作「不存在」），稍后重新检测';
  if (api?.status === 401) {
    title = `读取${label}失败：Cloudflare 凭据无效`;
    impact = '站长需要更新 Worker 的 Cloudflare 凭据（CF_HOSTED_DOMAINS_TOKEN）';
  } else if (api?.status === 403) {
    title = `本站 Cloudflare Token 无权读取${label}`;
    impact = '为 Token 补充对应的读写权限（Zone Settings、Email Routing Rules、DNS、Email Sending）后重新检测';
  } else if (api?.status === 429) {
    title = `读取${label}时 Cloudflare 接口限流`;
  }
  return check(key, 'unknown', 'blocker', title, { current: errorText(error), impact });
}

function check(
  key: SystemDomainCheckKey, state: SystemDomainCheckState, severity: SystemDomainSeverity, title: string,
  extra: Partial<Omit<SystemDomainCheck, 'key' | 'state' | 'severity' | 'title'>> = {},
): SystemDomainCheck {
  return { key, state, severity, ack: null, danger: false, title, current: null, proposed: null, impact: '', records: [], ...extra };
}

/** 分页读取：失败或未取全都按读取失败处理 */
function pageOf<T>(result: CfRead<CfPage<T>> | null): { items: T[] } | { error: unknown } {
  if (!result) return { error: new Error('未读取') };
  if (!result.ok) return { error: result.error };
  if (!result.value.complete) return { error: new Error('记录过多，未能读取完整') };
  return { items: result.value.items };
}

// ---------------------------------------------------------------------------
// inspect

async function readSending(creds: CloudflareCredentials, zoneId: string, domain: string) {
  const list = await listSendingSubdomains(creds, zoneId);
  const subdomain = list.find((item) => sameName(item.name, domain)) ?? null;
  const dnsStatus = subdomain && subdomain.enabled !== false ? await getSendingDnsStatus(creds, zoneId, subdomain.tag) : null;
  return { subdomain, dnsStatus, count: list.length };
}

/** 只读预检：并行读取，不吞错；zone 未激活时只返回 zone 本身 */
export async function inspectMailConfig(creds: CloudflareCredentials, zone: CfZone, domain: string): Promise<MailInspection> {
  const inspection: MailInspection = {
    domain, zone, workerName: creds.workerName,
    routing: null, catchAll: null, rules: null, apex: null, dmarc: null, dkim: null, bounce: null, sending: null,
  };
  if (zone.status !== 'active' || !sameName(zone.name, domain)) return inspection;
  const [routing, catchAll, rules, apex, dmarc, dkim, bounce, sending] = await Promise.all([
    read(getRouting(creds, zone.id)),
    read(getCatchAll(creds, zone.id)),
    read(listRoutingRules(creds, zone.id)),
    read(queryDnsRecords(creds, zone.id, { exact: domain })),
    read(queryDnsRecords(creds, zone.id, { exact: `_dmarc.${domain}` })),
    read(queryDnsRecords(creds, zone.id, { endsWith: `._domainkey.${domain}` })),
    read(queryDnsRecords(creds, zone.id, { endsWith: `cf-bounce.${domain}` })),
    read(readSending(creds, zone.id, domain)),
  ]);
  return { ...inspection, routing, catchAll, rules, apex, dmarc, dkim, bounce, sending };
}

// ---------------------------------------------------------------------------
// 分析：plan 与 apply 共用同一份判定

interface Analysis {
  foreignMx: CfDnsRecord[];
  spf: CfDnsRecord | null;
  spfMerged: string | null;
  catchAllBefore: CfCatchAll | null;
  routingEnabled: boolean | null;
  sendingTag: string | null;
  sendingConnected: boolean;
}

function analyze(inspection: MailInspection): Analysis {
  const apex = inspection.apex?.ok && inspection.apex.value.complete ? inspection.apex.value.items : [];
  const apexOf = (type: string) => apex.filter((r) => r.type === type && sameName(r.name, inspection.domain));
  const foreignMx = apexOf('MX').filter((r) => !isCloudflareMx(r));
  const spfRecords = apexOf('TXT').filter((r) => isSpfContent(r.content));
  const spf = spfRecords.length === 1 ? spfRecords[0]! : null;
  const merge = spf ? mergeCloudflareSpf(spf.content) : null;
  const sending = inspection.sending?.ok ? inspection.sending.value : null;
  return {
    foreignMx,
    spf,
    spfMerged: merge?.status === 'merged' ? merge.merged : null,
    catchAllBefore: inspection.catchAll?.ok ? inspection.catchAll.value : null,
    routingEnabled: inspection.routing?.ok ? inspection.routing.value.enabled : null,
    sendingTag: sending?.subdomain && sending.subdomain.enabled !== false ? sending.subdomain.tag : null,
    sendingConnected: Boolean(sending?.subdomain && sending.subdomain.enabled !== false),
  };
}

/** 写回 TXT 时沿用原记录的引号风格 */
function txtLike(original: string, value: string): string {
  return original.trim().startsWith('"') ? `"${value}"` : value;
}

// ---------------------------------------------------------------------------
// plan

/** 纯函数（哈希为异步）：把读取结果变成检查项、计划与指纹 */
export async function planMailChanges(inspection: MailInspection, policy: ProvisionPolicy): Promise<MailPlan> {
  const { domain, zone, workerName } = inspection;
  const checks: SystemDomainCheck[] = [];
  const observedInputs: { ack: SystemDomainAck; evidence: unknown }[] = [];
  const steps = new Map<SystemDomainWriteStep, string>();
  const confirm = (item: SystemDomainCheck, ack: SystemDomainAck, evidence: unknown, danger = false) => {
    checks.push({ ...item, severity: 'confirm', ack, danger });
    observedInputs.push({ ack, evidence });
  };

  // zone
  const active = zone.status === 'active';
  if (!sameName(zone.name, domain)) {
    checks.push(check('zone', 'conflict', 'blocker', '只支持 zone 的根域', {
      current: `${domain} 属于 zone ${zone.name}`, impact: 'catch-all 只支持根域，请接入 zone 本身的域名',
    }));
  } else if (zone.type && zone.type !== 'full') {
    checks.push(check('zone', 'conflict', 'blocker', `zone 的接入方式是 ${zone.type}，不能开启邮件路由`, {
      current: zone.type, impact: 'Email Routing 需要 Cloudflare 完整托管 DNS（full），请在 Cloudflare 改为完整接入后重新检测',
    }));
  } else if (zone.status === 'moved') {
    checks.push(check('zone', 'conflict', 'blocker', '域名的 NS 已不再指向 Cloudflare', {
      current: 'moved', impact: '请先把 NS 改回 Cloudflare 分配的名称服务器，或在 Cloudflare 重新激活该 zone',
    }));
  } else if (!active) {
    checks.push(check('zone', 'missing', 'info', '等待 Cloudflare 激活（NS 尚未生效）', {
      current: zone.status, proposed: (zone.name_servers ?? []).join(' / ') || null,
      impact: 'NS 生效后系统自动继续配置；收发配置要等 zone 激活后才能写入',
    }));
  } else if (zone.paused) {
    checks.push(check('zone', 'ok', 'info', 'zone 已暂停：只影响代理与安全功能，DNS 与邮件路由不受影响', { current: 'paused' }));
  } else {
    checks.push(check('zone', 'ok', 'none', 'zone 已在 Cloudflare 生效', { current: zone.status }));
  }

  if (!active || !sameName(zone.name, domain)) {
    const observed: OnboardingAcceptance[] = [];
    const blocked = checks.some((c) => c.severity === 'blocker');
    const waiting = { state: 'waiting' as const };
    return {
      checks, steps: [], requiredAcks: [], observed, verdict: blocked ? 'blocked' : 'pending',
      fingerprint: await fingerprintOf(observed), ready: false,
      snapshot: { routing: { ...waiting, status: '' }, catchAll: waiting, sending: { ...waiting, status: '', tag: null } },
    };
  }

  // token：任一读取 401 说明凭据失效
  const reads = [inspection.routing, inspection.catchAll, inspection.rules, inspection.apex, inspection.dmarc, inspection.dkim, inspection.bounce, inspection.sending];
  const unauthorized = reads.find((r) => r && !r.ok && apiError(r.error)?.status === 401);
  checks.push(unauthorized && !unauthorized.ok
    ? check('token', 'conflict', 'blocker', '本站 Cloudflare 凭据已失效', { current: errorText(unauthorized.error), impact: '站长需要更新 Worker 的 Cloudflare 凭据（CF_HOSTED_DOMAINS_TOKEN）后重新检测' })
    : check('token', 'ok', 'none', 'Cloudflare 凭据可用'));

  const facts = analyze(inspection);
  const apexPage = pageOf(inspection.apex);
  const apexRecords = 'items' in apexPage ? apexPage.items.filter((r) => sameName(r.name, domain)) : null;

  // mx
  if (!apexRecords) checks.push(readFailure('mx', '根域 MX 记录', (apexPage as { error: unknown }).error));
  else if (facts.foreignMx.length) {
    const hosts = facts.foreignMx.map((r) => (isNullMx(r) ? 'null MX' : normHost(r.content)));
    confirm(check('mx', 'conflict', 'confirm', `根域有 ${facts.foreignMx.length} 条其他邮件服务的 MX，需要删除`, {
      current: facts.foreignMx.map(mxLabel).join('；'),
      proposed: '删除这些 MX，改由 Cloudflare Email Routing 收信（route1/2/3.mx.cloudflare.net）',
      impact: `该域名将不再经 ${hosts.join('、')} 收信，原邮箱服务（例如企业邮箱）收不到这个域名的新邮件；原记录会写进变更台账，可手动恢复`,
      records: facts.foreignMx.map(brief),
    }), 'mx.delete', facts.foreignMx.map((r) => [normHost(r.content), r.priority ?? 0]).sort(), true);
    steps.set('mx.delete', `删除 ${facts.foreignMx.length} 条第三方 MX：${hosts.join('、')}`);
  } else if (apexRecords.some((r) => r.type === 'MX')) {
    checks.push(check('mx', 'ok', 'none', 'MX 已指向 Cloudflare Email Routing'));
  } else {
    checks.push(check('mx', 'missing', 'none', '没有 MX，开启收件路由时由 Cloudflare 写入'));
  }

  // spf
  if (!apexRecords) checks.push(readFailure('spf', '根域 SPF 记录', (apexPage as { error: unknown }).error));
  else {
    const spfRecords = apexRecords.filter((r) => r.type === 'TXT' && isSpfContent(r.content));
    if (spfRecords.length === 0) checks.push(check('spf', 'missing', 'none', '没有 SPF，开启收件路由时由 Cloudflare 创建'));
    else if (spfRecords.length > 1) {
      checks.push(check('spf', 'conflict', 'blocker', `根域有 ${spfRecords.length} 条 SPF，域名只能有一条`, {
        impact: '多条 SPF 会让 SPF 校验全部失败，请先在 Cloudflare 手动合并为一条后重新检测', records: spfRecords.map(brief),
      }));
    } else {
      const record = spfRecords[0]!;
      const merge = mergeCloudflareSpf(record.content);
      if (merge.status === 'present') checks.push(check('spf', 'ok', 'none', 'SPF 已包含 Cloudflare 收件路由', { current: decodeTxtContent(record.content) }));
      else if (merge.status === 'manual') {
          checks.push(check('spf', 'conflict', 'blocker', '已有的 SPF 无法自动合并', {
          current: decodeTxtContent(record.content), impact: `${merge.reason ?? ''}；请在 Cloudflare 手动加入 include:${CF_SPF_INCLUDE} 后重新检测`, records: [brief(record)],
        }));
      } else {
        confirm(check('spf', 'conflict', 'confirm', '合并已有的 SPF', {
          current: decodeTxtContent(record.content), proposed: merge.merged,
          impact: ['合并后 Cloudflare 的转发服务器能通过 SPF 校验，原有机制的匹配结果不变', ...merge.warnings].join('；'),
          records: [brief(record)],
        }), 'spf.merge', [record.id, decodeTxtContent(record.content)]);
        steps.set('spf.merge', `在 SPF 中加入 include:${CF_SPF_INCLUDE}`);
      }
    }
  }

  // routing
  let routingState: SystemDomainStepState = 'unknown';
  const routingStatus = inspection.routing?.ok ? inspection.routing.value.status ?? '' : '';
  if (!inspection.routing?.ok) checks.push(readFailure('routing', '收件路由设置', inspection.routing?.error));
  else {
    const routing = inspection.routing.value;
    const pendingFix = steps.has('mx.delete') || steps.has('spf.merge');
    if (routing.enabled && routing.status === 'ready' && !pendingFix) {
      routingState = 'ready';
      checks.push(check('routing', 'ok', 'none', '收件路由已开启'));
    } else if (routing.enabled && routing.status === 'unlocked' && !pendingFix) {
      routingState = 'ready';
      checks.push(check('routing', 'ok', 'info', '收件路由已开启（记录已被手动解锁，本站不会重新锁定）', { current: 'unlocked' }));
    } else {
      routingState = 'missing';
      const current = routing.enabled ? `已开启，状态 ${routing.status}` : '未开启';
      checks.push(check('routing', 'missing', 'none', routing.enabled ? '收件路由需要重新写入记录' : '将开启收件路由（写入并锁定 MX、SPF、DKIM）', {
        current, proposed: '已开启，状态 ready',
      }));
      steps.set('routing.enable', routing.enabled ? '重新写入收件路由记录' : '开启 Email Routing');
    }
  }

  // catch-all
  let catchAllState: SystemDomainStepState = 'unknown';
  if (!inspection.catchAll?.ok) checks.push(readFailure('catchAll', 'catch-all 规则', inspection.catchAll?.error));
  else {
    const rule = inspection.catchAll.value;
    const target = catchAllTarget(rule);
    if (targetsWorker(rule, workerName)) {
      catchAllState = 'ready';
      checks.push(check('catchAll', 'ok', 'none', `catch-all 已投递到本站（Worker ${workerName}）`));
    } else if (rule.source === 'wrangler') {
      catchAllState = 'conflict';
      checks.push(check('catchAll', 'conflict', 'blocker', 'catch-all 由其他 Worker 的 Wrangler 配置管理', {
        current: describeAction(rule.actions?.[0]),
        impact: '接管会让那个 Worker 在下次部署时报接管冲突。请先在那个 Worker 的 wrangler 配置中去掉该域名的 addresses 并重新部署，再重新检测',
      }));
    } else if (rule.enabled === true) {
      const current = describeAction(rule.actions?.[0]);
      const impact = target.action === 'worker'
        ? `Worker ${target.targets.join('、') || '（未知）'} 将收不到这个域名的信`
        : target.action === 'forward'
          ? `未匹配地址的来信不再转发到 ${target.targets.join('、')}（如需继续转发，可在本站个人通知里设置邮箱转发）`
          : target.action === 'drop'
            ? '未匹配地址的来信将进入本站，而不是被丢弃'
            : '原 catch-all 规则将被替换';
      if (policy.origin === 'created') {
        catchAllState = 'missing';
        checks.push(check('catchAll', 'missing', 'none', 'catch-all 将改为投递到本站', { current, proposed: `交给 Worker ${workerName}` }));
      } else {
        catchAllState = 'conflict';
        confirm(check('catchAll', 'conflict', 'confirm', '替换 catch-all 规则', {
          current, proposed: `交给 Worker ${workerName}`, impact,
        }), 'catchAll.replace', { enabled: rule.enabled ?? null, actions: rule.actions ?? [], source: rule.source ?? null });
      }
      steps.set('catchAll.put', `catch-all 改为交给 Worker ${workerName}`);
    } else {
      catchAllState = 'missing';
      checks.push(check('catchAll', 'missing', 'none', '将开启 catch-all，未匹配地址的来信进入本站', {
        current: '未启用', proposed: `交给 Worker ${workerName}`,
      }));
      steps.set('catchAll.put', `开启 catch-all，交给 Worker ${workerName}`);
    }
  }

  // 专用地址规则：只统计启用中的
  const rulesPage = pageOf(inspection.rules);
  if (!('items' in rulesPage)) checks.push(readFailure('rules', '专用地址规则', rulesPage.error));
  else {
    const suffix = `@${domain}`.toLowerCase();
    const bypass = rulesPage.items.filter((rule) => rule.enabled
      && rule.matchers.some((m) => m.type === 'literal' && (m.field ?? 'to') === 'to' && (m.value ?? '').toLowerCase().endsWith(suffix))
      && !(rule.actions[0]?.type === 'worker' && rule.actions[0].value?.[0] === workerName));
    if (bypass.length) {
      const lines = bypass.map((rule) => `${rule.matchers.find((m) => m.type === 'literal')?.value ?? ''} → ${describeAction(rule.actions[0])}`);
      confirm(check('rules', 'conflict', 'confirm', `有 ${bypass.length} 条专用地址规则优先于 catch-all`, {
        current: lines.join('；'),
        impact: '这些地址的来信不会进入本站；本站不修改这些规则，也不限制认领',
      }), 'rules.bypass', bypass.map((rule) => ({ id: rule.id, matchers: rule.matchers, actions: rule.actions }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)));
    } else checks.push(check('rules', 'ok', 'none', '没有会拦截来信的专用地址规则'));
  }

  // 发信子域
  let sendingState: SystemDomainStepState = 'unknown';
  let sendingStatus = '';
  if (!inspection.sending?.ok) {
    const api = apiError(inspection.sending?.error);
    if (api?.status === 403 && api.has(10105)) {
      checks.push(check('sending', 'conflict', 'blocker', '账户未开通 Email Sending', { impact: '需要 Workers Paid 计划并在 Cloudflare 开通 Email Sending 后重新检测' }));
    } else if (api?.status === 403 && api.has(10203)) {
      checks.push(check('sending', 'conflict', 'blocker', '该 zone 或账户的发信已被 Cloudflare 停用', { impact: '请在 Cloudflare 控制台恢复发信后重新检测' }));
    } else checks.push(readFailure('sending', '发信配置（Email Sending）', inspection.sending?.error));
  } else {
    const { subdomain, dnsStatus, count } = inspection.sending.value;
    sendingStatus = dnsStatus?.status ?? '';
    if (!subdomain || subdomain.enabled === false) {
      if (!subdomain && count >= SENDING_SUBDOMAIN_LIMIT) {
        sendingState = 'conflict';
        checks.push(check('sending', 'conflict', 'blocker', `该 zone 的发信子域已达 ${SENDING_SUBDOMAIN_LIMIT} 个上限`, { impact: '请先在 Cloudflare 删除不用的发信子域' }));
      } else {
        sendingState = 'missing';
        checks.push(check('sending', 'missing', 'none', subdomain ? '将重新启用发信' : '将接入发信（Email Sending）'));
        steps.set('sending.create', subdomain ? '重新启用发信子域' : '创建发信子域');
      }
    } else if (dnsStatus?.status === 'ready') {
      sendingState = 'ready';
      checks.push(check('sending', 'ok', 'none', '发信已就绪'));
    } else {
      sendingState = 'missing';
      checks.push(check('sending', 'missing', 'none', '将补写发信 DNS 记录', { current: dnsStatus?.status ?? null }));
      steps.set('sending.repair', '补写发信 DNS 记录');
    }
  }

  // cf-bounce 与 DKIM：尚未接入发信时，这些名称上已有的记录都是外来的
  const bouncePage = pageOf(inspection.bounce);
  const dkimPage = pageOf(inspection.dkim);
  if (!('items' in bouncePage)) checks.push(readFailure('sendingRecords', '发信退信域记录', bouncePage.error));
  else if (!('items' in dkimPage)) checks.push(readFailure('sendingRecords', 'DKIM 记录', dkimPage.error));
  else {
    const bounceName = `cf-bounce.${domain}`;
    const foreign = facts.sendingConnected ? [] : [
      ...bouncePage.items.filter((r) => sameName(r.name, bounceName) || normHost(r.name).endsWith(`.${bounceName}`)),
      ...dkimPage.items.filter((r) => sameName(r.name, `cf-bounce._domainkey.${domain}`)),
    ];
    if (foreign.length) {
      if (sendingState === 'missing') sendingState = 'conflict';
      checks.push(check('sendingRecords', 'conflict', 'blocker', 'cf-bounce 上已有其他记录，接入发信会冲突', {
        impact: '请先在 Cloudflare 删除这些记录后重新检测', records: foreign.map(brief),
      }));
    } else checks.push(check('sendingRecords', 'ok', 'none', '发信需要的记录名称没有冲突'));
  }

  // DKIM：Routing 未开启时 cf2024-1 selector 上已有记录是外来的
  if (!('items' in dkimPage)) checks.push(readFailure('dkim', 'DKIM 记录', dkimPage.error));
  else {
    const routingName = `${ROUTING_DKIM_SELECTOR}._domainkey.${domain}`;
    const routingSelector = dkimPage.items.filter((r) => sameName(r.name, routingName));
    const others = [...new Set(dkimPage.items.map((r) => normHost(r.name).split('._domainkey.')[0]!)
      .filter((selector) => selector !== ROUTING_DKIM_SELECTOR && selector !== 'cf-bounce'))];
    if (routingSelector.length && facts.routingEnabled === false) {
      checks.push(check('dkim', 'conflict', 'blocker', `${ROUTING_DKIM_SELECTOR}._domainkey 上已有其他记录`, {
        impact: '收件路由要在这个名称写入 DKIM，请先在 Cloudflare 删除该记录后重新检测', records: routingSelector.map(brief),
      }));
    } else {
      checks.push(check('dkim', 'ok', 'none', others.length ? `已有其他 DKIM selector（${others.join('、')}），名称不同，不冲突` : 'DKIM 没有冲突'));
    }
  }

  // DMARC：没有时接入发信会写入 p=reject；只有存在其他邮件服务的迹象时才需要知情确认
  const dmarcPage = pageOf(inspection.dmarc);
  if (!('items' in dmarcPage)) checks.push(readFailure('dmarc', 'DMARC 记录', dmarcPage.error));
  else {
    const records = dmarcPage.items.filter((r) => r.type === 'TXT' && sameName(r.name, `_dmarc.${domain}`));
    if (records.length > 1) {
      checks.push(check('dmarc', 'ok', 'info', `有 ${records.length} 条 DMARC，多条等于没有 DMARC`, { records: records.map(brief) }));
    } else if (records.length === 1) {
      checks.push(check('dmarc', 'ok', 'none', '已有 DMARC，接入发信时 Cloudflare 会保留', { current: decodeTxtContent(records[0]!.content) }));
    } else {
      const otherMail = facts.foreignMx.length > 0 || Boolean(facts.spf && otherSpfMechanisms(facts.spf.content));
      const base = check('dmarc', 'missing', 'info', '没有 DMARC，接入发信时 Cloudflare 会写入 p=reject', {
        proposed: 'v=DMARC1; p=reject;',
        impact: '如果该域名还经其他服务发信、且没有 DKIM 对齐，那些邮件会被收件方拒收',
      });
      if (otherMail) confirm(base, 'dmarc.create', { domain, otherMail });
      else checks.push(base);
    }
  }

  const blockers = checks.some((c) => c.severity === 'blocker');
  const observed = await Promise.all(observedInputs.map(async ({ ack, evidence }) => ({ ack, observed: await sha256Hex(stableStringify(evidence)) })));
  observed.sort((a, b) => SYSTEM_DOMAIN_ACKS.indexOf(a.ack) - SYSTEM_DOMAIN_ACKS.indexOf(b.ack));
  const orderedSteps = SYSTEM_DOMAIN_WRITE_STEPS.filter((kind) => steps.has(kind)).map((kind) => ({ kind, detail: steps.get(kind)! }));
  const snapshot: MailStepSnapshot = {
    routing: { state: routingState, status: routingStatus },
    catchAll: { state: catchAllState },
    sending: { state: sendingState, status: sendingStatus, tag: facts.sendingTag },
  };
  return {
    checks,
    steps: orderedSteps,
    requiredAcks: observed.map((item) => item.ack),
    observed,
    verdict: blockers ? 'blocked' : observed.length ? 'confirm' : 'ready',
    fingerprint: await fingerprintOf(observed),
    ready: !blockers && orderedSteps.length === 0 && routingState === 'ready' && catchAllState === 'ready' && sendingState === 'ready',
    snapshot,
  };
}

/** SPF 里除本站 include 与 all 以外还有其他机制：说明另有发信服务 */
function otherSpfMechanisms(content: string): boolean {
  return decodeTxtContent(content).trim().split(/\s+/).slice(1)
    .some((term) => !/^[+?~-]?all$/i.test(term) && !/^[+?~-]?include:_spf\.mx\.cloudflare\.net\.?$/i.test(term));
}

/** 指纹：所有需确认项 [ack, observed] 排序后的 sha256（十六进制） */
export async function fingerprintOf(observed: readonly OnboardingAcceptance[]): Promise<string> {
  const pairs = observed.map((item) => [item.ack, item.observed]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return sha256Hex(JSON.stringify(pairs));
}

/** 写前门禁：blocker 项，以及 ack 与观察值不在 accepted 中（两者都要一致）的需确认项 */
export function gatePlan(plan: Pick<MailPlan, 'checks' | 'observed'>, accepted: readonly OnboardingAcceptance[]): {
  blockers: SystemDomainCheck[];
  unconfirmed: SystemDomainAck[];
} {
  return {
    blockers: plan.checks.filter((item) => item.severity === 'blocker'),
    unconfirmed: plan.observed
      .filter((item) => !accepted.some((ok) => ok.ack === item.ack && ok.observed === item.observed))
      .map((item) => item.ack),
  };
}

// ---------------------------------------------------------------------------
// apply

export interface ApplyHooks {
  /** 每次远端写入前调用（心跳 + 取消检查）：返回 false 表示租约已丢失或已请求取消，立即停止、不再发起写入 */
  beforeWrite(step: SystemDomainWriteStep): Promise<boolean>;
  /** 追加台账事件（不受租约约束）；seq 省略时分配新的并返回 */
  record(event: Omit<OnboardingChangeEvent, 'seq' | 'at'> & { seq?: number }): Promise<number>;
  /** 墙钟截止时间（ms）：到点后不再开始新的写入，返回 stopped */
  deadline: number;
}

export interface MailApplyResult {
  /**
   * ready：写入后复读全部就绪；progress：有进展但尚未就绪（例如发信 DNS 未生效），下一轮继续；
   * needs_confirmation：远端出现新的需确认项（例如 Routing 返回 2008：预检后又出现第三方 MX）；
   * blocked：确定性失败或缺少权限；transient：瞬时错误，退避重试；stopped：租约丢失、已取消或到截止时间
   */
  outcome: 'ready' | 'progress' | 'needs_confirmation' | 'blocked' | 'transient' | 'stopped';
  done: SystemDomainWriteStep[];
  failedStep: SystemDomainWriteStep | null;
  /** 机器可读原因：mx_removed_routing_pending、mx_conflict、cf_permission、cf_transient、sending_not_enabled、sending_dns_conflict 等；无为空串 */
  errorCode: string;
  /** 中文说明；无为空串 */
  error: string;
  /** 写入后复读得到的分项状态 */
  snapshot: MailStepSnapshot;
  /** 收到 Cloudflare 429 时的 retry-after 秒数（没有该头时为 0），调用方据此设置全局退避 */
  retryAfter?: number;
}

/** 一步写入的结果：done 完成；skip 远端已是目标值（无需写入）；其余为停止原因 */
type StepResult =
  | { kind: 'done' }
  | { kind: 'stopped' }
  | { kind: 'drift'; message: string }
  | { kind: 'error'; error: unknown };

/** 写入后读到的远端状态：target 已是目标值；original 仍是写入前的值；other 第三种值（有人并发修改） */
type Verified = 'target' | 'original' | 'other';

const STEP_LABEL: Record<SystemDomainWriteStep, string> = {
  'spf.merge': '合并 SPF',
  'catchAll.put': '配置 catch-all',
  'mx.delete': '删除第三方 MX',
  'routing.enable': '开启收件路由',
  'sending.create': '接入发信',
  'sending.repair': '补写发信 DNS 记录',
};

const PERMISSION_LABEL: Record<SystemDomainWriteStep, string> = {
  'spf.merge': 'DNS: Edit',
  'catchAll.put': 'Email Routing Rules: Edit',
  'mx.delete': 'DNS: Edit',
  'routing.enable': 'Zone Settings: Edit',
  'sending.create': 'Email Sending: Edit',
  'sending.repair': 'Email Sending: Edit',
};

/**
 * 按计划写入（调用方已通过 gatePlan）。每步：beforeWrite → 台账 started → 写 → done；
 * 结果不明时先读远端：已是目标值记 done，仍是原值重试 1 次，第三种值返回 needs_confirmation。
 * 删除第三方 MX 与开启 Routing 必须紧挨着执行，Routing 失败返回 blocked + mx_removed_routing_pending。
 */
export async function applyMailPlan(
  creds: CloudflareCredentials, inspection: MailInspection, plan: MailPlan, hooks: ApplyHooks,
): Promise<MailApplyResult> {
  const zoneId = inspection.zone.id;
  const { domain, workerName } = inspection;
  const facts = analyze(inspection);
  const planned = new Set(plan.steps.map((step) => step.kind));
  const done: SystemDomainWriteStep[] = [];
  let snapshot = plan.snapshot;
  let mxDeleted = false;

  /** 执行一步写入：beforeWrite → started → exec；结果不明时 verify，原值重试 1 次 */
  async function write(step: SystemDomainWriteStep, opts: {
    target?: string; before?: unknown; exec: () => Promise<unknown>; verify: () => Promise<Verified>;
  }): Promise<StepResult> {
    if (Date.now() >= hooks.deadline) return { kind: 'stopped' };
    if (!(await hooks.beforeWrite(step))) return { kind: 'stopped' };
    const seq = await hooks.record({ kind: step, status: 'started', ...(opts.target ? { target: opts.target } : {}), ...(opts.before === undefined ? {} : { before: opts.before }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await opts.exec();
        await hooks.record({ seq, kind: step, status: 'done' });
        return { kind: 'done' };
      } catch (error) {
        if (!isOutcomeUnknown(error)) {
          await hooks.record({ seq, kind: step, status: 'failed', error: errorText(error) });
          return { kind: 'error', error };
        }
        let verified: Verified;
        try {
          verified = await opts.verify();
        } catch (readError) {
          await hooks.record({ seq, kind: step, status: 'unknown', error: errorText(error) });
          return { kind: 'error', error: isOutcomeUnknown(readError) ? readError : error };
        }
        if (verified === 'target') {
          await hooks.record({ seq, kind: step, status: 'done' });
          return { kind: 'done' };
        }
        if (verified === 'other') {
          await hooks.record({ seq, kind: step, status: 'unknown', error: '写入结果不明，且远端已被改成其他值' });
          return { kind: 'drift', message: `${STEP_LABEL[step]}时远端配置被改成了其他值，需要重新确认` };
        }
        // 仍是原值：写入没有生效，重试 1 次（重试前再过一次心跳）
        if (attempt === 1 || !(await hooks.beforeWrite(step))) {
          await hooks.record({ seq, kind: step, status: 'unknown', error: errorText(error) });
          return attempt === 1 ? { kind: 'error', error } : { kind: 'stopped' };
        }
      }
    }
    return { kind: 'stopped' };
  }

  const finish = async (outcome: MailApplyResult['outcome'], failedStep: SystemDomainWriteStep | null = null,
    errorCode = '', error = '', retryAfter?: number): Promise<MailApplyResult> => {
    if (outcome !== 'stopped') snapshot = await readSnapshot(creds, zoneId, domain, workerName, snapshot);
    const ready = snapshot.routing.state === 'ready' && snapshot.catchAll.state === 'ready' && snapshot.sending.state === 'ready';
    if (outcome === 'progress' && ready) outcome = 'ready';
    if (outcome === 'ready' && !ready) outcome = 'progress';
    return { outcome, done, failedStep, errorCode, error, snapshot, ...(retryAfter === undefined ? {} : { retryAfter }) };
  };

  /** 把一步的失败归类为结果 */
  const fail = (step: SystemDomainWriteStep, result: Exclude<StepResult, { kind: 'done' }>): Promise<MailApplyResult> => {
    if (result.kind === 'stopped') return finish('stopped', step);
    if (result.kind === 'drift') return finish('needs_confirmation', step, 'remote_changed', result.message);
    const api = apiError(result.error);
    const message = `${STEP_LABEL[step]}失败：${errorText(result.error)}`;
    const retryAfter = api?.status === 429 ? api.retryAfter ?? 0 : undefined;
    if (step === 'routing.enable' && api?.has(2008)) {
      return finish('needs_confirmation', step, 'mx_conflict', '根域又出现了其他邮件服务的 MX，需要重新确认');
    }
    // 删掉 MX 后路由没开起来：这个域名暂时收不了信，界面红字提示，按最短间隔重试
    if (step === 'routing.enable' && mxDeleted) {
      return finish('blocked', step, 'mx_removed_routing_pending', `MX 已删除，路由尚未开启：${errorText(result.error)}`, retryAfter);
    }
    if (retryAfter !== undefined) return finish('transient', step, 'cf_transient', message, retryAfter);
    if (!api || isOutcomeUnknown(result.error)) return finish('transient', step, 'cf_transient', message);
    if (api.status === 401) return finish('blocked', step, 'cf_auth', '本站 Cloudflare 凭据已失效，站长需要更新 Worker 的 Cloudflare 凭据');
    if (api.status === 403 && api.has(10105)) return finish('blocked', step, 'sending_not_enabled', '账户未开通 Email Sending');
    if (api.status === 403) return finish('blocked', step, 'cf_permission', `本站 Cloudflare Token 缺少 ${PERMISSION_LABEL[step]} 权限：${errorText(result.error)}`);
    if (api.has(2009)) return finish('blocked', step, 'zone_not_active', 'zone 尚未激活');
    if (step === 'sending.repair' && api.status === 409) {
      return finish('blocked', step, 'sending_dns_conflict', '发信记录与已有记录冲突，请在 Cloudflare 删除 cf-bounce 上的其他记录');
    }
    return finish('blocked', step, 'cf_rejected', message);
  };

  // S1 合并 SPF（放在开启 Routing 之前，开启时 Cloudflare 看到的已经是唯一且包含 include 的 SPF）
  if (planned.has('spf.merge') && facts.spf && facts.spfMerged) {
    const record = facts.spf;
    const merged = facts.spfMerged;
    const result = await write('spf.merge', {
      target: record.id, before: { id: record.id, content: record.content },
      exec: () => updateDnsRecord(creds, zoneId, record.id, { content: txtLike(record.content, merged) }),
      verify: async () => {
        const now = decodeTxtContent((await getDnsRecord(creds, zoneId, record.id)).content);
        return now === merged ? 'target' : now === decodeTxtContent(record.content) ? 'original' : 'other';
      },
    });
    if (result.kind !== 'done') return fail('spf.merge', result);
    done.push('spf.merge');
  }

  // S2 catch-all（放在开启 Routing 之前：MX 生效时未匹配地址已经有去处，不会退信）
  const catchAll = () => write('catchAll.put', {
    target: zoneId, before: facts.catchAllBefore ?? undefined,
    exec: () => putCatchAllWorker(creds, zoneId, workerName),
    verify: async () => {
      const now = await getCatchAll(creds, zoneId);
      if (targetsWorker(now, workerName)) return 'target';
      const before = facts.catchAllBefore;
      return stableStringify({ enabled: now.enabled ?? null, actions: now.actions ?? [] })
        === stableStringify({ enabled: before?.enabled ?? null, actions: before?.actions ?? [] }) ? 'original' : 'other';
    },
  });
  let catchAllDeferred = false;
  if (planned.has('catchAll.put')) {
    const result = await catchAll();
    if (result.kind === 'done') done.push('catchAll.put');
    else if (result.kind === 'error' && facts.routingEnabled === false && isRoutingPrecondition(result.error)) {
      // Routing 未开启时 Cloudflare 可能拒绝写 catch-all：降级为开启 Routing 后立即重做
      catchAllDeferred = true;
    } else return fail('catchAll.put', result);
  }

  // S2b 删除已确认的第三方 MX，之后必须紧接着开启 Routing（中间没有 MX，收不了信）
  if (planned.has('mx.delete')) {
    for (const record of facts.foreignMx) {
      const result = await write('mx.delete', {
        target: record.id, before: { name: record.name, content: record.content, priority: record.priority ?? null, ttl: record.ttl },
        exec: () => deleteDnsRecord(creds, zoneId, record.id),
        verify: async () => {
          try {
            const now = await getDnsRecord(creds, zoneId, record.id);
            return now.content === record.content ? 'original' : 'other';
          } catch (error) {
            if (apiError(error)?.status === 404 || apiError(error)?.has(81044)) return 'target';
            throw error;
          }
        },
      });
      if (result.kind !== 'done') {
        // 已经删掉一部分 MX：后续必须尽快开启 Routing
        if (mxDeleted) return finish('blocked', 'mx.delete', 'mx_removed_routing_pending', `部分 MX 已删除，路由尚未开启：${STEP_LABEL['mx.delete']}未完成`);
        return fail('mx.delete', result);
      }
      mxDeleted = true;
    }
    done.push('mx.delete');
  }

  // S3 开启 Routing（根域传 {}）
  if (planned.has('routing.enable') || mxDeleted || catchAllDeferred) {
    const result = await write('routing.enable', {
      target: zoneId,
      exec: () => enableRouting(creds, zoneId),
      verify: async () => ((await getRouting(creds, zoneId)).enabled ? 'target' : 'original'),
    });
    if (result.kind !== 'done') {
      if (mxDeleted && result.kind === 'stopped') {
        return finish('blocked', 'routing.enable', 'mx_removed_routing_pending', 'MX 已删除，路由尚未开启（处理被中断）');
      }
      return fail('routing.enable', result);
    }
    done.push('routing.enable');
  }
  if (catchAllDeferred) {
    const result = await catchAll();
    if (result.kind !== 'done') return fail('catchAll.put', result);
    done.push('catchAll.put');
  }

  // S4 接入发信：先按名称查，已启用视为完成，不盲目重复创建
  let tag = facts.sendingTag;
  if (planned.has('sending.create')) {
    const find = async () => (await listSendingSubdomains(creds, zoneId)).find((item) => sameName(item.name, domain) && item.enabled !== false) ?? null;
    const result = await write('sending.create', {
      target: domain,
      exec: async () => { tag = (await createSendingSubdomain(creds, zoneId, domain)).tag; },
      verify: async () => {
        const found = await find();
        if (found) tag = found.tag;
        return found ? 'target' : 'original';
      },
    });
    if (result.kind !== 'done') return fail('sending.create', result);
    done.push('sending.create');
  }

  // S5 补写发信 DNS：创建后先看状态，未就绪才修复
  if (tag && (planned.has('sending.repair') || planned.has('sending.create'))) {
    const sendingTag = tag;
    let status: string | null = null;
    try {
      status = (await getSendingDnsStatus(creds, zoneId, sendingTag)).status;
    } catch {
      status = null;
    }
    if (status !== 'ready') {
      const result = await write('sending.repair', {
        target: sendingTag,
        exec: () => repairSendingDns(creds, zoneId, sendingTag),
        verify: async () => ((await getSendingDnsStatus(creds, zoneId, sendingTag)).status === 'ready' ? 'target' : 'original'),
      });
      if (result.kind === 'error' && apiError(result.error)?.status === 404) {
        // 发信标签失效（被删除或重建）：下一轮重新预检时会回到创建子域
        return finish('progress', 'sending.repair', 'sending_tag_stale', '发信子域已失效，下一轮重新接入');
      }
      if (result.kind !== 'done') return fail('sending.repair', result);
      done.push('sending.repair');
    }
  }

  return finish('progress');
}

/** catch-all 写入因 Routing 未开启被拒（确定性 4xx，非权限、非限流） */
function isRoutingPrecondition(error: unknown): boolean {
  const api = apiError(error);
  return Boolean(api && api.status >= 400 && api.status < 500 && ![401, 403, 404, 429].includes(api.status));
}

/** 写入后复读三项状态；读取失败为 unknown */
async function readSnapshot(
  creds: CloudflareCredentials, zoneId: string, domain: string, workerName: string, previous: MailStepSnapshot,
): Promise<MailStepSnapshot> {
  const [routing, catchAll, sending] = await Promise.all([
    read(getRouting(creds, zoneId)),
    read(getCatchAll(creds, zoneId)),
    read(readSending(creds, zoneId, domain)),
  ]);
  const routingState: SystemDomainStepState = !routing.ok ? 'unknown'
    : routing.value.enabled && (routing.value.status === 'ready' || routing.value.status === 'unlocked') ? 'ready'
      : routing.value.enabled ? 'conflict' : 'missing';
  const sendingValue = sending.ok ? sending.value : null;
  const sendingState: SystemDomainStepState = !sending.ok ? 'unknown'
    : !sendingValue?.subdomain || sendingValue.subdomain.enabled === false ? 'missing'
      : sendingValue.dnsStatus?.status === 'ready' ? 'ready'
        : sendingValue.dnsStatus?.status === 'misconfigured' ? 'conflict' : 'missing';
  return {
    routing: { state: routingState, status: routing.ok ? routing.value.status ?? '' : previous.routing.status },
    catchAll: { state: !catchAll.ok ? 'unknown' : targetsWorker(catchAll.value, workerName) ? 'ready' : 'missing' },
    sending: {
      state: sendingState,
      status: sendingValue?.dnsStatus?.status ?? (sending.ok ? '' : previous.sending.status),
      tag: sendingValue?.subdomain?.tag ?? (sending.ok ? null : previous.sending.tag),
    },
  };
}

// ---------------------------------------------------------------------------
// RDAP 与 DNSSEC（只作提示，失败一律是「未知」）

const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const RDAP_TIMEOUT_MS = 5000;
const RDAP_BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
let rdapBootstrap: { services: [string[], string[]][]; expiresAt: number } | null = null;

async function rdapBaseFor(tld: string): Promise<string | null> {
  if (!rdapBootstrap || rdapBootstrap.expiresAt <= Date.now()) {
    const res = await fetch(RDAP_BOOTSTRAP, { signal: AbortSignal.timeout(RDAP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json() as { services?: [string[], string[]][] };
    rdapBootstrap = { services: body.services ?? [], expiresAt: Date.now() + RDAP_BOOTSTRAP_TTL_MS };
  }
  const service = rdapBootstrap.services.find(([tlds]) => tlds.some((item) => item.toLowerCase() === tld));
  return service?.[1]?.find((url) => url.startsWith('https://')) ?? service?.[1]?.[0] ?? null;
}

interface RdapEntity { roles?: string[]; vcardArray?: [string, [string, unknown, string, unknown][]]; entities?: RdapEntity[] }

/** RDAP 识别注册商（IANA bootstrap 在 isolate 内缓存 24 小时，每次请求 5 秒超时）；失败返回 { name: null, cloudflare: null } */
export async function lookupRegistrar(domain: string): Promise<SystemDomainRegistrar> {
  const unknown = { name: null, cloudflare: null };
  try {
    const tld = domain.toLowerCase().split('.').pop() ?? '';
    const base = await rdapBaseFor(tld);
    if (!base) return unknown;
    const res = await fetch(`${base.replace(/\/?$/, '/')}domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    });
    if (!res.ok) return unknown;
    const body = await res.json() as { entities?: RdapEntity[] };
    const registrar = body.entities?.find((entity) => entity.roles?.includes('registrar'));
    const fn = registrar?.vcardArray?.[1]?.find((field) => field[0] === 'fn')?.[3];
    if (typeof fn !== 'string' || !fn.trim()) return unknown;
    return { name: fn.trim(), cloudflare: /cloudflare/i.test(fn) };
  } catch {
    return unknown;
  }
}

/** DNSSEC 三态：DoH 查询 DS，NOERROR / NXDOMAIN 为确定结果，其余（SERVFAIL、HTTP 失败、超时）为 unknown */
export async function dnssecState(domain: string): Promise<DnssecState> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=DS`, {
      headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unknown';
    const body = await res.json() as { Status?: number; Answer?: { type: number }[] };
    if (body.Status === 0) return body.Answer?.some((answer) => answer.type === 43) ? 'on' : 'off';
    if (body.Status === 3) return 'off';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 估算的 Cloudflare 调用次数，供调用方预占系统接入的调用额度 */
export const INSPECT_CF_CALLS = 10;
export const APPLY_CF_CALLS = 10;
