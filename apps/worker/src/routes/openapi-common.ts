import {
  API_SCOPES, ERROR_CODES, MAX_BATCH_CLAIM, MAX_BODY_BYTES, MAX_RECIPIENTS, MAX_ATTACHMENTS, SINGLE_UPLOAD_THRESHOLD_BYTES, MULTIPART_PART_BYTES,
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
  ALLOWED_CUSTOM_HEADERS, MAX_CUSTOM_HEADER_VALUE_BYTES, MAX_CUSTOM_NON_X_HEADERS, MAX_CUSTOM_HEADERS_TOTAL_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES, MAX_INLINE_ATTACHMENT_TOTAL_BYTES, MAX_SEND_REQUEST_BYTES, MAX_REPLY_TO, MAX_DISPLAY_NAME_LENGTH,
  EXTERNAL_MESSAGE_MAX_BYTES, OUTBOUND_STATUSES, LIST_PAGE_DEFAULT_LIMIT, LIST_PAGE_MAX_LIMIT,
} from '@hpc-mail/shared';
import { REQUEST_ID_PATTERN } from '../middleware/error.js';

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
/** 客户端 X-Request-ID 的取用规则，与 requestId 中间件同一正则 */
export const clientRequestIdRule = `a client-supplied X-Request-ID is used only when it matches ${REQUEST_ID_PATTERN.source}`;
export const claimStrategy: Schema = { type: 'string', enum: ['uniform', 'claude'],
  description: 'Optional. Omitted or uniform uses ordinary claim rules. claude rejects any domain with a historical Claude suspension, including for administrators and hosted domains; writes recheck atomically and return 403 forbidden: 该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领. Historical observations do not guarantee future safety.' };
const claimRequest = fromZod(claimMailboxRequestSchema);
(claimRequest.properties as Record<string, Schema>).strategy = claimStrategy;
const MIB = 1024 * 1024;
const send = fromZod(internalSendMailSchema);
const sendProperties = send.properties as Record<string, Schema>;
const [fromString, fromAddressObject, fromMailbox] = sendProperties.from!.anyOf as Schema[];
const fromFields = fromMailbox!.properties as Record<string, Schema>;
const senderName = { ...fromFields.displayName,
  description: `Sender display name, at most ${MAX_DISPLAY_NAME_LENGTH} characters. Defaults to the mailbox display name, else the local part.` };
sendProperties.from = {
  description: 'Sender identity in one of four forms; pick an address from GET /identities with canSend=true. The two address forms are parsed into localPart+domain and follow the same rules.',
  oneOf: [
    { title: 'Mailbox id', type: 'object', required: ['mailboxId'], properties: { mailboxId: positiveId, displayName: senderName },
      not: { anyOf: [{ required: ['localPart'] }, { required: ['domain'] }] } },
    { title: 'Local part and domain', type: 'object', required: ['localPart', 'domain'],
      properties: { localPart: fromFields.localPart, domain: fromFields.domain, displayName: senderName }, not: { required: ['mailboxId'] } },
    { ...fromString, title: 'Address string', minLength: 3, examples: ['Alice <alice@example.org>', 'alice@example.org'],
      description: '"a@b" or "Name <a@b>"; the name may be double-quoted, with \\" for a literal quote. The address must be one this site can send from.' },
    { ...fromAddressObject, title: 'Address object', description: '{address, name?}; name is the display name.',
      properties: { address: { type: 'string', minLength: 3, maxLength: 254 }, name: { type: 'string', maxLength: MAX_DISPLAY_NAME_LENGTH } } },
  ],
};
/** to/cc/bcc/replyTo 的一个地址：字符串或 {address, name}，服务端解析后严格校验 */
const mailAddress: Schema = {
  description: `One address: "a@b", "Name <a@b>" (the name may be double-quoted, with \\" escapes) or {address, name?}. Addresses are lowercased and validated strictly: a dot-atom local part, DNS labels and a letter or punycode top-level domain, at most 254 characters; quoted local parts, IP literals and malformed input such as alice<a@b.com return 400 validation_failed. Display names are at most ${MAX_DISPLAY_NAME_LENGTH} characters and cannot contain control characters or angle brackets.`,
  oneOf: [
    { type: 'string', minLength: 3, examples: ['bob@example.net', 'Bob <bob@example.net>'] },
    { type: 'object', required: ['address'], properties: { address: { type: 'string', minLength: 3, maxLength: 254 },
      name: { type: 'string', maxLength: MAX_DISPLAY_NAME_LENGTH } } },
  ],
};
sendProperties.to = { ...array(ref('MailAddress')), description: `Required, may be empty when cc or bcc has an address. to+cc+bcc hold 1–${MAX_RECIPIENTS} addresses in total; duplicates are sent once.` };
sendProperties.cc = { ...array(ref('MailAddress')), default: [] };
sendProperties.bcc = { ...array(ref('MailAddress')), default: [], description: 'Never disclosed to other recipients.' };
sendProperties.replyTo = { ...array(ref('MailAddress')), maxItems: MAX_REPLY_TO,
  description: `Reply-To header: where recipients’ replies go, at most ${MAX_REPLY_TO} addresses. Defaults to the sender.` };
sendProperties.replyToMessageId = { ...sendProperties.replyToMessageId,
  description: 'Id of a message on this site being replied to; the server adds In-Reply-To/References from it. It does not fill recipients, subject or body. Cannot be combined with headers In-Reply-To/References (400 validation_failed).' };
sendProperties.forwardAttachmentsFrom = { ...sendProperties.forwardAttachmentsFrom,
  description: 'Id of a visible message whose attachments, including inline images, are attached again. It does not fill recipients, subject or body.' };
sendProperties.headers = {
  type: 'object', additionalProperties: { type: 'string', minLength: 1 },
  description: `Custom headers. Names: X-* or one of ${ALLOWED_CUSTOM_HEADERS.join(', ')} (case-insensitive). From/To/Cc/Bcc/Subject/Reply-To must use the request fields, and platform headers (Message-ID, Date, MIME-Version, Content-Type, DKIM-Signature, Received and so on) cannot be set: any disallowed name returns 400 header_not_allowed listing every rejected name in error.details.headers. Values are single-line (no CR/LF) and at most ${MAX_CUSTOM_HEADER_VALUE_BYTES} UTF-8 bytes each, a name appears once, at most ${MAX_CUSTOM_NON_X_HEADERS} non-X headers, and names plus values total at most ${MAX_CUSTOM_HEADERS_TOTAL_BYTES} bytes. Structured headers take printable ASCII; X-*, Comments, Keywords, Organization and Thread-Topic also accept UTF-8 (RFC 2047 encoded when sent). Formats: In-Reply-To is one <message-id>; References is space-separated <message-id>s; List-Unsubscribe is comma-separated <https:…> or <mailto:…> URIs; List-Unsubscribe-Post is exactly List-Unsubscribe=One-Click and needs an https List-Unsubscribe; Precedence bulk|list|junk; Importance high|normal|low; Priority normal|non-urgent|urgent; Sensitivity personal|private|company-confidential. Value problems return 400 validation_failed, also with details.headers. Use In-Reply-To/References only to reply to mail from outside this site (you know its Message-ID); for a message on this site use replyToMessageId, never both.`,
  'x-allowed-headers': ALLOWED_CUSTOM_HEADERS, 'x-max-value-utf8-bytes': MAX_CUSTOM_HEADER_VALUE_BYTES,
  'x-max-non-x-headers': MAX_CUSTOM_NON_X_HEADERS, 'x-max-total-bytes': MAX_CUSTOM_HEADERS_TOTAL_BYTES,
  examples: [{ 'X-Campaign': 'weekly-2026-11', 'List-Unsubscribe': '<https://example.org/unsubscribe?u=1>' }],
};
const contentIdDescription = 'Content-ID without angle brackets (brackets are stripped); reference it in html as <img src="cid:<contentId>">. Unique within the request, case-insensitively.';
const dispositionDescription = 'inline needs contentId and is embedded in the HTML body (multipart/related); omitted means inline when contentId is given, else attachment.';
const attachmentFields = (sendProperties.attachments!.items as Schema).properties as Record<string, Schema>;
attachmentFields.content = {
  type: 'string', minLength: 1, pattern: '^[A-Za-z0-9+/\\s]+(?:=\\s*){0,2}$',
  description: `Base64 without a data: prefix; whitespace and line breaks are removed before decoding. Base64 attachments together decode to at most ${MAX_INLINE_ATTACHMENT_TOTAL_BYTES / MIB} MiB (413 payload_too_large); upload larger files to /uploads and use attachmentTokens.`,
};
attachmentFields.contentId = { ...attachmentFields.contentId, description: contentIdDescription };
attachmentFields.disposition = { ...attachmentFields.disposition, description: dispositionDescription };
const [tokenString, tokenObject] = (sendProperties.attachmentTokens!.items as Schema).anyOf as Schema[];
const tokenFields = tokenObject!.properties as Record<string, Schema>;
sendProperties.attachmentTokens = { ...sendProperties.attachmentTokens,
  description: 'Completed upload tokens from /uploads: a token string, or {token, contentId?, disposition?} to embed it as an inline image. Tokens are consumed by a finished send.',
  items: { oneOf: [{ ...tokenString, title: 'Token' }, { ...tokenObject, title: 'Token with inline options', properties: { ...tokenFields,
    contentId: { ...tokenFields.contentId, description: contentIdDescription }, disposition: { ...tokenFields.disposition, description: dispositionDescription } } }] } };
send.description = `At least one recipient across to/cc/bcc; combined maximum ${MAX_RECIPIENTS}. At least one nonempty text/html body; combined UTF-8 body maximum ${MAX_BODY_BYTES} bytes. Subject is one line. At most ${MAX_ATTACHMENTS} total attachments, including tokens and source-message attachments, together at most ${MAX_ATTACHMENT_TOTAL_BYTES / MIB} MiB; base64 attachments together at most ${MAX_INLINE_ATTACHMENT_TOTAL_BYTES / MIB} MiB, and a request body over ${MAX_SEND_REQUEST_BYTES / MIB} MiB is rejected with 413 before parsing. When external recipients are present and the encoded message would exceed about ${EXTERNAL_MESSAGE_MAX_BYTES / MIB} MiB, attachments are delivered as signed download links valid for 90 days, and cid: images point to those links. Inline images: give an attachment or token a contentId and reference it as cid:<contentId> in html. Sender identity: ordinary users must own the mailbox, whatever form from takes (GET /identities lists those with canSend). Administrators may use any claimed mailbox by mailboxId, or an explicit address on a configured system domain, a removed domain that still has claimed mailboxes, or a hosted domain. Any address on a hosted domain needs that domain’s sending to be ready (400 otherwise); system domains do not. Existing owned mailboxes remain usable when their domain is removed from the new-claim list. Shared mailboxes never grant send permission. A sender that is not allowed returns 403 forbidden with fix and docs. replyToMessageId only adds In-Reply-To/References: recipients, subject and body are not filled in, so use the original replyTo addresses (else fromAddress) from message detail. To reply to mail from outside this site, put its Message-ID into headers In-Reply-To/References instead; giving both returns 400. forwardAttachmentsFrom copies all original attachments and preserves inline CID images. Both source ids must be visible to the sender: mail at an address the sender claimed, or non-deleted inbound mail shared with the sender; administrators may also reference mail at unclaimed addresses. A missing or invisible source, or a forwarded attachment whose stored content is gone, returns 404 source_unavailable; drop replyToMessageId/forwardAttachmentsFrom to send it as a new message. A missing sender mailboxId stays 404 not_found. API keys need mail.read in addition to mail.send when either field is present.`;
send.anyOf = [{ required: ['text'], properties: { text: { minLength: 1 } } }, { required: ['html'], properties: { html: { minLength: 1 } } }];
send['x-max-body-utf8-bytes'] = MAX_BODY_BYTES;
send['x-max-total-recipients'] = MAX_RECIPIENTS;
send['x-max-total-attachments'] = MAX_ATTACHMENTS;
send['x-max-attachment-bytes'] = MAX_ATTACHMENT_TOTAL_BYTES;
send['x-max-inline-attachment-bytes'] = MAX_INLINE_ATTACHMENT_TOTAL_BYTES;
send['x-max-request-bytes'] = MAX_SEND_REQUEST_BYTES;
const domains = fromZod(SETTING_SCHEMAS.domains, 'output');
const domainEntry = ((domains.properties as Record<string, Schema>).list!.items) as Schema;
(domainEntry.properties as Record<string, Schema>).domain = domainName;
(domainEntry.properties as Record<string, Schema>).random = { ...bool,
  description: 'Whether random suffix generation in the claim dialog (uniform and Claude zero-suspension) may pick this domain. Omitted means true; false keeps it available for manual selection only.' };
const settingsUpdate = fromZod(updateSettingsRequestSchema);
(settingsUpdate.properties as Record<string, Schema>).domains = object({ list: { ...array({ anyOf: [domainName, domainEntry] }), maxItems: 64, 'x-unique-normalized-domain': true }, revision: int }, ['revision']);
settingsUpdate.description = 'Partial settings update. A domains replacement requires expectedDomainsRevision from the latest GET; stale revisions return 409. A domain hosted by a user (/hosted-domains) cannot be added as a system domain and also returns 409. Adding a domain does not configure DNS or Cloudflare Email Routing. Removing a domain only removes new-claim availability, and preserves existing mailbox routing. At least one setting key is required.';
settingsUpdate.dependentRequired = { domains: ['expectedDomainsRevision'] };
const settingsResponse = object(Object.fromEntries(Object.entries(SETTING_SCHEMAS).map(([key, schema]) => [key, fromZod(schema, 'output')])));
for (const schema of [settingsResponse, settingsUpdate]) {
  const properties = schema.properties as Record<string, Schema>;
  properties.ai_model!.description = 'The single OpenAI-compatible Chat Completions model used by every AI feature: message translation and the inbound verification-code fallback. Configured means baseUrl, apiKey and model are all nonempty; baseUrl must be https and excludes /chat/completions. When translation is enabled, segments a user chooses to translate are sent to it; when code_extract.aiEnabled is on, the subject and first 6000 body characters of inbound mail that the regex could not resolve and that mentions a code-related keyword are sent to it. Unconfigured: translation is unavailable and code extraction uses regex only.';
  const aiFields = properties.ai_model!.properties as Record<string, Schema>;
  aiFields.apiKey = { ...aiFields.apiKey, description: 'Write-only provider key. Responses return ****** when a key is stored (empty string when none). Submitting ****** keeps the stored key; an empty string clears it. Keeping the stored key requires the same baseUrl origin and path (a trailing slash is ignored): ****** with a baseUrl whose scheme, host, port or path changed returns 400 validation_failed, so enter the apiKey again; clearing baseUrl may keep the stored key. The stored key is never sent to a new host.' };
  properties.claim_random!.description = 'Rules for the Claude zero-suspension random suffix strategy. Any historical suspension excludes a domain. paidSuspendedLimit and suspendedPercent are deprecated compatibility fields and never change eligibility, including when zero. pendingDays counts recently claimed mailboxes without Claude mail as load (0 disables). dailyLimit caps additions in the last 24 hours (Claude accounts first seen plus new claims without Claude mail), including this plan (0 disables); full zero-suspension domains never spill over to suspended domains. domains.list[].random controls participation.';
  const claimFields = properties.claim_random!.properties as Record<string, Schema>;
  for (const name of ['paidSuspendedLimit', 'suspendedPercent']) {
    claimFields[name] = { ...claimFields[name], deprecated: true, description: 'Compatibility only; ignored for eligibility. Any historical Claude suspension always excludes the domain.' };
  }
  properties.translation!.description = 'AI translation switch and quota. Enabling requires a configured ai_model (checked against the merged result when both are submitted). dailyCharsPerUser limits characters sent per user per UTC day, administrators included; 0 is unlimited.';
}
const notifyPrefs = fromZod(userNotifyPrefsSchema, 'output');
notifyPrefs.description = 'Personal preferences. Configured feishu.secret, webhook.secret and pushdeer.pushkey are returned as ******; plaintext secrets are never returned. In updates ****** preserves the secret (for PushDeer only while the endpoint keeps the same origin and path, ignoring a trailing slash, with an empty endpoint meaning the official one; otherwise 400 validation_failed asks for the pushkey again) and an explicit empty string clears it. Enabled configurations must have valid complete endpoints/keys/forward addresses. These are mail-owner notifications; shared mailbox readers do not receive owner notifications.';
/** 逐收件人结果：发件摘要与 delivery_failed 错误的 details 共用 */
const recipientOutcome = { ...object({ address: str,
  status: { type: 'string', enum: ['delivered', 'sent', 'failed', 'unknown'],
    description: 'delivered: stored for a recipient on this site; sent: accepted by the provider for an external recipient (not proof of inbox arrival); failed: rejected, see error; unknown: delivery was interrupted and the result was never recorded, so the recipient may already have it: confirm before resending.' },
  error: str }, ['error']), description: 'Result for one unique recipient address.' };
const messageSummary = object({
  id: positiveId, direction: { type: 'string', enum: ['inbound', 'outbound'] }, address: str, domain: str,
  fromAddress: str, fromName: str, subject: str, preview: str, verificationCode: str,
  verificationLink: { type: 'string', maxLength: 2048, description: 'Inbound only: the most likely http/https verification, sign-in, activation or password-reset link detected at receipt; empty string when none qualified (and for mail received before detection existed). Advisory and attacker-controllable: check the link host matches the expected service before opening it.' },
  status: { type: 'string', 'x-inbound-values': ['pending', 'received', 'degraded'], 'x-outbound-values': OUTBOUND_STATUSES,
    description: `Inbound: pending (attachments still being stored), received or degraded (parsing or attachments partly failed; see errorDetail and hasRaw). Outbound: ${OUTBOUND_STATUSES.join(', ')}. pending: delivery in progress, per-recipient results are filled in as each finishes. sent: the provider accepted at least one external recipient; not proof of arrival in the destination inbox. delivered: every recipient is on this site and the copies are stored. failed: every recipient failed. unknown: still pending an hour after creation (delivery interrupted), recorded results are kept and the rest are unknown; some recipients may already have the mail, so confirm before resending. A send response is never failed (that is 422 delivery_failed); errorDetail describes partial failures. Very old rows may carry other values; treat them as unknown.` },
  errorDetail: str, recipientOutcomes: { ...array(recipientOutcome), description: 'Outbound only: one entry per unique recipient across to/cc/bcc.' },
  recipientsTo: array(str), isRead: bool, isStarred: bool,
  hasAttachments: { ...bool, description: 'Whether the message has real attachments. Inline parts with a Content-ID (embedded images such as logos) are not counted.' },
  size: int, createdAt: date,
  deletedAt: { ...date, description: 'Only in trash=1 lists: when the message entered the trash. Trash is purged seven days later.' },
}, ['recipientOutcomes', 'recipientsTo', 'verificationLink', 'deletedAt']);
const { deletedAt: _deletedAt, ...summaryProperties } = messageSummary.properties as Record<string, Schema>;
const attachment = object({ id: positiveId, filename: str, mimeType: str, size: int, contentId: str, disposition: str,
  inline: { ...bool, description: 'True when bodyHtml references this part as cid:<contentId> and the reference was replaced by its url, so it is already shown inline; clients need not list it again as an attachment.' },
  url: { ...str, description: 'Signed download URL, possibly relative to the site origin. Session-API detail URLs are aligned to the hour and valid for 1–2 hours; /v1 detail URLs expire after 5 minutes. Read the message again for a fresh URL, or download with credentials instead.' } }, ['inline']);
const mailbox = object({ id: positiveId, address: str, domain: str, userId: positiveId, ownerUsername: str, displayName: str, messageCount: int, createdAt: date,
  canSend: { ...bool, description: 'Returned by mailbox lists: whether this mailbox’s domain can currently send (always true on system domains; hosted domains need an active domain with sending ready). Only reflects the domain; sending also requires owning the mailbox (administrators excepted).' } },
['ownerUsername', 'canSend']);
const sendIdentityReason = { type: 'string', enum: ['hosted_sending_not_ready', 'hosted_domain_unavailable', 'shared_readonly'],
  description: 'hosted_sending_not_ready: the hosted domain’s sending is not ready yet; hosted_domain_unavailable: the hosted domain is suspended, moved or being deleted; shared_readonly: a mailbox shared with the caller is read-only and can never send.' };
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
  Error: object({ error: object({ code: { type: 'string', enum: ERROR_CODES,
    description: 'Stable machine-readable code; branch on it, not on message. header_not_allowed (400): headers contains a name that cannot be set; details.headers lists every rejected name. payload_too_large (413): the request or attachments exceed a limit; upload large files and use attachmentTokens. idempotency_mismatch (409): this Idempotency-Key was already used for different send content; check the original send, then use a new key for new content. send_in_progress (409): the send for this key is still processing or its result is unconfirmed; check the outbox and retry later with the same key, never a fresh one. source_unavailable (404): the message referenced by replyToMessageId or forwardAttachmentsFrom does not exist or is not visible, or a forwarded attachment is lost; remove the reference to send a new message. delivery_failed (422): every recipient was attempted and rejected, nothing was delivered; details.messageId is the recorded outbound message and details.recipientOutcomes the reasons; the same key replays the same 422.' },
    message: { ...str, description: 'Human-readable Chinese explanation; wording may change.' },
    fix: { ...str, description: 'Optional: one actionable correction, e.g. which scope to add or which endpoint to call first.' },
    docs: { type: 'string', format: 'uri', description: 'Optional: absolute URL of the matching section in /references/errors.md on this site.' },
    details: { ...object({
      headers: { ...array(str), description: 'header_not_allowed and header value errors: offending header names as written in the request.' },
      messageId: { ...positiveId, description: 'delivery_failed: id of the recorded outbound message (visible in direction=outbound lists).' },
      recipientOutcomes: { ...array(recipientOutcome), description: 'delivery_failed: per-recipient results, all failed.' },
    }, ['headers', 'messageId', 'recipientOutcomes']), description: 'Optional structured data, present only on the codes above.' },
  }, ['fix', 'docs', 'details']),
    requestId: { ...str, description: `Same value as the X-Request-ID response header, which every response carries; ${clientRequestIdRule}, anything else is replaced by a server-generated UUID.` } }),
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
  SendIdentities: object({
    identities: { ...array(object({
      kind: { type: 'string', enum: ['owned', 'shared'], description: 'owned: claimed by the caller; shared: shared with the caller (read-only).' },
      mailboxId: positiveId, address: str, domain: str, displayName: str,
      canSend: { ...bool, description: 'Use as from (mailboxId or address) only when true.' },
      reason: { ...nullable(sendIdentityReason), description: 'Why canSend is false; null when it can send.' },
    })), description: 'Caller-owned mailboxes first, then mailboxes shared with the caller, each sorted by address. Administrators may still send from any mailbox by mailboxId; those are not listed.' },
    domains: { ...array(object({ domain: str, kind: { type: 'string', const: 'system' }, anyLocalPart: { type: 'boolean', const: true } })),
      description: 'Domains where any local part may be used as from (localPart+domain or "Name <any@domain>"). Only administrators get entries: every configured system domain. Empty for ordinary users.' },
  }),
  ApiKeySelf: object({
    key: object({ id: positiveId, name: str, keyPrefix: str, keySuffix: str, scopes: array({ type: 'string', enum: API_SCOPES }),
      rateLimit: { ...positiveId, description: 'Requests per minute for this key.' }, allowedIps: array(str), expiresAt: nullable(date), createdAt: date }),
    user: object({ id: positiveId, username: str, role: { type: 'string', enum: ['admin', 'user'] } }),
    limits: object({
      userRequestsPerMinute: { ...positiveId, description: 'Requests per minute across all keys of this user.' },
      waitPollsPerMinute: { ...positiveId, description: 'GET /messages/wait polls per user per minute.' },
    }),
    outbound: { ...object({
      sent: { ...int, description: 'Sends counted today (UTC).' }, recipients: { ...int, description: 'Recipients counted today (UTC).' },
      dailyLimit: { ...int, description: '0 means unlimited.' }, dailyRecipientLimit: { ...int, description: '0 means unlimited.' },
      exempt: { ...bool, description: 'Administrators are not subject to the outbound quota; limits are returned as 0.' },
      resetsAt: { ...date, description: 'Next UTC midnight, when the daily counters reset.' },
    }), description: 'Today’s outbound quota usage of the key owner (all keys and the web combined): each send adds 1 to sent and its unique recipients to recipients; a send where every recipient failed is given back. Nothing is counted for administrators or while both limits are 0.' },
  }),
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
  ChangePasswordResponse: object({ token: { ...str, description: 'Replacement JWT session token; previous sessions of this user are invalid.' }, user: ref('SessionUser'),
    revokedApiKeys: { ...int, description: 'API keys revoked by this change; 0 when revokeApiKeys was false or none were active.' } }),
  AdminUser: object({ ...adminUserProperties, status: { type: 'string', enum: ['active', 'disabled'] },
    mailboxCount: int, mailboxes: array(str), mailboxPolicy: nullable(fromZod(userMailboxPolicySchema)), mailboxPolicyRevision: int,
    apiKeyCount: int, lastLoginAt: nullable(date) }),
  ApiKeySummary: apiKey,
  CreatedApiKey: object({ ...(apiKey.properties as Record<string, Schema>), key: { ...str, description: 'Full hpcm_ key, returned only once at creation. Save securely.' } }, ['ownerUsername']),
  ApiRequestLog: { ...object({ id: positiveId, requestId: str, method: str,
    path: { ...str, maxLength: 256, description: 'Normalized route: numeric id segments become :id; at most 256 characters.' },
    statusCode: int, ip: str, durationMs: int, createdAt: date }),
    description: 'One row per accepted request. Rejected requests (disabled or expired key, IP not allowed, disabled user, rate limited) are recorded at most once per key per minute; revoked keys are treated as unknown and never logged.' },
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
  PublicConfig: object({ siteTitle: str, registrationMode: { type: 'string', enum: ['closed', 'invite', 'open'] }, domains: array(str), require2fa: bool,
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
    schema.description = 'All fields optional; the body may be omitted. Omitted or empty fields and apiKey ****** use the saved ai_model. An omitted, empty or ****** apiKey with a baseUrl whose origin or path differs from the saved one (a trailing slash is ignored) returns 400 validation_failed: the saved key is only sent to its own endpoint, so enter the apiKey to test a new one.';
    return schema;
  })(),
  AiModelTestResult: object({ ok: { const: true, type: 'boolean' }, latencyMs: int, sample: { ...str, description: 'Simplified Chinese translation of the fixed English sample.' } }),
  SendMailRequest: send, MailAddress: mailAddress,
  ClaimMailboxRequest: claimRequest, BatchMailboxRequest: fromZod(batchMailboxRequestSchema), UpdateMailboxRequest: fromZod(updateMailboxRequestSchema),
  TransferMailboxRequest: fromZod(transferMailboxRequestSchema),
  MarkReadRequest: fromZod(markReadRequestSchema), MessageIdsRequest: fromZod(deleteMessagesRequestSchema), StarMessagesRequest: fromZod(starMessagesRequestSchema),
  MarkAllReadRequest: (() => {
    const schema = fromZod(markAllReadRequestSchema);
    schema.description = 'All fields optional; {} or an empty body marks every unread, non-trash inbound message in the caller’s own claimed mailboxes. domain/address/q narrow the range; q uses the list search semantics (case-insensitive substring of subject, sender address/name, text body, recipients). Mail shared with the caller is never changed. Administrators use scope=unclaimed for unclaimed addresses. Unknown fields are ignored.';
    return schema;
  })(),
  InitMultipartUploadRequest: fromZod(initMultipartUploadSchema), CompleteMultipartUploadRequest: fromZod(completeMultipartUploadSchema),
  LoginRequest: fromZod(loginRequestSchema), RegisterRequest: fromZod(registerRequestSchema), ChangePasswordRequest: (() => {
    const schema = fromZod(changePasswordRequestSchema);
    (schema.properties as Record<string, Schema>).revokeApiKeys = { ...(schema.properties as Record<string, Schema>).revokeApiKeys,
      description: 'Default true: revoke every unrevoked API key of this user in the same change. Keep the default when the account may be compromised.' };
    return schema;
  })(),
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
export const pageQuery = [query('cursor', { type: 'string', maxLength: 128 }, 'Opaque server nextCursor. Omit on first page; null means no next page. A cursor that is present but cannot be decoded returns 400 validation_failed instead of silently restarting from the first page.'), query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 30 })];
export const listQuery = [query('direction', { type: 'string', enum: ['inbound', 'outbound'] }), query('domain', str), query('address', str),
  ...['unread', 'starred', 'trash'].map(name => query(name, { type: 'string', enum: ['1', 'true', '0', 'false'] })),
  query('q', { type: 'string', maxLength: 256 }, 'Literal substring search in subject/from/body; Unicode is supported.'),
  ...scopeQuery, query('afterId', int, 'Only IDs greater than this value; 0 starts from the beginning. Never advance past unprocessed messages.'), ...pageQuery];
export const idempotencyHeader = { name: 'Idempotency-Key', in: 'header', required: false,
  description: 'Use one stable unique visible-ASCII key per logical send, persisted with the request. After a network error, timeout or 5xx, retry the identical request with the same key: a finished send is replayed (201 with the original summary, or the same 422 delivery_failed when every recipient failed) and a send that failed before creating its outbound record continues. 409 send_in_progress: still processing or result unconfirmed; inspect the outbox and retry later with the same key, never with a fresh one. 409 idempotency_mismatch: the key was used for different content; check the original send and use a new key for new content. Business errors raised before sending (400, 403, 404, 413, 429) release the key, so the corrected request may reuse it. After 422 delivery_failed, correct the recipients and use a new key. A partial-success response should retry only recipientOutcomes marked failed, with a new logical key; confirm unknown recipients before resending to them. Outbound mail still pending an hour after creation is marked unknown, after which the same key replays 201 with status unknown. Completed keys are retained at least two days.',
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
      404: 'Resource not found or not visible', 409: 'Conflict or stale revision; for sends idempotency_mismatch or send_in_progress', 413: 'Payload exceeds limits', 429: 'Rate limit or quota exceeded', 500: 'Server or notification-delivery error' } as Record<number, string>)[code],
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
/** 发信：/api/messages/send 与 /v1/messages 同一份请求、结果与错误说明；/v1 另声明 scope */
export function sendMailOperation(scope?: string): Operation {
  const keyScopes = scope
    ? ` API keys need ${scope}; replyToMessageId or forwardAttachmentsFrom additionally require mail.read (403 without it).` : '';
  const base = operation('Send, reply, resend or forward mail', ref('MessageSummary'), { request: 'SendMailRequest', scope, status: 201, parameters: [idempotencyHeader],
    description: `HTTP 201 means at least one recipient succeeded: status is sent or delivered (or unknown when replaying an interrupted send). Partial failure is still 201, so always inspect errorDetail and recipientOutcomes, and retry only the failed recipients with a new key, keeping to/cc/bcc groups; use forwardAttachmentsFrom=<this id> for the attachments. When every recipient was attempted and rejected the response is 422 delivery_failed with error.details.messageId and error.details.recipientOutcomes, and replaying the same Idempotency-Key returns the same 422. Provider-accepted sent is not proof of recipient inbox delivery. Choose from with GET /identities. Recipients accept display names, replyTo sets Reply-To, headers adds X-* and allowlisted headers, and attachments or attachmentTokens with contentId embed inline images. Draft attachmentTokens come from /uploads; base64 attachments are also supported. Large external attachments become signed links valid for 90 days independently of sent-mail deletion. There is no separate reply or forward endpoint (POST /messages/{id} does not exist): set replyToMessageId (or headers In-Reply-To/References for mail from outside this site) or forwardAttachmentsFrom here; a missing or invisible source message, or a lost forwarded attachment, returns 404 source_unavailable, and removing the reference sends a new message. Idempotency conflicts return 409 idempotency_mismatch or send_in_progress, see the Idempotency-Key header.${keyScopes} Errors carry fix and docs hints.` });
  const error = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
  return { ...base,
    responses: { ...(base.responses as Record<string, unknown>),
      400: error('validation_failed (the message names the first invalid field; header value problems add details.headers), header_not_allowed (details.headers lists every rejected name), replyToMessageId combined with headers In-Reply-To/References, or a hosted-domain sender whose sending is not ready.'),
      403: error('forbidden: the API key lacks a scope (fix names it), or the sender identity is not allowed (fix points to GET /identities); shared mailboxes never send.'),
      413: error(`payload_too_large: request body over ${MAX_SEND_REQUEST_BYTES / 1024 / 1024} MiB (rejected before parsing), base64 attachments over ${MAX_INLINE_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MiB combined, or all attachments over ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MiB. Upload large files and use attachmentTokens.`),
      422: error('delivery_failed: every recipient was attempted and rejected, nothing was delivered. details.messageId is the recorded outbound message, details.recipientOutcomes the per-recipient errors. The same Idempotency-Key replays this 422; fix the recipients and send with a new key.'),
      429: error('rate_limited: request rate, or the daily outbound mail/recipient quota (GET /v1/me shows usage).'),
      500: error('internal: the server failed before every recipient was attempted. Retry the identical request with the same Idempotency-Key to fetch the result: it may be 201, or 422 delivery_failed whose recipientOutcomes show recipients that were never attempted.'),
    },
    ...(scope ? { 'x-conditional-scopes': [{ scope: 'mail.read', when: 'replyToMessageId or forwardAttachmentsFrom is present' }] } : {}) };
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
  return { title, description, version: '1.6.0', license: { name: 'MIT', identifier: 'MIT' },
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
export const identitiesDescription = 'Which addresses the caller can send from. identities lists caller-owned mailboxes (kind=owned) with canSend and reason, then mailboxes shared with the caller (kind=shared, always canSend=false, reason=shared_readonly). Use a canSend=true entry as from (mailboxId or address). domains lists system domains where any local part may be used; only administrators get entries. Administrators may still send from any claimed mailbox by mailboxId; those are not listed.';
/** 批量认领、批量可用性与随机后缀方案：会话与 API Key 两套接口同形，API Key 另需 scope */
export function mailboxBatchPaths(scopes?: { read: string; write: string }): Paths {
  return {
    '/mailboxes/batch': { post: operation('Claim several addresses in order', ref('BatchClaimMailboxResult'), { request: 'BatchMailboxRequest', scope: scopes?.write,
      description: 'Same rules as POST /mailboxes, applied to each item in request order. Each item accepts optional strategy; claude rechecks current suspension facts inside the write transaction and stops with forbidden when a domain has any historical suspension. An already-claimed address is skipped into taken and the batch continues; any other error stops the batch, keeps the addresses already claimed and reports stoppedBy with the remaining items in notAttempted.' }) },
    '/mailboxes/availability/batch': { post: operation('Check availability of several addresses', array(ref('MailboxAvailability')), { request: 'BatchMailboxRequest', scope: scopes?.read,
      description: 'Advisory only, same rules as GET /mailboxes/availability. Results follow request order.' }) },
    '/mailboxes/random-plan': { get: operation('Allocate random suffixes for a batch claim', ref('ClaimPlan'), { scope: scopes?.read,
      parameters: [query('count', { type: 'integer', minimum: 1, maximum: MAX_BATCH_CLAIM }, 'Number of addresses to allocate.', true),
        query('strategy', { type: 'string', enum: ['uniform', 'claude'] }, 'uniform: equal chance among eligible domains; claude: only zero-suspension domains, balanced by Claude accounts plus pending claims.', true)],
      description: 'Read-only: allocates domains, does not claim or reserve. Candidates are the domains the caller may claim with domains.list[].random true, trimmed by per-domain and per-user remaining quota. The claude strategy excludes every domain with any historical Claude suspension from both items and pool, regardless of paid status or deprecated thresholds. It balances accounts plus recent pending claims and stops at claim_random.dailyLimit or claim quotas without spilling over to suspended domains. Generate prefixes, then pass strategy=claude on each item for availability and actual claims, including after manual suffix changes. Claims atomically recheck suspension facts; a plan does not reserve eligibility.' }) },
  };
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

/** 可选分页的列表：出现 cursor 或 limit 即返回 Page，都不出现时返回旧版完整数组 */
const pageSwitch = 'Presence of cursor or limit (even empty) switches the response from the full array to a page {items, nextCursor}.';
export const optionalPageQuery = [
  query('cursor', { type: 'string', maxLength: 128 }, `${pageSwitch} Pass the previous nextCursor unchanged; empty means the first page; null nextCursor means no next page. A cursor that is present but cannot be decoded returns 400 validation_failed.`),
  query('limit', { type: 'integer', minimum: 1, maximum: LIST_PAGE_MAX_LIMIT, default: LIST_PAGE_DEFAULT_LIMIT }, `${pageSwitch} Items per page.`),
];
export const arrayOrPage = (items: Schema): Schema => ({ oneOf: [
  { ...array(items), title: 'Full array (neither cursor nor limit present)' },
  { ...page(items), title: 'Page (cursor or limit present)' },
] });
export const mailboxSearchQuery = [
  query('q', { type: 'string', maxLength: 254 }, 'Case-insensitive literal substring of the address or the owner username (no wildcards).'),
  query('domain', domainName, 'Exact domain.'),
];
export const mailboxListDescription = 'Ordered by mailbox id, newest first. q and domain filter in both response forms. Without cursor and limit the response stays the complete array, as before; scripts listing every mailbox with all=1 should page with limit and nextCursor instead.';
