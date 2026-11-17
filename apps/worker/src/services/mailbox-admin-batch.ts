/**
 * 管理员批量邮箱操作（/api/admin/mailboxes/batch/*，仅管理员 JWT）：运维脚本经应用完成批量创建、释放、过户、共享，
 * 不再直写 D1 自行复现业务不变量。
 *
 * 事务语义（认领除外）：逐项结果。读取阶段逐项校验，邮箱不存在、所有者与 expectedOwnerId 不符等项单独记为失败，
 * 不影响其他项；其余项在同一个 D1 事务中一起提交，事务开头的闸门复核读取时的状态，有变化则整批回滚并返回 409。
 * 这样单项失败不会挡住整批，也不会有某一项只做了一半（共享撤销了、邮箱没过户之类）。
 * 语句与绑定参数都不随项数增长：各项作为一个 JSON 参数传入，用 json_each 展开。
 * 审计每项一行（与单个接口同名的 action），detail 末尾带本次请求 id，同一批可据此归组。
 */
import {
  MAX_MAILBOX_GRANTEES,
  type AdminBatchClaimRequest, type AdminBatchReleaseRequest, type AdminBatchShareRequest, type AdminBatchTransferRequest,
  type AdminMailboxBatchItemResult, type AdminMailboxBatchResult, type BatchClaimMailboxResult, type ErrorCode,
  type Role, type UserMailboxPolicy, type UserStatus,
} from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env, ExecCtx } from '../types.js';
import { ACTOR_NAME_SQL, auditSuffix, type AuditActor } from './audit.js';
import {
  batchGateStatement, claimMailboxes, claimSettingsFrom, evaluateClaimPolicy, isBatchGateError,
  ownedCountsFromResult, ownedCountsStatement, ownerLabel, releaseTargets,
} from './mailbox.js';
import { claimSettingsStatement } from './mailbox-policy.js';

interface BatchMailboxRow {
  id: number;
  address: string;
  domain: string;
  user_id: number;
  owner_name: string | null;
  hosted: number;
}

function mailboxesByAddressStatement(env: Env, addresses: readonly string[]): D1PreparedStatement {
  return env.db.prepare(`SELECT m.id, m.address, m.domain, m.user_id, u.username AS owner_name,
      EXISTS (SELECT 1 FROM hosted_domains h WHERE h.domain = m.domain) AS hosted
    FROM mailboxes m LEFT JOIN users u ON u.id = m.user_id
    WHERE m.address IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(addresses));
}

function rowsByAddress(result: D1Result | undefined): Map<string, BatchMailboxRow> {
  return new Map(((result?.results ?? []) as BatchMailboxRow[]).map((row) => [row.address, {
    ...row, id: Number(row.id), user_id: Number(row.user_id), hosted: Number(row.hosted),
  }]));
}

const ownerOf = (row: BatchMailboxRow) => ({ userId: row.user_id, ownerName: row.owner_name });

function itemResult(address: string, row: BatchMailboxRow | undefined, status: AdminMailboxBatchItemResult['status'],
  extra: Partial<AdminMailboxBatchItemResult> = {}): AdminMailboxBatchItemResult {
  return { address, status, mailboxId: row?.id ?? null, ownerId: row?.user_id ?? null, error: null, ...extra };
}

const failure = (address: string, row: BatchMailboxRow | undefined, code: ErrorCode, message: string) =>
  itemResult(address, row, 'failed', { error: { code, message } });

/** 读取阶段的通用校验：邮箱不存在、所有者与 expectedOwnerId 不符 */
function precheck(item: { address: string; expectedOwnerId?: number }, row: BatchMailboxRow | undefined): AdminMailboxBatchItemResult | null {
  if (!row) return failure(item.address, row, 'not_found', '邮箱不存在');
  if (item.expectedOwnerId !== undefined && row.user_id !== item.expectedOwnerId) {
    return failure(item.address, row, 'conflict', '邮箱归属已改变，请刷新后重新确认');
  }
  return null;
}

function summarize(results: AdminMailboxBatchItemResult[]): AdminMailboxBatchResult {
  const count = (status: AdminMailboxBatchItemResult['status']) => results.filter((result) => result.status === status).length;
  return { results, done: count('done'), unchanged: count('unchanged'), failed: count('failed') };
}

function countBy(rows: readonly unknown[] | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of (rows ?? []) as { mailbox_id: number }[]) counts.set(Number(row.mailbox_id), (counts.get(Number(row.mailbox_id)) ?? 0) + 1);
  return counts;
}

/** 闸门失败：读取之后有并发修改，本批什么都没写 */
async function commit(env: Env, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await env.db.batch(statements);
  } catch (error) {
    if (isBatchGateError(error)) {
      throw new AppError('conflict', '邮箱归属、用户状态或额度在提交前已改变，本批未做任何修改，请刷新后重试');
    }
    throw error;
  }
}

const IDS_SQL = `SELECT json_extract(value, '$.id') FROM json_each(?1)`;

/** 邮箱仍归读取时的所有者（?1 = [{id, ownerId}]） */
const OWNER_CHANGED_SQL = `SELECT 1 FROM json_each(?1) j WHERE NOT EXISTS (SELECT 1 FROM mailboxes
  WHERE id = json_extract(j.value, '$.id') AND user_id = json_extract(j.value, '$.ownerId'))`;

interface TargetUser {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  mailboxPolicy: UserMailboxPolicy | null;
  mailboxPolicyRevision: number;
}

function targetUserStatement(env: Env, userId: number): D1PreparedStatement {
  return env.db.prepare('SELECT id, username, role, status, mailbox_policy, mailbox_policy_revision FROM users WHERE id = ?').bind(userId);
}

function targetUserFrom(result: D1Result | undefined, inactiveMessage: string): TargetUser {
  const row = result?.results?.[0] as { id: number; username: string; role: Role; status: UserStatus;
    mailbox_policy: string | null; mailbox_policy_revision: number } | undefined;
  if (!row) throw new AppError('not_found', '目标用户不存在');
  if (row.status !== 'active') throw new AppError('validation_failed', inactiveMessage);
  return {
    id: Number(row.id), username: row.username, role: row.role, status: row.status,
    mailboxPolicy: row.mailbox_policy === null ? null : JSON.parse(row.mailbox_policy) as UserMailboxPolicy,
    mailboxPolicyRevision: Number(row.mailbox_policy_revision),
  };
}

/**
 * 为指定用户批量认领：按该用户自己的认领规则（域名授权、保留前缀、额度、托管域名状态与成员资格）执行，
 * 语义同 POST /api/mailboxes/batch——按顺序认领，被占用的跳过，首个业务错误停止，之前认领的保留。
 * 认领分块提交，审计在认领之后补写（每个认领到的地址一行 mailbox.claim），写失败只记日志。
 */
export async function adminClaimMailboxes(env: Env, actor: AuditActor, req: AdminBatchClaimRequest, tag: string): Promise<BatchClaimMailboxResult> {
  const target = targetUserFrom(await targetUserStatement(env, req.userId).all(), '只能为启用中的用户认领');
  const result = await claimMailboxes(env, target.id, target.role, req.items);
  if (result.claimed.length) {
    try {
      await env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
        SELECT ?1, ${ACTOR_NAME_SQL}, 'mailbox.claim', value, ?2, ?3 FROM json_each(?4)`)
        .bind(actor.id, `为 ${target.username} (#${target.id}) 认领；${tag}${auditSuffix(actor)}`, actor.ip,
          JSON.stringify(result.claimed.map((mailbox) => mailbox.address)))
        .run();
    } catch (error) {
      console.error('批量认领的审计写入失败:', error);
    }
  }
  return result;
}

/** 批量释放：与单个释放同一套写入（releaseTargets），全部可释放项一个事务；每项一行 mailbox.release */
export async function adminReleaseMailboxes(
  env: Env, actor: AuditActor, req: AdminBatchReleaseRequest, tag: string, ctx?: ExecCtx | null,
): Promise<AdminMailboxBatchResult> {
  const rows = rowsByAddress(await mailboxesByAddressStatement(env, req.items.map((item) => item.address)).all());
  const results: AdminMailboxBatchItemResult[] = [];
  const accepted: { index: number; row: BatchMailboxRow }[] = [];
  req.items.forEach((item, index) => {
    const row = rows.get(item.address);
    const failed = precheck(item, row);
    if (failed) results[index] = failed;
    else accepted.push({ index, row: row! });
  });
  if (accepted.length) {
    const outcomes = await releaseTargets(env,
      accepted.map(({ row }) => ({ id: row.id, address: row.address, ...ownerOf(row) })),
      req.deleteHistory, { actor, note: `；${tag}` }, ctx);
    for (const { index, row } of accepted) {
      results[index] = itemResult(row.address, row, 'done', { deletedMessages: 0, revokedShares: 0, ...outcomes.get(row.id) });
    }
  }
  return summarize(results);
}

/**
 * 批量过户给同一个用户，规则同单个过户：必须带 expectedOwnerId；已归目标用户的项为 unchanged，不重复记审计；
 * 目标是使用专属配置的普通用户且邮箱在系统域名上时，按其认领规则逐项累计额度（与按顺序逐个过户的结果相同）；
 * 公共配置用户、管理员与托管域名地址保留强制过户。所有权变更、旧共享撤销与 mailbox.transfer 审计同一事务。
 */
export async function adminTransferMailboxes(env: Env, actor: AuditActor, req: AdminBatchTransferRequest, tag: string): Promise<AdminMailboxBatchResult> {
  const [targetResult, rowsResult, settingsResult, ownedResult] = await env.db.batch([
    targetUserStatement(env, req.userId),
    mailboxesByAddressStatement(env, req.items.map((item) => item.address)),
    claimSettingsStatement(env.db),
    ownedCountsStatement(env.db, req.userId),
  ]);
  const target = targetUserFrom(targetResult, '只能过户给启用中的用户');
  const rows = rowsByAddress(rowsResult);
  const settings = claimSettingsFrom(settingsResult);
  // owned 随本批接受的项累加；snapshot 保留读取时的计数，供闸门比对
  const owned = ownedCountsFromResult(ownedResult);
  const snapshot = ownedCountsFromResult(ownedResult);
  const checkedDomains = new Set<string>();
  const results: AdminMailboxBatchItemResult[] = [];
  const accepted: { index: number; row: BatchMailboxRow }[] = [];
  req.items.forEach((item, index) => {
    const row = rows.get(item.address);
    if (row?.user_id === target.id) {
      results[index] = itemResult(item.address, row, 'unchanged', { revokedShares: 0 });
      return;
    }
    const failed = precheck(item, row);
    if (failed) {
      results[index] = failed;
      return;
    }
    if (!row!.hosted && target.role === 'user' && target.mailboxPolicy !== null) {
      const policy = evaluateClaimPolicy(settings, target, owned, row!.address.slice(0, row!.address.lastIndexOf('@')), row!.domain);
      if (policy.blocked) {
        results[index] = failure(item.address, row, policy.blocked.error.code, policy.blocked.error.message);
        return;
      }
      owned.total += 1;
      owned.byDomain.set(row!.domain, (owned.byDomain.get(row!.domain) ?? 0) + 1);
      checkedDomains.add(row!.domain);
    }
    accepted.push({ index, row: row! });
  });
  if (!accepted.length) return summarize(results);

  const items = JSON.stringify(accepted.map(({ row }) => ({
    id: row.id, ownerId: row.user_id, address: row.address,
    detail: `${ownerLabel(ownerOf(row))} → ${target.username} (#${target.id})；保留全部历史并撤销旧共享；${tag}`,
  })));
  const domains = JSON.stringify([...checkedDomains].map((domain) => ({ domain, n: snapshot.byDomain.get(domain) ?? 0 })));
  const [, shares] = await commit(env, [
    // 闸门：所有者未变；目标用户仍启用且角色、权限版本未变；按额度判定过的，域名版本与目标已认领数仍是读取时的值
    batchGateStatement(env, `${OWNER_CHANGED_SQL}
      UNION ALL SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ?2 AND status = 'active' AND role = ?3 AND mailbox_policy_revision = ?4)
      UNION ALL SELECT 1 WHERE json_array_length(?5) > 0 AND (
        COALESCE((SELECT json_extract(value, '$.revision') FROM settings WHERE key = 'domains'), 0) <> ?6
        OR (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?2 AND domain NOT IN (SELECT domain FROM hosted_domains)) <> ?7
        OR EXISTS (SELECT 1 FROM json_each(?5) d WHERE json_extract(d.value, '$.n')
          <> (SELECT COUNT(*) FROM mailboxes WHERE user_id = ?2 AND domain = json_extract(d.value, '$.domain'))))`,
    items, target.id, target.role, target.mailboxPolicyRevision, domains, settings.domains.revision ?? 0, snapshot.total),
    env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id IN (${IDS_SQL}) RETURNING mailbox_id`).bind(items),
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?1, ${ACTOR_NAME_SQL}, 'mailbox.transfer', json_extract(j.value, '$.address'), json_extract(j.value, '$.detail') || ?2, ?3
      FROM json_each(?4) j`).bind(actor.id, auditSuffix(actor), actor.ip, items),
    env.db.prepare(`UPDATE mailboxes SET user_id = ?2 WHERE id IN (${IDS_SQL})`).bind(items, target.id),
  ]);
  const revoked = countBy(shares?.results);
  for (const { index, row } of accepted) {
    results[index] = itemResult(row.address, row, 'done', { revokedShares: revoked.get(row.id) ?? 0 });
  }
  return summarize(results);
}

/** 共享相关的读取：邮箱、被分享人状态与这些邮箱现有的成员 */
async function loadShareContext(env: Env, addresses: readonly string[], userIds: readonly number[]) {
  const [rowsResult, granteeResult, membersResult] = await env.db.batch([
    mailboxesByAddressStatement(env, addresses),
    env.db.prepare('SELECT id, status FROM users WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(userIds)),
    env.db.prepare(`SELECT s.mailbox_id, s.user_id FROM mailbox_shares s JOIN mailboxes m ON m.id = s.mailbox_id
      WHERE m.address IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(addresses)),
  ]);
  const members = new Map<number, Set<number>>();
  for (const row of (membersResult?.results ?? []) as { mailbox_id: number; user_id: number }[]) {
    const set = members.get(Number(row.mailbox_id)) ?? new Set<number>();
    set.add(Number(row.user_id));
    members.set(Number(row.mailbox_id), set);
  }
  return { rows: rowsByAddress(rowsResult), grantees: (granteeResult?.results ?? []) as { id: number; status: UserStatus }[], members };
}

/**
 * 批量共享：把同一批用户追加到每个邮箱的名单，不移除已有成员。规则同共享：被分享人必须存在且启用（否则整批 400），
 * 所有者本人不会被加入，每只邮箱最多 MAX_MAILBOX_GRANTEES 人；成员都已在名单里的项为 unchanged。每项一行 mailbox.share。
 */
export async function adminShareMailboxes(env: Env, actor: AuditActor, req: AdminBatchShareRequest, tag: string): Promise<AdminMailboxBatchResult> {
  const userIds = [...new Set(req.userIds)];
  const { rows, grantees, members } = await loadShareContext(env, req.items.map((item) => item.address), userIds);
  if (grantees.length !== userIds.length) throw new AppError('validation_failed', '包含不存在的用户');
  if (grantees.some((grantee) => grantee.status !== 'active')) throw new AppError('validation_failed', '只能共享给启用中的用户');
  const results: AdminMailboxBatchItemResult[] = [];
  const accepted: { index: number; row: BatchMailboxRow }[] = [];
  req.items.forEach((item, index) => {
    const row = rows.get(item.address);
    const failed = precheck(item, row);
    if (failed) {
      results[index] = failed;
      return;
    }
    const current = members.get(row!.id) ?? new Set<number>();
    const adding = userIds.filter((userId) => userId !== row!.user_id && !current.has(userId));
    if (!adding.length) results[index] = itemResult(item.address, row, 'unchanged', { addedShares: 0 });
    else if (current.size + adding.length > MAX_MAILBOX_GRANTEES) {
      results[index] = failure(item.address, row, 'validation_failed', `每只邮箱最多共享给 ${MAX_MAILBOX_GRANTEES} 个用户`);
    } else accepted.push({ index, row: row! });
  });
  if (!accepted.length) return summarize(results);

  const items = JSON.stringify(accepted.map(({ row }) => ({ id: row.id, ownerId: row.user_id, address: row.address })));
  const granteeJson = JSON.stringify(userIds);
  // 本项真正要新增的成员 g：不是所有者、也不在名单里。审计写在插入之前，列出的就是本次新增的人
  const isNew = `g.value <> json_extract(j.value, '$.ownerId')
    AND NOT EXISTS (SELECT 1 FROM mailbox_shares s WHERE s.mailbox_id = json_extract(j.value, '$.id') AND s.user_id = g.value)`;
  const [, , inserted] = await commit(env, [
    batchGateStatement(env, `${OWNER_CHANGED_SQL}
      UNION ALL SELECT 1 FROM json_each(?2) g WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = g.value AND status = 'active')`,
    items, granteeJson),
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?1, ${ACTOR_NAME_SQL}, 'mailbox.share', json_extract(j.value, '$.address'),
        '追加共享 ' || (SELECT group_concat(u.username, '、') FROM json_each(?3) g JOIN users u ON u.id = g.value WHERE ${isNew}) || ?4, ?2
      FROM json_each(?5) j WHERE EXISTS (SELECT 1 FROM json_each(?3) g WHERE ${isNew})`)
      .bind(actor.id, actor.ip, granteeJson, `；${tag}${auditSuffix(actor)}`, items),
    env.db.prepare(`INSERT INTO mailbox_shares (mailbox_id, user_id, granted_by)
      SELECT json_extract(j.value, '$.id'), g.value, ?1 FROM json_each(?2) j, json_each(?3) g
      WHERE g.value <> json_extract(j.value, '$.ownerId')
      ON CONFLICT (mailbox_id, user_id) DO NOTHING RETURNING mailbox_id`).bind(actor.id, items, granteeJson),
    // 并发追加使名单超出上限时整批回滚
    batchGateStatement(env, `SELECT 1 FROM mailbox_shares WHERE mailbox_id IN (${IDS_SQL}) GROUP BY mailbox_id HAVING COUNT(*) > ?2`,
      items, MAX_MAILBOX_GRANTEES),
  ]);
  const added = countBy(inserted?.results);
  for (const { index, row } of accepted) {
    const count = added.get(row.id) ?? 0;
    results[index] = itemResult(row.address, row, count ? 'done' : 'unchanged', { addedShares: count });
  }
  return summarize(results);
}

/** 批量取消共享：从每个邮箱的名单移除这批用户；都不在名单里的项为 unchanged。每项一行 mailbox.unshare。 */
export async function adminUnshareMailboxes(env: Env, actor: AuditActor, req: AdminBatchShareRequest, tag: string): Promise<AdminMailboxBatchResult> {
  const userIds = [...new Set(req.userIds)];
  const { rows, members } = await loadShareContext(env, req.items.map((item) => item.address), userIds);
  const results: AdminMailboxBatchItemResult[] = [];
  const accepted: { index: number; row: BatchMailboxRow }[] = [];
  req.items.forEach((item, index) => {
    const row = rows.get(item.address);
    const failed = precheck(item, row);
    if (failed) results[index] = failed;
    else if (!userIds.some((userId) => members.get(row!.id)?.has(userId))) {
      results[index] = itemResult(item.address, row, 'unchanged', { revokedShares: 0 });
    } else accepted.push({ index, row: row! });
  });
  if (!accepted.length) return summarize(results);

  const items = JSON.stringify(accepted.map(({ row }) => ({ id: row.id, ownerId: row.user_id, address: row.address })));
  const granteeJson = JSON.stringify(userIds);
  // 本项名单里要移除的成员 s。审计写在删除之前，列出的就是本次实际移除的人
  const isRemoved = `s.mailbox_id = json_extract(j.value, '$.id') AND s.user_id IN (SELECT value FROM json_each(?3))`;
  const [, , removed] = await commit(env, [
    batchGateStatement(env, OWNER_CHANGED_SQL, items),
    env.db.prepare(`INSERT INTO admin_audit_logs (actor_id, actor_name, action, target, detail, ip)
      SELECT ?1, ${ACTOR_NAME_SQL}, 'mailbox.unshare', json_extract(j.value, '$.address'),
        '移除共享 ' || (SELECT group_concat(u.username, '、') FROM mailbox_shares s JOIN users u ON u.id = s.user_id WHERE ${isRemoved}) || ?4, ?2
      FROM json_each(?5) j WHERE EXISTS (SELECT 1 FROM mailbox_shares s WHERE ${isRemoved})`)
      .bind(actor.id, actor.ip, granteeJson, `；${tag}${auditSuffix(actor)}`, items),
    env.db.prepare(`DELETE FROM mailbox_shares WHERE mailbox_id IN (${IDS_SQL}) AND user_id IN (SELECT value FROM json_each(?2))
      RETURNING mailbox_id`).bind(items, granteeJson),
  ]);
  const counts = countBy(removed?.results);
  for (const { index, row } of accepted) {
    const count = counts.get(row.id) ?? 0;
    results[index] = itemResult(row.address, row, count ? 'done' : 'unchanged', { revokedShares: count });
  }
  return summarize(results);
}
