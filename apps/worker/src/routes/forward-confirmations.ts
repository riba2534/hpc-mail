import { Hono } from 'hono';
import type { AppContext } from '../types.js';

/** /api/forward-confirmations：公开的转发目标确认（凭邮件里的一次性 token）。TODO(PR4a-notify)：实现 */
const app = new Hono<AppContext>();

export default app;
