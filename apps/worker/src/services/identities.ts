import type { Role, SendIdentities, SendIdentity } from '@hpc-mail/shared';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { hostedDomains, mailboxShares, mailboxes, users } from '../db/schema.js';
import type { Env } from '../types.js';
import { hostedSendBlock } from './domain.js';
import { getSettings } from './setting.js';

/**
 * 发件身份：自己认领的邮箱（按域名状态判定能否发信）与共享给我的邮箱（只读，恒不能发）。
 * 两条读取合成一个 batch；设置只有管理员需要（列出可用任意前缀的系统域名），走 isolate 缓存并行读。
 * 管理员凭 mailboxId 发他人邮箱的能力不变，但不在这里列出。
 */
export async function listSendIdentities(env: Env, actor: { userId: number; role: Role }): Promise<SendIdentities> {
  const db = createDb(env);
  const [[owned, shared], settings] = await Promise.all([
    db.batch([
      db.select({
        mailboxId: mailboxes.id, address: mailboxes.address, domain: mailboxes.domain, displayName: mailboxes.displayName,
        status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus,
      })
        .from(mailboxes)
        .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
        .where(eq(mailboxes.userId, actor.userId))
        .orderBy(asc(mailboxes.address)),
      // 与 GET /mailboxes/shared 同一口径：所有者停用时共享隐藏
      db.select({ mailboxId: mailboxes.id, address: mailboxes.address, domain: mailboxes.domain, displayName: mailboxes.displayName })
        .from(mailboxShares)
        .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
        .innerJoin(users, eq(users.id, mailboxes.userId))
        .where(and(eq(mailboxShares.userId, actor.userId), eq(users.status, 'active')))
        .orderBy(asc(mailboxes.address)),
    ]),
    actor.role === 'admin' ? getSettings(env) : null,
  ]);
  const identities: SendIdentity[] = [
    ...owned.map(({ status, sendingStatus, ...box }): SendIdentity => {
      const reason = hostedSendBlock({ status, sendingStatus });
      return { kind: 'owned', ...box, canSend: reason === null, reason };
    }),
    ...shared.map((box): SendIdentity => ({ kind: 'shared', ...box, canSend: false, reason: 'shared_readonly' })),
  ];
  return {
    identities,
    domains: (settings?.domains.list ?? []).map(({ domain }) => ({ domain, kind: 'system', anyLocalPart: true })),
  };
}
