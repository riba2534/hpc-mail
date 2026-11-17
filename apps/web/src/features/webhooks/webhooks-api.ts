import type {
  CreateWebhookEndpointInput,
  CreatedWebhookEndpoint,
  Page,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookTestResult,
} from '@hpc-mail/shared';
import { api } from '@/api/client';

/*
 * Webhook v2 端点只在个人设置页用到：接口与 query key 放在功能目录里，不进入口 chunk 的 api/resources.ts 与 api/query-keys.ts。
 */
export const webhookApi = {
  list: () => api.get<WebhookEndpoint[]>('/webhooks'),
  create: (body: CreateWebhookEndpointInput) => api.post<CreatedWebhookEndpoint, CreateWebhookEndpointInput>('/webhooks', body),
  update: (id: number, body: UpdateWebhookEndpointRequest) =>
    api.put<WebhookEndpoint, UpdateWebhookEndpointRequest>(`/webhooks/${id}`, body),
  remove: (id: number) => api.delete<{ success: boolean }>(`/webhooks/${id}`),
  rotateSecret: (id: number) => api.post<CreatedWebhookEndpoint>(`/webhooks/${id}/rotate-secret`),
  test: (id: number) => api.post<WebhookTestResult>(`/webhooks/${id}/test`),
  deliveries: (id: number) => api.get<Page<WebhookDelivery>>(`/webhooks/${id}/deliveries`, { query: { limit: 20 } }),
  retry: (id: number, deliveryId: number) => api.post<WebhookDelivery>(`/webhooks/${id}/deliveries/${deliveryId}/retry`),
};

export const webhookKeys = {
  list: ['webhooks', 'list'] as const,
  deliveries: (id: number) => ['webhooks', 'deliveries', id] as const,
};
