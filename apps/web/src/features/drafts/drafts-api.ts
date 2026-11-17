import type { Draft, DraftRequestBody, DraftStatus, DraftSummary, MessageSummary, Page, SendDraftRequest } from '@hpc-mail/shared';
import { api, apiRequest } from '@/api/client';

/*
 * 服务端草稿的接口与 query key 放在功能目录里，不进 api/resources.ts 与 api/query-keys.ts：
 * 那两个模块静态打进入口 chunk，草稿只在草稿箱与写信页（都是懒加载）用到，放这里入口与登录页体积不变。
 */

/** 服务端草稿（Agent 用 API Key 建的草稿在网页审阅后再发）与定时发送 */
export const draftsApi = {
  list: (query: { status?: DraftStatus; cursor?: string; limit?: number }, signal?: AbortSignal) =>
    api.get<Page<DraftSummary>>('/drafts', { query, signal }),
  get: (id: number, signal?: AbortSignal) => api.get<Draft>(`/drafts/${id}`, { signal }),
  /** 网络错误后用同一个 key、同一请求体重试，服务端返回原草稿，不会多建一份 */
  create: (body: DraftRequestBody, idempotencyKey?: string) =>
    api.post<Draft, DraftRequestBody>('/drafts', body, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  /** 缺省字段保持原值；带 expectedVersion 时版本已变返回 409 draft_state_conflict */
  update: (id: number, body: DraftRequestBody) => apiRequest<Draft, DraftRequestBody>('PATCH', `/drafts/${id}`, { body }),
  remove: (id: number) => api.delete<{ success: true }>(`/drafts/${id}`),
  /**
   * 立即发送：结果同发信（201 / 422 delivery_failed / 4xx）。expectedVersion 锁定审阅过的版本，
   * 之后又被改过时 409 draft_state_conflict、不发出；已发送的重放原结果，不需要 Idempotency-Key。
   */
  send: (id: number, expectedVersion?: number) =>
    api.post<MessageSummary, SendDraftRequest>(`/drafts/${id}/send`, expectedVersion ? { expectedVersion } : undefined),
};

/** 列表按状态筛选分开缓存（all 为不筛选）；写操作后由 draft-cache.ts 就地更新 */
export const draftKeys = {
  root: ['drafts'] as const,
  lists: ['drafts', 'list'] as const,
  list: (status: DraftStatus | 'all') => ['drafts', 'list', status] as const,
  detail: (id: number) => ['drafts', 'detail', id] as const,
};
