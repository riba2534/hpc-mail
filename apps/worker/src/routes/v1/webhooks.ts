import { webhookRoutes } from '../webhooks.js';

/** /v1/webhooks：API Key（webhook.write）管理 Webhook v2 端点，与网页会话 /api/webhooks 同形 */
export default webhookRoutes('key');
