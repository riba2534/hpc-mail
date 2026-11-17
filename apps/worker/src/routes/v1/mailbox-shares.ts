import { Hono } from 'hono';
import type { AppContext } from '../../types.js';

/** /v1/mailboxes/shares：API Key（mailbox.share）管理自己邮箱的共享，只接受 userId。TODO(PR4a-notify)：实现 */
const app = new Hono<AppContext>();

export default app;
