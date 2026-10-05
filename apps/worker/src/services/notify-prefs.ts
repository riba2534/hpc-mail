import {
  DEFAULT_USER_NOTIFY_PREFS,
  SECRET_MASK,
  feishuSettingSchema,
  gmailForwardSettingSchema,
  notifyWebhookSettingSchema,
  pushdeerSettingSchema,
  type UpdateNotifyPrefsRequest,
  type UserNotifyPrefs,
} from '@hpc-mail/shared';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { settings as settingsTable, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { validateFeishuWebhookUrl } from './feishu.js';
import { validatePushDeerEndpoint } from './pushdeer.js';
import { validateNotifyWebhookUrl } from './webhook-notify.js';

function clone(prefs: UserNotifyPrefs): UserNotifyPrefs {
  return {
    feishu: { ...prefs.feishu },
    webhook: { ...prefs.webhook },
    forward: { ...prefs.forward, addresses: [...prefs.forward.addresses] },
    pushdeer: { ...prefs.pushdeer },
  };
}

/** 逐块 safeParse，脏字段回落默认，避免单块坏数据整包失效 */
function normalize(raw: unknown): UserNotifyPrefs {
  const out = clone(DEFAULT_USER_NOTIFY_PREFS);
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const f = feishuSettingSchema.safeParse(r.feishu);
  if (f.success) out.feishu = f.data;
  const w = notifyWebhookSettingSchema.safeParse(r.webhook);
  if (w.success) out.webhook = w.data;
  const fw = gmailForwardSettingSchema.safeParse(r.forward);
  if (fw.success) out.forward = fw.data;
  const pd = pushdeerSettingSchema.safeParse(r.pushdeer);
  if (pd.success) out.pushdeer = pd.data;
  return out;
}

/**
 * 读旧全局通知设置（settings 表 feishu/notify_webhook/gmail_forward 三行原始值），
 * 映射成个人偏好结构——仅作为**管理员**首次未配置个人偏好时的继承来源。
 */
async function readLegacyGlobalNotify(env: Env): Promise<UserNotifyPrefs | null> {
  const db = createDb(env);
  const rows = await db
    .select()
    .from(settingsTable)
    .where(inArray(settingsTable.key, ['feishu', 'notify_webhook', 'gmail_forward']))
    .all();
  if (!rows.length) return null;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out = clone(DEFAULT_USER_NOTIFY_PREFS);
  const jsonOf = (v: string | undefined): unknown => {
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  const f = feishuSettingSchema.safeParse(jsonOf(map.get('feishu')));
  if (f.success) out.feishu = f.data;
  const w = notifyWebhookSettingSchema.safeParse(jsonOf(map.get('notify_webhook')));
  if (w.success) out.webhook = w.data;
  const fw = gmailForwardSettingSchema.safeParse(jsonOf(map.get('gmail_forward')));
  if (fw.success) out.forward = fw.data;
  return out;
}

/**
 * 读某用户的个人转发/通知偏好。
 * 已配置 → 用之；未配置且为 admin → 继承旧全局设置（平滑迁移，管理员体验不变）；否则默认（全关）。
 */
export async function getUserNotifyPrefs(env: Env, userId: number): Promise<UserNotifyPrefs> {
  const db = createDb(env);
  const row = await db
    .select({ notifyPrefs: users.notifyPrefs, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (!row) return clone(DEFAULT_USER_NOTIFY_PREFS);
  if (row.notifyPrefs) return normalize(row.notifyPrefs);
  if (row.role === 'admin') {
    const legacy = await readLegacyGlobalNotify(env);
    if (legacy) return legacy;
  }
  return clone(DEFAULT_USER_NOTIFY_PREFS);
}

/** 写个人偏好：逐块合并 + secret 掩码保留旧值 + 落库 */
export async function updateUserNotifyPrefs(
  env: Env,
  userId: number,
  patch: UpdateNotifyPrefsRequest,
): Promise<UserNotifyPrefs> {
  const current = await getUserNotifyPrefs(env, userId);
  const next = clone(current);
  if (patch.feishu) {
    next.feishu = {
      ...patch.feishu,
      secret: patch.feishu.secret === SECRET_MASK ? current.feishu.secret : patch.feishu.secret,
    };
  }
  if (patch.webhook) {
    next.webhook = {
      ...patch.webhook,
      secret: patch.webhook.secret === SECRET_MASK ? current.webhook.secret : patch.webhook.secret,
    };
  }
  if (patch.forward) next.forward = { ...patch.forward, addresses: [...patch.forward.addresses] };
  if (patch.pushdeer) {
    next.pushdeer = {
      ...patch.pushdeer,
      pushkey: patch.pushdeer.pushkey === SECRET_MASK ? current.pushdeer.pushkey : patch.pushdeer.pushkey,
    };
  }

  // 保存启用配置时采用与实际投递相同的校验，避免保存成功但永远无法执行。
  // 未启用的配置可作为未填完整的草稿；空 secret / PushKey 是明确清除，MASK 才是保留。
  if (patch.feishu && next.feishu.enabled) validateFeishuWebhookUrl(next.feishu.webhookUrl);
  if (patch.pushdeer && next.pushdeer.enabled) {
    validatePushDeerEndpoint(next.pushdeer.endpoint);
    if (!next.pushdeer.pushkey.trim()) throw new AppError('validation_failed', '开启 PushDeer 通知需要 PushKey');
  }
  if (patch.webhook && next.webhook.enabled && !validateNotifyWebhookUrl(next.webhook.url)) {
    throw new AppError('validation_failed', '开启通用 Webhook 需要有效的 HTTPS 公网地址');
  }
  if (patch.forward && next.forward.enabled && next.forward.addresses.length === 0) {
    throw new AppError('validation_failed', '开启邮箱转发需要至少一个目标地址');
  }

  const db = createDb(env);
  const res = await db
    .update(users)
    .set({ notifyPrefs: next })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!res.length) throw new AppError('not_found', '用户不存在');
  return next;
}

/** 回显脱敏：feishu / webhook secret 与 pushdeer pushkey 用 SECRET_MASK（保留 configured 状态） */
export function maskUserNotifyPrefs(prefs: UserNotifyPrefs): UserNotifyPrefs {
  return {
    ...prefs,
    feishu: { ...prefs.feishu, secret: prefs.feishu.secret ? SECRET_MASK : '' },
    webhook: { ...prefs.webhook, secret: prefs.webhook.secret ? SECRET_MASK : '' },
    pushdeer: { ...prefs.pushdeer, pushkey: prefs.pushdeer.pushkey ? SECRET_MASK : '' },
  };
}
