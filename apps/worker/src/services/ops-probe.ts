import { AppError } from '../lib/errors.js';
import { hmacSha256Hex, timingSafeEqualStr } from '../lib/crypto.js';
import { getEmailDomain, getLocalPart, normalizeEmail } from '../lib/email-address.js';
import { encodeBodyBase64, foldMimeHeaders } from '../lib/mime.js';
import type { Env } from '../types.js';
import { getDomains } from './domain.js';
import { cloudflareSender } from './outbound.js';
import { getSettings } from './setting.js';

/**
 * 部署后探针：CI 发布后用它验证 fetch 以外的两个入口。
 * - 收件金丝雀：经 send_email 真实外发一封信到本站系统域名，走 MX → Email Routing → email handler，
 *   handler 认出签名后只记一条 KV，CI 轮询到即说明外发与收件链路都在新版本上可用。
 * - cron 心跳：scheduled 每次运行读一次 KV，build 变了才写，记录「最近一次写入它的 build 与时间」。
 * 运维令牌与信头签名都从 jwt_secret 派生，CI 用同一个 secret 计算，不另设密钥。
 */
const CANARY_LABEL = 'hpc-canary-v1';
export const CANARY_HEADER = 'X-HPC-Canary';
/** rate_counters scope：全站每分钟 CANARY_RATE_LIMIT 次，scheduled 按分钟窗口回收 */
export const CANARY_RATE_SCOPE = 'canary';
export const CANARY_RATE_LIMIT = 2;
export const CRON_HEARTBEAT_KEY = 'cron:heartbeat';
const PROBE_TTL_SECONDS = 24 * 60 * 60;
/** 16 字节随机数的十六进制 */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
/** 金丝雀只发往 canary@<系统域名>，信头发出后 10 分钟内有效 */
const CANARY_LOCAL_PART = 'canary';
const CANARY_VALID_SECONDS = 10 * 60;
const CANARY_BODY = 'HPC Mail 部署金丝雀：用于验证外发与收件链路，收件端识别签名后直接丢弃，无需处理。';

export interface CanaryReceipt {
  receivedAt: string;
  build: string;
  to: string;
}

export interface CronHeartbeat {
  at: string;
  build: string;
  cron: string;
  ok: boolean;
  failedSteps: string[];
}

/** 当前运行的版本标识（与 /api/config 的 X-HPC-Build 同源） */
export function buildId(env: Env): string {
  return env.build_sha ?? 'local';
}

/** 校验 X-Canary-Token：常量时间比较；没有 jwt_secret 时一律不通过 */
export async function verifyCanaryToken(env: Env, provided: string | undefined): Promise<boolean> {
  if (!env.jwt_secret) return false;
  return timingSafeEqualStr(await hmacSha256Hex(env.jwt_secret, CANARY_LABEL), provided ?? '');
}

/** 签名覆盖 nonce、收件地址与过期时间：截获的信头不能拿去静默丢弃发往其他地址的来信，也不能长期重放 */
function canarySignature(env: Env, nonce: string, to: string, exp: number): Promise<string> {
  return hmacSha256Hex(env.jwt_secret, `${CANARY_LABEL}:${nonce}:${to}:${exp}`);
}

/** 信头值 `<nonce>.<exp 秒级时间戳>.<签名>` */
export async function canaryHeaderValue(env: Env, nonce: string, to: string, exp: number): Promise<string> {
  return `${nonce}.${exp}.${await canarySignature(env, nonce, to, exp)}`;
}

export function isCanaryNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}

function canaryKey(nonce: string): string {
  return `canary:${nonce}`;
}

/**
 * 校验信头格式与签名（按实际收件地址计算），通过即证明是本站发出的金丝雀，返回 nonce 与过期时间；
 * 是否过期、收件人是否合规由 consumeCanaryMail 判断。途经 MTA 折行可能在值里留下空白，先去掉。
 */
export async function verifyCanaryHeader(
  env: Env,
  value: string | null,
  to: string,
): Promise<{ nonce: string; exp: number } | null> {
  if (!value || !env.jwt_secret) return null;
  const [nonce = '', expText = '', signature = '', ...rest] = value.replace(/\s+/g, '').split('.');
  if (rest.length || !isCanaryNonce(nonce) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  return timingSafeEqualStr(await canarySignature(env, nonce, to, exp), signature) ? { nonce, exp } : null;
}

/**
 * 金丝雀收发域名：默认按字母序取前两个不同的系统域名，只有一个时自发自收；
 * 只指定一边时另一边取第一个与它不同的域名。指定的域名必须在系统域名列表内。
 */
export function pickCanaryDomains(
  domains: string[],
  requested: { fromDomain?: string; toDomain?: string },
): { fromDomain: string; toDomain: string } {
  const sorted = [...new Set(domains)].sort();
  for (const domain of [requested.fromDomain, requested.toDomain]) {
    if (domain !== undefined && !sorted.includes(domain)) {
      throw new AppError('validation_failed', `域名 ${domain} 不在系统域名列表内`);
    }
  }
  if (!sorted.length) throw new AppError('validation_failed', '尚未配置系统域名');
  const other = (domain: string) => sorted.find((item) => item !== domain) ?? domain;
  const fromDomain = requested.fromDomain ?? (requested.toDomain ? other(requested.toDomain) : sorted[0]!);
  return { fromDomain, toDomain: requested.toDomain ?? other(fromDomain) };
}

/**
 * 组装并经 send_email binding 外发金丝雀：只复用底层投递函数，不经过 sendMail——
 * 不落库、不占用户配额，也不会因为收件域是本站系统域名而走站内投递捷径（必须经真实 MX）。
 */
export async function sendCanaryMail(env: Env, from: string, to: string, nonce: string): Promise<void> {
  // 动态 import：mimetext 在 vitest workerd 里静态加载会崩（同 outbound.ts）
  const { createMimeMessage } = await import('mimetext/browser');
  const msg = createMimeMessage();
  msg.setSender({ name: 'HPC Mail Canary', addr: from });
  msg.setRecipient(to);
  msg.setSubject(`hpc-canary ${nonce}`);
  msg.setHeader('Message-ID', `<canary-${nonce}@${getEmailDomain(from)}>`);
  msg.addMessage({ contentType: 'text/plain', charset: 'UTF-8', encoding: 'base64', data: encodeBodyBase64(CANARY_BODY) });
  // 签名头在折行之后加：单行约 120 字节远低于 998 上限，原样一行收件端无需反折行
  const exp = Math.floor(Date.now() / 1000) + CANARY_VALID_SECONDS;
  const header = `${CANARY_HEADER}: ${await canaryHeaderValue(env, nonce, normalizeEmail(to), exp)}\r\n`;
  const send = await cloudflareSender(env, from);
  await send(to, header + foldMimeHeaders(msg.asRaw()));
}

/**
 * 收件入口最先调用，返回 true 时调用方直接结束——不落库、不转发、不通知、不自动认领：
 * - 签名不通过（没有头、伪造、或截获后改投其他地址）返回 false，照常按普通来信处理；
 * - 签名通过但已过期（如 KV 写失败后 SMTP 重投超过 10 分钟）、收件人不是 canary@、收件域不在系统域名列表
 *   （含读设置失败拿到空列表）时静默丢弃：只记一行日志，不写 KV——本站金丝雀不能落进 canary@ 邮箱去通知管理员；
 * - 其余记一条 KV 回执供 CI 轮询。
 * 只读 Cloudflare 已解析的信头，不消费原文；没有该头的普通来信不做任何读取。签名通过后才读设置，
 * 与收件主流程的设置读取共用 isolate 内存缓存，不增加 D1 往返。KV 写失败向上抛出，交给 SMTP 重投。
 */
export async function consumeCanaryMail(message: ForwardableEmailMessage, env: Env): Promise<boolean> {
  const to = normalizeEmail(message.to);
  const verified = await verifyCanaryHeader(env, message.headers.get(CANARY_HEADER), to);
  if (!verified) return false;
  const { nonce, exp } = verified;
  const dropReason = exp * 1000 < Date.now() ? 'expired'
    : getLocalPart(to) !== CANARY_LOCAL_PART ? 'not_canary_address'
      : !(await getDomains(env, await getSettings(env))).includes(getEmailDomain(to)) ? 'not_system_domain' : '';
  if (dropReason) {
    console.warn(JSON.stringify({ event: 'canary_dropped', reason: dropReason, nonce, to }));
    return true;
  }
  const receipt: CanaryReceipt = { receivedAt: new Date().toISOString(), build: buildId(env), to };
  await env.kv.put(canaryKey(nonce), JSON.stringify(receipt), { expirationTtl: PROBE_TTL_SECONDS });
  return true;
}

/** CI 发信后轮询；KV 跨区域最终一致，未命中也会被缓存，cacheTtl 取最小值缩短可见延迟 */
export async function readCanaryReceipt(
  env: Env,
  nonce: string,
): Promise<{ received: boolean; receivedAt?: string; build?: string }> {
  const receipt = await env.kv.get<CanaryReceipt>(canaryKey(nonce), { type: 'json', cacheTtl: 30 });
  return receipt ? { received: true, receivedAt: receipt.receivedAt, build: receipt.build } : { received: false };
}

/**
 * scheduled 每次运行结束调用。心跳的语义是「最近一次写入它的 build 与时间」，不是每 5 分钟刷新：
 * 每次运行读一次 KV（读便宜），存的 build 与当前不同（或已过期消失）才写，at/ok/failedSteps 只在 build 变化时更新。
 * 发布切换窗口里新旧 build 可能交替写入，旧 isolate 退场后由新 build 的下一次运行收敛到新 build，
 * 所以不能用 isolate 内标记跳过读取。不访问 D1。读写失败只记日志，不影响定时任务本身，下次运行重试。
 */
export async function writeCronHeartbeat(env: Env, cron: string, failedSteps: string[]): Promise<void> {
  const build = buildId(env);
  try {
    if ((await readCronHeartbeat(env))?.build === build) return;
    const heartbeat: CronHeartbeat = { at: new Date().toISOString(), build, cron, ok: failedSteps.length === 0, failedSteps };
    await env.kv.put(CRON_HEARTBEAT_KEY, JSON.stringify(heartbeat), { expirationTtl: PROBE_TTL_SECONDS });
  } catch (error) {
    console.error('cron 心跳写入失败:', error);
  }
}

export async function readCronHeartbeat(env: Env): Promise<CronHeartbeat | null> {
  return env.kv.get<CronHeartbeat>(CRON_HEARTBEAT_KEY, { type: 'json', cacheTtl: 30 });
}
