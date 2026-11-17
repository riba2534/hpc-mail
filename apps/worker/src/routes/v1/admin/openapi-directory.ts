import { MAX_ADMIN_LOOKUP, userMailboxPolicySchema } from '@hpc-mail/shared';
import {
  adminKeyRule, array, bool, date, fromZod, int, nullable, object, operation, positiveId, query, ref, registerSchemas, roleEnum, str,
  userStatusEnum, type Paths,
} from '../../openapi-common.js';
import { AT } from '../../openapi-examples.js';

registerSchemas({
  AdminUserView: object({ id: positiveId, username: str, role: roleEnum, status: userStatusEnum,
    mailboxPolicy: { ...nullable(fromZod(userMailboxPolicySchema)), description: 'Dedicated mailbox quota; null means the site-wide public rules apply.' },
    mailboxPolicyRevision: int, createdAt: date }),
  AdminHostedDomainView: object({ id: positiveId, domain: str, ownerId: positiveId, ownerUsername: str,
    status: { type: 'string', description: 'pending, provisioning, active, error, moved, suspended or deleting.' },
    zoneStatus: { ...str, description: 'Cloudflare zone status from the last check (active once the nameservers took effect); empty before the first check.' },
    routingStatus: { ...str, description: 'Email Routing status from the last check; ready when receiving is set up.' },
    sendingStatus: { ...str, description: 'Email Sending status from the last check; ready when sending is set up.' },
    catchAllReady: bool,
    ready: { ...bool, description: 'Receiving and sending both work: status and zoneStatus are active, routingStatus and sendingStatus are ready, and the catch-all points to this site.' },
    createdAt: date }),
});

/** /v1/admin/users 与 /v1/admin/hosted-domains：按用户名查用户、查托管域名及其就绪状态 */
export function adminDirectoryPaths(): Paths {
  return {
    '/admin/users': { get: operation('listAdminUsers', 'Look up users by username', array(ref('AdminUserView')), { scope: 'admin',
      parameters: [query('usernames', { type: 'string', minLength: 1 }, `Comma-separated usernames, or repeat the parameter; 1–${MAX_ADMIN_LOOKUP} distinct names, case-insensitive.`, true)],
      example: [{ id: 3, username: 'alice', role: 'user', status: 'active', mailboxPolicy: null, mailboxPolicyRevision: 0, createdAt: AT }],
      description: `${adminKeyRule} Sorted by username. Usernames that do not exist are absent from the result, so compare by username to find them. One database round trip.` }) },
    '/admin/hosted-domains': { get: operation('listAdminHostedDomains', 'Look up hosted domains and whether they are ready', array(ref('AdminHostedDomainView')), { scope: 'admin',
      parameters: [
        query('domains', { type: 'string', minLength: 1 }, `Comma-separated domains, or repeat the parameter; 1–${MAX_ADMIN_LOOKUP} distinct domains.`),
        query('owner', { type: 'string', minLength: 1 }, 'Only domains owned by this username; an unknown username returns an empty array.')],
      example: [{ id: 7, domain: 'alice.dev', ownerId: 3, ownerUsername: 'alice', status: 'active', zoneStatus: 'active', routingStatus: 'ready',
        sendingStatus: 'ready', catchAllReady: true, ready: true, createdAt: AT }],
      description: `${adminKeyRule} domains and owner may be combined (both must match); without either, every hosted domain of the site is returned. Sorted by id. Domains that are not hosted here are absent. The status fields come from this site’s last Cloudflare check. One database round trip.` }) },
  };
}
