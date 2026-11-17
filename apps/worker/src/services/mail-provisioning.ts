/**
 * 系统域名接入的 Cloudflare 邮件配置：inspect（只读，不吞错）→ plan（纯函数，确认项与指纹）→ apply（带前置复核的写入）。
 * 与托管域名的 ensureMailConfig 完全独立：读取失败一律是 unknown 并停止相关写入，绝不推断为「不存在」；
 * 已有配置（第三方 MX、catch-all、SPF）只在管理员确认后才改；不调用 deleteZone、关闭 Routing 或删除发信子域。
 *
 * 【接口契约（PR5h 负责人定义，实现者不得改签名；需要改时先找负责人）】
 */
import type {
  DnssecState, SystemDomainAck, SystemDomainCheck, SystemDomainRegistrar, SystemDomainStepState, SystemDomainVerdict, SystemDomainWriteStep,
} from '@hpc-mail/shared';
import type { OnboardingAcceptance, OnboardingChangeEvent } from '../db/schema.js';
import type {
  CfCatchAll, CfDnsRecord, CfPage, CfRouting, CfRoutingRule, CfSendingDnsStatus, CfSendingSubdomain, CfZone, CloudflareCredentials,
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

/** 只读预检：并行读取，不吞错；zone 未激活时只返回 zone 本身 */
export async function inspectMailConfig(_creds: CloudflareCredentials, _zone: CfZone, _domain: string): Promise<MailInspection> {
  throw new Error('not implemented');
}

/** 纯函数（哈希为异步）：把读取结果变成检查项、计划与指纹 */
export async function planMailChanges(_inspection: MailInspection, _policy: ProvisionPolicy): Promise<MailPlan> {
  throw new Error('not implemented');
}

/** 指纹：所有需确认项 [ack, observed] 排序后的 sha256（十六进制） */
export async function fingerprintOf(_observed: readonly OnboardingAcceptance[]): Promise<string> {
  throw new Error('not implemented');
}

/** 写前门禁：blocker 项，以及 ack 与观察值不在 accepted 中（两者都要一致）的需确认项 */
export function gatePlan(_plan: Pick<MailPlan, 'checks' | 'observed'>, _accepted: readonly OnboardingAcceptance[]): {
  blockers: SystemDomainCheck[];
  unconfirmed: SystemDomainAck[];
} {
  throw new Error('not implemented');
}

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
}

/**
 * 按计划写入（调用方已通过 gatePlan）。每步：beforeWrite → 台账 started → 写 → done；
 * 结果不明时先读远端：已是目标值记 done，仍是原值重试 1 次，第三种值返回 needs_confirmation。
 * 删除第三方 MX 与开启 Routing 必须紧挨着执行，Routing 失败返回 blocked + mx_removed_routing_pending。
 */
export async function applyMailPlan(
  _creds: CloudflareCredentials, _inspection: MailInspection, _plan: MailPlan, _hooks: ApplyHooks,
): Promise<MailApplyResult> {
  throw new Error('not implemented');
}

/** RDAP 识别注册商（IANA bootstrap 在 isolate 内缓存 24 小时，每次请求 5 秒超时）；失败返回 { name: null, cloudflare: null } */
export async function lookupRegistrar(_domain: string): Promise<SystemDomainRegistrar> {
  throw new Error('not implemented');
}

/** DNSSEC 三态：DoH 查询 DS，NOERROR / NXDOMAIN 为确定结果，其余（SERVFAIL、HTTP 失败、超时）为 unknown */
export async function dnssecState(_domain: string): Promise<DnssecState> {
  throw new Error('not implemented');
}

/** 估算的 Cloudflare 调用次数，供调用方预占系统接入的调用额度 */
export const INSPECT_CF_CALLS = 10;
export const APPLY_CF_CALLS = 10;
