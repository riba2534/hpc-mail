import { Hono } from 'hono';
import type { AppContext } from '../../types.js';

/** /v1/notify-prefs：API Key（notify.read / notify.write）读写飞书、PushDeer、通用 Webhook；邮箱转发只读。TODO(PR4a-notify)：实现 */
const app = new Hono<AppContext>();

export default app;
