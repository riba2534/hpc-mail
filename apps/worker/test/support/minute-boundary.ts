/** 按分钟计的断言在窗口边界附近会跨格：离整分钟不足 5 秒时等到下一分钟 */
export async function awayFromMinuteBoundary(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 5_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

/** 调用了 awayFromMinuteBoundary 的用例超时：最多等 5.1 秒，再加用例本身的耗时，超过 vitest 默认的 5 秒 */
export const MINUTE_EDGE_TIMEOUT = 15_000;
