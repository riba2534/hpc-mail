import { Hono } from 'hono';
import type { AppContext } from '../types.js';

/** /api/webhooks：网页会话（JWT）管理 Webhook v2 端点。TODO(PR4a-webhooks)：实现 */
const app = new Hono<AppContext>();

export default app;
