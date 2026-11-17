import { Hono } from 'hono';
import { ok } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { deliveryEventsOverview } from '../../services/event-subscriptions.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

/** 投递回执的开关、凭据与各发信域名的事件订阅状态 */
app.get('/', async (c) => ok(c, await deliveryEventsOverview(c.env)));

export default app;
