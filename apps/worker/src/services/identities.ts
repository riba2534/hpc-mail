import type { Role, SendIdentities, SendIdentity, SendIdentityDomain } from '@hpc-mail/shared';
import { and, asc, eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { hostedDomains, mailboxShares, mailboxes, users } from '../db/schema.js';
import type { Env } from '../types.js';
import { hostedSendBlock } from './domain.js';
import { getSettings } from './setting.js';

/**
 * 发件身份：自己认领的邮箱、共享给我的邮箱，管理员另列可用任意前缀的域名。
 * 能否发信与管理员的 domains 都按实际放行规则算（outbound.ts 的 resolveFrom + assertHostedSendable）：
 * 托管域名需未停用且发信就绪，系统域名与已移出列表的旧域名不受此限。普通用户共享来的邮箱恒不能发；
 * 管理员凭 mailboxId 能用任何邮箱发信，共享给他的同样只按域名判定，其他人未共享的邮箱不在这里列出。
 * 全部读取合成一个 batch；设置只有管理员需要，走 isolate 缓存并行读。
 */
export async function listSendIdentities(env: Env, actor: { userId: number; role: Role }): Promise<SendIdentities> {
  const db = createDb(env);
  const admin = actor.role === 'admin';
  const owned = db.select({
    mailboxId: mailboxes.id, address: mailboxes.address, domain: mailboxes.domain, displayName: mailboxes.displayName,
    status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus,
  })
    .from(mailboxes)
    .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
    .where(eq(mailboxes.userId, actor.userId))
    .orderBy(asc(mailboxes.address));
  // 与 GET /mailboxes/shared 同一口径：所有者停用时共享隐藏
  const shared = db.select({
    mailboxId: mailboxes.id, address: mailboxes.address, domain: mailboxes.domain, displayName: mailboxes.displayName,
    status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus,
  })
    .from(mailboxShares)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxShares.mailboxId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .leftJoin(hostedDomains, eq(hostedDomains.domain, mailboxes.domain))
    .where(and(eq(mailboxShares.userId, actor.userId), eq(users.status, 'active')))
    .orderBy(asc(mailboxes.address));
  // 管理员的 domains 与 getRoutableDomains 同一来源：全部托管域名的状态，以及仍有存量邮箱的域名
  const hosted = db.select({ domain: hostedDomains.domain, status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus })
    .from(hostedDomains).orderBy(asc(hostedDomains.domain));
  const claimed = db.selectDistinct({ domain: mailboxes.domain }).from(mailboxes).orderBy(asc(mailboxes.domain));
  const [rows, settings] = await Promise.all([
    admin ? db.batch([owned, shared, hosted, claimed]) : db.batch([owned, shared]),
    admin ? getSettings(env) : null,
  ]);
  const [ownedRows, sharedRows] = rows;
  const identities: SendIdentity[] = [
    ...ownedRows.map(({ status, sendingStatus, ...box }): SendIdentity => {
      const reason = hostedSendBlock({ status, sendingStatus });
      return { kind: 'owned', ...box, canSend: reason === null, reason };
    }),
    ...sharedRows.map(({ status, sendingStatus, ...box }): SendIdentity => {
      const reason = admin ? hostedSendBlock({ status, sendingStatus }) : 'shared_readonly';
      return { kind: 'shared', ...box, canSend: reason === null, reason };
    }),
  ];
  if (rows.length !== 4 || !settings) return { identities, domains: [] };

  const [, , hostedRows, claimedRows] = rows;
  const system = settings.domains.list.map(({ domain }) => domain);
  const known = new Set([...system, ...hostedRows.map(({ domain }) => domain)]);
  const entry = (kind: SendIdentityDomain['kind']) => (domain: string): SendIdentityDomain => ({ domain, kind, anyLocalPart: true });
  return {
    identities,
    domains: [
      ...system.map(entry('system')),
      ...hostedRows.filter((row) => hostedSendBlock(row) === null).map(({ domain }) => domain).map(entry('hosted')),
      // 暂停、未就绪、已迁走或删除中的托管域名发不出去，即使有存量邮箱也不算旧域名
      ...claimedRows.map(({ domain }) => domain).filter((domain) => !known.has(domain)).map(entry('legacy')),
    ],
  };
}
