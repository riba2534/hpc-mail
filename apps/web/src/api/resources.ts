import type {
  AdminAuditLogEntry,
  AdminUser,
  ApiKeySummary,
  ApiRequestLogEntry,
  ChangePasswordRequest,
  ClaimMailboxRequest,
  CompleteMultipartUploadRequest,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateInviteRequest,
  CreateUserRequest,
  DisableTwoFactorRequest,
  DomainOnboardingStatus,
  InitMultipartUploadRequest,
  InternalSendMailRequest,
  Invite,
  ListMessagesQuery,
  LoginRequest,
  LoginResponse,
  Mailbox,
  MailboxAvailability,
  MessageDetail,
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
  TwoFactorEnabled,
  TwoFactorSetup,
} from '@hpc-mail/shared';
import { api, type QueryParams } from './client';
import { xhrSend, type UploadProgress } from './upload-client';

// ---- auth ----
export const authApi = {
  login: (body: LoginRequest) => api.post<LoginResponse, LoginRequest>('/auth/login', body, { token: null }),
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

// ---- 可见域名（需登录，按角色：管理员=全部，普通用户=公开子集）----
export const domainApi = {
  visible: () => api.get<string[]>('/domains'),
};

// ---- 个人转发与通知偏好 ----
export const notifyPrefsApi = {
  get: () => api.get<UserNotifyPrefs>('/me/notify-prefs'),
  update: (body: UpdateNotifyPrefsRequest) =>
    api.put<UserNotifyPrefs, UpdateNotifyPrefsRequest>('/me/notify-prefs', body),
  testFeishu: () => api.post<{ ok: boolean }>('/me/notify-prefs/feishu-test'),
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
  availability: (localPart: string, domain: string) =>
    api.get<MailboxAvailability>('/mailboxes/availability', { query: { localPart, domain } }),
};

// ---- 邮件 ----
export const messageApi = {
  list: (query: Partial<ListMessagesQuery>) =>
    api.get<Page<MessageSummary>>('/messages', { query: query as unknown as QueryParams }),
  detail: (id: number, view?: { scope?: ListMessagesQuery['scope']; userId?: number }) =>
    api.get<MessageDetail>(`/messages/${id}`, { query: { scope: view?.scope, userId: view?.userId } }),
  thread: (id: number, view?: { scope?: ListMessagesQuery['scope']; userId?: number }) =>
    api.get<{ items: MessageSummary[] }>(`/messages/${id}/thread`, {
      query: { scope: view?.scope, userId: view?.userId },
    }),
  contacts: () => api.get<{ contacts: string[] }>('/messages/contacts'),
  send: (body: InternalSendMailRequest) =>
    api.post<MessageSummary, InternalSendMailRequest>('/messages/send', body),
  unreadCount: () => api.get<{ unread: number }>('/messages/unread-count'),
  markRead: (ids: number[], isRead: boolean, scope?: 'mine' | 'unclaimed') =>
    api.post<void, { ids: number[]; isRead: boolean }>('/messages/read', { ids, isRead }, { query: { scope } }),
  markAllRead: () => api.post<{ changed: number }, Record<string, never>>('/messages/read-all', {}),
  star: (
    ids: number[],
    starred: boolean,
    view?: { scope?: ListMessagesQuery['scope']; userId?: number },
  ) =>
    api.post<void, { ids: number[]; starred: boolean }>(
      '/messages/star',
      { ids, starred },
      { query: { scope: view?.scope, userId: view?.userId } },
    ),
  remove: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<void, { ids: number[] }>('/messages/delete', { ids }, { query: { scope } }),
  restore: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<void, { ids: number[] }>('/messages/restore', { ids }, { query: { scope } }),
  purge: (ids: number[], scope?: 'mine' | 'unclaimed') =>
    api.post<void, { ids: number[] }>('/messages/purge', { ids }, { query: { scope } }),
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
  listInvites: () => api.get<Invite[]>('/admin/invites'),
  createInvites: (body: CreateInviteRequest) => api.post<Invite[], CreateInviteRequest>('/admin/invites', body),
  revokeInvite: (id: number) => api.delete<void>(`/admin/invites/${id}`),
  auditLogs: (cursor?: string, limit = 30) =>
    api.get<Page<AdminAuditLogEntry>>('/admin/audit-logs', { query: { cursor, limit } }),
};
