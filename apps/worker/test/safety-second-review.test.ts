import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { mailboxes, messages, notificationJobs, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { login } from '../src/services/auth.js';
import { claimMailbox } from '../src/services/mailbox.js';
import { enqueueMailNotifications, processNotificationJobs, repairUnqueuedNotifications, retryNotificationJob } from '../src/services/notification-jobs.js';
import { updateUserNotifyPrefs } from '../src/services/notify-prefs.js';
import { updateSettings } from '../src/services/setting.js';
import type { Env } from '../src/types.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function beforeStatement(pattern: RegExp, hook: () => Promise<void>): Env {
  let triggered = false;
  const wrap = (statement: D1PreparedStatement, intercept: boolean): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), intercept);
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (intercept && !triggered && ['first', 'all', 'run', 'raw'].includes(String(property))) {
          triggered = true;
          await hook();
        }
        return method.apply(target, args);
      };
    },
  });
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => wrap(target.prepare(query), pattern.test(query));
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) } as Env;
}

async function seed(name: string) {
  return createDb(env).insert(users).values({ username: name, passwordHash: 'test-only' }).returning().get();
}

describe('independent safety review regressions', () => {
  it('rejects a login when two-factor authentication changes after credential verification', async () => {
    const db = createDb(env);
    const user = await db.insert(users).values({ username: 'second-review-2fa-race',
      passwordHash: await hashPassword('old-password-123'), authVersionMigrated: true }).returning().get();
    const racing = beforeStatement(/INSERT INTO sessions/i, async () => {
      await db.update(users).set({ totpSecret: 'changed-two-factor-secret', totpEnabledAt: new Date() }).where(eq(users.id, user!.id));
    });
    await expect(login(racing, { username: user!.username, password: 'old-password-123' }, '127.0.0.55'))
      .rejects.toMatchObject({ code: 'bad_credentials' });
  });

  it.each(['admin', 'user'] as const)('rejects a removed domain at the %s claim write boundary', async role => {
    const user = await seed(`second-review-domain-${role}`);
    await updateSettings(env, { domains: { list: [{ domain: 'claim-race.example', public: true, perUserLimit: 0 }] } });
    const racing = beforeStatement(/INSERT INTO "?mailboxes"?/i, async () => {
      await updateSettings(env, { domains: { list: [] } });
    });
    await expect(claimMailbox(racing, user!.id, role, { localPart: `race-${role}`, domain: 'claim-race.example' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await createDb(env).select().from(mailboxes).where(eq(mailboxes.userId, user!.id))).toHaveLength(0);
  });

  it('rejects a public domain becoming private during an ordinary-user claim', async () => {
    const user = await seed('second-review-private-race');
    await updateSettings(env, { domains: { list: [{ domain: 'claim-private.example', public: true, perUserLimit: 0 }] } });
    const racing = beforeStatement(/INSERT INTO "?mailboxes"?/i, async () => {
      await updateSettings(env, { domains: { list: [{ domain: 'claim-private.example', public: false, perUserLimit: 0 }] } });
    });
    await expect(claimMailbox(racing, user!.id, 'user', { localPart: 'private-race', domain: 'claim-private.example' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('still accepts normalized legacy string domain settings for an administrator', async () => {
    const user = await seed('second-review-legacy-domain');
    await env.db.prepare("INSERT INTO settings (key, value) VALUES ('domains', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(JSON.stringify({ list: ['Legacy-Claim.Example'] })).run();
    expect((await claimMailbox(env, user!.id, 'admin', { localPart: 'legacy', domain: 'legacy-claim.example' })).address)
      .toBe('legacy@legacy-claim.example');
  });

  it('a late expired processor cannot overwrite the manually retried lease', async () => {
    const db = createDb(env);
    const user = await seed('second-review-notification-lease');
    await updateUserNotifyPrefs(env, user!.id, { pushdeer: { enabled: true, endpoint: '', pushkey: 'PDU_SYNTHETIC_TEST' } });
    const ids = await enqueueMailNotifications(env, null, { ownerIds: [user!.id], text: 'body', message: {
      id: 9011, address: 'lease@hpc.email', fromAddress: 'from@example.net', fromName: '', subject: 'lease',
      verificationCode: '', preview: 'body', createdAt: new Date().toISOString(),
    } });
    let releaseFirst!: (response: Response) => void;
    let releaseSecond!: (response: Response) => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstStart = new Promise<void>(resolve => { firstStarted = resolve; });
    const secondStart = new Promise<void>(resolve => { secondStarted = resolve; });
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      if (++requests === 1) { releaseFirst = resolve; firstStarted(); }
      else { releaseSecond = resolve; secondStarted(); }
    })));
    const first = processNotificationJobs(env, { jobIds: ids, concurrency: 1 });
    await firstStart;
    await db.update(notificationJobs).set({ updatedAt: new Date(0) }).where(eq(notificationJobs.id, ids[0]!));
    await processNotificationJobs(env, { jobIds: ids });
    await retryNotificationJob(env, user!.id, ids[0]!);
    const second = processNotificationJobs(env, { jobIds: ids, concurrency: 1 });
    await secondStart;
    try {
      releaseFirst(Response.json({ code: 0 }));
      await first;
      expect(await db.select().from(notificationJobs).where(eq(notificationJobs.id, ids[0]!)).get())
        .toMatchObject({ status: 'processing', attempts: 2, maxAttempts: 4 });
    } finally {
      releaseFirst(Response.json({ code: 0 }));
      releaseSecond(new Response('temporary failure', { status: 502 }));
      await Promise.all([first, second]);
    }
    expect(await db.select().from(notificationJobs).where(eq(notificationJobs.id, ids[0]!)).get())
      .toMatchObject({ status: 'pending', attempts: 2, lastHttpStatus: 502 });
  });

  it('repairs an unqueued owner snapshot after an outage lasting over one day', async () => {
    const user = await seed('second-review-notification-repair');
    await updateUserNotifyPrefs(env, user!.id, { webhook: { enabled: true, url: 'https://notify.example.com/mail', secret: '' } });
    const message = await createDb(env).insert(messages).values({ direction: 'inbound', status: 'received',
      address: 'old-snapshot@hpc.email', domain: 'hpc.email', notifyOwnerIds: [user!.id], bodyText: 'durable body',
      createdAt: new Date(Date.now() - 3 * 86400000),
    }).returning().get();
    expect(await repairUnqueuedNotifications(env)).toBe(1);
    expect(await createDb(env).select().from(notificationJobs).where(eq(notificationJobs.messageId, message!.id)))
      .toHaveLength(1);
  });
});
