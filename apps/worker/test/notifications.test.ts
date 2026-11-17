import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { SECRET_MASK } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, notificationJobs, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';
import { createSession } from '../src/services/session.js';
import { notificationRequest, NotificationDeliveryError } from '../src/services/notification-http.js';
import { getUserNotifyPrefs, maskUserNotifyPrefs, updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { sendPushDeerNotification } from '../src/services/pushdeer.js';
import { sendFeishuNotification } from '../src/services/feishu.js';
import { sendNotifyWebhook } from '../src/services/webhook-notify.js';
import { cleanupNotificationJobs, enqueueMailNotifications, getNotificationHealth, processNotificationJobs, recordDeliveryResult, repairUnqueuedNotifications, retryNotificationJob } from '../src/services/notification-jobs.js';
import { bumpCounter, dayWindow } from '../src/services/rate-counter.js';

const pd = { enabled: true, endpoint: '', pushkey: 'PDU_SYNTHETIC_TEST' };
const webhook = { enabled: true, url: 'https://notify.example.com/mail', secret: '' };
const info = { subject: 'Review notification', fromAddress: 'sender@example.net', fromName: 'Sender', toAddress: 'recipient@hpc.email', code: '', body: 'test body' };
const mail = (id: number, ownerIds: number[]) => ({ ownerIds, message: {
  id, address: 'recipient@hpc.email', fromAddress: info.fromAddress, fromName: info.fromName,
  subject: info.subject, verificationCode: '', preview: 'test body', createdAt: new Date().toISOString(),
}, text: 'test body' });

async function seed(username: string): Promise<number> {
  const [user] = await createDb(env).insert(users).values({ username, passwordHash: 'x', role: 'user', status: 'active' }).returning({ id: users.id });
  return user!.id;
}
async function seedMessage(address: string): Promise<number> {
  const [row] = await createDb(env).insert(messages).values({ direction: 'inbound', address, domain: 'hpc.email',
    fromAddress: info.fromAddress, subject: info.subject, preview: 'test body', status: 'received' }).returning({ id: messages.id });
  return row!.id;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('通知截止时间与响应判定', () => {
  it('截止时间覆盖收到响应头后的慢响应体', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('{')); } });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(stream));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(notificationRequest('https://example.com', {}, '测试', 20)).rejects.toThrow('超时');
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally { streamController.close(); }
  });

  it.each(['<html>login</html>', 'null', '{}', '{"code":1}', '"ok"'])('PushDeer 测试拒绝无效响应 %s', async text => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
    await expect(sendPushDeerNotification(pd, info, { force: true, throwOnError: true })).rejects.toBeInstanceOf(NotificationDeliveryError);
  });

  it.each([403, 429, 500, 302])('Webhook HTTP %i 在任务模式返回可诊断失败', async status => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hidden response', { status })));
    await expect(sendNotifyWebhook(webhook, { event: 'mail.received', message: mail(1, []).message }, { throwOnError: true }))
      .rejects.toMatchObject({ httpStatus: status, message: `通用 Webhook HTTP ${status}` });
  });

  it('飞书以新响应code为准，不能被同时存在的旧StatusCode=0覆盖', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 19021, StatusCode: 0 })));
    await expect(sendFeishuNotification({ enabled: true, webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secret: '', contentLevel: 'summary' }, info, { throwOnError: true, attempts: 1 })).rejects.toThrow('19021');
  });

  it('已登录 PushDeer 测试 API 拒绝 HTTP 200 HTML 并记录失败', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createDb(env);
    const [user] = await db.insert(users).values({ username: 'notify-test-api', passwordHash: await hashPassword('local-test-password-123'), role: 'user' }).returning({ id: users.id });
    await updateUserNotifyPrefs(env, user!.id, { pushdeer: pd });
    const app = createApp();
    const loginCtx = createExecutionContext();
    const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'notify-test-api', password: 'local-test-password-123' }) }, env, loginCtx);
    await waitOnExecutionContext(loginCtx);
    const session = await login.json() as { data: { token: string } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>login</html>')));
    const ctx = createExecutionContext();
    const response = await app.request('/api/me/notify-prefs/pushdeer-test', { method: 'POST', headers: { Authorization: `Bearer ${session.data.token}` } }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    const health = await getNotificationHealth(env, user!.id);
    expect(health.channels.find(c => c.channel === 'pushdeer')?.latest).toMatchObject({ status: 'failed', lastError: 'PushDeer 返回非法 JSON' });
  });
});

describe('保存与密钥语义', () => {
  it('启用配置沿用投递端点校验，不完整草稿可以保存', async () => {
    const id = await seed('notify-validation');
    await expect(updateUserNotifyPrefs(env, id, { feishu: { enabled: true, webhookUrl: 'https://example.com/hook', secret: '', contentLevel: 'summary' } })).rejects.toThrow('非法');
    await expect(updateUserNotifyPrefs(env, id, { webhook: { enabled: true, url: 'https://127.0.0.1/hook', secret: '' } })).rejects.toThrow('公网地址');
    await expect(updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, pushkey: '' } })).rejects.toThrow('PushKey');
    await expect(updateUserNotifyPrefs(env, id, { forward: { enabled: true, addresses: [] } })).rejects.toThrow('目标地址');
    await expect(updateUserNotifyPrefs(env, id, { feishu: { enabled: false, webhookUrl: '', secret: '', contentLevel: 'summary' } })).resolves.toBeTruthy();
  });

  it('MASK 保留已配置密钥，明确空值清除', async () => {
    const id = await seed('notify-mask');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd });
    const masked = maskUserNotifyPrefs(await getUserNotifyPrefs(env, id));
    expect(masked.pushdeer.pushkey).toBe(SECRET_MASK);
    // 接入点不变（空地址与默认接入点、末尾斜杠视为同一个）时掩码沿用
    await updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, endpoint: 'https://api2.pushdeer.com/', pushkey: SECRET_MASK } });
    expect((await getUserNotifyPrefs(env, id)).pushdeer.pushkey).toBe(pd.pushkey);
    await updateUserNotifyPrefs(env, id, { pushdeer: { enabled: false, endpoint: '', pushkey: '' } });
    expect((await getUserNotifyPrefs(env, id)).pushdeer.pushkey).toBe('');
  });

  it('PushDeer 换了接入点（源或路径）时掩码不能沿用已存 PushKey，需重新填写', async () => {
    const id = await seed('notify-pushdeer-target');
    await updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, endpoint: 'https://push.example.com/tenant-a' } });
    for (const endpoint of ['https://evil.example', '', 'https://push.example.com', 'https://push.example.com/tenant-b']) {
      await expect(updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, endpoint, pushkey: SECRET_MASK } }))
        .rejects.toMatchObject({ code: 'validation_failed' });
      // 关闭状态同样不能借掩码改地址
      await expect(updateUserNotifyPrefs(env, id, { pushdeer: { enabled: false, endpoint, pushkey: SECRET_MASK } }))
        .rejects.toMatchObject({ code: 'validation_failed' });
    }
    expect((await getUserNotifyPrefs(env, id)).pushdeer).toEqual({ ...pd, endpoint: 'https://push.example.com/tenant-a' });

    const token = await signToken(env.jwt_secret, { sub: id, sid: await createSession(env, id), epoch: 0, uepoch: 0 });
    const ctx = createExecutionContext();
    const response = await createApp().request('/api/me/notify-prefs', { method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pushdeer: { ...pd, endpoint: 'https://evil.example', pushkey: SECRET_MASK } }) }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('validation_failed');

    // 重新填写 PushKey 后可以换接入点；同一接入点只差末尾斜杠仍可沿用
    await updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, endpoint: 'https://push.example.com/tenant-b', pushkey: 'PDU_NEW' } });
    await updateUserNotifyPrefs(env, id, { pushdeer: { ...pd, endpoint: 'https://push.example.com/tenant-b/', pushkey: SECRET_MASK } });
    expect((await getUserNotifyPrefs(env, id)).pushdeer.pushkey).toBe('PDU_NEW');
  });
});

describe('持久通知队列', () => {
  it('同一邮件按主人启用通道去重入队，存有限正文', async () => {
    const id = await seed('notify-dedupe');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd, webhook });
    const input = { ...mail(101, [id]), text: 'x'.repeat(8000) };
    expect(await enqueueMailNotifications(env, null, input)).toHaveLength(2);
    expect(await enqueueMailNotifications(env, null, input)).toHaveLength(0);
    const rows = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.userId, id));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload.body).toHaveLength(4000);
    expect(rows[0]!.payload.bodyTruncated).toBe(true);
    expect(rows.find(r => r.channel === 'webhook')!.maxAttempts).toBe(1);
    expect(rows.find(r => r.channel === 'pushdeer')!.maxAttempts).toBe(3);
  });

  it('一个 pending PushDeer 不阻塞健康 Webhook', async () => {
    const id = await seed('notify-independent');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd, webhook });
    const ids = await enqueueMailNotifications(env, null, mail(102, [id]));
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    let webhookSent!: () => void;
    const healthy = new Promise<void>(resolve => { webhookSent = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
      if (String(url).includes('pushdeer.com')) return pending;
      webhookSent();
      return Promise.resolve(Response.json({ ok: true }));
    }));
    const processing = processNotificationJobs(env, { jobIds: ids, concurrency: 2 });
    await healthy;
    release(Response.json({ code: 0 }));
    const result = await processing;
    expect(result).toMatchObject({ processed: 2, succeeded: 2 });
  });

  it('Webhook 零自动重试，PushDeer 暂时失败有限退避后成功', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seed('notify-retry-policy');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd, webhook });
    const ids = await enqueueMailNotifications(env, null, mail(103, [id]));
    let pdRequests = 0;
    let webhookRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      if (String(url).includes('pushdeer.com')) return ++pdRequests === 1 ? new Response('retry', { status: 502 }) : Response.json({ code: 0 });
      webhookRequests++;
      return new Response('failed', { status: 500 });
    }));
    expect(await processNotificationJobs(env, { jobIds: ids })).toMatchObject({ deferred: 1, failed: 1 });
    const db = createDb(env);
    const pending = await db.select().from(notificationJobs).where(and(eq(notificationJobs.userId, id), eq(notificationJobs.channel, 'pushdeer'))).get();
    expect(pending).toMatchObject({ status: 'pending', attempts: 1, lastHttpStatus: 502 });
    expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await db.update(notificationJobs).set({ nextAttemptAt: new Date(0) }).where(eq(notificationJobs.id, pending!.id));
    expect(await processNotificationJobs(env, { jobIds: ids })).toMatchObject({ processed: 1, succeeded: 1 });
    expect(webhookRequests).toBe(1);
    expect(pdRequests).toBe(2);
  });

  it('并发 processor 原子认领，同一任务只发送一次', async () => {
    const id = await seed('notify-claim');
    await updateUserNotifyPrefs(env, id, { webhook });
    const ids = await enqueueMailNotifications(env, null, mail(104, [id]));
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all([processNotificationJobs(env, { jobIds: ids }), processNotificationJobs(env, { jobIds: ids })]);
    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('成功外发后状态保存失败保持不确定，不自动重复发且不压制其他任务', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seed('notify-status-write');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd, webhook });
    const ids = await enqueueMailNotifications(env, null, mail(111, [id]));
    let fault = true;
    const faultEnv = { ...env, db: { ...env.db, prepare(query: string) {
      if (fault && query.startsWith('update "notification_jobs"') && query.includes('"last_http_status" = ')) {
        fault = false;
        throw new Error('temporary result write failure');
      }
      return env.db.prepare(query);
    }, batch: env.db.batch.bind(env.db), exec: env.db.exec.bind(env.db) } };
    const fetchMock = vi.fn(async () => Response.json({ code: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await processNotificationJobs(faultEnv as any, { jobIds: ids });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const db = createDb(env);
    const jobs = await db.select().from(notificationJobs).where(eq(notificationJobs.userId, id));
    expect(jobs.filter(job => job.status === 'processing')).toHaveLength(1);
    expect(jobs.filter(job => job.status === 'succeeded')).toHaveLength(1);
    await db.update(notificationJobs).set({ updatedAt: new Date(0) }).where(and(eq(notificationJobs.userId, id), eq(notificationJobs.status, 'processing')));
    await processNotificationJobs(env, { jobIds: ids });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await db.select().from(notificationJobs).where(eq(notificationJobs.userId, id))).some(job => job.status === 'unknown')).toBe(true);
  });

  it('指定任务逐条认领：投递进行中只有正在发送的任务是 processing，其余仍为 pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let allStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => { allStarted = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++started === 4) allStarted();
      await gate;
      return Response.json({ ok: true });
    }));
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await seed(`notify-claim-each-${i}`);
      await updateUserNotifyPrefs(env, id, { webhook });
      ids.push(...await enqueueMailNotifications(env, null, mail(500 + i, [id])));
    }
    expect(ids).toHaveLength(8);
    const run = processNotificationJobs(env, { jobIds: ids, concurrency: 4 });
    await fourStarted;
    // 此刻若 waitUntil 被截断，未开始的任务必须仍是 pending，cron 才会接着投递
    const states = await createDb(env).select({ status: notificationJobs.status }).from(notificationJobs).where(inArray(notificationJobs.id, ids)).all();
    const tally = states.reduce<Record<string, number>>((acc, { status }) => ({ ...acc, [status]: (acc[status] ?? 0) + 1 }), {});
    release();
    expect(await run).toMatchObject({ processed: 8, succeeded: 8 });
    expect(tally).toEqual({ processing: 4, pending: 4 });
  });

  it('jobIds 达到 90 个时每条语句的绑定参数不超过 D1 的 100 上限', async () => {
    const id = await seed('notify-bind-limit');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd, webhook });
    const real = await enqueueMailNotifications(env, null, mail(601, [id]));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 0 })));
    const jobIds = [...real, ...Array.from({ length: 90 - real.length }, (_, i) => 9_000_000 + i)];
    // 记录真正绑定到 D1 的参数个数（drizzle 每条语句都经 prepare → bind）
    const bound: { sql: string; params: number }[] = [];
    const db = new Proxy(env.db, { get(target, property) {
      if (property === 'prepare') return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, { get(inner, key) {
          if (key === 'bind') return (...params: unknown[]) => { bound.push({ sql: query, params: params.length }); return inner.bind(...params); };
          const value = Reflect.get(inner, key);
          return typeof value === 'function' ? value.bind(inner) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await processNotificationJobs({ ...env, db } as never, { jobIds })).toMatchObject({ processed: 2, succeeded: 2 });
    expect(Math.max(...bound.map((item) => item.params))).toBeGreaterThanOrEqual(90);
    expect(bound.filter((item) => item.params > 100)).toEqual([]);
  });

  it('过期 processing 标为 unknown，不自动重复投递', async () => {
    const id = await seed('notify-unknown');
    await updateUserNotifyPrefs(env, id, { pushdeer: pd });
    const ids = await enqueueMailNotifications(env, null, mail(105, [id]));
    await createDb(env).update(notificationJobs).set({ status: 'processing', attempts: 1, updatedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(notificationJobs.id, ids[0]!));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await processNotificationJobs(env, { jobIds: ids });
    expect(fetchMock).not.toHaveBeenCalled();
    const row = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.id, ids[0]!)).get();
    expect(row?.status).toBe('unknown');
  });

  it('停用用户/通道会跳过队列任务；仅主人可明确手动重试', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seed('notify-manual-retry');
    const other = await seed('notify-other');
    await updateUserNotifyPrefs(env, id, { webhook });
    // 重试会复核源邮件仍在，任务须指向真实存在的邮件
    const source = await seedMessage('notify-manual-retry@hpc.email');
    const ids = await enqueueMailNotifications(env, null, mail(source, [id]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('failed', { status: 503 })));
    await processNotificationJobs(env, { jobIds: ids });
    await expect(retryNotificationJob(env, other, ids[0]!)).rejects.toThrow('不存在');
    await retryNotificationJob(env, id, ids[0]!);
    await updateUserNotifyPrefs(env, id, { webhook: { ...webhook, enabled: false } });
    expect(await processNotificationJobs(env, { jobIds: ids })).toMatchObject({ skipped: 1 });
  });

  it('健康结果仅包含个人记录，显示UTC转发配额与最近结果', async () => {
    const id = await seed('notify-health');
    const other = await seed('notify-health-other');
    await updateUserNotifyPrefs(env, id, { forward: { enabled: true, addresses: ['target@example.net'] } });
    await createDb(env).insert(mailboxes).values({ address: 'health@hpc.email', domain: 'hpc.email', userId: id });
    await bumpCounter(env, 'fwd-target', 'target@example.net', dayWindow(), 7);
    await recordDeliveryResult(env, { userId: id, messageId: 107, channel: 'forward', target: 'target@example.net', status: 'succeeded' });
    await recordDeliveryResult(env, { userId: other, messageId: 108, channel: 'forward', target: 'private@example.net', status: 'failed', error: 'private error' });
    const health = await getNotificationHealth(env, id);
    expect(health.channels.find(c => c.channel === 'forward')).toMatchObject({ enabled: true, latest: { target: 'target@example.net', status: 'succeeded' }, failedCount: 0 });
    expect(health.forward.targets).toEqual([{ address: 'target@example.net', attempts: 7, remaining: 193 }]);
    expect(JSON.stringify(health)).not.toContain('private');
  });

  it('清理旧完成记录但保留未处理任务', async () => {
    const id = await seed('notify-cleanup');
    await updateUserNotifyPrefs(env, id, { webhook });
    const ids = await enqueueMailNotifications(env, null, mail(109, [id]));
    await createDb(env).update(notificationJobs).set({ createdAt: new Date(0) }).where(eq(notificationJobs.id, ids[0]!));
    await recordDeliveryResult(env, { userId: id, messageId: 110, channel: 'forward', status: 'failed' });
    await createDb(env).update(notificationJobs).set({ createdAt: new Date(0) }).where(and(eq(notificationJobs.userId, id), eq(notificationJobs.channel, 'forward')));
    await cleanupNotificationJobs(env);
    const rows = await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.userId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
  });

  it('临时D1入队失败后按收信owner快照补录，不通知后来认领者', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalOwner = await seed('notify-repair-owner');
    const laterOwner = await seed('notify-repair-later');
    await updateUserNotifyPrefs(env, originalOwner, { pushdeer: pd });
    await updateUserNotifyPrefs(env, laterOwner, { pushdeer: pd });
    const db = createDb(env);
    const [message] = await db.insert(messages).values({ direction: 'inbound', address: 'repair@hpc.email', domain: 'hpc.email', status: 'received',
      notifyOwnerIds: [originalOwner], subject: 'Repair original owner', bodyText: 'test body' }).returning();
    const faultEnv = { ...env, db: { ...env.db, prepare(query: string) {
      if (query.startsWith('insert into "notification_jobs"')) throw new Error('temporary D1 failure');
      return env.db.prepare(query);
    }, batch: env.db.batch.bind(env.db), exec: env.db.exec.bind(env.db) } };
    await enqueueMailNotifications(faultEnv as any, null, { ...mail(message!.id, [originalOwner]), message: { ...mail(message!.id, [originalOwner]).message, address: 'repair@hpc.email' } });
    expect((await db.select().from(messages).where(eq(messages.id, message!.id)).get())?.notificationsQueuedAt).toBeNull();
    await db.insert(mailboxes).values({ address: 'repair@hpc.email', domain: 'hpc.email', userId: laterOwner });
    expect(await repairUnqueuedNotifications(env)).toBe(1);
    const jobs = await db.select().from(notificationJobs).where(eq(notificationJobs.messageId, message!.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.userId).toBe(originalOwner);
    expect((await db.select().from(messages).where(eq(messages.id, message!.id)).get())?.notificationsQueuedAt).not.toBeNull();
    expect(await repairUnqueuedNotifications(env)).toBe(0);
  });

  it('无收件快照的历史邮件不参与补推', async () => {
    const id = await seed('notify-legacy-mail');
    await updateUserNotifyPrefs(env, id, { webhook });
    const [message] = await createDb(env).insert(messages).values({ direction: 'inbound', address: 'legacy@hpc.email', domain: 'hpc.email', status: 'received', bodyText: 'legacy body' }).returning({ id: messages.id });
    expect(await repairUnqueuedNotifications(env)).toBe(0);
    expect(await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, message!.id))).toHaveLength(0);
  });
});
