import {
  API_SCOPES, ERROR_CODES, MAX_BODY_BYTES, MAX_RECIPIENTS, MAX_ATTACHMENTS, SINGLE_UPLOAD_THRESHOLD_BYTES, MULTIPART_PART_BYTES,
  SETTING_SCHEMAS, batchMailboxRequestSchema, claimMailboxRequestSchema, updateMailboxRequestSchema, transferMailboxRequestSchema,
  internalSendMailSchema, markReadRequestSchema, markAllReadRequestSchema, deleteMessagesRequestSchema, starMessagesRequestSchema,
  initMultipartUploadSchema, completeMultipartUploadSchema, loginRequestSchema, registerRequestSchema,
  changePasswordRequestSchema, uploadAvatarRequestSchema, enableTwoFactorRequestSchema, disableTwoFactorRequestSchema,
  createUserRequestSchema, updateUserRequestSchema, userMailboxPolicySchema, createApiKeyRequestSchema, updateApiKeyRequestSchema,
  createInviteRequestSchema, replaceMailboxSharesRequestSchema, batchShareMailboxesRequestSchema, updateSettingsRequestSchema,
  updateNotifyPrefsRequestSchema, userNotifyPrefsSchema, translateMessageRequestSchema, aiModelTestRequestSchema,
  HOSTED_DOMAIN_STATUSES, createHostedDomainRequestSchema, updateHostedDomainRequestSchema, replaceHostedDomainMembersRequestSchema,
  transferHostedDomainRequestSchema, HOSTED_DNS_CAA_TAGS, HOSTED_DNS_TTL_AUTO, hostedDnsRecordInputSchema,
  MAX_TRANSLATE_BATCH_CHARS, MAX_TRANSLATE_SEGMENTS, MAX_TRANSLATE_SEGMENT_CHARS,
} from '@hpc-mail/shared';

export type Schema = Record<string, unknown>;
export type Operation = Record<string, unknown>;
export type Paths = Record<string, Record<string, Operation>>;
export const str: Schema = { type: 'string' };
export const int: Schema = { type: 'integer', minimum: 0 };
export const positiveId: Schema = { type: 'integer', minimum: 1 };
export const bool: Schema = { type: 'boolean' };
export const date: Schema = { type: 'string', format: 'date-time' };
export const domainName: Schema = { type: 'string', minLength: 1, maxLength: 253,
  pattern: '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
  description: 'Normalized lowercase DNS name. Each label is 1–63 characters and cannot start/end with a hyphen.' };
export const dnsRecordId: Schema = { type: 'string', pattern: '^[0-9a-f]{32}$', description: 'Cloudflare DNS record id: 32 lowercase hex characters.' };
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const array = (items: Schema): Schema => ({ type: 'array', items });
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
export const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)),
});
export const page = (items: Schema): Schema => object({ items: array(items), nextCursor: nullable(str) });
export function fromZod(schema: { toJSONSchema(params: { io: 'input' | 'output'; unrepresentable: 'any' }): unknown }, io: 'input' | 'output' = 'input'): Schema {
  const { $schema: _dialect, ...result } = schema.toJSONSchema({ io, unrepresentable: 'any' }) as Schema;
  return result;
}
export const claimStrategy: Schema = { type: 'string', enum: ['uniform', 'claude'],
  description: 'Optional. Omitted or uniform uses ordinary claim rules. claude rejects any domain with a historical Claude suspension, including for administrators and hosted domains; writes recheck atomically and return 403 forbidden: 该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领. Historical observations do not guarantee future safety.' };
const claimRequest = fromZod(claimMailboxRequestSchema);
(claimRequest.properties as Record<string, Schema>).strategy = claimStrategy;
const send = fromZod(internalSendMailSchema);
const sendProperties = send.properties as Record<string, Schema>;
sendProperties.from = { ...sendProperties.from, oneOf: [
  { required: ['mailboxId'], not: { anyOf: [{ required: ['localPart'], properties: { localPart: str } }, { required: ['domain'], properties: { domain: str } }] } },
  { required: ['localPart', 'domain'], not: { required: ['mailboxId'], properties: { mailboxId: positiveId } } },
] };
send.description = `At least one recipient across to/cc/bcc; combined maximum ${MAX_RECIPIENTS}. At least one nonempty text/html body; combined UTF-8 body maximum ${MAX_BODY_BYTES} bytes. At most ${MAX_ATTACHMENTS} total attachments, including tokens and source-message attachments. Base64 allows whitespace. A mailboxId must belong to the caller; ordinary users must own localPart+domain, and administrator explicit identities use configured/routable domains. Existing owned mailboxes remain usable when their domain is removed from the new-claim list. Shared mailboxes never grant send permission. replyToMessageId adds thread headers; use the original replyTo addresses from message detail as the new recipients. forwardAttachmentsFrom copies all original attachments and preserves inline CID images.`;
send.anyOf = [{ required: ['text'], properties: { text: { minLength: 1 } } }, { required: ['html'], properties: { html: { minLength: 1 } } }];
send['x-max-body-utf8-bytes'] = MAX_BODY_BYTES;
send['x-max-total-recipients'] = MAX_RECIPIENTS;
send['x-max-total-attachments'] = MAX_ATTACHMENTS;
send['x-max-attachment-bytes'] = 50 * 1024 * 1024;
(((sendProperties.attachments!.items as Schema).properties as Record<string, Schema>).content) = {
  type: 'string', minLength: 1, pattern: '^[A-Za-z0-9+/\\s]+(?:=\\s*){0,2}$',
  description: 'Base64 content; whitespace is allowed and removed before decoding. Combined decoded attachments must be at most 50 MiB.',
};
const domains = fromZod(SETTING_SCHEMAS.domains, 'output');
const domainEntry = ((domains.properties as Record<string, Schema>).list!.items) as Schema;
(domainEntry.properties as Record<string, Schema>).domain = domainName;
(domainEntry.properties as Record<string, Schema>).random = { ...bool,
  description: 'Whether random suffix generation in the claim dialog (uniform and Claude zero-suspension) may pick this domain. Omitted means true; false keeps it available for manual selection only.' };
const settingsUpdate = fromZod(updateSettingsRequestSchema);
(settingsUpdate.properties as Record<string, Schema>).domains = object({ list: { ...array({ anyOf: [domainName, domainEntry] }), maxItems: 64, 'x-unique-normalized-domain': true }, revision: int }, ['revision']);
settingsUpdate.description = 'Partial settings update. A domains replacement requires expectedDomainsRevision from the latest GET; stale revisions return 409. Adding a domain does not configure DNS or Cloudflare Email Routing. Removing a domain only removes new-claim availability, and preserves existing mailbox routing. At least one setting key is required.';
settingsUpdate.dependentRequired = { domains: ['expectedDomainsRevision'] };
const settingsResponse = object(Object.fromEntries(Object.entries(SETTING_SCHEMAS).map(([key, schema]) => [key, fromZod(schema, 'output')])));
for (const schema of [settingsResponse, settingsUpdate]) {
  const properties = schema.properties as Record<string, Schema>;
  properties.ai_model!.description = 'The single OpenAI-compatible Chat Completions model used by every AI feature: message translation and the inbound verification-code fallback. Configured means baseUrl, apiKey and model are all nonempty; baseUrl must be https and excludes /chat/completions. When translation is enabled, segments a user chooses to translate are sent to it; when code_extract.aiEnabled is on, the subject and first 6000 body characters of inbound mail that the regex could not resolve and that mentions a code-related keyword are sent to it. Unconfigured: translation is unavailable and code extraction uses regex only.';
  const aiFields = properties.ai_model!.properties as Record<string, Schema>;
  aiFields.apiKey = { ...aiFields.apiKey, description: 'Write-only provider key. Responses return ****** when a key is stored (empty string when none). Submitting ****** keeps the stored key; an empty string clears it.' };
  properties.claim_random!.description = 'Rules for the Claude zero-suspension random suffix strategy. Any historical suspension excludes a domain. paidSuspendedLimit and suspendedPercent are deprecated compatibility fields and never change eligibility, including when zero. pendingDays counts recently claimed mailboxes without Claude mail as load (0 disables). dailyLimit caps additions in the last 24 hours (Claude accounts first seen plus new claims without Claude mail), including this plan (0 disables); full zero-suspension domains never spill over to suspended domains. domains.list[].random controls participation.';
  const claimFields = properties.claim_random!.properties as Record<string, Schema>;
  for (const name of ['paidSuspendedLimit', 'suspendedPercent']) {
    claimFields[name] = { ...claimFields[name], deprecated: true, description: 'Compatibility only; ignored for eligibility. Any historical Claude suspension always excludes the domain.' };
  }
  properties.translation!.description = 'AI translation switch and quota. Enabling requires a configured ai_model (checked against the merged result when both are submitted). dailyCharsPerUser limits characters sent per user per UTC day, administrators included; 0 is unlimited.';
}
const notifyPrefs = fromZod(userNotifyPrefsSchema, 'output');
notifyPrefs.description = 'Personal preferences. Configured feishu.secret, webhook.secret and pushdeer.pushkey are returned as ******; plaintext secrets are never returned. In updates ****** preserves the secret and an explicit empty string clears it. Enabled configurations must have valid complete endpoints/keys/forward addresses. These are mail-owner notifications; shared mailbox readers do not receive owner notifications.';
const messageSummary = object({
  id: positiveId, direction: { type: 'string', enum: ['inbound', 'outbound'] }, address: str, domain: str,
  fromAddress: str, fromName: str, subject: str, preview: str, verificationCode: str,
  verificationLink: { type: 'string', maxLength: 2048, description: 'Inbound only: the most likely http/https verification, sign-in, activation or password-reset link detected at receipt; empty string when none qualified (and for mail received before detection existed). Advisory and attacker-controllable: check the link host matches the expected service before opening it.' },
  status: { type: 'string', description: 'Inbound: pending, received or degraded. Outbound: pending, sent, delivered or failed. sent means the provider accepted at least one external delivery; it is not proof of arrival in the destination inbox.' },
  errorDetail: str, recipientOutcomes: array(object({ address: str, status: { type: 'string', enum: ['delivered', 'sent', 'failed'] }, error: str }, ['error'])),
  recipientsTo: array(str), isRead: bool, isStarred: bool, hasAttachments: bool, size: int, createdAt: date,
  deletedAt: { ...date, description: 'Only in trash=1 lists: when the message entered the trash. Trash is purged seven days later.' },
}, ['recipientOutcomes', 'recipientsTo', 'verificationLink', 'deletedAt']);
const { deletedAt: _deletedAt, ...summaryProperties } = messageSummary.properties as Record<string, Schema>;
const attachment = object({ id: positiveId, filename: str, mimeType: str, size: int, contentId: str, disposition: str, url: str });
const mailbox = object({ id: positiveId, address: str, domain: str, userId: positiveId, ownerUsername: str, displayName: str, messageCount: int, createdAt: date }, ['ownerUsername']);
const user = object({ id: positiveId, username: str, role: { type: 'string', enum: ['admin', 'user'] }, createdAt: date, avatarUrl: nullable(str), twoFactorEnabled: bool });
const { twoFactorEnabled: _twoFactorEnabled, ...adminUserProperties } = user.properties as Record<string, Schema>;
const apiKey = object({ id: positiveId, name: str, keyPrefix: str, keySuffix: str, scopes: array({ type: 'string', enum: API_SCOPES }), rateLimit: positiveId,
  allowedIps: array(str), status: { type: 'string', enum: ['active', 'disabled', 'revoked'] }, expiresAt: nullable(date), lastUsedAt: nullable(date), createdAt: date, ownerUsername: str }, ['ownerUsername']);
const delivery = object({ id: positiveId, messageId: nullable(positiveId), target: str,
  status: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'failed', 'skipped', 'unknown'] },
  attempts: int, maxAttempts: positiveId, lastError: str, lastHttpStatus: nullable(int), createdAt: date, updatedAt: date,
  nextAttemptAt: date, lastAttemptAt: nullable(date),
});
export const schemas: Record<string, Schema> = {
  Error: object({ error: object({ code: { type: 'string', enum: ERROR_CODES }, message: str }), requestId: str }),
  MessageSummary: messageSummary,
  MessageDetail: object({ ...summaryProperties, replyTo: array(str), recipients: object({ to: array(str), cc: array(str), bcc: array(str) }),
    bodyText: str, bodyHtml: str, attachments: array(ref('Attachment')), hasRaw: bool }, ['recipientOutcomes', 'recipientsTo', 'replyTo', 'verificationLink']),
  MessagePage: page(ref('MessageSummary')), Attachment: attachment, Mailbox: mailbox,
  SessionMessagePage: object({ items: array(ref('MessageSummary')), nextCursor: nullable(str),
    head: { ...str, description: 'First page only (no cursor and no afterId): opaque fingerprint of this page for the current filters, same algorithm as /messages/sync head. Compare for equality only.' } }, ['head']),
  MessageSync: object({ unread: { ...int, maximum: 1000, description: 'Same value as /messages/unread-count: counting stops at 1000, so 1000 means at least 1000.' },
    head: { ...str, description: 'Opaque fingerprint of the first page for these filters. When it differs from the head of the loaded first page, refetch the list.' } }),
  BatchClaimMailboxResult: object({ claimed: array(ref('Mailbox')),
    taken: { ...array(ref('ClaimMailboxRequest')), description: 'Skipped because the address is already claimed; request order.' },
    notAttempted: { ...array(ref('ClaimMailboxRequest')), description: 'Not attempted after stoppedBy, including the item that stopped the batch; request order.' },
    stoppedBy: nullable(object({ code: { type: 'string', enum: ERROR_CODES }, message: str })) }),
  UserSearchResults: object({ items: array(object({ id: positiveId, username: str, role: { type: 'string', enum: ['admin', 'user'] } })), hasMore: bool }),
  MailboxTransferResult: object({ mailbox: ref('Mailbox'), previousUserId: positiveId, transferred: bool, revokedShares: int }),
  SharedMailbox: object({ mailboxId: positiveId, address: str, domain: str, displayName: str, ownerUsername: str }),
  MailboxShareGrant: object({ mailboxId: positiveId, address: str, domain: str, displayName: str,
    ownerUserId: positiveId, ownerUsername: str,
    grantees: array(object({ userId: positiveId, username: str, grantedAt: date, status: { type: 'string', enum: ['active', 'disabled'] } })) }),
  ClaimPlan: object({
    strategy: { type: 'string', enum: ['uniform', 'claude'] },
    items: { ...array(object({ domain: str, suspended: { ...int, description: 'Addresses on this domain that received a Claude suspension email, judged from historical official mail.' } })),
      description: 'Allocated domains in allocation order; at most count items. Prefixes are chosen by the client.' },
    pool: { ...array(str), description: 'Domains the caller can claim that take part in random generation, still have quota, and satisfy this strategy. claude excludes every domain with a historical suspension.' },
    shortfall: { ...int, description: 'count minus items length.' },
    reason: nullable({ type: 'string', enum: ['quota', 'domain_quota', 'daily_limit', 'no_candidates'],
      description: 'quota: the per-user total claim limit ran out; domain_quota: per-domain limits of the eligible domains ran out; daily_limit (claude only): every zero-suspension domain with quota left reached claim_random.dailyLimit for the last 24 hours; no_candidates: no eligible domain.' }) }),
  DomainClaudeStats: object({ domain: str,
    accounts: { ...int, description: 'Addresses that received a Claude welcome, receipt, subscription confirmation, suspension or Claude product email from official senders.' },
    suspended: int, paid: int, paidSuspended: int,
    pending: { ...int, description: 'Mailboxes claimed within claim_random.pendingDays that have not received Claude mail.' },
    recent: { ...int, description: 'New in the last 24 hours: Claude accounts first seen plus newly claimed mailboxes without Claude mail. The Claude zero-suspension strategy stops allocating the domain once this reaches claim_random.dailyLimit.' },
    risk: nullable({ type: 'string', enum: ['suspended', 'wiped', 'paid_suspended', 'suspended_rate'], description: 'suspended: any historical suspension exists, so the domain is excluded from the Claude zero-suspension strategy. Legacy enum values are retained for compatibility; new responses use suspended or null. Historical observations do not guarantee future safety.' }) }),
  MailboxAvailability: object({ address: str, available: bool,
    reason: { type: 'string', enum: ['taken', 'reserved', 'quota', 'domain_limit', 'domain_unavailable', 'claude_suspended'],
      description: 'Present only when available=false. taken: already claimed; reserved: system-reserved prefix; quota: caller reached the per-user claim limit; domain_limit: caller reached this domain’s per-user limit; domain_unavailable: domain not configured or not allowed by the caller’s public/dedicated policy. claude_suspended: strategy=claude and any historical suspension on this domain, including for administrators and hosted domains. Same rules and order as claiming.' } }, ['reason']),
  SessionUser: user,
  LoginResponse: object({ token: { ...str, description: 'Bearer JWT session token; store securely and never include it in published logs.' }, user: ref('SessionUser') }),
  AdminUser: object({ ...adminUserProperties, status: { type: 'string', enum: ['active', 'disabled'] },
    mailboxCount: int, mailboxes: array(str), mailboxPolicy: nullable(fromZod(userMailboxPolicySchema)), mailboxPolicyRevision: int,
    apiKeyCount: int, lastLoginAt: nullable(date) }),
  ApiKeySummary: apiKey,
  CreatedApiKey: object({ ...(apiKey.properties as Record<string, Schema>), key: { ...str, description: 'Full hpcm_ key, returned only once at creation. Save securely.' } }, ['ownerUsername']),
  ApiRequestLog: object({ id: positiveId, requestId: str, method: str, path: str, statusCode: int, ip: str, durationMs: int, createdAt: date }),
  AdminAuditLog: object({ id: positiveId, actorName: str, action: str, target: str, detail: str, ip: str, createdAt: date }),
  Invite: object({ id: positiveId, code: str, maxUses: positiveId, usedCount: int, expiresAt: nullable(date), note: str, createdAt: date,
    status: { type: 'string', enum: ['usable', 'exhausted', 'expired', 'revoked'] }, usedBy: array(str) }),
  Settings: settingsResponse, DomainEntry: domainEntry, NotifyPrefs: notifyPrefs,
  NotificationDelivery: delivery,
  NotificationHealth: object({ channels: array(object({ channel: { type: 'string', enum: ['feishu', 'pushdeer', 'webhook', 'forward'] }, enabled: bool,
    latest: nullable(ref('NotificationDelivery')), pendingCount: int, failedCount: int })),
    forward: object({ domainLimit: int, targetLimit: int, windowEndsAt: date,
      targets: array(object({ address: str, attempts: int, remaining: int })), domains: array(object({ domain: str, attempts: int, remaining: int })) }) }),
  DomainStatus: object({ domain: str, inList: bool, mxReady: bool, spfReady: bool, mxRecords: array(str), resolved: bool }),
  PublicConfig: object({ oidcEnabled: bool, siteTitle: str, registrationMode: { type: 'string', enum: ['closed', 'invite', 'open'] }, domains: array(str), require2fa: bool,
    translationEnabled: { ...bool, description: 'translation.enabled is on and ai_model has baseUrl, apiKey and model configured; provider details are never public.' },
    hostedDomainsEnabled: { ...bool, description: 'hosted_domains.enabled is on and the Worker has Cloudflare credentials, so users can add their own domains.' } }),
  HostedDomain: (() => {
    const step = { type: 'string', enum: ['waiting', 'ready', 'error'] };
    return object({
      id: positiveId, domain: domainName,
      status: { type: 'string', enum: HOSTED_DOMAIN_STATUSES,
        description: 'pending: waiting for the registrar nameservers to be changed; provisioning: nameservers active, Email Routing / catch-all / Email Sending being configured; active: receiving and sending ready; error: active nameservers but configuration or health check failed, retried automatically; moved: nameservers no longer point here; suspended: stopped by an administrator; deleting: mail, addresses and Cloudflare configuration are being removed.' },
      role: { type: 'string', enum: ['owner', 'member', 'admin'], description: 'Caller relationship: owner, member granted by sharing, or administrator viewing another user’s domain.' },
      ownerUserId: positiveId, ownerUsername: str,
      nameServers: { ...array(str), description: 'Set exactly these nameservers at the registrar.' },
      originalNameServers: { ...array(str), description: 'Nameservers detected when the domain was added; restore them before deleting the hosted domain.' },
      originalRegistrar: str,
      steps: object({ nameServers: step, routing: step, catchAll: step, sending: step }),
      warnings: { ...array(str), description: 'Actions required from the owner, such as disabling DNSSEC before changing nameservers.' },
      lastError: str, memberLimit: { ...int, description: 'Per-member claim limit on this domain; 0 means unlimited.' },
      memberCount: int, mailboxCount: { ...int, description: 'Claimed addresses on this domain across all users.' },
      createdAt: date, activatedAt: nullable(date), checkedAt: nullable(date),
      expiresAt: { ...nullable(date), description: 'While pending, the domain is deleted automatically if the nameservers are not changed by this time.' },
    });
  })(),
  HostedDomainMember: object({ userId: positiveId, username: str, status: { type: 'string', enum: ['active', 'disabled'] }, grantedAt: date,
    mailboxCount: { ...int, description: 'Addresses this member claimed on the domain.' } }),
  HostedDomainTransferResult: object({ domain: ref('HostedDomain'), previousUserId: positiveId, transferred: bool,
    movedMailboxes: { ...int, description: 'Mailboxes of the previous owner moved with the domain when includeMailboxes was true.' } }),
  HostedDomainsHealth: object({ enabled: bool, configured: { ...bool, description: 'Worker secrets cf_api_token and cf_account_id are set.' },
    tokenValid: nullable(bool), error: str, accountZones: nullable(int), accountPendingZones: nullable(int) }),
  HostedDnsRecord: object({
    id: dnsRecordId,
    type: { ...str, description: 'Cloudflare record type; readonly records may use types outside the editable A/AAAA/CNAME/TXT/MX/SRV/CAA.' },
    name: { ...str, description: 'Relative name: @ for the root, otherwise the name without the domain suffix, e.g. www, _acme-challenge, *.dev.' },
    fqdn: str,
    content: { ...str, description: 'Value as returned by Cloudflare. TXT may be quoted; SRV is "weight port target"; CAA is flags tag "value".' },
    ttl: { ...positiveId, description: '1 means automatic.' },
    priority: { ...nullable(int), description: 'MX preference; null for other types.' },
    srv: nullable(object({ priority: int, weight: int, port: int, target: str })),
    caa: { ...nullable(object({ flags: int, tag: str, value: str })),
      description: `CAA data as stored in Cloudflare. Editable records use flags 0 or 128 and tag ${HOSTED_DNS_CAA_TAGS.join('/')}; other values only appear on kind=readonly records.` },
    proxied: { ...bool, description: 'Cloudflare proxy. This site never enables it; proxied records are readonly.' },
    comment: str,
    kind: { type: 'string', enum: ['user', 'mail', 'readonly'],
      description: 'user: editable here; an existing record that conflicts with mail, such as a root CNAME created in the Cloudflare dashboard, is still user so it can be deleted, while saving it returns 400 with the conflict reason. mail: used by receiving or sending (root MX and SPF, _dmarc, DKIM under _domainkey, cf-bounce, or marked email_routing by Cloudflare); never editable. readonly: a type this site does not edit, a CAA record outside the editable flags/tags, a proxied record, or one maintained by another Cloudflare service (marked read_only only).' },
    lockedReason: { ...str, description: 'Why a mail or readonly record cannot be changed; empty for user records.' },
    modifiedAt: nullable(date),
  }),
  HostedDnsRecordInput: (() => {
    const schema = fromZod(hostedDnsRecordInputSchema);
    for (const variant of schema.oneOf as Schema[]) {
      const properties = variant.properties as Record<string, Schema>;
      properties.ttl = { type: 'integer',
        anyOf: [{ const: HOSTED_DNS_TTL_AUTO }, { minimum: 60, maximum: 86400 }], description: '1 means automatic.' };
      // 服务端先去掉首尾空白再校验 IP，zod 的 pipe 在输入侧只剩 string，这里补回格式
      const type = (properties.type as Schema).const;
      if (type === 'A' || type === 'AAAA') properties.content = { type: 'string', format: type === 'A' ? 'ipv4' : 'ipv6' };
    }
    schema.description = 'Selected by type. name is relative (@ for the root, www, _dmarc, *.dev) or a full name ending with the domain. ttl is 1 (automatic) or 60–86400 seconds. A/AAAA/CNAME/TXT use content, MX uses content and priority, SRV uses srv, CAA uses caa. comment is optional (empty clears it on update).';
    return schema;
  })(),
  CreateHostedDomainRequest: fromZod(createHostedDomainRequestSchema), UpdateHostedDomainRequest: fromZod(updateHostedDomainRequestSchema),
  ReplaceHostedDomainMembersRequest: fromZod(replaceHostedDomainMembersRequestSchema), TransferHostedDomainRequest: fromZod(transferHostedDomainRequestSchema),
  TranslateMessageRequest: (() => {
    const schema = fromZod(translateMessageRequestSchema);
    schema.description = `Segments cut from this message subject/body in display order, translated in order. 1–${MAX_TRANSLATE_SEGMENTS} segments, each at most ${MAX_TRANSLATE_SEGMENT_CHARS} characters, combined at most ${MAX_TRANSLATE_BATCH_CHARS} characters; split longer messages into several requests.`;
    schema['x-max-total-chars'] = MAX_TRANSLATE_BATCH_CHARS;
    return schema;
  })(),
  MessageTranslation: object({
    translations: { ...array(str), description: 'One Simplified Chinese translation per request segment, same order and count. Skipped or letterless segments are returned unchanged; surrounding whitespace is preserved.' },
    cached: { ...bool, description: 'Served from the per-message cache; no quota used.' },
    skipped: { ...int, description: 'Segments not found in this message content and therefore returned unchanged.' },
  }),
  AiModelTestRequest: (() => {
    const schema = fromZod(aiModelTestRequestSchema);
    schema.description = 'All fields optional; the body may be omitted. Omitted or empty fields and apiKey ****** use the saved ai_model.';
    return schema;
  })(),
  AiModelTestResult: object({ ok: { const: true, type: 'boolean' }, latencyMs: int, sample: { ...str, description: 'Simplified Chinese translation of the fixed English sample.' } }),
  SendMailRequest: send,
  ClaimMailboxRequest: claimRequest, BatchMailboxRequest: fromZod(batchMailboxRequestSchema), UpdateMailboxRequest: fromZod(updateMailboxRequestSchema),
  TransferMailboxRequest: fromZod(transferMailboxRequestSchema),
  MarkReadRequest: fromZod(markReadRequestSchema), MessageIdsRequest: fromZod(deleteMessagesRequestSchema), StarMessagesRequest: fromZod(starMessagesRequestSchema),
  MarkAllReadRequest: (() => {
    const schema = fromZod(markAllReadRequestSchema);
    schema.description = 'All fields optional; {} or an empty body marks every unread, non-trash inbound message in the caller’s own claimed mailboxes. domain/address/q narrow the range; q uses the list search semantics (case-insensitive substring of subject, sender address/name, text body, recipients). Mail shared with the caller is never changed. Administrators use scope=unclaimed for unclaimed addresses. Unknown fields are ignored.';
    return schema;
  })(),
  InitMultipartUploadRequest: fromZod(initMultipartUploadSchema), CompleteMultipartUploadRequest: fromZod(completeMultipartUploadSchema),
  LoginRequest: fromZod(loginRequestSchema), RegisterRequest: fromZod(registerRequestSchema), ChangePasswordRequest: fromZod(changePasswordRequestSchema),
  UploadAvatarRequest: fromZod(uploadAvatarRequestSchema), EnableTwoFactorRequest: fromZod(enableTwoFactorRequestSchema), DisableTwoFactorRequest: fromZod(disableTwoFactorRequestSchema),
  CreateUserRequest: fromZod(createUserRequestSchema), UpdateUserRequest: {
    ...fromZod(updateUserRequestSchema), dependentRequired: { mailboxPolicy: ['expectedMailboxPolicyRevision'] },
  }, CreateApiKeyRequest: fromZod(createApiKeyRequestSchema),
  UpdateApiKeyRequest: fromZod(updateApiKeyRequestSchema), CreateInviteRequest: fromZod(createInviteRequestSchema), ReplaceMailboxSharesRequest: fromZod(replaceMailboxSharesRequestSchema),
  BatchShareMailboxesRequest: fromZod(batchShareMailboxesRequestSchema),
  UpdateSettingsRequest: settingsUpdate, UpdateNotifyPrefsRequest: fromZod(updateNotifyPrefsRequestSchema),
  SingleUploadResult: object({ token: str, filename: str, size: int, mimeType: str }),
  MultipartInitResult: object({ token: str, uploadId: str, partBytes: positiveId, partCount: positiveId }),
  MultipartPartResult: object({ partNumber: positiveId, etag: str }), MultipartCompleteResult: object({ token: str, size: int }),
};
export const query = (name: string, schema: Schema, description?: string, required = false): Schema => ({ name, in: 'query', required, schema, ...(description ? { description } : {}) });
export const scopeQuery = [query('scope', { type: 'string', enum: ['mine', 'unclaimed', 'user'] }, 'Default mine. unclaimed/user are administrator-only; user requires userId. Shared inboxes add read-only inbound visibility.'),
  query('userId', positiveId, 'Required for administrator scope=user; mutations cannot modify another owner’s mail.')];
export const mutationQuery = [query('scope', { type: 'string', enum: ['mine', 'unclaimed'] }, 'Default mine; unclaimed requires administrator. Query or JSON body scope are accepted; conflicting values return 400.')];
export const pageQuery = [query('cursor', { type: 'string', maxLength: 128 }, 'Opaque server nextCursor. Omit on first page; null means no next page.'), query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 30 })];
export const listQuery = [query('direction', { type: 'string', enum: ['inbound', 'outbound'] }), query('domain', str), query('address', str),
  ...['unread', 'starred', 'trash'].map(name => query(name, { type: 'string', enum: ['1', 'true', '0', 'false'] })),
  query('q', { type: 'string', maxLength: 256 }, 'Literal substring search in subject/from/body; Unicode is supported.'),
  ...scopeQuery, query('afterId', int, 'Only IDs greater than this value; 0 starts from the beginning. Never advance past unprocessed messages.'), ...pageQuery];
export const idempotencyHeader = { name: 'Idempotency-Key', in: 'header', required: false,
  description: 'Use one stable unique visible-ASCII key per logical send. Retry identical content with the same key after network/server failures. 409 pending/unknown means inspect the outbox and do not send with a fresh key. A partial-success response should retry only recipientOutcomes marked failed, with a new logical key. Completed keys are retained at least two days.',
  schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[!-~]+$' } };
export const success = object({ success: { const: true, type: 'boolean' } });
export const changed = object({ changed: int });
export const okResult = object({ ok: { const: true, type: 'boolean' } });
export function operation(summary: string, data: Schema, options: {
  request?: string; requestRequired?: boolean; status?: number; parameters?: Schema[]; description?: string; public?: boolean; role?: 'admin'; scope?: string; binary?: string; security?: Schema[];
} = {}): Operation {
  const responseSchema = options.binary ? { type: 'string', format: 'binary' } : object({ data });
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 500].map(code => [code, {
    description: ({ 400: 'Invalid request', 401: 'Missing/invalid credentials; login may return totp_required', 403: 'Permission denied or totp_setup_required',
      404: 'Resource not found or not visible', 409: 'Conflict, stale revision or send result not confirmed', 413: 'Payload exceeds limits', 429: 'Rate limit exceeded', 500: 'Server or notification-delivery error' } as Record<number, string>)[code],
    content: { 'application/json': { schema: ref('Error') } },
  }]));
  return { summary, description: options.description || summary, tags: [options.role ? 'Administration' : 'Mail'],
    ...(options.role ? { 'x-required-role': options.role } : {}), ...(options.scope ? { 'x-required-scopes': [options.scope] } : {}),
    ...(options.public ? { security: [] } : options.security ? { security: options.security } : {}),
    ...(options.parameters?.length ? { parameters: options.parameters } : {}),
    ...(options.request ? { requestBody: { required: options.requestRequired ?? true, content: { 'application/json': { schema: ref(options.request) } } } } : {}),
    responses: { ...errors, [options.status ?? 200]: { description: options.status === 201 ? 'Created' : 'Success',
      content: { [options.binary || 'application/json']: { schema: responseSchema },
        ...(options.binary === 'application/octet-stream' ? { '*/*': { schema: responseSchema } } : {}) } } },
  };
}
export function describePaths(paths: Paths, namespace = ''): Paths {
  return Object.fromEntries(Object.entries(paths).map(([path, methods]) => [path, {
    ...methods,
    ...(Array.from(path.matchAll(/\{([^}]+)\}/g)).length ? { parameters: Array.from(path.matchAll(/\{([^}]+)\}/g), match => ({
      name: match[1], in: 'path', required: true,
      schema: match[1] === 'token' ? { type: 'string', minLength: 1 } : match[1] === 'recordId' ? dnsRecordId : positiveId,
    })) } : {}),
    ...Object.fromEntries(Object.entries(methods).map(([method, value]) => [method, {
      ...value, operationId: `${namespace}${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    }])),
  }])) as Paths;
}
export function specInfo(title: string, description: string) {
  return { title, description, version: '1.4.0', license: { name: 'MIT', identifier: 'MIT' },
    contact: { name: 'HPC Mail', url: 'https://github.com/riba2534/hpc-mail' } };
}
export function specificationOperation(): Operation {
  const document = object({ openapi: str, info: object({ title: str, version: str }), paths: { type: 'object' } });
  const base = operation('Read this OpenAPI specification', document, { public: true });
  return { ...base, responses: { ...(base.responses as Record<string, unknown>),
    200: { description: 'Raw OpenAPI 3.1 document, without a data envelope', content: { 'application/json': { schema: document } } },
  } };
}
/** Emit only schemas actually reachable from these routes, so imported tool contracts stay focused. */
export function usedSchemas(paths: Paths): Record<string, Schema> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Schema;
    if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/schemas/')) {
      const name = record.$ref.slice('#/components/schemas/'.length);
      if (!names.has(name)) { names.add(name); visit(schemas[name]); }
    }
    Object.values(record).forEach(visit);
  };
  visit(paths);
  return Object.fromEntries([...names].sort().map(name => [name, schemas[name]! ]));
}
export function uploadPaths(scope?: string): Paths {
  const binaryBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
  const lengthHeader = (maximum: number): Schema => ({ name: 'Content-Length', in: 'header', required: true,
    schema: { type: 'integer', minimum: 1, maximum }, description: 'Actual byte count of the raw binary request body.' });
  return {
    '/uploads': { post: { ...operation('Upload a small draft attachment', ref('SingleUploadResult'), { status: 201, scope,
      description: 'Raw binary upload up to 10 MiB. Pass returned token in SendMailRequest.attachmentTokens. Drafts expire after 24 hours; the combined attachment limit also applies at send time.',
      parameters: [query('filename', { type: 'string', minLength: 1, maxLength: 255 }, 'No path separators or ..', true),
        query('mimeType', { type: 'string', maxLength: 128, default: 'application/octet-stream' }), lengthHeader(SINGLE_UPLOAD_THRESHOLD_BYTES)] }), requestBody: binaryBody } },
    '/uploads/multipart': { post: operation('Initialize a large draft attachment', ref('MultipartInitResult'), { request: 'InitMultipartUploadRequest', status: 201, scope,
      description: 'Use returned token for parts/complete, and returned partBytes to split the file. Upload parts sequentially; the last part uses the remaining byte count. Maximum single file 50 MiB.' }) },
    '/uploads/multipart/{token}/parts/{partNumber}': { put: { ...operation('Upload a numbered binary part', ref('MultipartPartResult'), { scope,
      description: 'partNumber starts at 1 and cannot exceed partCount. Content-Length must equal partBytes, except the final remainder. Save each returned etag for completion.', parameters: [lengthHeader(MULTIPART_PART_BYTES)] }), requestBody: binaryBody } },
    '/uploads/multipart/{token}/complete': { post: operation('Complete the multipart draft', ref('MultipartCompleteResult'), { request: 'CompleteMultipartUploadRequest', scope,
      description: 'Submit every partNumber/etag in parts. The server checks the actual final object size. Only completed tokens may be attached to a message.' }) },
    '/uploads/{token}': { delete: operation('Cancel or delete a draft attachment', success, { scope,
      description: 'Own draft only. Aborts unfinished multipart uploads or deletes the completed draft object. R2 failure keeps the durable reference for cleanup.' }) },
  };
}
