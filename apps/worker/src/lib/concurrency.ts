/**
 * 有界并发：最多 limit 个任务同时进行，按 items 顺序领取。任一任务失败整体 reject
 * （与串行时「任一失败即抛出」语义一致）；不想中断的调用方在 task 里自行捕获。
 */
export async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  }));
}
