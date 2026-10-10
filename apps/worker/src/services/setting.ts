import {
  DEFAULT_SETTINGS,
  SECRET_MASK,
  SETTING_SCHEMAS,
  type SettingKey,
  type Settings,
  type UpdateSettingsRequest,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import { createDb } from '../db/client.js';
import { isAiModelConfigured } from './ai-provider.js';
import { settings as settingsTable } from '../db/schema.js';
import type { Env, ExecCtx } from '../types.js';

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

/**
 * isolate 内存缓存：同一 isolate 内 15s 复用，避免每个请求都跨区读 KV。
 * 只缓存「非强一致」读路径；认领/域名修订等仍走 getSettingsFresh 直读 D1。
 */
const MEMORY_TTL_MS = 15_000;
let memory: { value: Settings; expiresAt: number } | null = null;

/** 不阻塞响应的后台写：有 ctx 时交给 waitUntil，否则 fire-and-forget 并吞掉错误 */
function inBackground(ctx: ExecCtx | null | undefined, task: Promise<unknown>): void {
  const guarded = task.catch(() => {
    // 缓存写失败无所谓
  });
  if (ctx) ctx.waitUntil(guarded);
}

/**
 * 读设置：内存缓存 15s → KV 缓存 60s → 直读 D1，再失败用默认值（收件不因配置故障丢信）。
 * KV 回填放到 waitUntil，不阻塞响应。
 */
export async function getSettings(env: Env, ctx?: ExecCtx | null): Promise<Settings> {
  const now = Date.now();
  if (memory && memory.expiresAt > now) return memory.value;
  try {
    const cached = await env.kv.get(CACHE_KEY, { type: 'json' });
    // 与默认值浅合并：部署切换期缓存可能是旧代码写的、缺少新增的顶层键，
    // 直接返回会让下游 settings.X.Y 解引用 undefined 报 500。合并保证每个顶层键都在。
    if (cached) {
      const value = { ...DEFAULT_SETTINGS, ...(cached as Partial<Settings>) };
      memory = { value, expiresAt: now + MEMORY_TTL_MS };
      return value;
    }
  } catch {
    // 缓存读失败，继续直读 DB
  }
  try {
    const fresh = await getSettingsFresh(env);
    memory = { value: fresh, expiresAt: now + MEMORY_TTL_MS };
    inBackground(ctx, env.kv.put(CACHE_KEY, JSON.stringify(fresh), { expirationTtl: CACHE_TTL_SECONDS }));
    return fresh;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 清空本 isolate 的内存缓存（其他 isolate 最长 15s 后自然过期） */
export function invalidateSettingsMemory(): void {
  memory = null;
}

export async function invalidateSettingsCache(env: Env): Promise<void> {
  invalidateSettingsMemory();
  try {
    await env.kv.delete(CACHE_KEY);
  } catch {
    // ignore
  }
}

/** AI 翻译已启用且 ai_model 配置完整（/api/config 的 translationEnabled 与翻译接口共用此口径） */
export function isTranslationReady(settings: Pick<Settings, 'translation' | 'ai_model'>): boolean {
  return settings.translation.enabled && isAiModelConfigured(settings.ai_model);
}

/** 写设置：逐 key 校验后落库并失效缓存 */
export async function updateSettings(env: Env, patch: UpdateSettingsRequest): Promise<void> {
  const db = createDb(env);
  const writes: { key: string; value: string }[] = [];
  let fresh: Settings | undefined;
  const loadCurrent = async () => (fresh ??= await getSettingsFresh(env));

  const next: Partial<Pick<Settings, 'ai_model' | 'translation'>> = {};
  let domains: { value: string; expected: number } | undefined;
  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    const parsed = SETTING_SCHEMAS[key].safeParse(incoming);
    if (!parsed.success) throw new AppError('validation_failed', '配置格式非法');
    if (key === 'ai_model') {
      const value = parsed.data as Settings['ai_model'];
      // 提交 SECRET_MASK 表示保留已存 apiKey
      next.ai_model = { ...value, apiKey: value.apiKey === SECRET_MASK ? (await loadCurrent()).ai_model.apiKey : value.apiKey };
      writes.push({ key, value: JSON.stringify(next.ai_model) });
    } else if (key === 'translation') {
      next.translation = parsed.data as Settings['translation'];
      writes.push({ key, value: JSON.stringify(next.translation) });
    } else if (key === 'domains') {
      const current = await loadCurrent();
      const expected = patch.expectedDomainsRevision ?? current.domains.revision ?? 0;
      domains = { value: JSON.stringify({ ...parsed.data as object, revision: expected + 1 }), expected };
    } else writes.push({ key, value: JSON.stringify(parsed.data) });
  }
  // 翻译启用依赖模型配置：任一项在本次提交里时，按合并后的结果校验（验证码 AI 兜底未配置模型时只走正则，不拦）。
  // 校验先于任何写入，避免域名已写而其余设置被拒的半截更新
  if (next.ai_model || next.translation) {
    const current = next.ai_model && next.translation ? undefined : await loadCurrent();
    const merged = { ai_model: next.ai_model ?? current!.ai_model, translation: next.translation ?? current!.translation };
    if (merged.translation.enabled && !isTranslationReady(merged)) {
      throw new AppError('validation_failed', '启用 AI 翻译需先配置 AI 模型的接口地址、API Key 和模型');
    }
  }
  if (domains) {
    const result = await env.db.prepare(`INSERT INTO settings (key, value)
      SELECT 'domains', ? WHERE ? = COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE COALESCE(json_extract(settings.value, '$.revision'), 0) = ? RETURNING key`)
      .bind(domains.value, domains.expected, domains.expected).first();
    if (!result) throw new AppError('conflict', '域名配置已被其他请求修改，请刷新后重试');
  }
  for (const w of writes) {
    await db.insert(settingsTable).values(w)
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: w.value } });
  }
  await invalidateSettingsCache(env);
}

/** 管理端回显：AI 模型 apiKey 已配置时显示 SECRET_MASK（飞书/webhook 密钥已下放个人偏好） */
export function maskSettings(settings: Settings): Settings {
  const { ai_model: aiModel } = settings;
  return { ...settings, ai_model: { ...aiModel, apiKey: aiModel.apiKey ? SECRET_MASK : '' } };
}
