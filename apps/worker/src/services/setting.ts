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
import { anyHostedSql } from './domain-occupancy.js';
import { settings as settingsTable } from '../db/schema.js';
import type { Env, ExecCtx } from '../types.js';

/** 旧版本的 KV 设置缓存键：当前只在更新设置时尽力删除，回滚到旧版本时不会读到陈旧值 */
const LEGACY_KV_CACHE_KEY = 'setting-cache';
const SETTINGS_SQL = 'SELECT key, value FROM settings';

/** 设置行与默认值合并（逐 key safeParse，非法回落默认） */
export function mergeSettingRows(rows: readonly { key: string; value: string }[]): Settings {
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

/** 从 D1 读全部设置并与默认值合并 */
export async function getSettingsFresh(env: Env): Promise<Settings> {
  const db = createDb(env);
  return mergeSettingRows(await db.select().from(settingsTable).all());
}

/**
 * isolate 内存缓存：同一 isolate 内 15s 复用，未命中直读 D1（fetch 已 placement 到 D1 主库附近）。
 * 只缓存「非强一致」读路径；认领/域名修订等仍走 getSettingsFresh 直读 D1。
 * generation 在失效时递增：失效前发出、失效后才返回的读取不回填缓存，避免更新前的旧值再被缓存 15s。
 */
const MEMORY_TTL_MS = 15_000;
let memory: { value: Settings; expiresAt: number } | null = null;
let generation = 0;

/** 一次设置读取：缓存命中直接给值；未命中给出读语句和解析函数，调用方可把语句并进自己的 db.batch */
export type SettingsQuery =
  | { cached: Settings }
  | { statement: D1PreparedStatement; resolve(result: D1Result): Settings };

export function settingsQuery(env: Env): SettingsQuery {
  if (memory && memory.expiresAt > Date.now()) return { cached: memory.value };
  const issuedAt = generation;
  return {
    statement: env.db.prepare(SETTINGS_SQL),
    resolve(result) {
      const value = mergeSettingRows((result.results ?? []) as { key: string; value: string }[]);
      if (issuedAt === generation) memory = { value, expiresAt: Date.now() + MEMORY_TTL_MS };
      return value;
    },
  };
}

/**
 * 读设置：内存缓存 15s → 直读 D1，再失败用默认值（收件不因配置故障丢信）。
 * ctx 当前不用，保留给调用方统一传参。
 */
export async function getSettings(env: Env, _ctx?: ExecCtx | null): Promise<Settings> {
  try {
    const query = settingsQuery(env);
    if ('cached' in query) return query.cached;
    return query.resolve(await query.statement.all());
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 清空本 isolate 的内存缓存（其他 isolate 最长 15s 后自然过期） */
export function invalidateSettingsMemory(): void {
  memory = null;
  generation++;
}

/**
 * 失效设置缓存：本 isolate 内存立即失效；旧版 KV 缓存尽力删除，不阻塞调用方，失败也不报错。
 * 有 ctx 时交给 waitUntil，没有时 fire-and-forget。
 */
export async function invalidateSettingsCache(env: Env, ctx?: ExecCtx | null): Promise<void> {
  invalidateSettingsMemory();
  const guarded = (async () => {
    try {
      await env.kv.delete(LEGACY_KV_CACHE_KEY);
    } catch {
      // 删不掉的旧缓存会在 60s TTL 后自然过期
    }
  })();
  if (ctx) ctx.waitUntil(guarded);
}

/** AI 翻译已启用且 ai_model 配置完整（/api/config 的 translationEnabled 与翻译接口共用此口径） */
export function isTranslationReady(settings: Pick<Settings, 'translation' | 'ai_model'>): boolean {
  return settings.translation.enabled && isAiModelConfigured(settings.ai_model);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * apiKey 为 SECRET_MASK 表示沿用已存密钥，只能发往原来的接口：baseUrl 换了源（协议、主机或端口）时
 * 必须重新填写，否则管理员会话失窃后改个地址就能把已存密钥外带出去（清空地址不会发出密钥，允许）。保存设置与测试接口共用。
 */
export function resolveMaskedAiKey(saved: Settings['ai_model'], baseUrl: string, apiKey: string): string {
  if (apiKey !== SECRET_MASK) return apiKey;
  if (saved.apiKey && baseUrl && originOf(baseUrl) !== originOf(saved.baseUrl)) {
    throw new AppError('validation_failed', '接口地址已更换，请重新填写 API Key');
  }
  return saved.apiKey;
}

/** domains 的 CAS 没有写入：区分「被用户托管」和「revision 已变化」，给出可操作的原因 */
async function domainsWriteConflict(env: Env, listed: string): Promise<AppError> {
  const hosted = await env.db.prepare('SELECT domain FROM hosted_domains WHERE domain IN (SELECT value FROM json_each(?))')
    .bind(listed).all<{ domain: string }>();
  if (hosted.results.length) {
    return new AppError('conflict', `${hosted.results.map((row) => row.domain).join('、')} 已被用户托管，不能加为系统域名`);
  }
  return new AppError('conflict', '域名配置已被其他请求修改，请刷新后重试');
}

/** 写设置：逐 key 校验后落库并失效缓存 */
export async function updateSettings(env: Env, patch: UpdateSettingsRequest, ctx?: ExecCtx | null): Promise<void> {
  const db = createDb(env);
  const writes: { key: string; value: string }[] = [];
  let fresh: Settings | undefined;
  const loadCurrent = async () => (fresh ??= await getSettingsFresh(env));

  const next: Partial<Pick<Settings, 'ai_model' | 'translation'>> = {};
  let domains: { value: string; expected: number; listed: string } | undefined;
  for (const key of Object.keys(SETTING_SCHEMAS) as SettingKey[]) {
    const incoming = patch[key];
    if (incoming === undefined) continue;
    const parsed = SETTING_SCHEMAS[key].safeParse(incoming);
    if (!parsed.success) throw new AppError('validation_failed', '配置格式非法');
    if (key === 'ai_model') {
      const value = parsed.data as Settings['ai_model'];
      // 提交 SECRET_MASK 表示保留已存 apiKey（接口地址的源不变时）
      const apiKey = value.apiKey === SECRET_MASK ? resolveMaskedAiKey((await loadCurrent()).ai_model, value.baseUrl, value.apiKey) : value.apiKey;
      next.ai_model = { ...value, apiKey };
      writes.push({ key, value: JSON.stringify(next.ai_model) });
    } else if (key === 'translation') {
      next.translation = parsed.data as Settings['translation'];
      writes.push({ key, value: JSON.stringify(next.translation) });
    } else if (key === 'domains') {
      const expected = patch.expectedDomainsRevision ?? (await loadCurrent()).domains.revision ?? 0;
      const listed = JSON.stringify((parsed.data as Settings['domains']).list.map((entry) => entry.domain));
      domains = { value: JSON.stringify({ ...parsed.data as object, revision: expected + 1 }), expected, listed };
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
    // 用户托管的域名由其所有者管理，不能同时登记为系统域名。检查写在这条 CAS 里，
    // 与托管域名创建（hosted-domain.ts）互相守卫，两边交错时只有先执行的一方写入成功
    const result = await env.db.prepare(`INSERT INTO settings (key, value)
      SELECT 'domains', ?1 WHERE ?2 = COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0)
        AND NOT ${anyHostedSql('?3')}
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE COALESCE(json_extract(settings.value, '$.revision'), 0) = ?2 RETURNING key`)
      .bind(domains.value, domains.expected, domains.listed).first();
    if (!result) throw await domainsWriteConflict(env, domains.listed);
  }
  for (const w of writes) {
    await db.insert(settingsTable).values(w)
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: w.value } });
  }
  await invalidateSettingsCache(env, ctx);
}

/** 管理端回显：AI 模型 apiKey 已配置时显示 SECRET_MASK（飞书/webhook 密钥已下放个人偏好） */
export function maskSettings(settings: Settings): Settings {
  const { ai_model: aiModel } = settings;
  return { ...settings, ai_model: { ...aiModel, apiKey: aiModel.apiKey ? SECRET_MASK : '' } };
}
