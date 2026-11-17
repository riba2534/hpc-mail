import { HOSTED_DOMAIN_USABLE_STATUSES, type Role, type SendIdentityBlockReason, type Settings } from '@hpc-mail/shared';
import { eq, inArray } from 'drizzle-orm';
import { chunk } from '../lib/d1.js';
import { createDb } from '../db/client.js';
import { hostedDomains, mailboxes } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { getSettings, getSettingsFresh } from './setting.js';
import { asActor, mailboxPolicyUserFromResult, mailboxPolicyUserStatement, resolveMailboxPolicy } from './mailbox-policy.js';

/**
 * 全部系统域名名（管理员可用范围）：完全由 settings.domains.list 决定（管理端维护，无写死 fallback）。
 * 收件人分组 / 发件校验 / 可用性检查 / 认领「是否系统域名」判定都走这里，保证同一来源。
 * 未配置任何域名时返回空数组——此时认领/发件全部被拒，需管理员先在设置里加域名。
 */
export async function getDomains(env: Env, settings?: Settings): Promise<string[]> {
  const s = settings ?? (await getSettings(env));
  return s.domains.list.map((e) => e.domain);
}

/** 系统通知（登录告警/测试卡片等）展示用的发件地址：取首个已配域名，未配置时回退 localhost。 */
export async function getSystemFromAddress(env: Env): Promise<string> {
  const [first] = await getDomains(env);
  return `system@${first ?? 'localhost'}`;
}

/** 对普通用户公开的域名子集（可见 + 可认领）；管理员不受此限。 */
export async function getPublicDomains(env: Env, settings?: Settings): Promise<string[]> {
  const s = settings ?? (await getSettings(env));
  return s.domains.list.filter((e) => e.public).map((e) => e.domain);
}

/**
 * 当前用户可以新增认领的域名；用户专属配置与认领校验使用同一解析器。
 * 直读 D1（与用户策略并行，不多一层往返）：认领弹窗以它为前端闸门，管理员增删域名后必须立即可见。
 */
export async function getVisibleDomains(
  env: Env,
  actor: { userId: number; role: Role },
  settings?: Settings,
): Promise<string[]> {
  const { userId } = actor;
  // 用户策略与托管域名合成一个 batch，与设置直读并行，仍是一层往返。
  // 管理员规则要求账户与凭据都是管理员（没有 admin scope 的管理员 Key 按普通用户，见 asActor）
  const [[userResult, hosted], resolved] = await Promise.all([
    env.db.batch([
      mailboxPolicyUserStatement(env.db, userId),
      env.db.prepare(`SELECT domain FROM hosted_domains h WHERE status IN (${USABLE_HOSTED_SQL})
        AND ((?2 = 'admin' AND (SELECT role FROM users WHERE id = ?1) = 'admin') OR user_id = ?1
          OR EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = h.id AND m.user_id = ?1))
        ORDER BY domain`).bind(userId, actor.role),
    ]),
    settings ?? getSettingsFresh(env),
  ]);
  // 托管域名排在系统域名之后：普通用户是自己拥有或被共享的，管理员可在任何人的托管域名下认领
  return [
    ...resolveMailboxPolicy(resolved, asActor(mailboxPolicyUserFromResult(userResult), actor.role)).domains.map(({ domain }) => domain),
    ...((hosted?.results ?? []) as { domain: string }[]).map((row) => row.domain),
  ];
}

/** 可认领、可收发的托管域名状态，写成 SQL 的 IN 列表 */
export const USABLE_HOSTED_SQL = HOSTED_DOMAIN_USABLE_STATUSES.map((status) => `'${status}'`).join(', ');

/** 托管域名站内投递：已生效或被暂停（由收件方拒收）走站内，等待 NS、已迁走或删除中按真实 DNS 外发 */
const INTERNAL_HOSTED_STATUSES: readonly string[] = [...HOSTED_DOMAIN_USABLE_STATUSES, 'suspended'];

/**
 * 发件域名状态的唯一判定（发信校验、发件身份、邮箱列表的 canSend 共用）：只看托管域名行
 * （LEFT JOIN 没匹配时各列为 null），不是托管域名（系统域名、已移出列表的旧域名）返回 null 即可发；
 * 托管域名需未停用且发信已就绪。
 */
export function hostedSendBlock(
  hosted: { status: string | null; sendingStatus: string | null } | undefined,
): Extract<SendIdentityBlockReason, 'hosted_domain_unavailable' | 'hosted_sending_not_ready'> | null {
  if (!hosted?.status) return null;
  if (!(HOSTED_DOMAIN_USABLE_STATUSES as readonly string[]).includes(hosted.status)) return 'hosted_domain_unavailable';
  return hosted.sendingStatus === 'ready' ? null : 'hosted_sending_not_ready';
}

/** 从托管域名发信需该域发信已就绪；系统域名不受此限 */
export async function assertHostedSendable(env: Env, settings: Settings, domain: string): Promise<void> {
  if (settings.domains.list.some((entry) => entry.domain === domain)) return;
  const row = await createDb(env).select({ status: hostedDomains.status, sendingStatus: hostedDomains.sendingStatus })
    .from(hostedDomains).where(eq(hostedDomains.domain, domain)).get();
  if (hostedSendBlock(row)) {
    throw new AppError('validation_failed', '该域名的发信尚未生效或已停用', {
      fix: '先调 GET /v1/identities（网页会话用 /api/identities），从 canSend=true 的地址里选一个作为 from；托管域名要等发信就绪后才能使用',
      docs: '/references/errors.md#forbidden-sender',
    });
  }
}

/**
 * 站内投递 / 已领地址发件白名单：settings 列表 ∪ 已有 mailbox 的 domain。
 * 管理员从列表拿掉某个域后，已认领用户仍应按站内互投，而不是被当成外发。
 * 传入 candidates 时只核对这些域是否有认领地址（走 idx_mailboxes_domain），结果对这些域的
 * 判定与全量一致；不传则读出全部认领域名。
 */
export async function getRoutableDomains(env: Env, settings?: Settings, candidates?: string[]): Promise<string[]> {
  const listed = await getDomains(env, settings);
  const set = new Set(listed);
  const db = createDb(env);
  // 托管域名按状态决定：未生效、已迁走或删除中的域名即使有存量地址也按真实 DNS 外发
  const applyHosted = (rows: { domain: string; status: string }[]) => {
    for (const row of rows) {
      if (INTERNAL_HOSTED_STATUSES.includes(row.status)) set.add(row.domain);
      else set.delete(row.domain);
    }
  };
  if (candidates) {
    const unknown = [...new Set(candidates.filter((domain) => domain && !set.has(domain)))];
    for (const batch of chunk(unknown)) {
      const [rows, hosted] = await db.batch([
        db.selectDistinct({ domain: mailboxes.domain }).from(mailboxes).where(inArray(mailboxes.domain, batch)),
        db.select({ domain: hostedDomains.domain, status: hostedDomains.status }).from(hostedDomains)
          .where(inArray(hostedDomains.domain, batch)),
      ]);
      for (const row of rows) set.add(row.domain);
      applyHosted(hosted);
    }
    return [...set];
  }
  const [rows, hosted] = await db.batch([
    db.selectDistinct({ domain: mailboxes.domain }).from(mailboxes),
    db.select({ domain: hostedDomains.domain, status: hostedDomains.status }).from(hostedDomains),
  ]);
  for (const row of rows) set.add(row.domain);
  applyHosted(hosted);
  return [...set];
}
