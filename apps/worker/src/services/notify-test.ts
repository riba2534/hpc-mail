import type { Env } from '../types.js';
import { getSystemFromAddress } from './domain.js';
import { sendFeishuNotification } from './feishu.js';
import { recordDeliveryResult } from './notification-jobs.js';
import { NotificationDeliveryError } from './notification-http.js';
import { getUserNotifyPrefs } from './notify-prefs.js';
import { sendPushDeerNotification } from './pushdeer.js';

/**
 * 用当前**已保存**的个人飞书 / PushDeer 配置发一条测试通知（网页会话与 notify.write Key 共用），
 * 结果记入投递健康；失败原样抛出给调用方。
 */
export async function sendNotifyTest(env: Env, user: { id: number; username: string }, channel: 'feishu' | 'pushdeer'): Promise<void> {
  const prefs = await getUserNotifyPrefs(env, user.id);
  const fromAddress = await getSystemFromAddress(env);
  try {
    if (channel === 'feishu') {
      await sendFeishuNotification(
        prefs.feishu,
        {
          subject: 'HPC Mail 飞书机器人测试', fromAddress, fromName: 'HPC Mail', toAddress: user.username, code: '',
          body: '配置有效。今后你认领地址收到的新邮件会把正文推送到此机器人。',
        },
        { force: true, throwOnError: true, test: true, attempts: 1 },
      );
    } else {
      await sendPushDeerNotification(
        prefs.pushdeer,
        {
          subject: 'HPC Mail PushDeer 测试', fromAddress, fromName: 'HPC Mail', toAddress: user.username, code: '123456',
          body: '配置有效。今后你认领地址收到的新邮件会推送到此设备。',
        },
        { force: true, throwOnError: true },
      );
    }
    await recordDeliveryResult(env, { userId: user.id, messageId: null, channel, status: 'succeeded' });
  } catch (error) {
    await recordDeliveryResult(env, { userId: user.id, messageId: null, channel, status: 'failed',
      error: error instanceof Error ? error.message : '测试失败', httpStatus: error instanceof NotificationDeliveryError ? error.httpStatus : null });
    throw error;
  }
}
