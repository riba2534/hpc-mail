import type { Paths } from './openapi-common.js';

/**
 * Webhook v2 端点的 OpenAPI 路径：kind=api 为网页会话 /api/webhooks，kind=v1 为 API Key /v1/webhooks（x-required-scopes webhook.write）。
 * 需要的组件 schema 用 openapi-common 的 registerSchemas 在本模块顶层登记。
 * TODO(PR4a-webhooks)：实现
 */
export function webhookPaths(kind: 'api' | 'v1'): Paths {
  void kind;
  return {};
}
