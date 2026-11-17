/**
 * D1 单条查询最多 **100 个绑定参数**（Cloudflare 平台硬限），超出即整条语句被拒（`too many SQL variables`），
 * 所在 batch 整体失败。本地测试用的 D1 同样按 100 拒绝（test/d1-param-limit.test.ts 有哨兵测试），
 * 超限只要被测试走到就会暴露，所以满额输入（100 个 id、50 个邀请码等）要有对应用例。
 * 凡是把数组展开成 IN (?,?,…) 或多行 VALUES 的语句都必须分批或改用 json_each；
 * drizzle 会把带默认值的列也作为参数绑定，多行插入按每行实际参数数计算批大小。
 */
export const D1_MAX_BOUND_PARAMS = 100;

/** 单批 id 数：留 10 个余量给同一语句里的其他绑定值（SET 的字段、附加条件等） */
export const D1_ID_BATCH = 90;

/** 每行占 2 个绑定参数的批量 INSERT（如 stars 的 userId+messageId）单批行数 */
export const D1_PAIR_BATCH = 45;

/** 把数组切成不超过 size 的批次；空数组返回空批次列表 */
export function chunk<T>(arr: readonly T[], size: number = D1_ID_BATCH): T[][] {
  if (size < 1) throw new Error('chunk size 必须 ≥ 1');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * drizzle 查询构建器 → 原生 D1 语句，供 `env.db.batch` 合并往返。
 * 不用 drizzle 的 db.batch：语句准备阶段抛错时它会留下一个未处理的 rejection。
 */
export function d1Statement(env: { db: D1Database }, query: { toSQL(): { sql: string; params: unknown[] } }): D1PreparedStatement {
  const { sql, params } = query.toSQL();
  return env.db.prepare(sql).bind(...params);
}
