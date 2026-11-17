import {
  array, bool, changed, claimStrategy, describePaths, idempotencyHeader, int, listQuery, mutationQuery, object, operation,
  positiveId, query, ref, scopeQuery, specInfo, specificationOperation, str, uploadPaths, usedSchemas, type Paths,
} from '../openapi-common.js';

/** Public API-key contract. Session/admin operations are described separately. */
export function buildOpenApiSpec(origin: string) {
  const paths: Paths = {
    '/openapi.json': { get: specificationOperation() },
    '/status': { get: operation('Check API key access', object({ status: { type: 'string', const: 'operational' }, userId: positiveId,
      role: { type: 'string', enum: ['admin', 'user'] }, scopes: array({ type: 'string', enum: ['mail.read', 'mail.write', 'mail.send', 'mailbox.read', 'mailbox.write'] }) }),
      { description: 'Requires an active API key and enabled API. No additional scope. This confirms access, not end-to-end mail delivery. userId identifies the key owner: mailboxes in GET /mailboxes with this userId are the identities this key can send from; GET /mailboxes/shared entries cannot send. Revoked keys, including those revoked by a password change or administrator password reset, return 401 like unknown keys.' }) },
    '/domains': { get: operation('List configured domains available to this user', object({ domains: array(str) }),
      { description: 'Domains the key owner may claim new addresses on. No additional scope. Ordinary users see public domains or their dedicated mailboxPolicy domains, including explicitly granted private domains; administrators see all configured domains. Active hosted domains follow the system domains: those the key owner owns or was granted (see the session API /hosted-domains), or every active hosted domain for administrators. Claim only a returned domain. Removed domains remain usable for existing owned mailbox identities but are absent from this new-claim list.' }) },
    '/mailboxes': {
      get: operation('List owned mailboxes', array(ref('Mailbox')), { scope: 'mailbox.read', parameters: [query('all', { type: 'string', enum: ['1', 'true', '0', 'false'] }, 'Administrator-only, explicit all=1 lists every owner. Default lists caller-owned mailboxes.')] }),
      post: operation('Claim a mailbox in an existing configured domain', ref('Mailbox'), { request: 'ClaimMailboxRequest', scope: 'mailbox.write', status: 201,
        description: 'Use a domain returned by GET /domains. Does not register a domain or provision DNS. Ordinary users obey system reserved-prefix restrictions and their effective public or dedicated domain/total/per-domain quotas. Dedicated policies replace public limits. Claiming inherits all historical mail at this address. A concurrent domain or user permission change returns 409. Existing owned mailboxes remain usable after permissions tighten. Optional strategy=claude rejects any domain with a historical Claude suspension with 403 forbidden, including for administrators and hosted domains; checked atomically at insertion. Omitted or uniform preserves ordinary claims.' }),
    },
    '/mailboxes/shared': { get: operation('List inboxes shared with the caller', array(ref('SharedMailbox')), { scope: 'mailbox.read',
      description: 'Read-only inbound access. Shares do not grant send/delete/forward-notification rights. The read state of shared mail belongs to the owner: readers cannot change it, and it is excluded from their unread count and unread=1 list filter. Stars are personal.' }) },
    '/mailboxes/availability': { get: operation('Check address availability', ref('MailboxAvailability'), { scope: 'mailbox.read', parameters: [
      query('localPart', { type: 'string', minLength: 1, maxLength: 64 }, undefined, true), query('domain', str, 'Use a visible configured domain.', true), query('strategy', claimStrategy)],
      description: 'Advisory and not a reservation. Uses the same rules as claiming; when available=false, reason is taken, reserved, quota, domain_limit, domain_unavailable or claude_suspended. A subsequent claim still re-checks everything, including concurrent ownership.' }) },
    '/mailboxes/{id}': {
      put: operation('Update mailbox display name', ref('Mailbox'), { scope: 'mailbox.write', request: 'UpdateMailboxRequest' }),
      delete: operation('Release a mailbox', object({ success: bool, deletedMessages: int }), { scope: 'mailbox.write', parameters: [query('deleteHistory', { type: 'string', enum: ['1', 'true', '0', 'false'] })],
        description: 'Default retains all history and a future claimant inherits it. deleteHistory=1 atomically removes the address history and ownership. Already delivered external download links retain their promised 90-day lifetime. Owner or administrator only.' }),
    },
    '/messages': {
      get: operation('List incoming or outgoing mail', ref('MessagePage'), { scope: 'mail.read', parameters: listQuery,
        description: 'Descending cursor pagination. Use nextCursor exactly as returned; null ends the page stream. Shared inboxes only add non-trash inbound visibility. afterId supports incremental polling, but process all relevant results before advancing. unread=1 matches only caller-claimed addresses; other views still include shared inbound mail. trash=1 items include deletedAt.' }),
      post: { ...operation('Send, reply, resend or forward mail', ref('MessageSummary'), { request: 'SendMailRequest', scope: 'mail.send', status: 201, parameters: [idempotencyHeader],
        description: 'HTTP 201 can represent partial or total recipient failure: always inspect status, errorDetail and recipientOutcomes. Retry only failed recipients; preserve BCC, body and attachments explicitly. Provider-accepted sent is not proof of recipient inbox delivery. Draft attachmentTokens come from /uploads; base64 attachments are also supported. Large external attachments become signed links valid for 90 days independently of sent-mail deletion. There is no separate reply or forward endpoint (POST /messages/{id} does not exist): set replyToMessageId or forwardAttachmentsFrom here, which additionally requires mail.read (403 without it); a missing or invisible source message returns 404. Idempotency conflicts return 409 idempotency_mismatch or send_in_progress, see the Idempotency-Key header.' }),
        'x-conditional-scopes': [{ scope: 'mail.read', when: 'replyToMessageId or forwardAttachmentsFrom is present' }] },
    },
    '/messages/wait': { get: operation('Wait for the earliest new incoming message matching optional filters', object({
      message: { anyOf: [ref('MessageSummary'), { type: 'null' }] },
      scannedThroughId: { ...int, description: 'Largest id already examined: equals message.id on a match, or the last skipped non-matching id (afterId when nothing new arrived). Use it as the next afterId even after a timeout.' },
    }), { scope: 'mail.read',
      parameters: [query('address', str), query('afterId', { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 }), query('timeout', { type: 'integer', minimum: 1, maximum: 50, default: 25 }),
        query('from', { type: 'string', maxLength: 254 }, 'Sender filter, case-insensitive: a full address for an exact match, or @domain to match that exact domain suffix (subdomains are not included).'),
        query('subjectContains', { type: 'string', minLength: 1, maxLength: 200 }, 'Case-insensitive subject substring.'),
        query('hasCode', { type: 'string', enum: ['1', 'true', '0', 'false'] }, 'Only messages whose returned verificationCode is non-empty. A just-arrived message without a code is held for up to 30 seconds while asynchronous AI extraction may still fill it.'),
        ...scopeQuery],
      description: 'Returns the earliest inbound id > afterId that matches every supplied filter, skipping non-matching mail, or message:null on timeout. A new message whose attachments are still being stored (status pending) is never skipped: scanning stops before it and scannedThroughId stays below its id until a later call. Default scope is caller-owned/shared inbound; administrator may explicitly select unclaimed or user with userId. Poll every two seconds internally; maximum 120 polls per user per minute. Persist message.id (or scannedThroughId after a timeout) as the next afterId only after processing.' }) },
    '/messages/read': { post: operation('Mark selected owned messages read or unread', changed, { request: 'MarkReadRequest', scope: 'mail.write', parameters: mutationQuery,
      description: 'Changes only mail at addresses the caller owns (or unclaimed addresses with administrator scope=unclaimed). Shared mail is silently skipped; changed counts actual matches.' }) },
    '/messages/read-all': { post: operation('Mark incoming messages read, optionally narrowed by filters', changed, { scope: 'mail.write', parameters: mutationQuery, request: 'MarkAllReadRequest', requestRequired: false,
      description: 'Range is unread, non-trash inbound mail in the caller’s own claimed mailboxes (administrator scope=unclaimed: unclaimed addresses). Shared mail is never changed: its read state belongs to the owner. domain/address/q narrow it with the list search semantics. It never applies pagination.' }) },
    '/messages/delete': { post: operation('Move selected messages to trash', object({ deleted: int }), { request: 'MessageIdsRequest', scope: 'mail.write', parameters: mutationQuery,
      description: 'Soft deletion only. Restorable until permanent deletion or automatic trash cleanup after seven days. Shared readers cannot delete mail.' }) },
    '/messages/restore': { post: operation('Restore selected messages from trash', object({ restored: int, changed: int }), { request: 'MessageIdsRequest', scope: 'mail.write', parameters: mutationQuery }) },
    '/messages/purge': { post: operation('Permanently delete selected trashed messages', object({ purged: int, changed: int }), { request: 'MessageIdsRequest', scope: 'mail.write', parameters: mutationQuery,
      description: 'Irreversible metadata deletion. Cleanup persists through R2 outages. Count reflects messages actually removed; zero does not mean every requested id existed or was permitted.' }) },
    '/messages/star': { post: operation('Set per-user stars on visible messages', changed, { request: 'StarMessagesRequest', scope: 'mail.write', parameters: mutationQuery }) },
    '/messages/unread-count': { get: operation('Count unread inbox mail', object({ unread: int }), { scope: 'mail.read',
      parameters: [query('scope', { type: 'string', enum: ['mine'] }, 'Optional; only mine is accepted. Any other value, including unclaimed and user for administrators, returns 400 validation_failed.')],
      description: 'Exact count over addresses the caller claimed; no other scope is available. Shared mail is excluded because its read state belongs to the owner.' }) },
    '/messages/contacts': { get: operation('List recent contact addresses', object({ contacts: array(str) }), { scope: 'mail.read', parameters: scopeQuery }) },
    '/messages/{id}': { get: operation('Read message detail, reply targets and attachments', ref('MessageDetail'), { scope: 'mail.read', parameters: scopeQuery,
      description: 'replyTo is the preferred reply recipient list; otherwise reply to fromAddress. Attachment url values are signed download URLs valid for at least one hour, aligned to the hour; prefer GET /messages/{id}/attachments/{attId} with the API key, which does not expire. hasRaw indicates an original .eml is available. Degraded inbound mail exposes errorDetail and the original archive.' }) },
    '/messages/{id}/thread': { get: operation('Read a visible message thread', object({ items: array(ref('MessageSummary')) }), { scope: 'mail.read', parameters: scopeQuery,
      description: 'Bounded thread view built from Message-ID/In-Reply-To/References. Without linking headers it falls back to the same address and normalized subject within 30 days, only when one side has a Re:/Fwd:/Fw:/回复:/转发: prefix and neither side carries a verification code.' }) },
    '/messages/{id}/raw': { get: operation('Download the original message archive', str, { scope: 'mail.read', parameters: scopeQuery, binary: 'message/rfc822', description: 'Returns binary .eml, without a data envelope. 404 when no raw archive exists.' }) },
    '/messages/{id}/attachments/{attId}': { get: operation('Download a visible message attachment', str, { scope: 'mail.read', parameters: scopeQuery, binary: 'application/octet-stream',
      description: 'Binary bytes with a safe Content-Type/Content-Disposition, without a data envelope. Attachment must belong to message id and the message must be visible.' }) },
    ...uploadPaths('mail.send'),
  };
  return {
    openapi: '3.1.0', info: specInfo('HPC Mail Open API', 'API-key mail/mailbox automation. Bearer hpcm_ keys are distinct from JWT sessions. Keys are limited by owner, scope, expiry, IP allowlist and per-key/user/instance rates; requests already over a key or user limit do not count toward the instance limit. Users cannot create arbitrary domains. Management, notification preferences, sessions and 2FA use the related JWT API. Every response carries X-Request-ID; a client-supplied X-Request-ID is used only when it matches ^[A-Za-z0-9._:-]{1,64}$.'),
    servers: [{ url: `${origin}/v1` }], security: [{ apiKey: [] }],
    externalDocs: { description: 'Agent usage guide and authentication workflows', url: `${origin}/skill.md` },
    'x-relatedApis': [{ url: `${origin}/api/openapi.json`, description: 'JWT session and administration API' }],
    tags: [{ name: 'Mail', description: 'Mail and mailbox operations. Required scopes are listed in x-required-scopes.' }],
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'hpcm_ followed by 64 hexadecimal characters' } }, schemas: usedSchemas(paths) },
    paths: describePaths(paths),
  };
}
