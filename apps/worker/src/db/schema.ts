import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { MessageAuth, MessageRecipients, RecipientOutcome, UserMailboxPolicy, UserNotifyPrefs } from '@hpc-mail/shared';

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
  /**
   * 已废弃：曾标记旧 KV uepoch 是否已惰性迁入 D1。0030 迁移把存量全部置 1，当前代码不再读取；
   * 列保留（迁移只增不删），建户时显式写 1，回滚到上一版本时可直接走其快路径。
   * 不改列默认值：SQLite 改默认值要整表重建
   */
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
  /** null=使用公共配置；专属配置只约束新增认领/过户，存量邮箱保持可用。 */
  mailboxPolicy: text('mailbox_policy', { mode: 'json' }).$type<UserMailboxPolicy>(),
  mailboxPolicyRevision: integer('mailbox_policy_revision').notNull().default(0),
  createdAt: createdAtColumn(),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  lastLoginIp: text('last_login_ip'),
}, (t) => [
  // 未认领地址的通知归属（resolveNotifyOwnerIds）每封收件都查一次启用中的管理员；
  // 部分索引只收这几行，免得每次扫完整张 users。
  index('idx_users_active_admin').on(t.id).where(sql`${t.role} = 'admin' AND ${t.status} = 'active'`),
]);

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
    replyTo: text('reply_to', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
    recipientOutcomes: text('recipient_outcomes', { mode: 'json' }).notNull().$type<RecipientOutcome[]>().default(sql`'[]'`),
    purgeToken: text('purge_token'),
    notifyOwnerIds: text('notify_owner_ids', { mode: 'json' }).$type<number[]>(),
    notificationsQueuedAt: integer('notifications_queued_at', { mode: 'timestamp_ms' }),
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
    /** 收件时识别出的验证/登录链接（仅 http/https，≤2048）；识别不到或历史邮件为空串 */
    verificationLink: text('verification_link').notNull().default(''),
    /** 收件时采信的发件认证结果（lib/auth-results.ts）；null=没有可信结果（历史邮件、站内互投、发件） */
    auth: text('auth', { mode: 'json' }).$type<MessageAuth>(),
    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    references: text('references').notNull().default(''),
    status: text('status').notNull(),
    sendChannel: text('send_channel').notNull().default(''),
    errorDetail: text('error_detail').notNull().default(''),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    size: integer('size').notNull().default(0),
    /** 入站 pending 自愈（定时任务用 R2 原文重走收件）已失败的次数；达到上限标为 degraded */
    inboundRepairAttempts: integer('inbound_repair_attempts').notNull().default(0),
    createdAt: createdAtColumn(),
  },
  (t) => [
    index('idx_messages_address').on(t.address, t.id),
    index('idx_messages_domain').on(t.domain, t.id),
    // 「未删除 + id 倒序」的覆盖索引，替换原 idx_messages_deleted(deleted_at)。
    // D1 不自动跑 ANALYZE，无统计信息时优化器把 deleted_at IS NULL 当高选择性条件，列表/搜索/
    // 联系人会沿这个索引倒扫；把 address/direction/is_read 放进索引后残余过滤不必回表，
    // 新用户/稀疏用户的扫描从回表读整行降为只读索引。原 idx_messages_direction(direction, id)
    // 必须同时删除，否则收件箱查询会改走它按方向全量倒扫。
    index('idx_messages_live').on(t.deletedAt, t.id, t.address, t.direction, t.isRead),
    // 收件箱主查询（address ∈ 认领地址 + 未删除 + 按 id 倒序）。
    index('idx_messages_address_deleted_id').on(t.address, t.deletedAt, t.id),
    // 未读角标：按可见地址逐个计数，direction/is_read 在索引内，不读表行。
    index('idx_messages_visible').on(t.address, t.deletedAt, t.direction, t.isRead),
    index('idx_messages_created_id').on(t.createdAt, t.id),
    index('idx_messages_message_id').on(t.messageId),
    index('idx_messages_in_reply_to').on(t.inReplyTo),
    uniqueIndex('idx_messages_ingest_key').on(t.ingestKey),
    index('idx_messages_notification_outbox').on(t.createdAt, t.id).where(sql`${t.notifyOwnerIds} IS NOT NULL AND ${t.notificationsQueuedAt} IS NULL AND ${t.deletedAt} IS NULL`),
    // 清理链路按 purge_token / R2 key 反查，绝大多数行为 NULL，部分索引只收非空行。
    index('idx_messages_purge_token').on(t.purgeToken).where(sql`${t.purgeToken} IS NOT NULL`),
    index('idx_messages_body_r2').on(t.bodyR2Key).where(sql`${t.bodyR2Key} IS NOT NULL`),
    index('idx_messages_raw_r2').on(t.rawR2Key).where(sql`${t.rawR2Key} IS NOT NULL`),
    // 外发 pending 恢复：定时任务找出超过 1 小时仍未回填结果的发件行，正常时只有正在投递的少数几行
    index('idx_messages_outbound_pending').on(t.createdAt).where(sql`${t.direction} = 'outbound' AND ${t.status} = 'pending'`),
    // 入站 pending 自愈：附件等未保存完整的收件行，正常时为 0 行
    index('idx_messages_inbound_pending').on(t.createdAt).where(sql`${t.direction} = 'inbound' AND ${t.status} = 'pending'`),
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
    messageId: integer('message_id'),
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
  (t) => [index('idx_attachments_message').on(t.messageId), index('idx_attachments_r2_key').on(t.r2Key), uniqueIndex('idx_attachments_message_object').on(t.messageId, t.r2Key)],
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
    // 发信直接引用草稿对象后，对象清理要按 r2_key 判断草稿是否仍在（未发送的草稿不能被回收）
    index('idx_draft_r2_key').on(t.r2Key),
  ],
);

/**
 * 共享邮箱：所有者分享自己的地址，管理员可分享任意已认领地址。
 * 不改变 mailboxes.user_id（唯一认领人），也不参与通知归属。
 */
export const mailboxShares = sqliteTable(
  'mailbox_shares',
  {
    mailboxId: integer('mailbox_id').notNull(),
    userId: integer('user_id').notNull(),
    grantedBy: integer('granted_by').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.mailboxId, t.userId] }),
    index('idx_mailbox_shares_user').on(t.userId),
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

/**
 * AI 翻译缓存：按邮件 + 待译片段的哈希存译文，同一邮件的所有可见者共用。
 * 内容来自邮件本身，随邮件永久删除（purgeStatements）一并删除。
 */
export const messageTranslations = sqliteTable(
  'message_translations',
  {
    messageId: integer('message_id').notNull(),
    /** sha256(提示版本 + 模型 + 待译片段 JSON) */
    cacheKey: text('cache_key').notNull(),
    /** 与待译片段一一对应的译文 JSON 数组 */
    translations: text('translations', { mode: 'json' }).notNull().$type<string[]>(),
    model: text('model').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.cacheKey] })],
);

/**
 * 按收件地址记录的 Claude 账号事实，由官方来信归纳（services/claude-facts.ts）。
 * 不随邮件删除：邮件硬删后后缀的账号与封号统计仍然保留。标志只会由否变是。
 */
export const claudeAddressFacts = sqliteTable(
  'claude_address_facts',
  {
    address: text('address').primaryKey(),
    domain: text('domain').notNull(),
    paid: integer('paid', { mode: 'boolean' }).notNull().default(false),
    suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    suspendedAt: integer('suspended_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('idx_claude_facts_domain').on(t.domain)],
);

/**
 * 用户托管域名：zone 建在站长 Cloudflare 账户，用户把 NS 改过来后自动开通收发。
 * 只操作本表记录过的 zone_id，从不接管账户里已有的 zone。未认领地址的来信自动认领给 user_id。
 */
export const hostedDomains = sqliteTable(
  'hosted_domains',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    domain: text('domain').notNull().unique(),
    userId: integer('user_id').notNull(),
    status: text('status', {
      enum: ['pending', 'provisioning', 'active', 'error', 'moved', 'suspended', 'deleting'],
    }).notNull().default('pending'),
    /** 创建请求先占位，zone 建好后回填；null 表示占位后 zone 尚未创建成功 */
    zoneId: text('zone_id'),
    nameServers: text('name_servers', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
    originalNameServers: text('original_name_servers', { mode: 'json' }).notNull().$type<string[]>().default(sql`'[]'`),
    originalRegistrar: text('original_registrar').notNull().default(''),
    /** 以下四列是最近一次核对 Cloudflare 的结果，供状态展示与发信判断 */
    zoneStatus: text('zone_status').notNull().default(''),
    routingStatus: text('routing_status').notNull().default(''),
    catchAllReady: integer('catch_all_ready', { mode: 'boolean' }).notNull().default(false),
    sendingStatus: text('sending_status').notNull().default(''),
    sendingTag: text('sending_tag'),
    /** 公共 DNS 仍能查到 DS 记录：切换 NS 前必须先在注册商关闭 DNSSEC */
    dnssec: integer('dnssec', { mode: 'boolean' }).notNull().default(false),
    lastError: text('last_error').notNull().default(''),
    /** 每位成员在该域名下最多认领的地址数（0=不限） */
    memberLimit: integer('member_limit').notNull().default(0),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    activatedAt: integer('activated_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
    createdAt: createdAtColumn(),
  },
  (t) => [index('idx_hosted_domains_user').on(t.userId), index('idx_hosted_domains_status').on(t.status, t.checkedAt)],
);

/** 托管域名成员：可在该域名下认领地址，不改变域名归属，也看不到他人地址的邮件 */
export const hostedDomainMembers = sqliteTable(
  'hosted_domain_members',
  {
    domainId: integer('domain_id').notNull(),
    userId: integer('user_id').notNull(),
    grantedBy: integer('granted_by').notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    primaryKey({ columns: [t.domainId, t.userId] }),
    index('idx_hosted_domain_members_user').on(t.userId),
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

/** Long-lived delivery links keep an independent R2 reference after sent-mail deletion. */
export const externalAttachmentLinks = sqliteTable('external_attachment_links', {
  attachmentId: integer('attachment_id').primaryKey(),
  r2Key: text('r2_key').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('idx_external_links_expiry').on(t.expiresAt), index('idx_external_links_r2').on(t.r2Key)]);

/** Durable garbage references survive failed R2 cleanup. */
export const storageCleanupJobs = sqliteTable('storage_cleanup_jobs', {
  r2Key: text('r2_key').primaryKey(),
  createdAt: createdAtColumn(),
  lastError: text('last_error').notNull().default(''),
});

export const notificationJobs = sqliteTable('notification_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  messageId: integer('message_id'),
  userId: integer('user_id').notNull(),
  channel: text('channel', { enum: ['feishu', 'pushdeer', 'webhook', 'forward'] }).notNull(),
  target: text('target').notNull().default(''),
  payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  status: text('status', { enum: ['pending', 'processing', 'succeeded', 'failed', 'skipped', 'unknown'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAtColumn(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error').notNull().default(''),
  lastHttpStatus: integer('last_http_status'),
  /** 邮箱转发走的通道：native 原生 forward()、relay no-reply 中转；未尝试（跳过）或其他通道为空串 */
  forwardMode: text('forward_mode', { enum: ['', 'native', 'relay'] }).notNull().default(''),
  dedupeKey: text('dedupe_key').notNull().unique(),
}, (t) => [index('idx_notification_due').on(t.status, t.nextAttemptAt), index('idx_notification_user').on(t.userId, t.createdAt),
  // 通知健康页按 (用户, 通道) 取最新一条
  index('idx_notification_user_channel').on(t.userId, t.channel, t.id)]);

/** Temporary references protect delivery objects while sending or copying metadata. */
export const deliveryObjectLeases = sqliteTable('delivery_object_leases', {
  r2Key: text('r2_key').notNull(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [primaryKey({ columns: [t.r2Key, t.token] }), index('idx_delivery_lease_expiry').on(t.expiresAt)]);

/**
 * 外发与 Cloudflare 投递事件的对应：每个外部收件人一次 send() 一行。事件到达时依次按 send() 返回的
 * Cloudflare 消息 ID、本站 Message-ID（同收件人）、同一发件人与收件人唯一一条未回执的记录查找。
 * 保留 30 天，由每日维护清理。
 */
export const emailDeliveryRefs = sqliteTable('email_delivery_refs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** send() 返回的 Cloudflare 消息 ID；没有返回时为 null */
  providerMessageId: text('provider_message_id'),
  /** 本站写进原文的 Message-ID（不含尖括号）；中转转发为 null */
  rfcMessageId: text('rfc_message_id'),
  /** message：发件行（messages.id）；forward：中转转发，messageId 为被转发的收件行 */
  kind: text('kind', { enum: ['message', 'forward'] }).notNull(),
  messageId: integer('message_id').notNull(),
  sender: text('sender').notNull(),
  recipient: text('recipient').notNull(),
  /** forward：该目标的转发结果归属人（notification_jobs.user_id） */
  ownerIds: text('owner_ids', { mode: 'json' }).notNull().$type<number[]>().default(sql`'[]'`),
  /** 收到终态事件的时间；null 表示还没有回执 */
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex('idx_delivery_refs_provider').on(t.providerMessageId).where(sql`${t.providerMessageId} IS NOT NULL`),
  index('idx_delivery_refs_rfc').on(t.rfcMessageId).where(sql`${t.rfcMessageId} IS NOT NULL`),
  // 兜底匹配只看还没有回执的记录
  index('idx_delivery_refs_pending_pair').on(t.recipient, t.sender, t.id).where(sql`${t.resolvedAt} IS NULL`),
  index('idx_delivery_refs_created').on(t.createdAt),
]);

/**
 * 外发抑制名单：退信与投诉后，同一发信域名再发给该地址直接失败（范围与 Cloudflare 的 sending_domain 一致）。
 * expires_at 为 null 长期有效，由管理员解除；到期的行由每日维护清理。
 */
export const emailSuppressions = sqliteTable('email_suppressions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  address: text('address').notNull(),
  sendingDomain: text('sending_domain').notNull(),
  reason: text('reason', { enum: ['hard_bounce', 'soft_bounce', 'complaint'] }).notNull(),
  detail: text('detail').notNull().default(''),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  /** 最近一次写入该条目的 Cloudflare 事件 ID */
  eventId: text('event_id').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAtColumn(),
}, (t) => [
  uniqueIndex('idx_suppressions_address_domain').on(t.address, t.sendingDomain),
  index('idx_suppressions_expires').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
]);

/** 发信域名的 Cloudflare 事件订阅（系统域名与托管域名共用） */
export const emailEventSubscriptions = sqliteTable('email_event_subscriptions', {
  domain: text('domain').primaryKey(),
  kind: text('kind', { enum: ['system', 'hosted'] }).notNull(),
  zoneId: text('zone_id').notNull().default(''),
  subscriptionId: text('subscription_id'),
  status: text('status', { enum: ['active', 'error'] }).notNull(),
  lastError: text('last_error').notNull().default(''),
  checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
  createdAt: createdAtColumn(),
});
