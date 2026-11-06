import type {
  MailboxTransferResult,
  TransferMailboxRequest,
  UserSearchResults,
  AdminAuditLogEntry,
  AdminUser,
  BatchClaimMailboxResult,
  BatchMailboxRequest,
  BatchShareMailboxesRequest,
  ApiKeySummary,
  ApiRequestLogEntry,
  ChangePasswordRequest,
  ClaimMailboxRequest,
  ClaimPlan,
  ClaimPlanStrategy,
  CompleteMultipartUploadRequest,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateInviteRequest,
  CreateUserRequest,
  DisableTwoFactorRequest,
  DomainClaudeStats,
  DomainOnboardingStatus,
  InitMultipartUploadRequest,
  InternalSendMailRequest,
  Invite,
  ListMessagesQuery,
  LoginRequest,
  MarkAllReadRequest,
  LoginResponse,
  Mailbox,
  MailboxAvailability,
  MailboxShareGrant,
  ReplaceMailboxSharesRequest,
  SharedMailboxView,
  MessageDetail,
  MessageListPage,
  MessageSyncResult,
  MessageSummary,
  MultipartCompleteResult,
  MultipartInitResult,
  MultipartPartResult,
  Page,
  PublicConfig,
  RegisterRequest,
  SessionUser,
  Settings,
  SingleUploadResult,
  UpdateApiKeyRequest,
  UpdateMailboxRequest,
  UpdateNotifyPrefsRequest,
  UpdateSettingsRequest,
  UpdateUserRequest,
  UploadAvatarRequest,
  UploadedPart,
  UserNotifyPrefs,
  NotificationHealth,
  TwoFactorEnabled,
  TwoFactorSetup,
} from '@hpc-mail/shared';
import { api, type QueryParams } from './client';
import { xhrSend, type UploadProgress } from './upload-client';

// ---- auth ----
export const authApi = {
  login: (body: LoginRequest) => api.post<LoginResponse, LoginRequest>('/auth/login', body, { token: null }),
  oidcExchange: () => api.post<LoginResponse>('/auth/oidc/exchange', undefined, { token: null }),
  register: (body: RegisterRequest) =>
    api.post<LoginResponse, RegisterRequest>('/auth/register', body, { token: null }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<SessionUser>('/auth/me'),
  changePassword: (body: ChangePasswordRequest) =>
    api.put<LoginResponse, ChangePasswordRequest>('/auth/password', body),
  uploadAvatar: (body: UploadAvatarRequest) =>
    api.post<SessionUser, UploadAvatarRequest>('/auth/avatar', body),
  deleteAvatar: () => api.delete<SessionUser>('/auth/avatar'),
  setup2fa: () => api.post<TwoFactorSetup>('/auth/2fa/setup'),
  enable2fa: (code: string) => api.post<TwoFactorEnabled, { code: string }>('/auth/2fa/enable', { code }),
  disable2fa: (body: DisableTwoFactorRequest) =>
    api.post<{ success: boolean }, DisableTwoFactorRequest>('/auth/2fa/disable', body),
};

// ---- 公开配置 ----
export const configApi = {
  getPublic: () => api.get<PublicConfig>('/config', { token: null }),
};

// ---- 可认领域名（需登录，按公共或用户专属规则）----
export const domainApi = {
  visible: () => api.get<string[]>('/domains'),
};

// ---- 个人转发与通知偏好 ----
export const notifyPrefsApi = {
  get: () => api.get<UserNotifyPrefs>('/me/notify-prefs'),
  update: (body: UpdateNotifyPrefsRequest) =>
    api.put<UserNotifyPrefs, UpdateNotifyPrefsRequest>('/me/notify-prefs', body),
  testFeishu: () => api.post<{ ok: boolean }>('/me/notify-prefs/feishu-test'),
  testPushdeer: () => api.post<{ ok: boolean }>('/me/notify-prefs/pushdeer-test'),
  health: () => api.get<NotificationHealth>('/me/notify-prefs/health'),
  retry: (id: number) => api.post<{ ok: boolean }>(`/me/notify-prefs/jobs/${id}/retry`),
};

// ---- 邮箱 ----
export const mailboxApi = {
  list: (all = false) => api.get<Mailbox[]>('/mailboxes', { query: { all: all ? 1 : undefined } }),
  claim: (body: ClaimMailboxRequest) => api.post<Mailbox, ClaimMailboxRequest>('/mailboxes', body),
  update: (id: number, body: UpdateMailboxRequest) =>
    api.put<Mailbox, UpdateMailboxRequest>(`/mailboxes/${id}`, body),
  release: (id: number, deleteHistory = false) =>
    api.delete<{ success: boolean; deletedMessages: number }>(`/mailboxes/${id}`, undefined, {
      query: { deleteHistory: deleteHistory ? 1 : undefined },
    }),
  availability: (localPart: string, domain: string, strategy?: ClaimMailboxRequest['strategy']) =>
    api.get<MailboxAvailability>('/mailboxes/availability', { query: { localPart, domain, strategy } }),
  batchAvailability: (items: ClaimMailboxRequest[]) =>
    api.post<MailboxAvailability[], BatchMailboxRequest>('/mailboxes/availability/batch', { items }),
  batchClaim: (items: ClaimMailboxRequest[]) =>
    api.post<BatchClaimMailboxResult, BatchMailboxRequest>('/mailboxes/batch', { items }),
  /** 随机后缀分配：只返回为当前用户分好的后缀，不认领 */
  randomPlan: (count: number, strategy: ClaimPlanStrategy) =>
    api.get<ClaimPlan>('/mailboxes/random-plan', { query: { count, strategy } }),
  shared: () => api.get<SharedMailboxView[]>('/mailboxes/shared'),
  listShares: () => api.get<MailboxShareGrant[]>('/mailboxes/shares'),
  replaceShares: (body: ReplaceMailboxSharesRequest) =>
    api.put<MailboxShareGrant, ReplaceMailboxSharesRequest>('/mailboxes/shares', body),
  /** 把自己的多只邮箱一次共享给同一批用户：追加到各自名单，返回每只邮箱更新后的完整名单 */
  batchShare: (body: BatchShareMailboxesRequest) =>
    api.post<MailboxShareGrant[], BatchShareMailboxesRequest>('/mailboxes/shares/batch', body),
  searchShareUsers: (q: string, excludeUserId?: number, signal?: AbortSignal) =>
    api.get<UserSearchResults>('/mailboxes/share-users', { query: { q, excludeUserId }, signal }),
};

// ---- 邮件 ----
export const messageApi = {
  list: (query: Partial<ListMessagesQuery>, signal?: AbortSignal) =>
    api.get<MessageListPage>('/messages', { query: query as unknown as QueryParams, signal }),
  /** 轻量轮询：未读数 + 当前筛选下首页指纹；与列表首页的 head 不同才需要重拉列表 */
  sync: (query: Partial<ListMessagesQuery>, signal?: AbortSignal) =>
    api.get<MessageSyncResult>('/messages/sync', { query: query as unknown as QueryParams, signal }),
  detail: (id: number, view?: { scope?: ListMessagesQuery['scope']; userId?: number }, signal?: AbortSignal) =>
    api.get<MessageDetail>(`/messages/${id}`, { query: { scope: view?.scope, userId: view?.userId }, signal }),
  thread: (id: number, view?: { scope?: ListMessagesQuery['scope']; userId?: number }, signal?: AbortSignal) =>
    api.get<{ items: MessageSummary[] }>(`/messages/${id}/thread`, {
      query: { scope: view?.scope, userId: view?.userId },
      signal,
    }),
  contacts: () => api.get<{ contacts: string[] }>('/messages/contacts'),
  send: (body: InternalSendMailRequest, idempotencyKey?: string) =>
    api.post<MessageSummary, InternalSendMailRequest>('/messages/send', body, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  unreadCount: () => api.get<{ unread: number }>('/messages/unread-count'),
  markRead: (ids: number[], isRead: boolean, scope?: 'mine' | 'unclaimed') =>
    api.post<{ changed: number }, { ids: number[]; isRead: boolean }>('/messages/read', { ids, isRead }, { query: { scope } }),
  /** 按筛选（domain/address/q）收窄范围的全部已读；只处理自己认领的地址 */
  markAllRead: (body: MarkAllReadRequest = {}) =>
    api.post<{ changed: number }, MarkAllReadRequest>('/messages/read-all', body),
  star: (
    ids: number[],
    starred: boolean,
    view?: { scope?: ListMessagesQuery['scope']; userId?: number },
  ) =>
    api.post<{ changed: number }, { ids: number[]; starred: boolean }>(
      '/messages/star',
      { ids, starred },
      { query: { scope: view?.scope, userId: view?.userId } },
    ),
  remove: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<{ deleted: number }, { ids: number[] }>('/messages/delete', { ids }, { query: { scope } }),
  restore: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<{ changed: number }, { ids: number[] }>('/messages/restore', { ids }, { query: { scope } }),
  purge: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<{ changed: number }, { ids: number[] }>('/messages/purge', { ids }, { query: { scope } }),
};

// ---- 附件上传（先落 R2 草稿区，发送时引用 token）----
export const uploadsApi = {
  /** 单片直传（< 阈值）：二进制流式上传，带真实进度 */
  single: (
    file: Blob,
    filename: string,
    mimeType: string,
    onProgress?: (p: UploadProgress) => void,
    signal?: AbortSignal,
  ) =>
    xhrSend<SingleUploadResult>({
      method: 'POST',
      path: '/uploads',
      query: { filename, mimeType },
      body: file,
      onProgress,
      signal,
    }),
  /** 大文件分片：初始化 R2 multipart upload */
  initMultipart: (req: InitMultipartUploadRequest) =>
    api.post<MultipartInitResult, InitMultipartUploadRequest>('/uploads/multipart', req),
  /** 上传一个分片：带真实进度 */
  uploadPart: (
    token: string,
    partNumber: number,
    blob: Blob,
    onProgress?: (p: UploadProgress) => void,
    signal?: AbortSignal,
  ) =>
    xhrSend<MultipartPartResult>({
      method: 'PUT',
      path: `/uploads/multipart/${token}/parts/${partNumber}`,
      body: blob,
      onProgress,
      signal,
    }),
  /** 完成分片：提交所有 parts 触发 R2 complete */
  completeMultipart: (token: string, parts: UploadedPart[]) =>
    api.post<MultipartCompleteResult, CompleteMultipartUploadRequest>(
      `/uploads/multipart/${token}/complete`,
      { parts },
    ),
  /** 删除草稿附件（取消上传 / 移除已上传） */
  remove: (token: string) => api.delete<{ success: boolean }>(`/uploads/${token}`),
};

// ---- API Keys（自助） ----
export const apiKeyApi = {
  list: () => api.get<ApiKeySummary[]>('/api-keys'),
  create: (body: CreateApiKeyRequest) => api.post<CreatedApiKey, CreateApiKeyRequest>('/api-keys', body),
  update: (id: number, body: UpdateApiKeyRequest) =>
    api.put<ApiKeySummary, UpdateApiKeyRequest>(`/api-keys/${id}`, body),
  remove: (id: number) => api.delete<void>(`/api-keys/${id}`),
  listAll: () => api.get<ApiKeySummary[]>('/admin/api-keys'),
  /** 自助：查看自己 key 的调用审计 */
  logsMine: (id: number, cursor?: string, limit = 30) =>
    api.get<Page<ApiRequestLogEntry>>(`/api-keys/${id}/logs`, { query: { cursor, limit } }),
  /** admin：查看全站任意 key 的审计 */
  logs: (id: number, cursor?: string, limit = 30) =>
    api.get<Page<ApiRequestLogEntry>>(`/admin/api-keys/${id}/logs`, { query: { cursor, limit } }),
  revokeAdmin: (id: number) => api.delete<void>(`/admin/api-keys/${id}`),
};

// ---- 管理端 ----
export const adminApi = {
  searchUsers: (q: string, excludeUserId?: number, signal?: AbortSignal) =>
    api.get<UserSearchResults>('/admin/users/search', { query: { q, excludeUserId }, signal }),
  getMailbox: (id: number) => api.get<Mailbox>(`/admin/mailboxes/${id}`),
  transferMailbox: (id: number, body: TransferMailboxRequest) =>
    api.post<MailboxTransferResult, TransferMailboxRequest>(`/admin/mailboxes/${id}/transfer`, body),
  listUsers: () => api.get<AdminUser[]>('/admin/users'),
  createUser: (body: CreateUserRequest) => api.post<AdminUser, CreateUserRequest>('/admin/users', body),
  updateUser: (id: number, body: UpdateUserRequest) =>
    api.put<AdminUser, UpdateUserRequest>(`/admin/users/${id}`, body),
  deleteUser: (id: number) => api.delete<void>(`/admin/users/${id}`),
  getSettings: () => api.get<Settings>('/admin/settings'),
  updateSettings: (body: UpdateSettingsRequest) =>
    api.put<Settings, UpdateSettingsRequest>('/admin/settings', body),
  domainStatus: (domain: string) =>
    api.get<DomainOnboardingStatus>('/admin/settings/domain-status', { query: { domain } }),
  domainClaudeStats: () => api.get<DomainClaudeStats[]>('/admin/settings/domain-claude-stats'),
  listInvites: () => api.get<Invite[]>('/admin/invites'),
  createInvites: (body: CreateInviteRequest) => api.post<Invite[], CreateInviteRequest>('/admin/invites', body),
  revokeInvite: (id: number) => api.delete<void>(`/admin/invites/${id}`),
  auditLogs: (cursor?: string, limit = 30) =>
    api.get<Page<AdminAuditLogEntry>>('/admin/audit-logs', { query: { cursor, limit } }),
  listMailboxShares: (mailboxId?: number) =>
    api.get<MailboxShareGrant[]>('/admin/mailbox-shares', { query: { mailboxId } }),
  replaceMailboxShares: (body: ReplaceMailboxSharesRequest) =>
    api.put<MailboxShareGrant, ReplaceMailboxSharesRequest>('/admin/mailbox-shares', body),
  revokeMailboxShare: (mailboxId: number, userId: number) =>
    api.delete<{ success: boolean }>(`/admin/mailbox-shares/${mailboxId}/grantees/${userId}`),
};
