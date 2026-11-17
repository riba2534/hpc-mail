import {
  MAX_API_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_API_USER_REQUESTS_PER_MINUTE,
  MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE,
  MAX_AUTH_USER_REQUESTS_PER_MINUTE,
} from '@hpc-mail/shared';
import type { Env } from '../types.js';

/**
 * 已认证请求的分钟级限流：Cloudflare Workers Rate Limiting binding（wrangler.toml 的 [[ratelimits]]，周期 60 秒）。
 *
 * 计数由 Cloudflare 在每个节点本地维护、后台同步，`limit()` 不等同步就返回：热路径不写 D1，
 * 代价是近似计数——同一节点内可能略超上限，不同节点各算各的。登录失败与按天的业务配额要求精确，仍在 D1。
 *
 * binding 的上限写死在配置里、只按 key 计数，所以：
 * - 用户桶与全站桶各一个 binding，上限与 shared 常量一致（wrangler-ratelimits 测试核对配置）；
 * - Key 自定义的每分钟上限拆成 1-2-5 档位之和（如 120 = 100 + 20），每档一个 binding，按档位从大到小依次尝试，
 *   任一档放行即通过；平时只调用一次，接近上限时才逐档往下试。
 *
 * binding 拒绝的调用不计数。检查按「Key → 用户 → 全站」短路，被前一级拒绝的请求不调用后一级：
 * Key 超限不占用户额度，用户超限推不高全站桶（R04）。
 * binding 缺失（vitest、未带 [[ratelimits]] 的部署）时退回进程内固定窗口计数，只在本 isolate 内有效。
 */

/** Key 级档位（1-2-5 系列，从大到小）。档位之和覆盖 1–1200，超过用户上限的部分由用户桶决定 */
export const API_KEY_LIMIT_TIERS = [500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

/** Rate Limiting binding 名（wrangler.toml 的 [[ratelimits]] name） */
export type RateLimitBindingName =
  | 'rl_auth_user'
  | 'rl_auth_global'
  | 'rl_api_user'
  | 'rl_api_global'
  | `rl_api_key_${(typeof API_KEY_LIMIT_TIERS)[number]}`;

/** binding 名 → 每分钟上限。进程内替身按它计数，wrangler.toml 的 [[ratelimits]] 必须逐条一致 */
export const RATE_LIMIT_BINDINGS = {
  rl_auth_user: MAX_AUTH_USER_REQUESTS_PER_MINUTE,
  rl_auth_global: MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE,
  rl_api_user: MAX_API_USER_REQUESTS_PER_MINUTE,
  rl_api_global: MAX_API_GLOBAL_REQUESTS_PER_MINUTE,
  ...Object.fromEntries(API_KEY_LIMIT_TIERS.map((tier) => [`rl_api_key_${tier}`, tier])),
} as Readonly<Record<RateLimitBindingName, number>>;

/** 全站桶的 key：binding 按 key 计数，全站只有一个计数主体 */
const INSTANCE_KEY = 'instance';
const PERIOD_MS = 60_000;

type Window = { epoch: number; counts: Map<string, number> };
const memoryWindows = new Map<RateLimitBindingName, Window>();

/** 与 binding 相同语义的进程内替身：固定 60 秒窗口，超限的调用不计数 */
function memoryLimit(name: RateLimitBindingName, key: string): boolean {
  const epoch = Math.floor(Date.now() / PERIOD_MS);
  let window = memoryWindows.get(name);
  if (!window || window.epoch !== epoch) {
    window = { epoch, counts: new Map() };
    memoryWindows.set(name, window);
  }
  const used = window.counts.get(key) ?? 0;
  if (used >= RATE_LIMIT_BINDINGS[name]) return false;
  window.counts.set(key, used + 1);
  return true;
}

/** 清空进程内替身的计数（测试用） */
export function resetMemoryRateLimits(): void {
  memoryWindows.clear();
  localKeyUsage.clear();
}

/**
 * 调用一个 binding；缺失时用进程内替身。binding 本身出错时放行并记日志：
 * 限流服务故障不应让全站请求失败，D1 侧的业务配额与登录节流不受影响。
 */
async function admit(env: Env, name: RateLimitBindingName, key: string): Promise<boolean> {
  const binding = env[name];
  if (!binding) return memoryLimit(name, key);
  try {
    return (await binding.limit({ key })).success;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', operation: 'rate-limit', binding: name, message: String(error) }));
    return true;
  }
}

/** /api（JWT）请求：返回拒绝它的那一级，放行返回 null */
export async function limitSessionRequest(env: Env, userId: number): Promise<'user' | 'global' | null> {
  if (!(await admit(env, 'rl_auth_user', String(userId)))) return 'user';
  if (!(await admit(env, 'rl_auth_global', INSTANCE_KEY))) return 'global';
  return null;
}

interface KeySlot { binding: RateLimitBindingName; tier: number; key: string }

/** 把 Key 的每分钟上限拆成档位之和；同一档用多次时用不同的 key 区分 */
export function apiKeySlots(keyId: number, rateLimit: number): KeySlot[] {
  const slots: KeySlot[] = [];
  let rest = Math.min(Math.max(1, Math.floor(rateLimit)), MAX_API_USER_REQUESTS_PER_MINUTE);
  for (const tier of API_KEY_LIMIT_TIERS) {
    for (let index = 0; rest >= tier; index++, rest -= tier) {
      slots.push({ binding: `rl_api_key_${tier}`, tier, key: `${keyId}:${index}` });
    }
  }
  return slots;
}

/**
 * 本 isolate 内各 Key 当前分钟放行的次数，只用来估算 X-RateLimit-Remaining。
 * 同一客户端的连续请求多落在同一 isolate，与「已用满的档位」取较大者作为已用量的下界。
 */
const localKeyUsage = new Map<number, { epoch: number; count: number }>();
const LOCAL_USAGE_MAX_KEYS = 10_000;

function noteLocalUsage(keyId: number, epoch: number): number {
  const entry = localKeyUsage.get(keyId);
  const count = entry && entry.epoch === epoch ? entry.count + 1 : 1;
  if (!entry && localKeyUsage.size >= LOCAL_USAGE_MAX_KEYS) localKeyUsage.clear();
  localKeyUsage.set(keyId, { epoch, count });
  return count;
}

export interface ApiRateVerdict {
  /** 拒绝它的那一级；放行为 null */
  rejectedBy: 'key' | 'user' | 'global' | null;
  /** X-RateLimit-Remaining：估计上界，计数是近似的，未归零时也可能被拒 */
  remaining: number;
  /** X-RateLimit-Reset：下一个整分钟的 Unix 秒数（binding 的窗口边界不公开，取近似值） */
  reset: number;
}

/** /v1（API Key）请求：Key 档位 → 用户桶 → 全站桶，逐级短路 */
export async function limitApiKeyRequest(
  env: Env,
  apiKey: { id: number; userId: number; rateLimit: number },
  now = Date.now(),
): Promise<ApiRateVerdict> {
  const epoch = Math.floor(now / PERIOD_MS);
  const reset = (epoch + 1) * 60;
  let exhausted = 0;
  let admitted = false;
  for (const slot of apiKeySlots(apiKey.id, apiKey.rateLimit)) {
    if (await admit(env, slot.binding, slot.key)) { admitted = true; break; }
    exhausted += slot.tier;
  }
  if (!admitted) return { rejectedBy: 'key', remaining: 0, reset };
  const used = Math.max(exhausted + 1, noteLocalUsage(apiKey.id, epoch));
  const remaining = Math.max(0, apiKey.rateLimit - used);
  if (!(await admit(env, 'rl_api_user', String(apiKey.userId)))) return { rejectedBy: 'user', remaining, reset };
  if (!(await admit(env, 'rl_api_global', INSTANCE_KEY))) return { rejectedBy: 'global', remaining, reset };
  return { rejectedBy: null, remaining, reset };
}
