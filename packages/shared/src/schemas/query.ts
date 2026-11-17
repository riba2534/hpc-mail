import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';

/**
 * 查询参数里的空串按「没传」处理。skill.md 教的就是 `?cursor=&limit=` 这种形状，
 * 而 z.coerce.number() 会把 '' 转成 0 再被 min(1) 拒掉——外部调用方照文档拼串直接 400。
 * 前端不受影响（api/client.ts 本来就跳过空串），纯粹是外部调用方的陷阱。
 */
export function emptyAsUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** 布尔开关参数：接受 1/true/0/false，空串等同未传 */
export function boolFlag() {
  return emptyAsUndefined(
    z
      .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
      .transform((v) => v === '1' || v === 'true'),
  );
}

/** 游标分页参数（`?cursor=&limit=`，空串当没传）：展开进列表查询的 z.object */
export const pageQueryShape = {
  cursor: emptyAsUndefined(z.string().max(128)),
  limit: emptyAsUndefined(z.coerce.number().int().min(1).max(MAX_PAGE_SIZE)).default(DEFAULT_PAGE_SIZE),
};
