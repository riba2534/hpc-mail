import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MessageRecipients, UserNotifyPrefs } from '@hpc-mail/shared';

/** 统一时间戳列：unix 毫秒，Drizzle 映射为 Date */
const createdAtColumn = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  /** 强一致鉴权版本：改密/禁用时原子 +1，旧 JWT 立即失效 */
  authVersion: integer('auth_version').notNull().default(0),
  /** 是否已把旧 KV uepoch 惰性迁入 D1；避免版本 0 用户每请求读取 KV */
  authVersionMigrated: integer('auth_version_migrated', { mode: 'boolean' }).notNull().default(false),
  inviteId: integer('invite_id'),
  /** 头像 R2 key（null 表示无头像）；随每次上传变化，用于 URL 版本号防缓存 */
  avatarKey: text('avatar_key'),
  /** TOTP 密钥（base32，启用 2FA 后有值）；未启用为 null */
  totpSecret: text('totp_secret'),
  /** 2FA 启用时间；null 表示未启用（有 totpSecret 但未启用=登记中） */
  totpEnabledAt: integer('totp_enabled_at', { mode: 'timestamp_ms' }),
  /** 恢复码哈希列表（JSON，SHA-256）；每个用一次即移除 */
  totpRecoveryCodes: text('totp_recovery_codes', { mode: 'json' }).$type<string[]>(),
  /** 个人转发与通知偏好（JSON）：飞书/通用 webhook/邮箱转发。null=未配置，走默认（管理员则继承旧全局） */
  notifyPrefs: text('notify_prefs', { mode: 'json' }).$type<UserNotifyPrefs>(),
  createdAt: createdAtColumn(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  lastLoginIp: text('last_login_ip'),
});

export const mailboxes = sqliteTable(
  'mailboxes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    address: text('address').notNull().unique(),
    domain: text('domain').notNull(),
    userId: integer('user_id').notNull(),
    displayName: text('display_name').notNull().default(''),
    createdAt: createdAtColumn(),
  },
  (t) => [index('idx_mailboxes_user').on(t.userId), index('idx_mailboxes_domain').on(t.domain)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    /** 本站侧地址（inbound=收件地址；outbound=发件地址） */
    address: text('address').notNull(),
    domain: text('domain').notNull(),
    fromAddress: text('from_address').notNull().default(''),
    fromName: text('from_name').notNull().default(''),
    recipients: text('recipients', { mode: 'json' })
      .notNull()
      .$type<MessageRecipients>()
      .default(sql`'{"to":[],"cc":[],"bcc":[]}'`),
    subject: text('subject').notNull().default(''),
    /** 正文前 160 字符纯文本摘要，列表接口只读此列 */
    preview: text('preview').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    bodyHtml: text('body_html').notNull().default(''),
    /** 正文超限时完整 JSON 落 R2 的 key */
    bodyR2Key: text('body_r2_key'),
    /** 原始 .eml 落 R2 的 key（inbound 收件时存档，供下载/排查 DKIM）；null 表示未存档 */
    rawR2Key: text('raw_r2_key'),
    /** 入站幂等键（recipient + Message-ID + raw digest）；站内/外发为 null */
    ingestKey: text('ingest_key'),
    /** 软删除时间；null=正常，有值=在回收站（scheduled 到期后硬删） */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    verificationCode: text('verification_code').notNull().default(''),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').notNull().default(''),
    status: text('status').notNull(),
    sendChannel: text('send_channel').notNull().default(''),
    errorDetail: text('error_detail').notNull().default(''),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    size: integer('size').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('idx_messages_address').on(t.address, t.id),
    index('idx_messages_domain').on(t.domain, t.id),
    index('idx_messages_direction').on(t.direction, t.id),
    index('idx_messages_deleted').on(t.deletedAt),
    // 收件箱主查询（address ∈ 认领地址 + 未删除 + 按 id 倒序）与未读角标的覆盖索引。
    // D1 不自动跑 ANALYZE，无统计信息时优化器会挑 idx_messages_deleted 沿「未删除」这个
    // 巨大的等值组倒扫、把地址当残余过滤，代价随全表行数线性增长（20 万行实测 62ms）
    index('idx_messages_address_deleted_id').on(t.address, t.deletedAt, t.id),
    index('idx_messages_direction_read').on(t.direction, t.isRead, t.deletedAt),
    index('idx_messages_created_id').on(t.createdAt, t.id),
    index('idx_messages_message_id').on(t.messageId),
    index('idx_messages_in_reply_to').on(t.inReplyTo),
    uniqueIndex('idx_messages_ingest_key').on(t.ingestKey),
  ],
);

/** 强一致会话表。KV 仅在过渡期双写，鉴权以本表为准。 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAtColumn(),
  },
  (t) => [index('idx_sessions_user').on(t.userId), index('idx_sessions_expiry').on(t.expiresAt)],
);

/** 发信幂等记录：先原子占位，再执行真实副作用；完成结果可安全重放。 */
export const idempotencyRecords = sqliteTable(
  'idempotency_records',
  {
    actorType: text('actor_type', { enum: ['user', 'api_key'] }).notNull(),
    actorId: integer('actor_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status', { enum: ['pending', 'completed', 'failed'] })
      .notNull()
      .default('pending'),
    responseJson: text('response_json'),
    errorDetail: text('error_detail').notNull().default(''),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.actorType, t.actorId, t.key] }),
    index('idx_idempotency_created').on(t.createdAt),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: integer('message_id').notNull(),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull().default('download'),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    contentId: text('content_id').notNull().default(''),
    disposition: text('disposition').notNull().default('attachment'),
  },
  (t) => [index('idx_attachments_message').on(t.messageId)],
);

/**
 * 草稿附件：前端先独立上传到 R2、拿到 token，发送时引用 token。
 * 发送成功后内容迁移到 att/{messageId}/ 并删行；24h 未发送由 scheduled 清理（孤儿）。
 */
export const draftAttachments = sqliteTable(
  'draft_attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    /** 对外引用 token（前端持有，发送时回传） */
    token: text('token').notNull().unique(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    r2Key: text('r2_key').notNull(),
    /** R2 multipart upload id；null = 单片直传已完成 */
    uploadId: text('upload_id'),
    /** 已上传分片 [{partNumber, etag}]（JSON，单片直传为 null） */
    parts: text('parts', { mode: 'json' }).$type<{ partNumber: number; etag: string }[]>(),
    status: text('status', { enum: ['uploading', 'ready'] }).notNull().default('uploading'),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('idx_draft_user').on(t.userId),
    index('idx_draft_status').on(t.status, t.createdAt),
  ],
);

/** 星标：每用户对某封邮件的标记（messages 不含 user_id，星标独立表关联） */
export const stars = sqliteTable(
  'stars',
  {
    userId: integer('user_id').notNull(),
    messageId: integer('message_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index('idx_stars_message').on(t.messageId),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const invites = sqliteTable('invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  note: text('note').notNull().default(''),
  status: text('status', { enum: ['active', 'revoked'] })
    .notNull()
    .default('active'),
  createdBy: integer('created_by'),
  createdAt: createdAtColumn(),
});

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keySuffix: text('key_suffix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    userId: integer('user_id').notNull(),
    scopes: text('scopes', { mode: 'json' }).notNull().$type<string[]>(),
    allowedIps: text('allowed_ips', { mode: 'json' }).notNull().$type<string[]>(),
    rateLimit: integer('rate_limit').notNull().default(120),
    status: text('status', { enum: ['active', 'disabled', 'revoked'] })
      .notNull()
      .default('active'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    lastUsedIp: text('last_used_ip'),
    createdAt: createdAtColumn(),
  },
  (t) => [index('idx_api_keys_user').on(t.userId)],
);

export const apiRequestLogs = sqliteTable(
  'api_request_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    apiKeyId: integer('api_key_id').notNull(),
    requestId: text('request_id').notNull().default(''),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    ip: text('ip').notNull().default(''),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('idx_api_logs_key').on(t.apiKeyId, t.id),
    index('idx_api_logs_created').on(t.createdAt),
  ],
);

export const apiRateLimits = sqliteTable(
  'api_rate_limits',
  {
    apiKeyId: integer('api_key_id').notNull(),
    windowStart: integer('window_start').notNull(),
    requestCount: integer('request_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.windowStart] })],
);

/**
 * 通用计数器（外发配额 / 转发配额 / 注册限流 / 登录失败）。
 *
 * 这些原先都存在 KV 上做 get→+1→put：既非原子，KV 读还有最长 60s 边缘缓存，
 * 并发请求会读到同一个旧值互相覆盖——防盗号群发的闸门形同虚设。改用 D1 的
 * `ON CONFLICT DO UPDATE ... RETURNING`（与 api_rate_limits 同一模式）拿原子计数。
 *
 * window 的单位由调用方决定（外发配额用 yyyymmdd，登录失败用 15 分钟窗口序号）。
 */
export const rateCounters = sqliteTable(
  'rate_counters',
  {
    /** 计数类别，如 out / fwd / reg / login-fail */
    scope: text('scope').notNull(),
    /** 计数主体，如 userId、IP hash、用户名 hash */
    subject: text('subject').notNull(),
    window: integer('window').notNull(),
    count: integer('count').notNull().default(0),
    /** 附加计量，如外发收件人数；不需要时恒为 0 */
    units: integer('units').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scope, t.subject, t.window] })],
);

/** 管理操作审计：记录 admin 的高危动作（删户/改密/改设置/删域名/邀请/吊销 key），可追溯 */
export const adminAuditLogs = sqliteTable(
  'admin_audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').notNull(),
    actorName: text('actor_name').notNull().default(''),
    /** 动作类型，如 user.delete / settings.update / invite.revoke */
    action: text('action').notNull(),
    /** 目标的可读标识，如用户名、设置键、域名 */
    target: text('target').notNull().default(''),
    /** 附加说明 */
    detail: text('detail').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: createdAtColumn(),
  },
  (t) => [index('idx_admin_audit_created').on(t.createdAt)],
);
