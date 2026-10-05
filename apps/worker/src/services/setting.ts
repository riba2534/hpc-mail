import {
  DEFAULT_SETTINGS,
  SETTING_SCHEMAS,
  type SettingKey,
  type Settings,
  type UpdateSettingsRequest,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { createDb } from '../db/client.js';
import { settings as settingsTable } from '../db/schema.js';
import type { Env } from '../types.js';

const CACHE_KEY = 'setting-cache';
const CACHE_TTL_SECONDS = 60;

/** 从 D1 读全部设置并与默认值合并（逐 key safeParse，非法回落默认） */
export async function getSettingsFresh(env: Env): Promise<Settings> {
  const db = createDb(env);
  const rows = await db.select().from(settingsTable).all();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const merged = { ...DEFAULT_SETTINGS } as Settings;
  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) {
    const raw = stored.get(key);
    if (raw === undefined) continue;
    try {
      const parsed = SETTING_SCHEMAS[key].safeParse(JSON.parse(raw));
      if (parsed.success) (merged as Record<string, unknown>)[key] = parsed.data;
    } catch {
      // 非法值忽略，保留默认
    }
  }
  return merged;
}

/** 读设置（KV 缓存 60s，失败降级直读 DB，再失败用默认值——收件不因配置故障丢信） */
export async function getSettings(env: Env): Promise<Settings> {
  try {
    const cached = await env.kv.get(CACHE_KEY, { type: 'json' });
    // 与默认值浅合并：部署切换期缓存可能是旧代码写的、缺少新增的顶层键，
    // 直接返回会让下游 settings.X.Y 解引用 undefined 报 500。合并保证每个顶层键都在。
    if (cached) return { ...DEFAULT_SETTINGS, ...(cached as Partial<Settings>) };
  } catch {
    // 缓存读失败，继续直读 DB
  }
  try {
    const fresh = await getSettingsFresh(env);
    try {
      await env.kv.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // 缓存写失败无所谓
    }
    return fresh;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function invalidateSettingsCache(env: Env): Promise<void> {
  try {
    await env.kv.delete(CACHE_KEY);
  } catch {
    // ignore
  }
}

/** 写设置：逐 key 校验后落库并失效缓存 */
export async function updateSettings(env: Env, patch: UpdateSettingsRequest): Promise<void> {
  const db = createDb(env);
  const writes: { key: string; value: string }[] = [];

  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    const parsed = SETTING_SCHEMAS[key].safeParse(incoming);
    if (!parsed.success) throw new AppError('validation_failed', '配置格式非法');
    if (key === 'domains') {
      const current = await getSettingsFresh(env);
      const expected = patch.expectedDomainsRevision ?? current.domains.revision ?? 0;
      const value = JSON.stringify({ ...parsed.data as object, revision: expected + 1 });
      const result = await env.db.prepare(`INSERT INTO settings (key, value)
        SELECT 'domains', ? WHERE ? = COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE COALESCE(json_extract(settings.value, '$.revision'), 0) = ? RETURNING key`)
        .bind(value, expected, expected).first();
      if (!result) throw new AppError('conflict', '域名配置已被其他请求修改，请刷新后重试');
    } else writes.push({ key, value: JSON.stringify(parsed.data) });
  }
  for (const w of writes) {
    await db.insert(settingsTable).values(w)
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: w.value } });
  }
  await invalidateSettingsCache(env);
}

/** 管理端回显：系统设置已无密文字段（飞书/webhook 密钥已下放个人偏好），原样返回 */
export function maskSettings(settings: Settings): Settings {
  return { ...settings };
}
