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
/** /api 未读数封顶：侧栏只显示到 99+、标题到 999+，数到上限即停；/v1 精确计数 */
export const UNREAD_COUNT_CAP = 1000;
/** 批量认领 / 批量可用性检查单次最多处理的地址数 */
export const MAX_BATCH_CLAIM = 999;
/** 批量共享单次最多处理的邮箱数 */
export const MAX_BATCH_SHARE_MAILBOXES = 100;
/** 每只邮箱最多共享给多少人（替换与批量追加共用） */
export const MAX_MAILBOX_GRANTEES = 100;
/** 每个托管域名最多共享给多少位成员 */
export const MAX_HOSTED_DOMAIN_MEMBERS = 100;
export const MAX_DRAFT_ATTACHMENT_BYTES_PER_USER = 100 * 1024 * 1024;

/** 用户名：小写字母/数字开头，3-32 位，允许 - _ */
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9_-]{2,31}$/;
/**
 * 系统保留用户名：注册与管理员创建都不能使用。ci-smoke 由部署流水线的 seed 脚本维护（密码由 JWT_SECRET 派生），
 * 若被他人抢先注册，seed 会重置其密码。
 */
export const RESERVED_USERNAMES: readonly string[] = ['ci-smoke'];

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

/** AI 翻译：单次请求的片段数、单片段字符数与总字符数上限（前端据此分批） */
export const MAX_TRANSLATE_SEGMENTS = 60;
export const MAX_TRANSLATE_SEGMENT_CHARS = 2000;
export const MAX_TRANSLATE_BATCH_CHARS = 6000;
