import { updateNotifyPrefsRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody, parseId } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getSystemFromAddress } from '../services/domain.js';
import { sendFeishuNotification } from '../services/feishu.js';
import { sendPushDeerNotification } from '../services/pushdeer.js';
import {
  getUserNotifyPrefs,
  maskUserNotifyPrefs,
  updateUserNotifyPrefs,
} from '../services/notify-prefs.js';
import type { AppContext } from '../types.js';
import { getNotificationHealth, processNotificationJobs, recordDeliveryResult, retryNotificationJob } from '../services/notification-jobs.js';
import { NotificationDeliveryError } from '../services/notification-http.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth);

/** 读个人转发/通知偏好（secret 掩码回显） */
app.get('/', async (c) => {
  const user = c.get('user')!;
  const prefs = await getUserNotifyPrefs(c.env, user.id);
  return ok(c, maskUserNotifyPrefs(prefs));
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

/** 写个人转发/通知偏好 */
app.put('/', async (c) => {
  const user = c.get('user')!;
  const req = await parseBody(c, updateNotifyPrefsRequestSchema);
  const prefs = await updateUserNotifyPrefs(c.env, user.id, req);
  return ok(c, maskUserNotifyPrefs(prefs));
});

/** 用当前保存的个人飞书配置发一张测试卡片 */
app.post('/feishu-test', async (c) => {
  const user = c.get('user')!;
  const prefs = await getUserNotifyPrefs(c.env, user.id);
  try {
    await sendFeishuNotification(
      prefs.feishu,
      {
        subject: 'HPC Mail 飞书机器人测试',
        fromAddress: await getSystemFromAddress(c.env),
        fromName: 'HPC Mail',
        toAddress: user.username,
        code: '',
        body: '配置有效。今后你认领地址收到的新邮件会把正文推送到此机器人。',
      },
      { force: true, throwOnError: true, test: true, attempts: 1 },
    );
    await recordDeliveryResult(c.env, { userId: user.id, messageId: null, channel: 'feishu', status: 'succeeded' });
  } catch (error) {
    await recordDeliveryResult(c.env, { userId: user.id, messageId: null, channel: 'feishu', status: 'failed',
      error: error instanceof Error ? error.message : '测试失败', httpStatus: error instanceof NotificationDeliveryError ? error.httpStatus : null });
    throw error;
  }
  return ok(c, { ok: true });
});

/** 用当前保存的个人 PushDeer 配置发一条测试通知 */
app.post('/pushdeer-test', async (c) => {
  const user = c.get('user')!;
  const prefs = await getUserNotifyPrefs(c.env, user.id);
  try {
    await sendPushDeerNotification(
      prefs.pushdeer,
      {
        subject: 'HPC Mail PushDeer 测试',
        fromAddress: await getSystemFromAddress(c.env),
        fromName: 'HPC Mail',
        toAddress: user.username,
        code: '123456',
        body: '配置有效。今后你认领地址收到的新邮件会推送到此设备。',
      },
      { force: true, throwOnError: true },
    );
    await recordDeliveryResult(c.env, { userId: user.id, messageId: null, channel: 'pushdeer', status: 'succeeded' });
  } catch (error) {
    await recordDeliveryResult(c.env, { userId: user.id, messageId: null, channel: 'pushdeer', status: 'failed',
      error: error instanceof Error ? error.message : '测试失败', httpStatus: error instanceof NotificationDeliveryError ? error.httpStatus : null });
    throw error;
  }
  return ok(c, { ok: true });
});

export default app;
