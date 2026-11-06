import { HOSTED_DOMAIN_STATUSES, MAX_BATCH_CLAIM, MAX_HOSTED_DNS_RECORDS, MAX_HOSTED_DNS_REQUESTS_PER_MINUTE } from '@hpc-mail/shared';
import {
  array, bool, changed, claimStrategy, describePaths, idempotencyHeader, int, listQuery, mutationQuery, object, okResult, operation,
  page, pageQuery, query, ref, scopeQuery, specInfo, specificationOperation, str, success, uploadPaths, usedSchemas, type Paths,
} from './openapi-common.js';
import { MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE } from '../services/hosted-dns.js';

/** Complete JWT-session contract; API keys are never accepted for these operations. */
export function buildSessionOpenApiSpec(origin: string) {
  const admin = { role: 'admin' as const };
  const oidcRedirect = (summary: string, description: string) => {
    const base = operation(summary, str, { public: true, status: 302, description });
    return { ...base, responses: { ...(base.responses as Record<string, unknown>), 302: { description: 'Redirect', headers: { Location: { schema: str } } } } };
  };
  const paths: Paths = {
    '/openapi.json': { get: specificationOperation() },
    '/config': { get: operation('Read public site configuration', ref('PublicConfig'), { public: true }) },
    '/avatar/{userId}': { get: operation('Download a public avatar', str, { public: true, binary: 'application/octet-stream', parameters: [query('v', str, 'Avatar version from avatarUrl; cache-busting value.') ] }) },
    '/auth/login': { post: operation('Sign in and create a JWT session', ref('LoginResponse'), { public: true, request: 'LoginRequest',
      description: 'If enabled, supply a six-digit TOTP or a recovery code in totp. A 401 error.code=totp_required means retry login with that code. The session token is different from an hpcm_ API key. New sessions are guarded against concurrent password/2FA changes.' }) },
    '/auth/oidc/start': { get: oidcRedirect('Start an optional OIDC login', 'Redirects to the configured OIDC provider after creating an HTTP-only state cookie.') },
    '/auth/oidc/callback': { get: oidcRedirect('Complete an OIDC provider callback', 'Validates the provider response and redirects to the login page with an encrypted handoff cookie.') },
    '/auth/oidc/exchange': { post: operation('Exchange an OIDC handoff for a session', ref('LoginResponse'), { public: true, description: 'Requires the same-origin HTTP-only handoff cookie and Origin header.' }) },
    '/auth/register': { post: operation('Register a user and create a session', ref('LoginResponse'), { public: true, request: 'RegisterRequest', status: 201,
      description: 'Subject to closed/invite/open registration policy and IP limits. Invite mode requires inviteCode.' }) },
    '/auth/me': { get: operation('Read the current session user', ref('SessionUser')) },
    '/auth/avatar': {
      post: operation('Upload a base64 avatar', ref('SessionUser'), { request: 'UploadAvatarRequest' }),
      delete: operation('Delete the current user avatar', ref('SessionUser')),
    },
    '/auth/password': { put: operation('Change password and replace the session', ref('LoginResponse'), { request: 'ChangePasswordRequest',
      description: 'Supply the current password. Changes password and credential epoch atomically, invalidates previous user JWTs, and returns a replacement JWT. Use the new token for subsequent calls.' }) },
    '/auth/2fa/setup': { post: operation('Begin TOTP enrollment', object({ secret: str, otpauthUri: str }),
      { description: 'Returns a sensitive enrollment secret and QR-compatible otpauth URI; this does not enable TOTP until /auth/2fa/enable succeeds.' }) },
    '/auth/2fa/enable': { post: operation('Verify TOTP and enable two-factor authentication', object({ recoveryCodes: array(str) }), { request: 'EnableTwoFactorRequest', status: 201,
      description: 'Supply the six-digit code for the current enrollment secret. Recovery codes are returned once; store securely. This route is available when totp_setup_required restricts other actions.' }) },
    '/auth/2fa/disable': { post: operation('Disable two-factor authentication', success, { request: 'DisableTwoFactorRequest',
      description: 'An enrolled account must supply its current password or a valid TOTP code.' }) },
    '/auth/logout': { post: operation('Revoke the current session', success) },
    '/domains': { get: operation('List configured domains visible to this user', array(str), { description: 'Returns data as an array, unlike /v1/domains data.domains. Ordinary users see public domains or the domains allowed by their dedicated mailboxPolicy. Dedicated policies replace public visibility and quotas; explicitly granted private domains are allowed. Active hosted domains follow the system domains: those the caller owns or was granted, or every active hosted domain for administrators, who may claim addresses on any user’s hosted domain. Adding/managing system domains requires administrator settings; users host their own domains with /hosted-domains; claiming an address is a separate operation.' }) },
    '/hosted-domains': {
      get: operation('List hosted domains the caller owns or was granted', array(ref('HostedDomain')), {
        description: 'Users can host their own domains on this site. Each item has role owner or member; administrators also see only their own here and use /admin/hosted-domains for all.' }),
      post: operation('Host a domain', ref('HostedDomain'), { request: 'CreateHostedDomainRequest', status: 201,
        description: 'Requires /config hostedDomainsEnabled. Enter a registered root domain (not a subdomain). The site creates a Cloudflare zone and returns status pending with the two nameServers to set at the registrar; existing DNS records at the old nameservers are not migrated automatically; recreate common records (website, verification and so on) with /hosted-domains/{id}/dns-records, preferably before changing the nameservers. Disable DNSSEC at the registrar first. After the nameservers take effect, receiving (Email Routing catch-all) and sending (Email Sending) are configured automatically; poll GET /hosted-domains/{id}. Mail to any unclaimed address on an active hosted domain is claimed for the owner on arrival. Ordinary users obey hosted_domains.maxPerUser and pending limits; domains already used on this site, system domains and zones already in the site account are rejected with 409.' }),
    },
    '/hosted-domains/{id}': {
      get: operation('Read a hosted domain and its setup progress', ref('HostedDomain'), { description: 'Owner, member or administrator; otherwise 404.' }),
      put: operation('Set the per-member claim limit', ref('HostedDomain'), { request: 'UpdateHostedDomainRequest', description: 'Owner or administrator.' }),
      delete: operation('Stop hosting and delete the domain', success, {
        description: 'Owner or administrator. Irreversible: the domain enters deleting, rejects mail immediately, then every message on the domain is permanently deleted, all its addresses are released and the Cloudflare zone is removed. Restore the original nameservers at the registrar first or the domain stops resolving.' }),
    },
    '/hosted-domains/{id}/check': { post: operation('Check the nameservers and continue setup now', ref('HostedDomain'), {
      description: 'Owner or administrator. Asks Cloudflare to re-check nameservers while pending, then advances setup. Calls within 15 seconds of the last check return the current state.' }) },
    '/hosted-domains/{id}/members': {
      get: operation('List members of a hosted domain', array(ref('HostedDomainMember')), { description: 'Owner or administrator.' }),
      put: operation('Replace the members of a hosted domain', array(ref('HostedDomainMember')), { request: 'ReplaceHostedDomainMembersRequest',
        description: 'Owner or administrator. Members may claim addresses on the domain (subject to memberLimit and reserved prefixes) and only see mail of addresses they claimed. userIds replaces the whole list; removed members keep addresses they already claimed. expectedOwnerId must be the current owner, otherwise 409. Find users with GET /mailboxes/share-users.' }),
    },
    '/hosted-domains/{id}/members/{userId}': { delete: operation('Remove a member or leave a shared domain', success, {
      description: 'Owner or administrator removes any member; a member may remove themselves. Their claimed addresses are kept.' }) },
    '/hosted-domains/{id}/dns-records': {
      get: operation('List DNS records of a hosted domain', array(ref('HostedDnsRecord')), {
        description: `Owner or administrator; members get 403, other users 404. Reads the domain’s Cloudflare zone directly and needs only the Worker’s Cloudflare credentials, not hosted_domains.enabled (403 without them). Works while pending, so records can be added before changing the nameservers, and while suspended. Deleting domains return 409, as do domains still being created. Sorted by name (@ first), type and content, including kind=mail records used for receiving and sending and kind=readonly records this site cannot edit. All four DNS endpoints share a limit of ${MAX_HOSTED_DNS_REQUESTS_PER_MINUTE} requests per user per minute, administrators included. Because every hosted domain uses the site’s Cloudflare token, this feature is also limited to ${MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE} Cloudflare calls per minute across the whole site: listing costs 1, adding, updating and deleting cost 2 each, and only requests that can reach Cloudflare count (not those over the per-user limit, or rejected for permission or domain status). Either limit returns 429 rate_limited.` }),
      post: operation('Add a DNS record to a hosted domain', ref('HostedDnsRecord'), { request: 'HostedDnsRecordInput', status: 201,
        description: `Owner or administrator; on suspended domains only administrators may write (403). DNS only: A, AAAA and CNAME are created with proxied=false. Records that would conflict with mail are rejected with 400 before Cloudflare is called: root MX, root SPF TXT, any record at _dmarc, _domainkey, *._domainkey, cf-bounce or *.cf-bounce, and a CNAME at the root. At most ${MAX_HOSTED_DNS_RECORDS} non-mail records per domain (403). Cloudflare rejecting the value returns 400; an existing record that cannot coexist with the same name returns 409.` }),
    },
    '/hosted-domains/{id}/dns-records/{recordId}': {
      put: operation('Update a DNS record of a hosted domain', ref('HostedDnsRecord'), { request: 'HostedDnsRecordInput',
        description: 'Owner or administrator, same domain status rules as adding. Only kind=user records can be changed; mail and readonly records return 403 with their lockedReason. type must equal the existing record type (400; delete and re-add instead). The new name and value follow the same mail-conflict rules as adding. An unknown or malformed recordId returns 404.' }),
      delete: operation('Delete a DNS record of a hosted domain', success, {
        description: 'Owner or administrator, same domain status rules as adding. Only kind=user records can be deleted; mail and readonly records return 403. An unknown or malformed recordId returns 404.' }),
    },
    '/hosted-domains/{id}/transfer': { post: operation('Transfer a hosted domain to another user', ref('HostedDomainTransferResult'), { request: 'TransferHostedDomainRequest',
      description: 'Owner or administrator. The target must be an active user; ordinary owners are limited by the target’s hosted_domains.maxPerUser. includeMailboxes moves the previous owner’s addresses on the domain with all history and revokes their mailbox shares. Members are kept. A stale expectedOwnerId returns 409; retrying a completed transfer returns transferred=false.' }) },
    '/mailboxes': {
      get: operation('List caller-owned mailboxes', array(ref('Mailbox')), { parameters: [query('all', { type: 'string', enum: ['1', 'true', '0', 'false'] }, 'Administrator all=1 or true includes all owners; ordinary users cannot request this range.')] }),
      post: operation('Claim an address on a configured domain', ref('Mailbox'), { request: 'ClaimMailboxRequest', status: 201,
        description: 'Claim only a domain returned by /domains. Existing history at the address becomes visible to the claimant. Ordinary users obey their effective public or dedicated domain/global/per-domain quotas and system reserved-prefix restrictions. Dedicated policies do not revoke existing owned mailboxes. Does not provision a domain or Email Routing. Optional strategy=claude rejects any historical Claude suspension with 403 forbidden, including for administrators and hosted domains; checked atomically at insertion. Omitted or uniform preserves ordinary claims.' }),
    },
    '/mailboxes/shared': { get: operation('List inboxes shared with the caller', array(ref('SharedMailbox')), { description: 'Read-only inbound access; no sending, deletion or owner notifications. The read state of shared mail belongs to the owner: readers cannot change it, and it is excluded from their unread count and unread=1 list filter. Stars are personal.' }) },
    '/mailboxes/shares': {
      get: operation('List grants on caller-owned mailboxes', array(ref('MailboxShareGrant'))),
      put: operation('Replace grants on a caller-owned mailbox', ref('MailboxShareGrant'), { request: 'ReplaceMailboxSharesRequest',
        description: 'Owner JWT only; cannot manage another owner through this endpoint, even as an administrator. userIds replaces the entire list; [] revokes all. At most 100 unique active users, including administrators, excluding the mailbox owner. expectedOwnerId is optional and returns 409 if ownership changed. Shares grant only existing and future non-deleted inbound mail; no send/delete/read-state/notification rights. Use administrator endpoints to manage any owner.' }),
    },
    '/mailboxes/shares/batch': { post: operation('Add the same grantees to several caller-owned mailboxes', array(ref('MailboxShareGrant')), { request: 'BatchShareMailboxesRequest',
      description: 'Owner JWT only; every mailboxId must be owned by the caller, even for administrators, otherwise 403 and nothing is written. Appends: each userId is added to every mailbox, existing grantees keep their grantedAt, and nobody is removed, so retries are idempotent. Duplicate ids are ignored. userIds must be existing active users or administrators other than the caller; each mailbox may end with at most 100 grantees. All or nothing: every error leaves all mailboxes unchanged. 400 covers the caller in userIds, missing or disabled users, and a mailbox that would exceed 100 grantees after the append. Ownership, recipient status and the limit are rechecked in the same transaction as the write; 409 means state changed after validation, for example a mailbox was transferred or released, a recipient was disabled or deleted, or concurrent writes pushed a mailbox past 100 grantees. Concurrent grants or replacements by themselves are not rejected: they are merged in order, skipping grantees already present. Returns each mailbox’s full list as of this write, in the order of the deduplicated mailboxIds; a repeated id appears once. Use PUT /mailboxes/shares to replace or shrink a list.' }) },
    '/mailboxes/shares/{mailboxId}/grantees/{userId}': { delete: operation('Revoke one grantee on a caller-owned mailbox', success) },
    '/mailboxes/share-users': { get: operation('Search active users for mailbox sharing', ref('UserSearchResults'), {
      parameters: [query('q', { type: 'string', minLength: 1, maxLength: 32 }, 'Required username substring; trimmed and case-insensitive.', true),
        query('excludeUserId', { type: 'integer', minimum: 1 }, 'Exclude the mailbox owner.'),
        query('limit', { type: 'integer', minimum: 1, maximum: 20, default: 20 })],
      description: 'JWT only. Returns only id, username and role for active candidates; no account details or mailbox lists. hasMore means refine the search.'
    }) },
    '/mailboxes/batch': { post: operation('Claim several addresses in order', ref('BatchClaimMailboxResult'), { request: 'BatchMailboxRequest',
      description: 'Same rules as POST /mailboxes, applied to each item in request order. Each item accepts optional strategy; claude rechecks current suspension facts inside the write transaction and stops with forbidden when a domain has any historical suspension. An already-claimed address is skipped into taken and the batch continues; any other error stops the batch, keeps the addresses already claimed and reports stoppedBy with the remaining items in notAttempted.' }) },
    '/mailboxes/availability/batch': { post: operation('Check availability of several addresses', array(ref('MailboxAvailability')), { request: 'BatchMailboxRequest',
      description: 'Advisory only, same rules as GET /mailboxes/availability. Results follow request order.' }) },
    '/mailboxes/random-plan': { get: operation('Allocate random suffixes for a batch claim', ref('ClaimPlan'), {
      parameters: [query('count', { type: 'integer', minimum: 1, maximum: MAX_BATCH_CLAIM }, 'Number of addresses to allocate.', true),
        query('strategy', { type: 'string', enum: ['uniform', 'claude'] }, 'uniform: equal chance among eligible domains; claude: only zero-suspension domains, balanced by Claude accounts plus pending claims.', true)],
      description: 'JWT only. Read-only: allocates domains, does not claim or reserve. Candidates are the domains the caller may claim with domains.list[].random true, trimmed by per-domain and per-user remaining quota. The claude strategy excludes every domain with any historical Claude suspension from both items and pool, regardless of paid status or deprecated thresholds. It balances accounts plus recent pending claims and stops at claim_random.dailyLimit or claim quotas without spilling over to suspended domains. Generate prefixes, then pass strategy=claude on each item for availability and actual claims, including after manual suffix changes. Claims atomically recheck suspension facts; a plan does not reserve eligibility.' }) },
    '/mailboxes/availability': { get: operation('Check mailbox availability', ref('MailboxAvailability'), { parameters: [query('localPart', str, undefined, true), query('domain', str, undefined, true), query('strategy', claimStrategy)],
      description: 'Advisory only, not a reservation. Same rules as claiming; when available=false, reason is taken, reserved, quota, domain_limit, domain_unavailable or claude_suspended. Claim still re-checks everything.' }) },
    '/mailboxes/{id}': {
      put: operation('Set mailbox display name', ref('Mailbox'), { request: 'UpdateMailboxRequest', description: 'Mailbox owner or administrator only.' }),
      delete: operation('Release mailbox ownership', object({ success: bool, deletedMessages: int }), { parameters: [query('deleteHistory', { type: 'string', enum: ['1', 'true', '0', 'false'] })],
        description: 'Default retains all address history for the next claimant. deleteHistory=1 atomically removes all existing address mail and ownership. Owner or administrator only. Previously delivered external links retain their promised 90-day validity.' }),
    },
    '/messages': { get: operation('List mail with cursor pagination', ref('SessionMessagePage'), { parameters: listQuery, description: 'unread=1 matches only caller-claimed addresses; other views still include shared inbound mail. trash=1 items include deletedAt. Inbound summaries carry verificationLink (empty when none was detected).' }) },
    '/messages/sync': { get: operation('Poll unread count and first-page fingerprint', ref('MessageSync'), { parameters: listQuery,
      description: 'Lightweight polling for the list view: accepts the same filters as GET /messages (cursor and afterId are ignored). Refetch the list only when head differs from the head returned with its first page.' }) },
    '/messages/send': { post: operation('Send, reply, resend or forward mail', ref('MessageSummary'), { request: 'SendMailRequest', status: 201, parameters: [idempotencyHeader],
      description: 'HTTP 201 may contain partial or total delivery failure. Inspect status/errorDetail/recipientOutcomes; retry only failed recipients. sent means provider acceptance, not confirmed destination-inbox delivery. Use base64 attachments or draft attachmentTokens; source forwarding attachments count toward the total. Large external attachments become independent 90-day signed links.' }) },
    '/messages/read': { post: operation('Mark selected owned messages read/unread', changed, { request: 'MarkReadRequest', parameters: mutationQuery,
      description: 'Changes only mail at addresses the caller owns (or unclaimed addresses with administrator scope=unclaimed). Shared mail is silently skipped; changed counts actual matches.' }) },
    '/messages/read-all': { post: operation('Mark incoming messages read, optionally narrowed by filters', changed, { parameters: mutationQuery, request: 'MarkAllReadRequest', requestRequired: false,
      description: 'Range is unread, non-trash inbound mail in the caller’s own claimed mailboxes (administrator scope=unclaimed: unclaimed addresses). Shared mail is never changed: its read state belongs to the owner. domain/address/q narrow it with the list search semantics. It never applies pagination.' }) },
    '/messages/delete': { post: operation('Move selected messages to trash', object({ deleted: int }), { request: 'MessageIdsRequest', parameters: mutationQuery,
      description: 'Soft deletion. Restore before permanent deletion or the seven-day trash cleanup. Shared readers cannot delete mail.' }) },
    '/messages/restore': { post: operation('Restore selected trashed messages', object({ restored: int, changed: int }), { request: 'MessageIdsRequest', parameters: mutationQuery }) },
    '/messages/purge': { post: operation('Permanently delete selected trashed messages', object({ purged: int, changed: int }), { request: 'MessageIdsRequest', parameters: mutationQuery,
      description: 'Irreversible metadata removal. R2 cleanup failures are retried durably. Count reflects actual permitted deletions, not the input id count.' }) },
    '/messages/star': { post: operation('Set per-user stars', changed, { request: 'StarMessagesRequest', parameters: mutationQuery }) },
    '/messages/unread-count': { get: operation('Count unread inbox messages', object({ unread: int }), {
      description: 'Counts only addresses the caller claimed. Shared mail is excluded because its read state belongs to the owner. Counting stops at 1000 (1000 means at least 1000); /v1/messages/unread-count returns the exact value.' }) },
    '/messages/contacts': { get: operation('Read recent contact addresses', object({ contacts: array(str) }), { parameters: scopeQuery }) },
    '/messages/{id}': { get: operation('Read full message detail', ref('MessageDetail'), { parameters: scopeQuery,
      description: 'replyTo supplies preferred reply targets; fall back to fromAddress. Attachment URLs are short-lived signed URLs. Degraded mail has errorDetail; hasRaw reports archive availability.' }) },
    '/messages/{id}/thread': { get: operation('Read a visible thread', object({ items: array(ref('MessageSummary')) }), { parameters: scopeQuery,
      description: 'Bounded thread view built from Message-ID/In-Reply-To/References. Without linking headers it falls back to the same address and normalized subject within 30 days, only when one side has a Re:/Fwd:/Fw:/回复:/转发: prefix and neither side carries a verification code.' }) },
    '/messages/{id}/translate': { post: operation('Translate text segments of a visible message to Simplified Chinese', ref('MessageTranslation'), { request: 'TranslateMessageRequest', parameters: scopeQuery,
      description: 'JWT only; there is no /v1 equivalent. Returns 403 forbidden unless an administrator enabled translation and configured ai_model (see /config translationEnabled). Same visibility and scope/userId validation as message detail. Each segment is trimmed and whitespace-folded; only segments found in this message subject or full body (matching compares only letters and digits, ignoring HTML tags, entities, punctuation, whitespace and case) are sent to the configured external model, others are returned unchanged and counted in skipped. Segments without letters after removing URLs and email addresses (numbers, codes, punctuation) are returned unchanged and not billed. Identical segments are sent once. Results are cached per message and segment set: cached=true does not use quota. Each user has a daily character quota (settings.translation.dailyCharsPerUser, 0 unlimited; administrators included) and at most 30 model-calling requests per minute; exceeding either returns 429 rate_limited without consuming quota. A provider failure returns 500 and refunds the characters. Cached translations are deleted with the message.' }) },
    '/messages/{id}/raw': { get: operation('Download the original .eml', str, { binary: 'message/rfc822', parameters: scopeQuery,
      description: 'Binary response without a data envelope; 404 when the message has no original archive.' }) },
    '/attachments/{id}': { get: operation('Download an attachment by session or signed URL', str, { binary: 'application/octet-stream',
      parameters: [query('exp', { type: 'integer' }, 'Signed expiry, required together with sig for anonymous downloads.'), query('sig', str, 'HMAC signature; obtain the complete URL from message detail or an external email.')],
      security: [{ sessionToken: [] }, { attachmentSignature: [], attachmentExpiry: [] }],
      description: 'JWT mode enforces visibility. Signed mode requires both exp and sig and may serve retained external links after sent-mail deletion. Returns binary bytes with safe MIME/download headers.' }) },
    ...uploadPaths(),
    '/me/notify-prefs': {
      get: operation('Read masked personal notification and forwarding preferences', ref('NotifyPrefs')),
      put: operation('Update personal notification and forwarding preferences', ref('NotifyPrefs'), { request: 'UpdateNotifyPrefsRequest',
        description: 'At least one channel. ****** preserves stored secrets; explicit empty strings clear them. Enabled channels require complete valid configuration. Webhook is HPC Mail JSON ({event:"mail.received",message:{id,address,fromAddress,fromName,subject,verificationCode,verificationLink,preview,createdAt}}), not a native Bark/ntfy request. Email forwarding includes rate limits; shared readers never receive owner notifications.' }),
    },
    '/me/notify-prefs/health': { get: operation('Read personal recent delivery health and forwarding quotas', ref('NotificationHealth'),
      { description: 'Current user only. pending/processing are queued; unknown means a result was not confirmed and must be checked before manual retry. Forward counts are attempts, and reset at UTC midnight. No message bodies or raw endpoint secrets are returned.' }) },
    '/me/notify-prefs/jobs/{id}/retry': { post: operation('Explicitly retry a failed or unknown personal notification', okResult,
      { description: 'Owner-only failed/unknown mail notification jobs. Check actual receipt before retrying unknown results to avoid a duplicate. Forward/test records cannot use this endpoint. The selected channel must be enabled. Webhook has no automatic retry; this action is explicit.' }) },
    '/me/notify-prefs/feishu-test': { post: operation('Send a real Feishu test with saved settings', okResult, { description: 'Performs an external notification and records its validated result. Failed delivery returns an error; this is not a dry run.' }) },
    '/me/notify-prefs/pushdeer-test': { post: operation('Send a real PushDeer test with saved settings', okResult, { description: 'Performs an external notification and validates HTTP and provider JSON success. This is not a dry run.' }) },
    '/api-keys': {
      get: operation('List own API keys without plaintext secrets', array(ref('ApiKeySummary'))),
      post: operation('Create an API key', ref('CreatedApiKey'), { request: 'CreateApiKeyRequest', status: 201,
        description: 'The full key is returned only once. Scopes limit /v1 operations, never grant administrator/JWT-only permissions, and are additionally bounded by the owner role and mailbox visibility.' }),
    },
    '/api-keys/{id}': {
      get: operation('Read own API key metadata', ref('ApiKeySummary')),
      put: operation('Update own API key limits/scopes/status', ref('ApiKeySummary'), { request: 'UpdateApiKeyRequest' }),
      delete: operation('Revoke own API key', success),
    },
    '/api-keys/{id}/logs': { get: operation('Read own API key audit logs', page(ref('ApiRequestLog')), { parameters: pageQuery }) },
    '/admin/users': {
      get: operation('List users', array(ref('AdminUser')), admin),
      post: operation('Create a user', ref('AdminUser'), { ...admin, request: 'CreateUserRequest', status: 201 }),
    },
    '/admin/users/search': { get: operation('Search active users for mailbox transfer', ref('UserSearchResults'), {
      ...admin, parameters: [query('q', { type: 'string', minLength: 1, maxLength: 32 }, 'Required username substring, trimmed and case-insensitive; % and _ are literal characters.', true),
        query('excludeUserId', { type: 'integer', minimum: 1 }, 'Exclude the mailbox current owner.'),
        query('limit', { type: 'integer', minimum: 1, maximum: 20, default: 20 })],
      description: 'Returns only active users with id, username and role. Exact matches are ranked first, then prefixes, then other substring matches. hasMore means refine q to narrow the results. This endpoint avoids returning all account details and mailbox lists.'
    }) },
    '/admin/users/{id}': {
      put: operation('Change user role/status/password or mailbox policy', ref('AdminUser'), { ...admin, request: 'UpdateUserRequest',
        description: 'At least one field. Cannot disable self or remove the last active administrator. Password reset/disable revokes prior JWT epochs. Role changes preserve mailbox shares. mailboxPolicy=null restores public rules; a dedicated policy contains perUserLimit and domains:[{domain,perUserLimit}], with 0 meaning unlimited and an empty domain list blocking new claims. Only configured system domains may be granted, including private ones. Changing mailboxPolicy requires expectedMailboxPolicyRevision from GET /admin/users; a stale revision returns 409. Existing mailboxes retain read/send access and count toward quotas. Administrators are exempt. Role changes also increment mailboxPolicyRevision.' }),
      delete: operation('Delete a user', success, { ...admin, description: 'Cannot delete self or last active administrator. Releases owned mailboxes and revokes keys/shares; message history remains address-owned and may be inherited by later claimants.' }),
    },
    '/admin/mailboxes/{id}': { get: operation('Read any claimed mailbox', ref('Mailbox'), { ...admin,
      description: 'Administrator JWT only. Includes ownerUsername and messageCount; 404 when the mailbox does not exist.' }) },
    '/admin/mailboxes/{id}/transfer': { post: operation('Transfer any existing mailbox to an active user', ref('MailboxTransferResult'), {
      ...admin, request: 'TransferMailboxRequest', description: 'Administrator JWT only. userId is the target owner; expectedOwnerId comes from GET /mailboxes?all=1. Transfers an existing mailbox directly, including another user’s mailbox. For ordinary users with a dedicated mailboxPolicy, obeys configured-domain visibility, reserved-prefix restrictions and dedicated total/per-domain quotas; violations return 400/403. Users inheriting public rules and administrators retain the force-transfer exemption. Quotas and target permission/domain revisions are rechecked atomically; concurrent changes can return 409. Preserves mailbox id, address, display name and all message/attachment history. Atomically changes ownership, revokes all old shares and records mailbox.transfer audit. A stale owner returns 409, unless the mailbox already belongs to the target: that retry returns transferred=false and does not revoke new shares. Disabled/missing users cannot receive a mailbox. Future mail uses the new owner’s notification preferences; existing receipt-time snapshots/jobs remain unchanged.'
    }) },
    '/admin/settings': {
      get: operation('Read current settings and domain revision', ref('Settings'), admin),
      put: operation('Update validated settings with domain conflict protection', ref('Settings'), { ...admin, request: 'UpdateSettingsRequest',
        description: 'Use expectedDomainsRevision from the latest GET when replacing domains. A stale revision returns 409. Domain changes control new claims; DNS/catch-all setup is external and existing owned mailbox routing persists. ai_model.apiKey is write-only: responses show ****** when configured and submitting ****** keeps the stored key. Enabling translation requires a configured ai_model, checked against the merged result when both are submitted; code_extract.aiEnabled may stay on without a model (regex only).' }),
    },
    '/admin/settings/ai-model-test': { post: operation('Test the AI model with a fixed translation sample', ref('AiModelTestResult'), { ...admin, request: 'AiModelTestRequest', requestRequired: false,
      description: 'Performs one real Chat Completions call, in the translation JSON format, with the sample "Your verification code is 123456. It expires in 10 minutes." Omitted or empty fields, and apiKey ******, use the saved settings.ai_model values; no feature needs to be enabled, so a model can be tested before saving it. Missing baseUrl/apiKey/model after resolution returns 400. A provider failure returns 500 with the HTTP status, timeout or invalid-response reason; the key is never echoed. Does not consume user translation quota.' }) },
    '/admin/settings/domain-claude-stats': { get: operation('Per-domain Claude account statistics', array(ref('DomainClaudeStats')), { ...admin,
      description: 'One item per configured domain, in list order. Judged from official Claude/Anthropic mail by MIME From and subject; senders are not DKIM-verified. Facts are kept after mail is deleted and are refreshed every 5 minutes.' }) },
    '/admin/settings/domain-status': { get: operation('Check public domain DNS onboarding', ref('DomainStatus'), { ...admin, parameters: [query('domain', str, undefined, true)],
      description: 'Checks MX/SPF via public DNS. Cannot prove the private Cloudflare catch-all target or end-to-end email delivery.' }) },
    '/admin/hosted-domains': { get: operation('List all hosted domains', array(ref('HostedDomain')), { ...admin,
      parameters: [query('status', { type: 'string', enum: HOSTED_DOMAIN_STATUSES }), query('q', { type: 'string', maxLength: 253 }, 'Domain or owner username substring.')],
      description: 'Administrators manage details, members, transfer and deletion through /hosted-domains/{id} with full rights.' }) },
    '/admin/hosted-domains/health': { get: operation('Check hosted domain prerequisites', ref('HostedDomainsHealth'), { ...admin,
      description: 'Whether the Worker has Cloudflare credentials, whether the token verifies, and the account zone counts. Cloudflare blocks new zones when an account has more than 50 zones and more pending than active ones.' }) },
    '/admin/hosted-domains/{id}/suspend': { post: operation('Suspend a hosted domain', ref('HostedDomain'), { ...admin,
      description: 'Rejects incoming mail, blocks sending and new claims. Addresses and history are kept.' }) },
    '/admin/hosted-domains/{id}/resume': { post: operation('Resume a suspended hosted domain', ref('HostedDomain'), { ...admin,
      description: 'Re-checks Cloudflare immediately and returns to the matching state.' }) },
    '/admin/mailbox-shares': {
      get: operation('List grants on all claimed mailboxes', array(ref('MailboxShareGrant')), { ...admin,
        parameters: [query('mailboxId', { type: 'integer', minimum: 1 }, 'Only this mailbox (at most one item).')] }),
      put: operation('Replace grants on any claimed mailbox', ref('MailboxShareGrant'), { ...admin, request: 'ReplaceMailboxSharesRequest',
        description: 'Administrator JWT can share any claimed mailbox, including other users’ mailboxes, with any active user or administrator except the owner. Empty userIds revokes all shares. At most 100 grantees. expectedOwnerId optionally detects stale ownership with 409. The write also rechecks ownership and recipient status atomically. Owner metadata and grantee status are returned. Grants are read-only incoming mail; owner disable hides shares, role changes preserve them, and release/transfer/deletion revoke them.' }),
    },
    '/admin/mailbox-shares/{mailboxId}/grantees/{userId}': { delete: operation('Revoke one mailbox grantee', success, admin) },
    '/admin/invites': {
      get: operation('List invitation codes and use history', array(ref('Invite')), admin),
      post: operation('Create invitation codes', array(ref('Invite')), { ...admin, request: 'CreateInviteRequest', status: 201 }),
    },
    '/admin/invites/{id}': { delete: operation('Revoke an invitation code', success, admin) },
    '/admin/api-keys': { get: operation('List all API key metadata with owners', array(ref('ApiKeySummary')), admin) },
    '/admin/api-keys/{id}': {
      get: operation('Read any API key metadata', ref('ApiKeySummary'), admin),
      delete: operation('Revoke any API key', success, admin),
    },
    '/admin/api-keys/{id}/logs': { get: operation('Read any API key audit logs', page(ref('ApiRequestLog')), { ...admin, parameters: pageQuery }) },
    '/admin/audit-logs': { get: operation('Read administrator audit logs', page(ref('AdminAuditLog')), { ...admin, parameters: pageQuery }) },
  };
  return { openapi: '3.1.0', info: specInfo('HPC Mail Session and Administration API',
    'JWT session API for all web-client functions. Authorization: Bearer <JWT> from login/register. hpcm_ API keys cannot authenticate these routes; see the related /v1 specification. Administrator endpoints require an active admin role. If site policy requires 2FA, un-enrolled sessions receive 403 totp_setup_required; /auth/me, logout and /auth/2fa routes remain available to complete setup.'),
    servers: [{ url: `${origin}/api` }], security: [{ sessionToken: [] }],
    externalDocs: { description: 'Agent usage guide and workflows', url: `${origin}/skill.md` },
    'x-relatedApis': [{ url: `${origin}/v1/openapi.json`, description: 'Scoped API-key mail/mailbox automation' }],
    tags: [{ name: 'Mail', description: 'Session, mail, mailbox and personal preferences' }, { name: 'Administration', description: 'Administrator role required; no API-key scopes grant this role.' }],
    components: { securitySchemes: {
      sessionToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      attachmentSignature: { type: 'apiKey', in: 'query', name: 'sig' }, attachmentExpiry: { type: 'apiKey', in: 'query', name: 'exp' },
    }, schemas: usedSchemas(paths) }, paths: describePaths(paths, 'jwt_'),
  };
}
