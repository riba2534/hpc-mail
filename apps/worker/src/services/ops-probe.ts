import { AppError } from '../lib/errors.js';
import { hmacSha256Hex, timingSafeEqualStr } from '../lib/crypto.js';
import { getEmailDomain, normalizeEmail } from '../lib/email-address.js';
import { encodeBodyBase64, foldMimeHeaders } from '../lib/mime.js';
import type { Env } from '../types.js';
import { sendViaCloudflare } from './outbound.js';

/**
 * 部署后探针：CI 发布后用它验证 fetch 以外的两个入口。
 * - 收件金丝雀：经 send_email 真实外发一封信到本站系统域名，走 MX → Email Routing → email handler，
 *   handler 认出签名后只记一条 KV，CI 轮询到即说明外发与收件链路都在新版本上可用。
 * - cron 心跳：scheduled 每次结束写一条 KV，带上运行它的 build。
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

function canarySignature(env: Env, nonce: string): Promise<string> {
  return hmacSha256Hex(env.jwt_secret, `${CANARY_LABEL}:${nonce}`);
}

export function isCanaryNonce(value: string): boolean {
  return NONCE_PATTERN.test(value);
}

function canaryKey(nonce: string): string {
  return `canary:${nonce}`;
}

/** 信头 `<nonce>.<签名>` 有效时返回 nonce；途经 MTA 折行可能在值里留下空白，先去掉 */
export async function verifyCanaryHeader(env: Env, value: string | null): Promise<string | null> {
  if (!value || !env.jwt_secret) return null;
  const [nonce = '', signature = '', ...rest] = value.replace(/\s+/g, '').split('.');
  if (rest.length || !isCanaryNonce(nonce)) return null;
  return timingSafeEqualStr(await canarySignature(env, nonce), signature) ? nonce : null;
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
  // 签名头在折行之后加：单行 111 字节远低于 998 上限，原样一行收件端无需反折行
  const signature = `${CANARY_HEADER}: ${nonce}.${await canarySignature(env, nonce)}\r\n`;
  await sendViaCloudflare(env, from, to, signature + foldMimeHeaders(msg.asRaw()));
}

/**
 * 收件入口最先调用：签名有效的金丝雀只记一条 KV 并返回 true，调用方直接结束——
 * 不落库、不转发、不通知、不自动认领；无头或签名无效返回 false，照常按普通来信处理。
 * 只读 Cloudflare 已解析的信头，不消费原文、不访问 D1，普通来信路径不增加往返。
 * KV 写失败向上抛出，交给 SMTP 重投。
 */
export async function consumeCanaryMail(message: ForwardableEmailMessage, env: Env): Promise<boolean> {
  const nonce = await verifyCanaryHeader(env, message.headers.get(CANARY_HEADER));
  if (!nonce) return false;
  const receipt: CanaryReceipt = { receivedAt: new Date().toISOString(), build: buildId(env), to: normalizeEmail(message.to) };
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

/** scheduled 每次运行结束调用；写失败只记日志，不影响定时任务本身 */
export async function writeCronHeartbeat(env: Env, cron: string, failedSteps: string[]): Promise<void> {
  const heartbeat: CronHeartbeat = {
    at: new Date().toISOString(), build: buildId(env), cron, ok: failedSteps.length === 0, failedSteps,
  };
  try {
    await env.kv.put(CRON_HEARTBEAT_KEY, JSON.stringify(heartbeat), { expirationTtl: PROBE_TTL_SECONDS });
  } catch (error) {
    console.error('cron 心跳写入失败:', error);
  }
}

export async function readCronHeartbeat(env: Env): Promise<CronHeartbeat | null> {
  return env.kv.get<CronHeartbeat>(CRON_HEARTBEAT_KEY, { type: 'json', cacheTtl: 30 });
}
