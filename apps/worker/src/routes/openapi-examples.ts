import {
  API_SCOPES, MAX_API_KEYS_PER_USER, MAX_DRAFT_ATTACHMENT_BYTES_PER_USER, MAX_DRAFT_ATTACHMENTS_PER_USER, MAX_HOSTED_DNS_RECORDS,
  MAX_SEND_REQUEST_BYTES, MULTIPART_PART_BYTES, type ApiErrorDetails, type ErrorCode, type SuppressedRecipient, type SystemDomainPrecheck,
} from '@hpc-mail/shared';

/**
 * 两份 OpenAPI 的示例数据。成功示例按响应 schema 由这里的组件示例拼出（见 openapi-common 的 exampleOf），
 * 失败示例放进 components.examples，operation 用 $ref 引用；message 取自实现里真实抛出的文案。
 */
const AT = '2026-11-17T08:30:00.000Z';
const LATER = '2026-11-17T08:31:12.000Z';
const ATTACHMENT_URL = '/api/attachments/77?exp=1795251600&sig=9b1f0c7e4d2a6b8c3e5f7a9d1c3b5e7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b';

const inboundSummary = {
  id: 1024, direction: 'inbound', address: 'alice@example.org', domain: 'example.org',
  fromAddress: 'no-reply@service.example', fromName: 'Example Service', subject: 'Your verification code',
  preview: 'Your verification code is 482913. It expires in 10 minutes.', verificationCode: '482913', verificationLink: '',
  status: 'received', errorDetail: '', isRead: false, isStarred: false, hasAttachments: true, size: 52480, createdAt: AT,
  auth: { spf: 'pass', dkim: 'pass', dkimDomain: 'service.example', dmarc: 'pass', aligned: true },
};
/** 发信成功（201）的摘要：外部收件人已被服务商接受 */
export const sentMessageExample = {
  id: 1025, direction: 'outbound', address: 'alice@example.org', domain: 'example.org',
  fromAddress: 'alice@example.org', fromName: 'Alice', subject: 'Re: Project update', preview: 'Thanks, see you tomorrow.',
  verificationCode: '', status: 'sent', errorDetail: '', recipientOutcomes: [{ address: 'bob@example.net', status: 'sent' }],
  recipientsTo: ['bob@example.net'], isRead: true, isStarred: false, hasAttachments: false, size: 1532, createdAt: LATER,
};
/** 转发成功（201）的摘要：原邮件附件一并带上 */
export const forwardedMessageExample = {
  ...sentMessageExample, id: 1027, subject: 'Fwd: Your verification code', preview: 'FYI, see the code below.',
  hasAttachments: true, size: 53120,
};
const attachment = {
  id: 77, filename: 'invoice.pdf', mimeType: 'application/pdf', size: 48213, contentId: '', disposition: 'attachment', inline: false, url: ATTACHMENT_URL,
};
const mailbox = {
  id: 12, address: 'alice@example.org', domain: 'example.org', userId: 3, ownerUsername: 'alice', displayName: 'Alice', messageCount: 128, createdAt: AT, canSend: true,
};
const sessionUser = { id: 3, username: 'alice', role: 'user', createdAt: AT, avatarUrl: null, twoFactorEnabled: false };
const apiKey = {
  id: 5, name: 'ci-bot', keyPrefix: 'hpcm_3f9a', keySuffix: 'c2d1', scopes: ['mail.read', 'mail.send'], rateLimit: 60,
  allowedIps: [], status: 'active', expiresAt: null, lastUsedAt: LATER, createdAt: AT, allowedMailboxIds: [], allowedDomains: [], ownerUsername: 'alice',
};
const hostedDomain = {
  id: 8, domain: 'alice.dev', status: 'active', role: 'owner', ownerUserId: 3, ownerUsername: 'alice',
  nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], originalNameServers: ['ns1.registrar.example', 'ns2.registrar.example'],
  originalRegistrar: 'Example Registrar', steps: { nameServers: 'ready', routing: 'ready', catchAll: 'ready', sending: 'ready' },
  warnings: [], lastError: '', memberLimit: 0, memberCount: 1, mailboxCount: 4, createdAt: AT, activatedAt: LATER, checkedAt: LATER, expiresAt: null,
};
const suppressed: SuppressedRecipient = { address: 'nobody@example.net', reason: 'hard_bounce', sendingDomain: 'example.org', since: '2026-11-16T09:12:00.000Z', expiresAt: '2026-11-23T09:12:00.000Z' };
const delivery = {
  id: 301, messageId: 1024, target: 'webhook', status: 'succeeded', attempts: 1, maxAttempts: 1, lastError: '', lastHttpStatus: 200,
  createdAt: AT, updatedAt: LATER, nextAttemptAt: AT, lastAttemptAt: LATER,
};

/** 系统域名接入的预检：已有 zone，根域有第三方 MX 需要确认删除 */
const systemDomainPrecheck: SystemDomainPrecheck = {
  mode: 'existing_zone', domain: 'example.com', zoneId: '023e105f4ecef8ad9ca31a8372d0c353', zoneStatus: 'active', checkedAt: AT,
  checks: [{ key: 'mx', state: 'conflict', severity: 'confirm', ack: 'mx.delete', danger: true, title: '根域有第三方 MX',
    current: '10 smtp.google.com', proposed: 'Cloudflare Email Routing 的 MX', impact: '确认后删除原 MX，该域名不再经原服务商收信',
    records: [{ type: 'MX', name: 'example.com', content: 'smtp.google.com', priority: 10, ttl: 3600 }] }],
  steps: [{ kind: 'mx.delete', detail: '删除 1 条第三方 MX' }, { kind: 'routing.enable', detail: '开启 Email Routing' }],
  requiredAcks: ['mx.delete'], verdict: 'confirm', fingerprint: '5f2c9a7e1b3d4c6a', registrar: { name: 'Example Registrar', cloudflare: false },
  nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], dnssec: null,
};
/** 组件 schema 的成功示例：键为 components.schemas 的名字 */
export const SCHEMA_EXAMPLES: Record<string, unknown> = {
  MessageSummary: inboundSummary,
  MessageDetail: {
    ...inboundSummary, replyTo: [], recipients: { to: ['alice@example.org'], cc: [], bcc: [] },
    bodyText: 'Your verification code is 482913. It expires in 10 minutes.',
    bodyHtml: '<p>Your verification code is <b>482913</b>. It expires in 10 minutes.</p>', attachments: [attachment], hasRaw: true,
    extractedText: 'Your verification code is 482913. It expires in 10 minutes.', risk: { promptInjection: false, reasons: [] },
  },
  MessagePage: { items: [inboundSummary], nextCursor: 'MTAyNA' },
  SessionMessagePage: { items: [inboundSummary], nextCursor: 'MTAyNA', head: '1024:0:3f9a' },
  MessageSync: { unread: 3, head: '1024:0:3f9a' },
  Attachment: attachment,
  Mailbox: mailbox,
  SharedMailbox: { mailboxId: 14, address: 'team@example.org', domain: 'example.org', displayName: 'Team', ownerUsername: 'bob' },
  MailboxAvailability: { address: 'alice@example.org', available: false, reason: 'taken' },
  MailboxShareGrant: {
    mailboxId: 12, address: 'alice@example.org', domain: 'example.org', displayName: 'Alice', ownerUserId: 3, ownerUsername: 'alice',
    grantees: [{ userId: 4, username: 'bob', grantedAt: AT, status: 'active' }],
  },
  MailboxTransferResult: { mailbox: { ...mailbox, userId: 4, ownerUsername: 'bob' }, previousUserId: 3, transferred: true, revokedShares: 1 },
  BatchClaimMailboxResult: {
    claimed: [mailbox], taken: [{ localPart: 'bob', domain: 'example.org' }], notAttempted: [], stoppedBy: null,
  },
  ClaimPlan: { strategy: 'uniform', items: [{ domain: 'example.org', suspended: 0 }, { domain: 'example.net', suspended: 0 }], pool: ['example.org', 'example.net'], shortfall: 0, reason: null },
  UserSearchResults: { items: [{ id: 4, username: 'bob' }], hasMore: false },
  SendIdentities: {
    identities: [
      { kind: 'owned', mailboxId: 12, address: 'alice@example.org', domain: 'example.org', displayName: 'Alice', canSend: true, reason: null },
      { kind: 'shared', mailboxId: 14, address: 'team@example.org', domain: 'example.org', displayName: 'Team', canSend: false, reason: 'shared_readonly' },
    ],
    domains: [],
  },
  ApiKeySelf: {
    key: { id: 5, name: 'ci-bot', keyPrefix: 'hpcm_3f9a', keySuffix: 'c2d1', scopes: ['mail.read', 'mail.send'], rateLimit: 60, allowedIps: [], expiresAt: null, createdAt: AT,
      allowedMailboxIds: [12], allowedDomains: [], effectiveRole: 'user' },
    user: { id: 3, username: 'alice', role: 'user' },
    limits: { userRequestsPerMinute: 120, waitPollsPerMinute: 120 },
    outbound: { sent: 4, recipients: 6, dailyLimit: 100, dailyRecipientLimit: 300, exempt: false, resetsAt: '2026-11-18T00:00:00.000Z' },
  },
  SystemDomainPrecheck: systemDomainPrecheck,
  SessionUser: sessionUser,
  LoginResponse: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjN9.c2lnbmF0dXJl', user: sessionUser },
  ChangePasswordResponse: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjN9.bmV3LXNpZw', user: sessionUser, revokedApiKeys: 2 },
  AdminUser: {
    id: 3, username: 'alice', role: 'user', createdAt: AT, avatarUrl: null, status: 'active', mailboxCount: 1, mailboxes: ['alice@example.org'],
    mailboxPolicy: null, mailboxPolicyRevision: 0, apiKeyCount: 1, lastLoginAt: LATER,
  },
  ApiKeySummary: apiKey,
  CreatedApiKey: { ...apiKey, lastUsedAt: null, key: 'hpcm_3f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9c2d1' },
  ApiRequestLog: { id: 9001, requestId: '7f9c2ba4-e88f-4a2b-9f3c-2d1e5b8a6c01', method: 'GET', path: '/v1/messages/:id', statusCode: 200, ip: '203.0.113.7', durationMs: 412, count: 12, createdAt: AT },
  AdminAuditLog: { id: 51, actorName: 'admin', action: 'mailbox.transfer', target: 'alice@example.org', detail: 'alice → bob', ip: '203.0.113.7', createdAt: AT },
  Invite: { id: 6, code: 'K7Q2-M9XD', maxUses: 5, usedCount: 1, expiresAt: '2026-12-01T00:00:00.000Z', note: 'team onboarding', createdAt: AT, status: 'usable', usedBy: ['bob'] },
  NotificationDelivery: delivery,
  NotificationHealth: {
    channels: [{ channel: 'webhook', enabled: true, latest: delivery, pendingCount: 0, failedCount: 0 }],
    forward: { domainLimit: 200, targetLimit: 100, windowEndsAt: '2026-11-18T00:00:00.000Z', targets: [{ address: 'me@example.net', attempts: 3, remaining: 97 }], domains: [{ domain: 'example.net', attempts: 3, remaining: 197 }] },
  },
  NotifyPrefs: {
    feishu: { enabled: false, webhookUrl: '', secret: '', contentLevel: 'summary' },
    webhook: { enabled: true, url: 'https://hooks.example.net/hpc-mail', secret: '******' },
    forward: { enabled: true, addresses: ['me@example.net'] },
    pushdeer: { enabled: false, endpoint: '', pushkey: '' },
    forwardPending: [{ address: 'new@example.net', expiresAt: '2026-11-20T00:00:00.000Z' }],
  },
  DomainStatus: { domain: 'example.org', inList: true, mxReady: true, spfReady: true, mxRecords: ['route1.mx.cloudflare.net'], resolved: true },
  DomainClaudeStats: { domain: 'example.org', accounts: 12, suspended: 0, paid: 3, paidSuspended: 0, pending: 2, recent: 1, risk: null },
  PublicConfig: { siteTitle: 'HPC Mail', registrationMode: 'invite', domains: ['example.org'], require2fa: false, translationEnabled: true, hostedDomainsEnabled: true },
  HostedDomain: hostedDomain,
  HostedDomainMember: { userId: 4, username: 'bob', status: 'active', grantedAt: AT, mailboxCount: 1 },
  HostedDomainTransferResult: { domain: { ...hostedDomain, ownerUserId: 4, ownerUsername: 'bob' }, previousUserId: 3, transferred: true, movedMailboxes: 4 },
  HostedDomainsHealth: { enabled: true, configured: true, tokenValid: true, error: '', accountZones: 12, accountPendingZones: 1 },
  HostedDnsRecord: {
    id: '023e105f4ecef8ad9ca31a8372d0c353', type: 'A', name: 'www', fqdn: 'www.alice.dev', content: '203.0.113.10', ttl: 1, priority: null,
    srv: null, caa: null, proxied: false, comment: 'website', kind: 'user', lockedReason: '', modifiedAt: AT,
  },
  SuppressedRecipient: suppressed,
  EmailSuppression: { id: 41, ...suppressed, detail: '550 5.1.1 User unknown', updatedAt: '2026-11-16T09:12:00.000Z' },
  DeliveryEventsOverview: {
    enabled: true, credentials: true, queue: 'hpc-mail-email-events',
    subscriptions: [{ domain: 'example.org', kind: 'system', zoneId: '023e105f4ecef8ad9ca31a8372d0c353', subscriptionId: 'f3b2c1d0-5e6a-4b7c-8d9e-0a1b2c3d4e5f', status: 'active', lastError: '', checkedAt: AT }],
  },
  MessageTranslation: { translations: ['你的验证码是 482913，10 分钟内有效。'], cached: false, skipped: 0 },
  AiModelTestResult: { ok: true, latencyMs: 820, sample: '你的验证码是 123456，10 分钟内有效。' },
  SingleUploadResult: { token: 'upl_8f3c2a1b9d7e', filename: 'report.pdf', size: 482113, mimeType: 'application/pdf' },
  MultipartInitResult: { token: 'upl_5d1e7c3a2b9f', uploadId: '2~kZ8yQ0mXr3', partBytes: MULTIPART_PART_BYTES, partCount: 4 },
  MultipartPartResult: { partNumber: 1, etag: '"a54357aff0632cce46d942af68356b38"' },
  MultipartCompleteResult: { token: 'upl_5d1e7c3a2b9f', size: 18874368 },
};

/** 二进制响应的成功示例（按媒体类型） */
export const BINARY_EXAMPLES: Record<string, string> = {
  'message/rfc822': 'From: Example Service <no-reply@service.example>\r\nTo: alice@example.org\r\nSubject: Your verification code\r\n\r\nYour verification code is 482913.\r\n',
  'application/octet-stream': '<binary file content>',
  '*/*': '<binary file content>',
};

export interface ErrorExample {
  code: ErrorCode;
  message: string;
  fix?: string;
  /** 站内路径，导出时按请求 origin 补成绝对 URL；省略时按错误码套用中间件的默认建议 */
  docs?: string;
  details?: ApiErrorDetails;
}
const MIB = 1024 * 1024;
const FORBIDDEN_SENDER_FIX = '先调 GET /v1/identities（网页会话用 /api/identities），从 canSend=true 的地址里选一个作为 from；共享给你的邮箱只能读，不能发信';

/**
 * 失败示例目录：键名即 components.examples 的名字，HTTP 状态由错误码决定（ERROR_STATUS）。
 * 新接口有专属错误时在这里加一条，再在 operation 的 errors 里引用键名。
 */
export const ERROR_EXAMPLES = {
  UnauthorizedSession: { code: 'unauthorized', message: '令牌无效或已过期' },
  UnauthorizedApiKey: { code: 'unauthorized', message: 'API Key 无效' },
  RateLimitedSession: { code: 'rate_limited', message: '请求过于频繁，请稍后重试' },
  RateLimitedApiKey: { code: 'rate_limited', message: 'API 调用频率超限' },
  ForbiddenAdmin: { code: 'forbidden', message: '需要管理员权限' },
  ForbiddenScopeIdentities: { code: 'forbidden', message: '需要 API scope: mail.send 或 mailbox.read',
    fix: '这把 Key 需要 mail.send 或 mailbox.read 其中之一：在网页「API Key」页面加上，或换用带其中一个 scope 的 Key（GET /v1/me 可查看当前 scopes）',
    docs: '/references/errors.md#forbidden-scope' },
  InvalidJson: { code: 'validation_failed', message: '请求体不是合法 JSON' },
  InvalidCursor: { code: 'validation_failed', message: 'cursor 无效：请原样传回上一页响应的 nextCursor，首页不带 cursor' },
  MissingUserId: { code: 'validation_failed', message: '查看指定用户邮件需要 userId' },
  ValidationFailed: { code: 'validation_failed', message: '参数校验失败' },
  Internal: { code: 'internal', message: '服务器内部错误' },
  NotFoundMessage: { code: 'not_found', message: '邮件不存在' },
  NotFoundAttachment: { code: 'not_found', message: '附件不存在' },
  NotFoundMailbox: { code: 'not_found', message: '邮箱不存在' },
  NotFoundHostedDomain: { code: 'not_found', message: '域名不存在' },
  NotFoundDnsRecord: { code: 'not_found', message: '解析记录不存在' },
  NotFoundApiKey: { code: 'not_found', message: 'API Key 不存在' },
  NotFoundUser: { code: 'not_found', message: '用户不存在' },
  NotFoundInvite: { code: 'not_found', message: '邀请码不存在' },
  NotFoundUpload: { code: 'not_found', message: '上传会话不存在' },
  NotFoundAvatar: { code: 'not_found', message: '头像不存在' },
  NotFoundNotificationJob: { code: 'not_found', message: '通知任务不存在' },
  NotFoundGrantee: { code: 'not_found', message: '该用户不在共享名单中' },
  NotFoundSuppression: { code: 'not_found', message: '抑制条目不存在或已解除' },
  NoRawArchive: { code: 'not_found', message: '该邮件无原始存档' },
  SignatureInvalid: { code: 'unauthorized', message: '签名无效或已过期' },
  BadCredentials: { code: 'bad_credentials', message: '用户名或密码错误' },
  WrongPassword: { code: 'bad_credentials', message: '原密码错误' },
  WrongTotp: { code: 'bad_credentials', message: '两步验证码错误' },
  TotpRequired: { code: 'totp_required', message: '需要两步验证码' },
  UserDisabled: { code: 'user_disabled', message: '账号已被禁用' },
  LoginRateLimited: { code: 'rate_limited', message: '登录尝试过于频繁，请稍后再试' },
  RegisterRateLimited: { code: 'rate_limited', message: '注册尝试过于频繁，请稍后再试' },
  RegistrationClosed: { code: 'registration_closed', message: '注册已关闭' },
  InviteInvalid: { code: 'invite_invalid', message: '邀请码无效或已用尽' },
  UsernameTaken: { code: 'conflict', message: '用户名已存在' },
  TwoFactorAlreadyEnabled: { code: 'conflict', message: '两步验证已启用' },
  AvatarTooLarge: { code: 'payload_too_large', message: '头像图片不能超过 2MB' },
  AddressTaken: { code: 'address_taken', message: '该地址已被占用' },
  ClaimQuota: { code: 'forbidden', message: '认领地址数已达上限（10）' },
  ClaimDomainForbidden: { code: 'forbidden', message: '当前用户无权认领该域名' },
  ClaudeSuspended: { code: 'forbidden', message: '该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领' },
  MailboxOwnerChanged: { code: 'conflict', message: '邮箱所有者已改变，请刷新后重试' },
  NotFoundTargetUser: { code: 'not_found', message: '目标用户不存在' },
  BatchStateChanged: { code: 'conflict', message: '邮箱归属、用户状态或额度在提交前已改变，本批未做任何修改，请刷新后重试' },
  GranteeMissing: { code: 'validation_failed', message: '包含不存在的用户' },
  ShareOwnMailboxOnly: { code: 'forbidden', message: '只能共享自己已认领的地址' },
  ShareToOwner: { code: 'validation_failed', message: '邮箱所有者已经拥有访问权限，无需共享' },
  ShareListChanged: { code: 'conflict', message: '共享名单已改变，请刷新后重试' },
  ForbiddenSender: { code: 'forbidden', message: '只能使用自己认领的地址发件', fix: FORBIDDEN_SENDER_FIX, docs: '/references/errors.md#forbidden-sender' },
  FromRequired: { code: 'from_required', message: '原信的收件地址 team@example.org 不是你可用的发件身份（例如共享给你的邮箱），请在 from 指定自己的地址',
    fix: '先调 GET /v1/identities，从 canSend=true 的地址里选一个填进 from（写法同 POST /v1/messages）', docs: '/references/errors.md#from_required' },
  CloudflareCredentialsMissing: { code: 'forbidden', message: '本站 Worker 未配置 Cloudflare 凭据，不能自动接入系统域名' },
  ZoneNotVisible: { code: 'not_found', message: 'Cloudflare 账户中没有该 zone：它可能在其他账户，或站长的 Token 无权访问' },
  NotFoundOnboarding: { code: 'not_found', message: '接入任务不存在' },
  OnboardingNeedsConfirmation: { code: 'conflict', message: '需要确认 1 项变更', details: { precheck: systemDomainPrecheck } },
  UnconfirmedChanges: { code: 'validation_failed', message: '还有 1 项变更未确认', details: { precheck: systemDomainPrecheck } },
  OnboardingFinished: { code: 'conflict', message: '接入已结束' },
  OnboardingBusy: { code: 'conflict', message: '正在检查，请稍后再试' },
  OnboardingNotAwaitingConfirmation: { code: 'conflict', message: '当前状态不需要确认' },
  HiddenZonesChanged: { code: 'conflict', message: '隐藏列表已被其他请求修改，请刷新后重试' },
  HostedNotMoved: { code: 'conflict', message: '只有名称服务器已改走的域名可以重新接入' },
  SourceUnavailableReply: { code: 'source_unavailable', message: '回复的原邮件不存在或不可见', details: { source: 'reply' } },
  SourceUnavailableForward: { code: 'source_unavailable', message: '转发的原邮件不存在或不可见', details: { source: 'forward' } },
  HeaderNotAllowed: { code: 'header_not_allowed', message: '不允许的邮件头：Message-ID 由平台生成，不能自定义',
    fix: '去掉这些头：只允许 X- 开头的头与白名单头；From/To/Cc/Bcc/Subject/Reply-To 用对应的请求字段',
    docs: '/references/errors.md#header_not_allowed', details: { headers: ['Message-ID'] } },
  SendPayloadTooLarge: { code: 'payload_too_large', message: `发信请求体超过 ${MAX_SEND_REQUEST_BYTES / MIB}MB 上限` },
  DeliveryFailed: { code: 'delivery_failed', message: '全部收件人投递失败: nobody@example.net: 550 5.1.1 User unknown',
    details: { messageId: 1026, recipientOutcomes: [{ address: 'nobody@example.net', status: 'failed', error: '550 5.1.1 User unknown' }] } },
  RecipientSuppressed: { code: 'recipient_suppressed', message: '全部收件人都在抑制名单中，没有发送：nobody@example.net（此前退信（地址或域名不可用））',
    fix: '换用其他收件人；对方地址恢复后由管理员在抑制名单中解除（软退信 24 小时、一般硬退信 7 天后自动解除）',
    docs: '/references/errors.md#recipient_suppressed',
    details: { suppressed: [suppressed] } },
  IdempotencyMismatch: { code: 'idempotency_mismatch', message: '相同 Idempotency-Key 不能用于不同的发信内容，请使用新的 Key' },
  SendInProgress: { code: 'send_in_progress', message: '该发信请求正在处理或结果待确认，请查询发送结果，不要换 Key 重发' },
  OutboundQuota: { code: 'rate_limited', message: '已达每日外发上限（100 封），请明日再试' },
  DraftQuota: { code: 'rate_limited', message: `待发送附件最多 ${MAX_DRAFT_ATTACHMENTS_PER_USER} 个、合计 ${MAX_DRAFT_ATTACHMENT_BYTES_PER_USER / MIB}MB` },
  UploadSizeMismatch: { code: 'validation_failed', message: '上传大小与 Content-Length 不一致' },
  PartSizeMismatch: { code: 'validation_failed', message: `第 2 片大小应为 ${MULTIPART_PART_BYTES} 字节` },
  WaitRateLimited: { code: 'rate_limited', message: '长轮询查询频率超限，请稍后重试' },
  UnreadScopeMineOnly: { code: 'validation_failed', message: '未读数只统计调用者认领的地址，scope 只能为 mine' },
  TranslationDisabled: { code: 'forbidden', message: '管理员未启用 AI 翻译' },
  TranslationQuota: { code: 'rate_limited', message: '今日翻译额度已用完' },
  TranslationUnavailable: { code: 'internal', message: '翻译服务暂时不可用' },
  AiModelIncomplete: { code: 'validation_failed', message: '请先填写接口地址、API Key 和模型' },
  AiModelFailed: { code: 'internal', message: '网络请求失败' },
  KeyReentryRequired: { code: 'validation_failed', message: '接口地址已更换，请重新填写 API Key' },
  PushKeyReentryRequired: { code: 'validation_failed', message: 'PushDeer 接入点已更换，请重新填写 PushKey' },
  StaleDomainsRevision: { code: 'conflict', message: '域名配置已被其他请求修改，请刷新后重试' },
  StalePolicyRevision: { code: 'conflict', message: '邮箱权限已被其他请求修改，请刷新后重试' },
  LastAdmin: { code: 'forbidden', message: '至少保留一个可用管理员，无法执行此操作' },
  SelfDisable: { code: 'forbidden', message: '不能禁用自己' },
  SelfDelete: { code: 'forbidden', message: '不能删除自己' },
  UserOwnsHostedDomains: { code: 'conflict', message: '该用户还拥有托管域名 alice.dev，请先过户或删除' },
  ApiKeyLimit: { code: 'forbidden', message: `每个用户最多保留 ${MAX_API_KEYS_PER_USER} 个 API Key` },
  NotificationNotRetryable: { code: 'conflict', message: '该通知任务无需重试' },
  NotificationTestFailed: { code: 'internal', message: '飞书 webhook 调用失败' },
  PushKeyMissing: { code: 'validation_failed', message: '未配置 PushKey' },
  HostingDisabled: { code: 'forbidden', message: '本站未开启域名托管' },
  HostedDomainTaken: { code: 'conflict', message: '该域名已被其他用户托管' },
  HostedCreateRateLimited: { code: 'rate_limited', message: '添加域名过于频繁，请稍后再试' },
  HostedOwnerOnly: { code: 'forbidden', message: '只有域名所有者或管理员可以执行此操作' },
  HostedStateChanged: { code: 'conflict', message: '域名状态已改变，请刷新后重试' },
  HostedTransferLimit: { code: 'forbidden', message: '对方托管的域名数已达上限（3）' },
  CloudflareBusy: { code: 'rate_limited', message: 'Cloudflare 接口繁忙，请稍后再试' },
  DnsRecordLimit: { code: 'forbidden', message: `每个域名最多 ${MAX_HOSTED_DNS_RECORDS} 条解析记录` },
  DnsRecordMailConflict: { code: 'validation_failed', message: '根域的 MX 记录用于本站收件，由系统维护' },
  DnsRecordLocked: { code: 'forbidden', message: '根域的 SPF 记录用于本站收发，由系统维护' },
  ReauthRequired: { code: 'reauth_required', message: '该操作需要输入当前密码', fix: '在请求体里带上当前登录密码 password 后重试',
    docs: '/references/errors.md#reauth_required' },
  ReauthFailed: { code: 'reauth_failed', message: '当前密码错误', docs: '/references/errors.md#reauth_failed' },
  ReauthRateLimited: { code: 'rate_limited', message: '密码验证失败次数过多，请 15 分钟后再试' },
  WrongTotpCode: { code: 'validation_failed', message: '验证码错误，请重试' },
  AdminScopeForbidden: { code: 'forbidden', message: '只有管理员可以授予 admin scope' },
  AdminScopeRules: { code: 'validation_failed', message: '带 admin scope 的 Key 必须设置 IP 白名单' },
  KeyRestricted: { code: 'forbidden', message: '这把 API Key 限定了可用的邮箱或域名，不能访问 bob@example.org',
    fix: 'GET /v1/me 查看 key.allowedMailboxIds 与 key.allowedDomains；换用覆盖它的 Key，或请用户在网页「API Key」页面调整范围',
    docs: '/references/errors.md#key-restricted' },
  ForwardSessionOnly: { code: 'forbidden', message: '邮箱转发目标只能在网页会话里修改',
    fix: '去掉请求里的 forward；需要改转发目标时请用户登录网页「个人设置 - 转发与通知」修改（新目标要邮件确认）', docs: '/references/notifications.md' },
  ForwardConfirmLimit: { code: 'rate_limited', message: '每天最多发送 20 封转发确认邮件，请明天再试' },
  ForwardConfirmInvalid: { code: 'not_found', message: '确认链接无效或已过期' },
  ForwardTargetLimit: { code: 'conflict', message: '转发目标已达 5 个上限' },
  NotFoundWebhook: { code: 'not_found', message: 'Webhook 端点不存在' },
  WebhookEndpointLimit: { code: 'forbidden', message: '每个用户最多 10 个 Webhook 端点' },
  WebhookUrlInvalid: { code: 'validation_failed', message: 'Webhook 地址不能指向本站' },
  WebhookNotRetryable: { code: 'conflict', message: '只有投递失败的记录可以重试' },
} satisfies Record<string, ErrorExample>;
export type ErrorExampleName = keyof typeof ERROR_EXAMPLES;

/** 按 scope 生成的 403 示例名 */
export type ScopeExampleName = `ForbiddenScope${string}`;
/** 缺少 scope 的 403 示例名：mail.read → ForbiddenScopeMailRead */
export function scopeExampleName(scope: string): ScopeExampleName {
  return `ForbiddenScope${scope.split(/[._-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
}
const SCOPE_EXAMPLES: Record<string, ErrorExample> = Object.fromEntries(API_SCOPES.map(scope => [scopeExampleName(scope), {
  code: 'forbidden', message: `需要 API scope: ${scope}`,
  fix: `这把 Key 缺少 scope ${scope}：在网页「API Key」页面给它加上，或换用带该 scope 的 Key（GET /v1/me 可查看当前 scopes）`,
  docs: '/references/errors.md#forbidden-scope',
}]));

/** 按名字取失败示例（含按 scope 生成的 403）；不存在时返回 undefined */
export function errorExample(name: string): ErrorExample | undefined {
  return (ERROR_EXAMPLES as Record<string, ErrorExample>)[name] ?? SCOPE_EXAMPLES[name];
}

/** 失败示例里统一的 requestId */
export const EXAMPLE_REQUEST_ID = '7f9c2ba4-e88f-4a2b-9f3c-2d1e5b8a6c01';
