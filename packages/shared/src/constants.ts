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
  'domain.read',
  'domain.write',
  /** 管理自己邮箱的共享（只接受 userId，不提供用户搜索） */
  'mailbox.share',
  /** 配置 Webhook v2 端点 */
  'webhook.write',
  /** 读取个人通知配置（飞书、PushDeer、通用 Webhook；转发目标只读） */
  'notify.read',
  /** 修改飞书、PushDeer、通用 Webhook；邮箱转发目标只能用网页会话（JWT）修改 */
  'notify.write',
  /**
   * 管理员能力开关：只有管理员可以授予；IP 白名单与有效期与其他 scope 一样可选。
   * 不带它的管理员 Key 按普通用户处理（不能跨用户查看、不能用任意 mailboxId 发信、受外发配额约束）。
   */
  'admin',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
/** Key 限定范围：allowedMailboxIds / allowedDomains 的数量上限（两者都为空表示不限） */
export const MAX_KEY_ALLOWED_MAILBOXES = 100;
export const MAX_KEY_ALLOWED_DOMAINS = 20;

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * 发件行实际写入的状态：pending 投递进行中（结果尚未回填）；sent 至少一个外部收件人被 Cloudflare 接受；
 * delivered 全部为站内收件人且已落库；failed 全部收件人失败；unknown 投递中断、超过 1 小时仍未回填，
 * 由定时任务标记（已回填的逐收件人结果保留，未回填的收件人记为 unknown）。
 * 历史数据里可能残留早期通道写入的其他值，展示时按未知值处理。
 */
export const OUTBOUND_STATUSES = ['pending', 'sent', 'delivered', 'failed', 'unknown'] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUSES)[number];
/** 外发 pending 超过该时长仍未回填结果，定时任务把它标为 unknown */
export const OUTBOUND_PENDING_STALE_MS = 60 * 60 * 1000;

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
 * base64 内联附件（请求体里的 attachments[].content）解码后合计上限。JSON 解析、base64 解码等环节会同时持有
 * 多份副本，超过该值容易逼近 Workers 128MB 内存上限；更大的文件先走 /uploads 拿 token
 * （token 附件仍受 MAX_ATTACHMENT_TOTAL_BYTES 约束）。
 */
export const MAX_INLINE_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
/** 发信请求体（JSON）上限：正文 1MiB + base64 内联附件编码后约 13.4MiB，留余量 */
export const MAX_SEND_REQUEST_BYTES = 16 * 1024 * 1024;
/** 单封邮件 replyTo 地址数上限 */
export const MAX_REPLY_TO = 10;
/** 收件人与发件人显示名长度上限（字符） */
export const MAX_DISPLAY_NAME_LENGTH = 64;
/** 外发并发：同一封邮件的外部收件人最多同时投递几路 */
export const OUTBOUND_DELIVERY_CONCURRENCY = 4;

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
/** /v1/messages/wait 单次最多同时等待的地址数（address 逗号分隔或重复参数） */
export const MAX_WAIT_ADDRESSES = 20;
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
/**
 * 批量添加 / 批量检测托管域名单次最多的项数。实际能处理的还受每人每分钟添加与检测次数、
 * pending 上限和全站 Cloudflare 额度约束，额度不够的项明确失败且不计数，下一分钟可用剩余项重试。
 */
export const MAX_HOSTED_DOMAIN_BATCH = 20;
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

/**
 * 转发中转（relayForward：以 no-reply@收件域名 经 send_email 重发）的日上限缺省值，
 * 管理员可在 settings.quota.relayDaily / relayPerUserDaily 覆盖（0=不限）。
 * 全站值取 Cloudflare 账户日发信配额（约 1000）的 30%，给用户自己的外发留足余量；
 * 按归属人计数，一封信转给同一归属人的多个目标各计一次。原生 forward() 不计入。
 */
export const DEFAULT_RELAY_DAILY_LIMIT = 300;
export const DEFAULT_RELAY_PER_USER_DAILY_LIMIT = 50;
/** 未认领地址的来信中转全站合计（不按管理员人数叠加） */
export const DEFAULT_RELAY_UNCLAIMED_DAILY_LIMIT = 50;

/** AI 翻译：单次请求的片段数、单片段字符数与总字符数上限（前端据此分批） */
export const MAX_TRANSLATE_SEGMENTS = 60;
export const MAX_TRANSLATE_SEGMENT_CHARS = 2000;
export const MAX_TRANSLATE_BATCH_CHARS = 6000;

/**
 * 服务端草稿与定时发送（/v1/drafts、/api/drafts）。
 * draft 可编辑；scheduled 到 sendAt 由每分钟的定时任务发出；sending 发送中（不可修改）；
 * sent 已执行发送，结果看 messageId 对应的发件记录（含部分失败与 unknown）；failed 没有任何收件人收到，可修改后重发。
 */
export const DRAFT_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
/** 定时发送时间：最早 1 分钟后、最晚 30 天内（按服务器时间） */
export const MIN_SEND_AT_DELAY_MS = 60 * 1000;
export const MAX_SEND_AT_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
/** 每个用户未发送（sent 以外）的服务端草稿上限 */
export const MAX_DRAFTS_PER_USER = 100;
/** 已发送的草稿保留天数（之后由每日维护删除；发件记录本身不受影响） */
export const SENT_DRAFT_RETENTION_DAYS = 7;

/** 批量发送单次最多项数 */
export const MAX_BATCH_SEND_ITEMS = 20;

/** URL 附件：每个用户每分钟最多拉取的个数（发信、批量与草稿合计） */
export const MAX_URL_ATTACHMENT_FETCHES_PER_MINUTE = 30;
/** URL 附件：没有 Content-Length 的响应要先读进内存，一个请求里这类缓冲合计的上限（批量的各项共用） */
export const MAX_URL_ATTACHMENT_BUFFER_BYTES = 10 * 1024 * 1024;

/** URL 附件：单次拉取总超时、最多跟随的重定向次数 */
export const URL_ATTACHMENT_TIMEOUT_MS = 15 * 1000;
export const URL_ATTACHMENT_MAX_REDIRECTS = 3;

/** sendAt（Unix 毫秒）不在允许范围内时返回原因，否则 null */
export function sendAtProblem(sendAt: number, now = Date.now()): string | null {
  if (sendAt < now + MIN_SEND_AT_DELAY_MS) return '定时发送时间最早为 1 分钟后';
  if (sendAt > now + MAX_SEND_AT_DELAY_MS) return '定时发送时间最晚为 30 天内';
  return null;
}
