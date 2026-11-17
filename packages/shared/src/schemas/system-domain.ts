import { z } from 'zod';
import { domainSchema } from './mailbox.js';

/**
 * 系统域名一键接入（管理员，/api/admin/system-domains，只接受 JWT）。
 * 接入完成后域名照常写入 settings.domains.list（默认仅管理员可认领）；接入进度记在 system_domain_onboarding。
 *
 * - existing_zone：使用站长 Cloudflare 账户里已有的 zone（不改 NS），一键配置收发；
 * - new_zone：域名不在 Cloudflare：新建 zone，管理员到注册商改 NS，生效后自动继续。
 */
export const SYSTEM_DOMAIN_ONBOARDING_MODES = ['new_zone', 'existing_zone'] as const;
export type SystemDomainOnboardingMode = (typeof SYSTEM_DOMAIN_ONBOARDING_MODES)[number];

/**
 * 接入任务状态：
 * - creating_zone：new_zone 已占位，建 zone 的请求进行中或结果不明（约 10 分钟内由定时任务按名称确认）
 * - awaiting_ns：zone 已存在但尚未激活，等待改 NS 生效
 * - needs_confirmation：有需要管理员确认的变更（指纹变化或尚未确认），不自动推进
 * - blocked：存在阻断项或环境问题，每 30 分钟只读复检，条件消失后自动继续
 * - configuring：正在写入 Cloudflare（SPF、catch-all、删除已确认的第三方 MX、Email Routing、Email Sending）
 * - finalizing：远端已就绪，正在加入系统域名列表
 * - cancelling：已请求取消，等待在途操作结束或清理本次创建、未激活的 zone
 * - completed / cancelled / failed：终态
 */
export const SYSTEM_DOMAIN_ONBOARDING_ACTIVE_STATES = [
  'creating_zone', 'awaiting_ns', 'needs_confirmation', 'blocked', 'configuring', 'finalizing', 'cancelling',
] as const;
export const SYSTEM_DOMAIN_ONBOARDING_TERMINAL_STATES = ['completed', 'cancelled', 'failed'] as const;
export const SYSTEM_DOMAIN_ONBOARDING_STATES = [
  ...SYSTEM_DOMAIN_ONBOARDING_ACTIVE_STATES, ...SYSTEM_DOMAIN_ONBOARDING_TERMINAL_STATES,
] as const;
export type SystemDomainOnboardingState = (typeof SYSTEM_DOMAIN_ONBOARDING_STATES)[number];

/** zone 来源：created 本任务创建（仅「取消且从未激活」时可删）；linked 关联已有 zone；unknown 建 zone 超时后按名称找回。后两者永不删除 */
export const SYSTEM_DOMAIN_ZONE_ORIGINS = ['created', 'linked', 'unknown'] as const;
export type SystemDomainZoneOrigin = (typeof SYSTEM_DOMAIN_ZONE_ORIGINS)[number];

/** DNSSEC 三态：检测失败是 unknown，不等于未开启 */
export const DNSSEC_STATES = ['on', 'off', 'unknown'] as const;
export type DnssecState = (typeof DNSSEC_STATES)[number];

/**
 * 分项（zone / routing / catchAll / sending）状态：unknown 未读过或读取失败（不能当作不存在）；waiting 前置条件未满足；
 * missing 已确认不存在、待写入；ready 就绪；conflict 有需确认或阻断的冲突；error 写入得到确定性失败。
 */
export const SYSTEM_DOMAIN_STEP_STATES = ['unknown', 'waiting', 'missing', 'ready', 'conflict', 'error'] as const;
export type SystemDomainStepState = (typeof SYSTEM_DOMAIN_STEP_STATES)[number];
export const SYSTEM_DOMAIN_STEP_KEYS = ['zone', 'routing', 'catchAll', 'sending'] as const;
export type SystemDomainStepKey = (typeof SYSTEM_DOMAIN_STEP_KEYS)[number];
export interface SystemDomainStep {
  state: SystemDomainStepState;
  /** 一句中文说明，界面直接展示 */
  detail: string;
}
export type SystemDomainSteps = Record<SystemDomainStepKey, SystemDomainStep>;

/**
 * 需要管理员逐项确认的变更标识（创建或确认时放进 accept）：
 * - ns.change：new_zone 需要改 NS，影响整个域名的 DNS；
 * - mx.delete：根域存在第三方 MX 或 null MX，确认后由系统删除（危险确认：该域名不再经原服务商收信）；
 * - catchAll.replace：catch-all 当前启用并指向其他 Worker、转发或丢弃，确认后改为本站；
 * - spf.merge：已有唯一一条 SPF，确认后合并 include:_spf.mx.cloudflare.net；
 * - rules.bypass：有启用中的专用地址规则，这些地址的来信不会进入本站（知情确认，不修改规则）；
 * - dmarc.create：没有 _dmarc，接入发信时 Cloudflare 会写入 p=reject（知情确认）。
 */
export const SYSTEM_DOMAIN_ACKS = ['ns.change', 'mx.delete', 'catchAll.replace', 'spf.merge', 'rules.bypass', 'dmarc.create'] as const;
export type SystemDomainAck = (typeof SYSTEM_DOMAIN_ACKS)[number];

/** 预检项 */
export const SYSTEM_DOMAIN_CHECK_KEYS = [
  'occupancy', 'capacity', 'zone', 'token', 'nameServers', 'dnssec',
  'mx', 'spf', 'routing', 'catchAll', 'rules', 'sending', 'sendingRecords', 'dmarc', 'dkim',
] as const;
export type SystemDomainCheckKey = (typeof SYSTEM_DOMAIN_CHECK_KEYS)[number];

/** none 无需处理；info 仅提示；confirm 必须确认（ack）；blocker 阻断，处理后重新检测 */
export const SYSTEM_DOMAIN_SEVERITIES = ['none', 'info', 'confirm', 'blocker'] as const;
export type SystemDomainSeverity = (typeof SYSTEM_DOMAIN_SEVERITIES)[number];

/** ok 已符合；missing 不存在、将由计划写入；conflict 与本站要求冲突；unknown 读取失败或无权限（停止写入） */
export type SystemDomainCheckState = 'ok' | 'missing' | 'conflict' | 'unknown';

export interface SystemDomainRecordBrief {
  type: string;
  /** 完整域名 */
  name: string;
  content: string;
  priority: number | null;
  ttl: number | null;
}

export interface SystemDomainCheck {
  key: SystemDomainCheckKey;
  state: SystemDomainCheckState;
  severity: SystemDomainSeverity;
  /** severity=confirm 时为确认标识，其余为 null */
  ack: SystemDomainAck | null;
  /** 危险确认（界面红字），目前只有 mx.delete */
  danger: boolean;
  /** 一句话结论 */
  title: string;
  /** 现状（例如「转发到 a@example.net」「10 smtp.google.com」）；没有时为 null */
  current: string | null;
  /** 接入后的样子；仅提示或阻断时可为 null */
  proposed: string | null;
  /** 影响与后果（confirm、blocker 必填，例如「xxx-worker 将收不到信」） */
  impact: string;
  /** 相关记录明细，例如要删除的 MX、原 SPF */
  records: SystemDomainRecordBrief[];
}

/** 计划中的远端写入，按执行顺序：SPF 合并 → catch-all → 删除已确认的第三方 MX → 开启 Routing → 创建发信子域 → 修复发信 DNS */
export const SYSTEM_DOMAIN_WRITE_STEPS = ['spf.merge', 'catchAll.put', 'mx.delete', 'routing.enable', 'sending.create', 'sending.repair'] as const;
export type SystemDomainWriteStep = (typeof SYSTEM_DOMAIN_WRITE_STEPS)[number];

/** 注册商（RDAP 识别，只作提示）：name 为 null 表示查不到；cloudflare 为 null 表示未知 */
export interface SystemDomainRegistrar {
  name: string | null;
  cloudflare: boolean | null;
}

/**
 * 汇总结论：ready 可直接接入（无需确认）；confirm 有待确认项；blocked 有阻断项（含读取失败）；
 * pending zone 已在账户中但尚未激活（可以「关联并等待生效」）。
 */
export const SYSTEM_DOMAIN_VERDICTS = ['ready', 'confirm', 'blocked', 'pending'] as const;
export type SystemDomainVerdict = (typeof SYSTEM_DOMAIN_VERDICTS)[number];

export interface SystemDomainPrecheck {
  mode: SystemDomainOnboardingMode;
  domain: string;
  /** new_zone 建 zone 前为 null */
  zoneId: string | null;
  /** Cloudflare zone 状态：initializing / pending / active / moved；不存在为 null */
  zoneStatus: string | null;
  checkedAt: string;
  checks: SystemDomainCheck[];
  /** 计划执行的写入，已按执行顺序排列 */
  steps: { kind: SystemDomainWriteStep; detail: string }[];
  /** 需要在 accept 中提交的确认标识（去重，按 SYSTEM_DOMAIN_ACKS 的顺序） */
  requiredAcks: SystemDomainAck[];
  verdict: SystemDomainVerdict;
  /** 需确认项与其观察值的指纹；创建或确认时原样回传，服务端重新预检后比对 */
  fingerprint: string;
  registrar: SystemDomainRegistrar | null;
  /** zone 分配的名称服务器（已有 zone 时）；new_zone 建 zone 前为空 */
  nameServers: string[];
  /** new_zone 与等待 NS 时检测；其余为 null */
  dnssec: DnssecState | null;
}

/** 远端变更台账（只追加）：同一动作的 started / done / unknown / failed 共用 seq */
export const SYSTEM_DOMAIN_CHANGE_KINDS = ['zone.create', 'zone.delete', ...SYSTEM_DOMAIN_WRITE_STEPS] as const;
export type SystemDomainChangeKind = (typeof SYSTEM_DOMAIN_CHANGE_KINDS)[number];
export interface SystemDomainChange {
  seq: number;
  kind: SystemDomainChangeKind;
  status: 'started' | 'done' | 'unknown' | 'failed';
  at: string;
  /** zone id、发信 tag、记录 id 等 */
  target: string | null;
  /** 写入前的原值摘要（原 catch-all、原 SPF、被删除的 MX），供人工恢复 */
  before: string | null;
  error: string | null;
}

export interface SystemDomainOnboarding {
  id: number;
  domain: string;
  mode: SystemDomainOnboardingMode;
  state: SystemDomainOnboardingState;
  zoneId: string | null;
  zoneOrigin: SystemDomainZoneOrigin;
  /** Cloudflare 最近一次读到的 zone 状态；未知为空串，确认不存在为 missing */
  zoneStatus: string;
  /** 需要在注册商填写的名称服务器（new_zone） */
  nameServers: string[];
  originalNameServers: string[];
  originalRegistrar: string;
  dnssec: DnssecState;
  steps: SystemDomainSteps;
  /** 最近一次预检快照；creating_zone、awaiting_ns 阶段可能为 null */
  precheck: SystemDomainPrecheck | null;
  /** 已确认的变更 */
  accepted: SystemDomainAck[];
  changes: SystemDomainChange[];
  /** 机器可读原因（如 mx_removed_routing_pending、provision_timeout、list_full、occupied、cf_transient）；无为空串 */
  errorCode: string;
  lastError: string;
  /** 已请求取消，等待处理 */
  cancelRequested: boolean;
  /** 取消时可以勾选删除 zone：本任务创建且从未激活 */
  canDeleteZone: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  /** 最近一次与 Cloudflare 核对的时间 */
  checkedAt: string | null;
  /** 下次后台处理时间；不自动处理时为 null */
  nextCheckAt: string | null;
  activatedAt: string | null;
  finishedAt: string | null;
  /** Cloudflare 控制台中该 zone 的链接（含 account id，仅管理员可见）；未建 zone 时为 null */
  dashboardUrl: string | null;
}

/** 列表行内展示用的任务摘要 */
export type SystemDomainOnboardingSummary = Pick<SystemDomainOnboarding,
  'id' | 'domain' | 'mode' | 'state' | 'steps' | 'errorCode' | 'lastError' | 'updatedAt' | 'nextCheckAt' | 'cancelRequested'>;

/** zone 分类：available 可接入；onboarding 有进行中的任务；system 已是系统域名；hosted 用户托管；inconsistent 托管记录与 zone id 不一致（只读告警） */
export const SYSTEM_DOMAIN_ZONE_CATEGORIES = ['available', 'onboarding', 'system', 'hosted', 'inconsistent'] as const;
export type SystemDomainZoneCategory = (typeof SYSTEM_DOMAIN_ZONE_CATEGORIES)[number];

/** 可接入 zone 的就绪摘要：unchecked 本次未预检（超出每次 10 个的预检上限，点击时再查） */
export interface SystemDomainZoneReadiness {
  verdict: SystemDomainVerdict | 'unchecked';
  /** 需确认项数 */
  confirmCount: number;
  /** 阻断、需确认或等待的原因（各项 title），最多 5 条 */
  reasons: string[];
  registrar: SystemDomainRegistrar | null;
  checkedAt: string | null;
}

export interface SystemDomainZone {
  zoneId: string;
  name: string;
  /** Cloudflare 原值：initializing / pending / active / moved */
  status: string;
  /** full / partial / secondary；未知为 null */
  type: string | null;
  paused: boolean;
  category: SystemDomainZoneCategory;
  hidden: boolean;
  /** hosted / inconsistent：托管所有者 */
  owner: { userId: number; username: string; isAdmin: boolean } | null;
  /** onboarding：进行中的任务 */
  onboarding: SystemDomainOnboardingSummary | null;
  /** available：就绪摘要 */
  readiness: SystemDomainZoneReadiness | null;
}

export interface SystemDomainZonesView {
  /** Worker 是否配置了 Cloudflare 凭据；false 时其余字段为空，界面隐藏整个卡片 */
  configured: boolean;
  /** 可接入（available）与正在接入（onboarding）的 zone；hidden=1 时只返回已隐藏的 */
  zones: SystemDomainZone[];
  /** 不可选的 zone（system / hosted / inconsistent），供「展开查看」 */
  others: SystemDomainZone[];
  /** 进行中、但账户 zone 列表里没有对应 zone 的任务（例如 new_zone 正在建 zone） */
  unlistedTasks: SystemDomainOnboardingSummary[];
  counts: Record<SystemDomainZoneCategory, number> & { hostedByAdmin: number; hidden: number };
  /** Cloudflare zone 列表是否取全（超过分页上限时为 false） */
  complete: boolean;
  /** 隐藏列表的 revision，PUT hidden-zones 时回传 */
  hiddenRevision: number;
}

export interface SystemDomainHiddenZones {
  hiddenZones: string[];
  revision: number;
}

// ---------------------------------------------------------------------------
// 请求

/** Cloudflare zone ID：32 位小写十六进制 */
export const cloudflareZoneIdSchema = z.string().trim().toLowerCase().regex(/^[0-9a-f]{32}$/, 'zone ID 格式非法');

/** 查询参数开关：'1' 为真，缺省为假 */
const flagSchema = z.enum(['0', '1']).default('0').transform((value) => value === '1');

export const systemDomainZonesQuerySchema = z.object({
  /** 1：只看已隐藏的 zone */
  hidden: flagSchema,
  /** 1：跳过 60 秒缓存，重新读取 Cloudflare */
  refresh: flagSchema,
});
export type SystemDomainZonesQuery = z.infer<typeof systemDomainZonesQuerySchema>;

/** 接入目标：新建 zone（填域名）或账户里已有的 zone */
const newZoneTarget = z.object({ mode: z.literal('new_zone'), domain: domainSchema });
const existingZoneTarget = z.object({ mode: z.literal('existing_zone'), zoneId: cloudflareZoneIdSchema });

export const systemDomainPrecheckQuerySchema = z.discriminatedUnion('mode', [newZoneTarget, existingZoneTarget]);
export type SystemDomainPrecheckQuery = z.infer<typeof systemDomainPrecheckQuerySchema>;

const fingerprintSchema = z.string().trim().min(1).max(128);
const acceptSchema = z.array(z.enum(SYSTEM_DOMAIN_ACKS)).max(SYSTEM_DOMAIN_ACKS.length * 2).default([]);

/**
 * 一键接入。服务端重新预检：没有需确认项，或 accept 覆盖全部需确认项且 fingerprint 一致时创建任务并立即开始；
 * 否则返回 409，error.details.precheck 带最新预检（计划与指纹）。同一域名、同一方式的进行中任务重放返回 200。
 */
const ackShape = { fingerprint: fingerprintSchema.optional(), accept: acceptSchema };
export const createSystemDomainOnboardingRequestSchema = z.discriminatedUnion('mode', [
  newZoneTarget.extend(ackShape),
  existingZoneTarget.extend(ackShape),
]);
export type CreateSystemDomainOnboardingRequest = z.input<typeof createSystemDomainOnboardingRequestSchema>;

/** 配置途中远端变化（指纹漂移）后的确认 */
export const confirmSystemDomainOnboardingRequestSchema = z.object({
  fingerprint: fingerprintSchema,
  accept: acceptSchema,
});
export type ConfirmSystemDomainOnboardingRequest = z.input<typeof confirmSystemDomainOnboardingRequestSchema>;

export const cancelSystemDomainOnboardingRequestSchema = z.object({
  /** 同时删除本任务创建、从未激活的 zone；不满足条件时返回 400。关联已有或来源不明的 zone 永不删除 */
  deleteCreatedZone: z.boolean().default(false),
});
export type CancelSystemDomainOnboardingRequest = z.input<typeof cancelSystemDomainOnboardingRequestSchema>;

export const systemDomainOnboardingsQuerySchema = z.object({
  /** 1：只看进行中的任务 */
  active: flagSchema,
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type SystemDomainOnboardingsQuery = z.infer<typeof systemDomainOnboardingsQuerySchema>;

/** 隐藏或恢复可接入列表中的 zone（按域名记录） */
export const updateSystemDomainHiddenZonesRequestSchema = z.object({
  domain: domainSchema,
  hidden: z.boolean(),
  expectedRevision: z.number().int().min(0),
});
export type UpdateSystemDomainHiddenZonesRequest = z.infer<typeof updateSystemDomainHiddenZonesRequestSchema>;
