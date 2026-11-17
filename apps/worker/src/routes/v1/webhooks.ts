import { Hono } from 'hono';
import type { AppContext } from '../../types.js';

/** /v1/webhooks：API Key（webhook.write）管理 Webhook v2 端点。TODO(PR4a-webhooks)：实现 */
const app = new Hono<AppContext>();

export default app;
