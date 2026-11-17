import { updateNotifyPrefsRequestSchema, type NotifyPrefsView } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseId } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { listPendingForwards, updatePrefsWithForwardConfirmation } from '../services/forward-confirm.js';
import { getUserNotifyPrefs, maskUserNotifyPrefs } from '../services/notify-prefs.js';
import { sendNotifyTest } from '../services/notify-test.js';
import type { AppContext } from '../types.js';
import { getNotificationHealth, processNotificationJobs, retryNotificationJob } from '../services/notification-jobs.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 读个人转发/通知偏好（secret 掩码回显，附等待确认的转发目标） */
app.get('/', async (c) => {
  const user = c.get('user')!;
  const [prefs, pending] = await Promise.all([getUserNotifyPrefs(c.env, user.id), listPendingForwards(c.env, user.id)]);
  return ok(c, { ...maskUserNotifyPrefs(prefs), forwardPending: pending } satisfies NotifyPrefsView);
});

/** 最近投递结果与转发尝试配额，只返回当前用户的记录，不含正文或密钥。 */
app.get('/health', async (c) => ok(c, await getNotificationHealth(c.env, c.get('user')!.id)));

/** 用户明确发起重试；通用 Webhook 的自动重试策略仍是零次。 */
app.post('/jobs/:id/retry', async (c) => {
  const id = parseId(c.req.param('id'));
  await retryNotificationJob(c.env, c.get('user')!.id, id);
  c.executionCtx.waitUntil(processNotificationJobs(c.env, { jobIds: [id] }));
  return ok(c, { ok: true });
});

/** 写个人转发/通知偏好：新增转发目标要当前密码，且先发确认信、确认后才生效 */
app.put('/', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, updateNotifyPrefsRequestSchema);
  const { prefs, pending } = await updatePrefsWithForwardConfirmation(c.env, user, req, new URL(c.req.url).origin, c.get('sessionId')!);
  return ok(c, { ...maskUserNotifyPrefs(prefs), forwardPending: pending } satisfies NotifyPrefsView);
});

/** 用当前保存的个人飞书配置发一张测试卡片 */
app.post('/feishu-test', async (c) => {
  await sendNotifyTest(c.env, c.get('user')!, 'feishu');
  return ok(c, { ok: true });
});

/** 用当前保存的个人 PushDeer 配置发一条测试通知 */
app.post('/pushdeer-test', async (c) => {
  await sendNotifyTest(c.env, c.get('user')!, 'pushdeer');
  return ok(c, { ok: true });
});

export default app;
