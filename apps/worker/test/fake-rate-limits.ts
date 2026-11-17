import { env } from 'cloudflare:test';
import { RATE_LIMIT_BINDINGS, type RateLimitBindingName } from '../src/services/rate-limit.js';
import type { Env } from '../src/types.js';

/** 与 Rate Limiting binding 同语义的假实现：固定上限、被拒的调用不计数；记录每次调用的 key */
export class FakeRateLimit implements RateLimit {
  readonly calls: string[] = [];
  readonly counts = new Map<string, number>();
  constructor(readonly max: number) {}

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    this.calls.push(key);
    const used = this.counts.get(key) ?? 0;
    if (used >= this.max) return { success: false };
    this.counts.set(key, used + 1);
    return { success: true };
  }

  /** 把某个 key 的额度直接用满 */
  fill(key: string): void {
    this.counts.set(key, this.max);
  }
}

/** 每个 binding 一个假实现（上限默认同生产配置，可覆盖），连同注入后的 env 一起返回 */
export function fakeRateLimits(limits: Partial<Record<RateLimitBindingName, number>> = {}, base: Env = env) {
  const fakes = Object.fromEntries(Object.entries(RATE_LIMIT_BINDINGS).map(([name, max]) =>
    [name, new FakeRateLimit(limits[name as RateLimitBindingName] ?? max)])) as Record<RateLimitBindingName, FakeRateLimit>;
  return { env: { ...base, ...fakes } as Env, fakes };
}
