import type { ExecCtx } from '../types.js';

/** 后台任务：有 ctx 放进 waitUntil，没有时（定时任务、单测）同步等待；失败只记日志「<label>失败」 */
export async function runDetached(ctx: ExecCtx | null | undefined, label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = task().catch((error) => console.error(`${label}失败:`, error));
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}
