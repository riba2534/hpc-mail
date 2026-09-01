export const REGISTRATION_MODES = ['closed', 'invite', 'open'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export const ROLES = ['admin', 'user'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const API_SCOPES = [
  'mail.read',
  'mail.write',
  'mail.send',
  'mailbox.read',
  'mailbox.write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const OUTBOUND_STATUSES = [
  'sent',
  'delivered',
  'bounced',
  'failed',
  'complained',
  'delayed',
] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];

export const API_KEY_STATUSES = ['active', 'disabled', 'revoked'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 100;

export const MAX_RECIPIENTS = 100;
export const MAX_ATTACHMENTS = 10;
/** 单个附件上限（站内互投共享 R2 对象；外发另受 EXTERNAL_MESSAGE_MAX_BYTES 约束） */
export const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;
/** 单封邮件附件合计上限 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
/** 单封正文上限 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 附件独立上传到 R2（前端先上传拿 token，发送时引用 token）
 */
/** 草稿附件未发送保留时长：超时由 scheduled 清理（孤儿） */
export const DRAFT_ATTACHMENT_TTL_HOURS = 24;
/** 小于此阈值单片流式直传；否则走 R2 multipart 分片 */
export const SINGLE_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024;
/** R2 multipart 每片大小（R2 要求每片 ≥ 5MB，末片除外） */
export const MULTIPART_PART_BYTES = 5 * 1024 * 1024;

/**
 * 外发约束：Cloudflare send_email 单封邮件（含附件、base64 编码后）硬限 5 MiB。
 * 取 4 MiB 作为「正文 + Σ(base64 附件字节)」近似上限，留余量给 MIME 头/边界。
 * 仅对含外部收件人的发送生效；站内互投走 R2 不受此限。
 */
export const EXTERNAL_MESSAGE_MAX_BYTES = 4 * 1024 * 1024;

export const API_KEY_PREFIX = 'hpcm_';
export const DEFAULT_API_RATE_LIMIT = 120;
export const MAX_API_RATE_LIMIT = 600;
export const MAX_API_KEYS_PER_USER = 10;
export const MAX_API_USER_REQUESTS_PER_MINUTE = 1200;
export const MAX_API_GLOBAL_REQUESTS_PER_MINUTE = 10000;
export const MAX_WAIT_POLLS_PER_USER_PER_MINUTE = 120;
export const MAX_AUTH_USER_REQUESTS_PER_MINUTE = 600;
export const MAX_AUTH_GLOBAL_REQUESTS_PER_MINUTE = 5000;
export const MAX_DRAFT_ATTACHMENTS_PER_USER = 20;
export const MAX_DRAFT_ATTACHMENT_BYTES_PER_USER = 100 * 1024 * 1024;

/** 用户名：小写字母/数字开头，3-32 位，允许 - _ */
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** 邮箱前缀（local part）：1-64 位，小写字母数字开头结尾，中间允许 . _ + - */
export const LOCAL_PART_REGEX = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** 默认保留前缀：普通用户禁止认领这些「官方/系统」身份（admin 豁免） */
export const DEFAULT_RESERVED_LOCAL_PARTS = [
  'admin',
  'administrator',
  'postmaster',
  'hostmaster',
  'webmaster',
  'abuse',
  'security',
  'root',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'support',
  'billing',
  'info',
  'help',
] as const;
