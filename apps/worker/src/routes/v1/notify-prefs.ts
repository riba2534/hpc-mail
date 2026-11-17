import { updateNotifyPrefsRequestSchema, type NotifyPrefsView } from '@hpc-mail/shared';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../lib/errors.js';
import { execCtx, ok, parseBody, parseId } from '../../lib/http.js';
import { apiKeyAuth, assertKeyUnrestricted, requireScope } from '../../middleware/api-key-auth.js';
import { listPendingForwards } from '../../services/forward-confirm.js';
import { getNotificationHealth, processNotificationJobs, retryNotificationJob } from '../../services/notification-jobs.js';
import { getUserNotifyPrefs, maskUserNotifyPrefs, updateUserNotifyPrefs } from '../../services/notify-prefs.js';
import { sendNotifyTest } from '../../services/notify-test.js';
import type { AppContext } from '../../types.js';

/**
 * /v1/notify-prefs：API Key 读写个人通知配置。notify.read 读（掩码）与投递健康，notify.write 改飞书、PushDeer、
 * 通用 Webhook 并发测试。邮箱转发目标配置后所有来信都会外发，是被盗 Key 的数据外泄口，只能网页会话修改。
 * 限定了邮箱或域名的 Key 不能改这些作用于全部来信的配置，也不能看投递健康。
 */
const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

const ACCOUNT_WIDE = '作用于全部来信的通知配置';

function keyOwner(c: Context<AppContext>): { id: number; username: string } {
  const key = c.get('apiKey')!;
  return { id: key.userId, username: key.username };
}

app.get('/', async (c) => {
  requireScope(c, 'notify.read');
  const userId = c.get('apiKey')!.userId;
  const [prefs, pending] = await Promise.all([getUserNotifyPrefs(c.env, userId), listPendingForwards(c.env, userId)]);
  return ok(c, { ...maskUserNotifyPrefs(prefs), forwardPending: pending } satisfies NotifyPrefsView);
});

/**
 * 飞书、PushDeer、通用 Webhook 都会推送来信的主题、验证码与正文摘要：修改它们另需 mail.read。
 * 管理员的个人配置同时作用于未认领地址的来信，没有 admin scope 的管理员 Key 不能修改
 */
function assertCanRouteMail(c: Context<AppContext>): void {
  requireScope(c, 'mail.read');
  const key = c.get('apiKey')!;
  if (key.accountRole === 'admin' && key.role !== 'admin') {
    throw new AppError('forbidden', '管理员的通知配置也推送未认领地址的来信，需要带 admin scope 的 API Key', {
      fix: '改用带 admin scope 的管理员 Key，或请用户在网页「个人设置 - 转发与通知」修改',
      docs: '/references/notifications.md',
    });
  }
}

app.put('/', async (c) => {
  requireScope(c, 'notify.write');
  assertKeyUnrestricted(c, ACCOUNT_WIDE);
  assertCanRouteMail(c);
  const { forward, password: _password, ...req } = await parseBody(c, updateNotifyPrefsRequestSchema);
  if (forward !== undefined) {
    throw new AppError('forbidden', '邮箱转发目标只能在网页会话里修改', {
      fix: '去掉请求里的 forward；需要改转发目标时请用户登录网页「个人设置 - 转发与通知」修改（新目标要邮件确认）',
      docs: '/references/notifications.md',
    });
  }
  if (!req.feishu && !req.webhook && !req.pushdeer) throw new AppError('validation_failed', '至少提供一个待更新项');
  const userId = c.get('apiKey')!.userId;
  const [prefs, pending] = await Promise.all([updateUserNotifyPrefs(c.env, userId, req), listPendingForwards(c.env, userId)]);
  return ok(c, { ...maskUserNotifyPrefs(prefs), forwardPending: pending } satisfies NotifyPrefsView);
});

app.get('/health', async (c) => {
  requireScope(c, 'notify.read');
  assertKeyUnrestricted(c, '账户的通知投递健康');
  return ok(c, await getNotificationHealth(c.env, c.get('apiKey')!.userId));
});

app.post('/jobs/:id/retry', async (c) => {
  requireScope(c, 'notify.write');
  assertKeyUnrestricted(c, ACCOUNT_WIDE);
  const id = parseId(c.req.param('id'));
  await retryNotificationJob(c.env, c.get('apiKey')!.userId, id);
  const ctx = execCtx(c);
  const run = processNotificationJobs(c.env, { jobIds: [id] }).catch(() => console.error('通知重试处理失败'));
  if (ctx) ctx.waitUntil(run);
  else await run;
  return ok(c, { ok: true });
});

for (const channel of ['feishu', 'pushdeer'] as const) {
  app.post(`/${channel}-test`, async (c) => {
    requireScope(c, 'notify.write');
    assertKeyUnrestricted(c, ACCOUNT_WIDE);
    await sendNotifyTest(c.env, keyOwner(c), channel);
    return ok(c, { ok: true });
  });
}

export default app;
