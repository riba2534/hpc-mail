import {
  MAX_ADMIN_LOOKUP, MAX_ADMIN_MAILBOX_BATCH, MAX_MAILBOX_GRANTEES, adminBatchReplaceSharesRequestSchema, adminClaimAndShareRequestSchema,
} from '@hpc-mail/shared';
import {
  adminKeyRule, array, date, domainName, fromZod, nullable, object, operation, positiveId, query, ref, registerSchemas, schemas, str,
  type Paths, type Schema,
} from '../../openapi-common.js';
import { AT, SCHEMA_EXAMPLES } from '../../openapi-examples.js';

registerSchemas({
  AdminClaimAndShareRequest: fromZod(adminClaimAndShareRequestSchema),
  AdminClaimAndShareResult: object({
    ...(schemas.BatchClaimMailboxResult!.properties as Record<string, Schema>),
    shares: { ...nullable(ref('AdminMailboxBatchResult')),
      description: 'Results of sharing the claimed mailboxes with shareUserIds, in the order of claimed (addresses in taken are not shared). null when shareUserIds is omitted or empty.' },
  }),
  AdminBatchReplaceSharesRequest: fromZod(adminBatchReplaceSharesRequestSchema),
  AdminMailboxView: object({ id: positiveId, address: str, domain: str, ownerId: positiveId, ownerUsername: str,
    grantees: { ...array(object({ userId: positiveId, username: str })), description: 'Users the mailbox is shared with, sorted by username.' },
    createdAt: date }),
});

const sameAs = (path: string) => `${adminKeyRule} Same rules, transaction and per-item results as the session API POST /api${path}; the administration audit rows are the same, with the detail ending in （API Key #id）.`;
const batchLimit = `At most ${MAX_ADMIN_MAILBOX_BATCH} items with distinct addresses (case-insensitive), otherwise 400 for the whole batch.`;

const claimed = SCHEMA_EXAMPLES.Mailbox as Record<string, unknown>;
const view = { id: 12, address: 'alice@example.org', domain: 'example.org', ownerId: 3, ownerUsername: 'alice',
  grantees: [{ userId: 4, username: 'bob' }], createdAt: AT };

/** /v1/admin/mailboxes：按地址或域名查询、批量认领（可同时共享）、释放、过户、共享与替换共享名单 */
export function adminMailboxPaths(): Paths {
  return {
    '/admin/mailboxes': { get: operation('listAdminMailboxes', 'Look up claimed mailboxes by address or domain', array(ref('AdminMailboxView')), { scope: 'admin',
      parameters: [
        query('addresses', { type: 'string', minLength: 1 }, `Comma-separated full addresses, or repeat the parameter; 1–${MAX_ADMIN_LOOKUP} distinct addresses.`),
        query('domain', domainName, 'Every claimed mailbox on this domain.')],
      example: [view],
      description: `${adminKeyRule} Give exactly one of addresses or domain (400 otherwise). Returns claimed mailboxes with owner and share members, sorted by address; unclaimed addresses are absent, so compare by address to find them. domain returns every claimed mailbox of that domain without paging. One database round trip.` }) },
    '/admin/mailboxes/batch/claim': { post: operation('claimMailboxesForUser', 'Claim several addresses for a user and optionally share them', ref('AdminClaimAndShareResult'), { scope: 'admin',
      request: 'AdminClaimAndShareRequest', errors: ['NotFoundTargetUser', 'GranteeMissing'],
      example: { ...(SCHEMA_EXAMPLES.BatchClaimMailboxResult as Record<string, unknown>),
        shares: { results: [{ address: claimed.address, status: 'done', mailboxId: claimed.id, ownerId: claimed.userId, error: null, addedShares: 1 }], done: 1, unchanged: 0, failed: 0 } },
      description: `${sameAs('/admin/mailboxes/batch/claim')} At most ${MAX_ADMIN_MAILBOX_BATCH} items. Claims for userId under that user’s own claim rules, in order: already-claimed addresses go to taken, the first other error stops the batch and keeps what was claimed. Optional shareUserIds (at most ${MAX_MAILBOX_GRANTEES}) then appends those users to the share list of every address claimed by this request, with the rules of POST /admin/mailboxes/batch/share (the owner is never added); shares holds those per-item results and is null without shareUserIds. shareUserIds is checked before claiming: a missing, disabled or system-reserved user returns 400 and claims nothing. If sharing fails as a whole after the claims were committed (for example 409 because a user was disabled meanwhile), the claims are kept and every claimed address is reported in shares as failed with that error; retry those with POST /admin/mailboxes/batch/share. 404 when userId does not exist; 400 when that user is disabled.` }) },
    '/admin/mailboxes/batch/release': { post: operation('releaseMailboxes', 'Release several mailboxes', ref('AdminMailboxBatchResult'), { scope: 'admin',
      request: 'AdminBatchReleaseRequest', errors: ['BatchStateChanged'],
      description: `${sameAs('/admin/mailboxes/batch/release')} ${batchLimit} Releases each mailbox and revokes its shares; deleteHistory=true also permanently deletes the history of those addresses. Items that do not exist (not_found) or whose owner differs from expectedOwnerId (conflict) fail alone; if ownership changes before commit, nothing is written and the response is 409.` }) },
    '/admin/mailboxes/batch/transfer': { post: operation('transferMailboxes', 'Transfer several mailboxes to one user', ref('AdminMailboxBatchResult'), { scope: 'admin',
      request: 'AdminBatchTransferRequest', errors: ['NotFoundTargetUser', 'BatchStateChanged'],
      description: `${sameAs('/admin/mailboxes/batch/transfer')} ${batchLimit} Every item needs expectedOwnerId. History is kept and old shares are revoked; items already owned by userId are unchanged. 404 when userId does not exist; 400 when that user is disabled; 409 when state changes before commit.` }) },
    '/admin/mailboxes/batch/share': { post: operation('shareMailboxesAsAdmin', 'Share several mailboxes with the same users', ref('AdminMailboxBatchResult'), { scope: 'admin',
      request: 'AdminBatchShareRequest', errors: ['GranteeMissing', 'BatchStateChanged'],
      description: `${sameAs('/admin/mailboxes/batch/share')} ${batchLimit} Appends userIds without removing anyone; the owner is never added and each mailbox keeps at most ${MAX_MAILBOX_GRANTEES} grantees. Every userId must be an existing, active, non-reserved user (otherwise 400 for the whole batch).` }) },
    '/admin/mailboxes/batch/unshare': { post: operation('unshareMailboxes', 'Remove the same users from several mailboxes', ref('AdminMailboxBatchResult'), { scope: 'admin',
      request: 'AdminBatchShareRequest', errors: ['BatchStateChanged'],
      description: `${sameAs('/admin/mailboxes/batch/unshare')} ${batchLimit} Items where none of userIds were listed are unchanged.` }) },
    '/admin/mailboxes/shares': { put: operation('replaceMailboxSharesAsAdmin', 'Replace the share list of several mailboxes', ref('AdminMailboxBatchResult'), { scope: 'admin',
      request: 'AdminBatchReplaceSharesRequest', errors: ['GranteeMissing', 'BatchStateChanged'],
      example: { results: [{ address: 'alice@example.org', status: 'done', mailboxId: 12, ownerId: 3, error: null, addedShares: 1, revokedShares: 2 },
        { address: 'team@example.org', status: 'unchanged', mailboxId: 14, ownerId: 4, error: null, addedShares: 0, revokedShares: 0 }], done: 1, unchanged: 1, failed: 0 },
      description: `${adminKeyRule} ${batchLimit} Sets each mailbox’s share list to exactly userIds (at most ${MAX_MAILBOX_GRANTEES}); an empty array removes everyone. Every userId must be an existing, active, non-reserved user, otherwise 400 for the whole batch. Per item: not_found when the mailbox does not exist, conflict when the owner differs from expectedOwnerId, validation_failed when userIds contains that mailbox’s owner; items already matching userIds are unchanged; done items report addedShares and revokedShares. The rest commit in one transaction; if an owner or a user’s status changes before commit, nothing is written and the response is 409. Audit: one mailbox.unshare row listing removed users and one mailbox.share row listing added users per changed mailbox, the detail ending in （API Key #id）.` }) },
  };
}
