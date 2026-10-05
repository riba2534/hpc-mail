import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sendMailRequestSchema, domainSchema, domainsSettingSchema } from '@hpc-mail/shared';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, deliveryObjectLeases, draftAttachments, mailboxes, messages, storageCleanupJobs, users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { login } from '../src/services/auth.js';
import { retainExternalAttachments } from '../src/services/external-attachment.js';
import { claimMailbox, releaseMailbox } from '../src/services/mailbox.js';
import { getMessageDetail, getThread, listMessages, purgeMessages, restoreMessages } from '../src/services/message.js';
import { getUserEpoch } from '../src/services/session.js';
import { getSettingsFresh, updateSettings } from '../src/services/setting.js';
import { runScheduled } from '../src/services/scheduled.js';
import { processStorageCleanup, expireDeliveryObjectLeases } from '../src/services/storage-cleanup.js';
import { consumeDraftAttachments } from '../src/services/upload.js';
import type { Env } from '../src/types.js';

async function seed(name: string, trashed = false) {
  const db = createDb(env);
  const user = await db.insert(users).values({ username: name, passwordHash: 'local-only', role: 'user' }).returning().get();
  const address = `${name}@review.example`;
  const mailbox = await db.insert(mailboxes).values({ userId: user!.id, address, domain: 'review.example' }).returning().get();
  const key = `review/${name}/raw.eml`;
  await env.r2.put(key, 'review message');
  const message = await db.insert(messages).values({ direction: 'inbound', address, domain: 'review.example', status: 'received', subject: name, bodyText: 'body', rawR2Key: key, deletedAt: trashed ? new Date(Date.now() - 8 * 86400000) : null }).returning().get();
  return { db, viewer: { userId: user!.id, role: 'user' as const }, id: message!.id, key, address, mailboxId: mailbox!.id };
}

/** Inject a competing write immediately before a selected D1 statement executes. */
function beforeStatement(pattern: RegExp, hook: () => Promise<void>): Env {
  let triggered = false;
  let selected = false;
  const wrap = (statement: D1PreparedStatement, intercept: boolean): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), intercept);
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        if (intercept && !triggered && ['first', 'all', 'run', 'raw'].includes(String(property))) {
          triggered = true; await hook();
        }
        return method.apply(target, args);
      };
    },
  });
  return { ...env, db: new Proxy(env.db, { get(target, property) {
    if (property === 'prepare') return (query: string) => { const match = pattern.test(query); selected ||= match; return wrap(target.prepare(query), match); };
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => { if (selected && !triggered) { triggered = true; await hook(); } return target.batch(statements); };
    const method = Reflect.get(target, property);
    return typeof method === 'function' ? method.bind(target) : method;
  } }) } as Env;
}

describe('mail functional safety regressions', () => {
  it('does not issue a valid session for a password verified before a concurrent reset', async () => {
    const db = createDb(env);
    const user = await db.insert(users).values({ username: 'reset-race', passwordHash: await hashPassword('old-password-123'), authVersionMigrated: true }).returning().get();
    const racing = beforeStatement(/INSERT INTO sessions/i, async () => {
      await db.update(users).set({ passwordHash: 'reset-password-hash', authVersion: 1 }).where(eq(users.id, user!.id));
    });
    await expect(login(racing, { username: 'reset-race', password: 'old-password-123' }, '127.0.0.25')).rejects.toMatchObject({ code: 'bad_credentials' });
    expect((await db.select().from(users).where(eq(users.id, user!.id)).get())!.authVersion).toBe(1);
  });

  it('legacy KV migration cannot undo a concurrent D1 credential version bump', async () => {
    const db = createDb(env);
    const user = await db.insert(users).values({ username: 'epoch-race', passwordHash: 'x' }).returning().get();
    const racing = { ...env, kv: { get: async () => {
      await db.update(users).set({ authVersion: 9, authVersionMigrated: true }).where(eq(users.id, user!.id));
      return '2';
    } } } as unknown as Env;
    expect(await getUserEpoch(racing, user!.id)).toBe(9);
  });

  it('long literal UTF-8 searches and thread subjects work beyond the D1 LIKE limit', async () => {
    const s = await seed('long-search');
    const subject = '中文_%\\'.repeat(25);
    await s.db.update(messages).set({ subject }).where(eq(messages.id, s.id));
    expect((await listMessages(env, s.viewer, { q: subject, limit: 30 })).items.map(m => m.id)).toEqual([s.id]);
    expect((await getThread(env, s.viewer, s.id)).map(m => m.id)).toContain(s.id);
  });

  it('restore never reports success after permanent deletion has committed', async () => {
    const s = await seed('purge-race', true);
    let restored = -1;
    const racing = { ...env, r2: { delete: async (key: string | string[]) => {
      restored = await restoreMessages(env, s.viewer, [s.id]); await env.r2.delete(key);
    } } } as unknown as Env;
    expect(await purgeMessages(racing, s.viewer, [s.id])).toBe(1);
    expect(restored).toBe(0);
  });

  it('failed R2 cleanup keeps a durable reference and succeeds on retry', async () => {
    const s = await seed('cleanup-retry', true);
    const broken = { ...env, r2: { delete: async () => { throw new Error('R2 temporarily unavailable'); } } } as unknown as Env;
    expect(await purgeMessages(broken, s.viewer, [s.id])).toBe(1);
    expect(await s.db.select().from(storageCleanupJobs).where(eq(storageCleanupJobs.r2Key, s.key)).get()).toBeDefined();
    expect(await env.r2.get(s.key)).not.toBeNull();
    await processStorageCleanup(env);
    expect(await env.r2.get(s.key)).toBeNull();
  });

  it('release deletes a message arriving after authorization but before its atomic transaction', async () => {
    const s = await seed('release-race');
    let inserted = false;
    const racing = { ...env, db: new Proxy(env.db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!inserted) { inserted = true; await s.db.insert(messages).values({ direction: 'inbound', address: s.address, domain: 'review.example', status: 'received', subject: 'concurrent' }); }
        return target.batch(statements);
      };
      const method = Reflect.get(target, property);
      return typeof method === 'function' ? method.bind(target) : method;
    } }) } as Env;
    expect((await releaseMailbox(racing, s.viewer.userId, s.mailboxId, false, true)).deletedMessages).toBe(2);
    expect(await s.db.select().from(messages).where(eq(messages.address, s.address)).all()).toHaveLength(0);
  });

  it('retention rechecks mailbox ownership when it reserves messages for deletion', async () => {
    const s = await seed('retention-claim-race');
    await s.db.delete(mailboxes).where(eq(mailboxes.id, s.mailboxId));
    await s.db.update(messages).set({ createdAt: new Date(Date.now() - 3 * 86400000) }).where(eq(messages.id, s.id));
    await updateSettings(env, { retention: { unclaimedDays: 1, allMessagesDays: 0 } });
    const racing = beforeStatement(/update "?messages"? set "?purge_token"?/i, async () => {
      await s.db.insert(mailboxes).values({ address: s.address, domain: 'review.example', userId: s.viewer.userId });
    });
    await runScheduled(racing);
    expect((await getMessageDetail(env, s.viewer, s.id)).bodyText).toBe('body');
  });

  it('external delivery link still downloads after the sent-mail row is purged', async () => {
    const s = await seed('retained-link', true);
    const key = 'review/retained-link/file.txt'; await env.r2.put(key, 'durable download');
    const att = await s.db.insert(attachments).values({ messageId: s.id, r2Key: key, filename: 'file.txt', mimeType: 'text/plain', size: 16 }).returning().get();
    const links = await retainExternalAttachments(env, [att!], 'https://hpc.email');
    await purgeMessages(env, s.viewer, [s.id]);
    const response = await createApp().request(links.get(att!.id)!, undefined, env);
    expect(response.status).toBe(200); expect(await response.text()).toBe('durable download');
  });

  it('domain CAS rejects stale replacement and claim returns inherited message count', async () => {
    await updateSettings(env, { domains: { list: [{ domain: 'review.example', public: true, perUserLimit: 0 }] } });
    const before = await getSettingsFresh(env);
    const patch = { domains: { list: [{ domain: 'review.example', public: true, perUserLimit: 0 }, { domain: 'second.example', public: false, perUserLimit: 0 }] }, expectedDomainsRevision: before.domains.revision };
    await updateSettings(env, patch);
    await expect(updateSettings(env, patch)).rejects.toMatchObject({ code: 'conflict' });
    const s = await seed('claim-history-count'); await s.db.delete(mailboxes).where(eq(mailboxes.id, s.mailboxId));
    expect((await claimMailbox(env, s.viewer.userId, 'admin', { localPart: 'claim-history-count', domain: 'review.example' })).messageCount).toBe(1);
  });

  it('failed draft-object cleanup retains the draft row for later retry', async () => {
    const s = await seed('draft-cleanup'); const token = crypto.randomUUID(); const r2Key = `draft/${token}`;
    await env.r2.put(r2Key, 'file');
    await s.db.insert(draftAttachments).values({ userId: s.viewer.userId, token, r2Key, filename: 'file.txt', status: 'ready' });
    const broken = { ...env, r2: { delete: async () => { throw new Error('R2 failure'); } } } as unknown as Env;
    await consumeDraftAttachments(broken, s.viewer.userId, [token]);
    expect(await s.db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get()).toBeDefined();
    await consumeDraftAttachments(env, s.viewer.userId, [token]);
    expect(await s.db.select().from(draftAttachments).where(eq(draftAttachments.token, token)).get()).toBeUndefined();
  });

  it('expired crashed delivery leases reclaim orphan references without touching a live send', async () => {
    const s = await seed('lease-expiry');
    const key = 'review/crashed-delivery.bin'; await env.r2.put(key, 'attachment');
    await s.db.insert(attachments).values({ messageId: 9999999, r2Key: key });
    await s.db.insert(deliveryObjectLeases).values([
      { r2Key: key, token: 'crashed', expiresAt: new Date(Date.now() - 1000) },
      { r2Key: key, token: 'live', expiresAt: new Date(Date.now() + 60000) },
    ]);
    await expireDeliveryObjectLeases(env); await processStorageCleanup(env);
    expect(await env.r2.get(key)).not.toBeNull();
    await s.db.update(deliveryObjectLeases).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(deliveryObjectLeases.token, 'live'));
    await expireDeliveryObjectLeases(env); await processStorageCleanup(env);
    expect(await env.r2.get(key)).toBeNull();
    expect(await s.db.select().from(attachments).where(eq(attachments.r2Key, key)).get()).toBeUndefined();
  });

  it('validates DNS labels, duplicate normalized domains and UTF-8 body totals', () => {
    for (const domain of ['a..com', '-bad.com', 'bad-.com', `${'a'.repeat(64)}.com`]) expect(domainSchema.safeParse(domain).success).toBe(false);
    expect(domainsSettingSchema.safeParse({ list: ['Example.com', 'example.com'] }).success).toBe(false);
    const req = { from: { mailboxId: 1 }, to: [], bcc: ['hidden@example.com'], subject: 'retry', text: 'hello' };
    expect(sendMailRequestSchema.safeParse(req).success).toBe(true);
    expect(sendMailRequestSchema.safeParse({ ...req, text: '中'.repeat(400000) }).success).toBe(false);
  });
});
