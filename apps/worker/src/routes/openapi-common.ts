import {
  API_SCOPES, ERROR_CODES, MAX_BODY_BYTES, MAX_RECIPIENTS, MAX_ATTACHMENTS, SINGLE_UPLOAD_THRESHOLD_BYTES, MULTIPART_PART_BYTES,
  SETTING_SCHEMAS, claimMailboxRequestSchema, updateMailboxRequestSchema, transferMailboxRequestSchema,
  internalSendMailSchema, markReadRequestSchema, deleteMessagesRequestSchema, starMessagesRequestSchema,
  initMultipartUploadSchema, completeMultipartUploadSchema, loginRequestSchema, registerRequestSchema,
  changePasswordRequestSchema, uploadAvatarRequestSchema, enableTwoFactorRequestSchema, disableTwoFactorRequestSchema,
  createUserRequestSchema, updateUserRequestSchema, createApiKeyRequestSchema, updateApiKeyRequestSchema,
  createInviteRequestSchema, replaceMailboxSharesRequestSchema, updateSettingsRequestSchema,
  updateNotifyPrefsRequestSchema, userNotifyPrefsSchema,
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
const settingsUpdate = fromZod(updateSettingsRequestSchema);
(settingsUpdate.properties as Record<string, Schema>).domains = object({ list: { ...array({ anyOf: [domainName, domainEntry] }), maxItems: 64, 'x-unique-normalized-domain': true }, revision: int }, ['revision']);
settingsUpdate.description = 'Partial settings update. A domains replacement requires expectedDomainsRevision from the latest GET; stale revisions return 409. Adding a domain does not configure DNS or Cloudflare Email Routing. Removing a domain only removes new-claim availability, and preserves existing mailbox routing. At least one setting key is required.';
settingsUpdate.dependentRequired = { domains: ['expectedDomainsRevision'] };
const settingsResponse = object(Object.fromEntries(Object.entries(SETTING_SCHEMAS).map(([key, schema]) => [key, fromZod(schema, 'output')])));
const notifyPrefs = fromZod(userNotifyPrefsSchema, 'output');
notifyPrefs.description = 'Personal preferences. Configured feishu.secret, webhook.secret and pushdeer.pushkey are returned as ******; plaintext secrets are never returned. In updates ****** preserves the secret and an explicit empty string clears it. Enabled configurations must have valid complete endpoints/keys/forward addresses. These are mail-owner notifications; shared mailbox readers do not receive owner notifications.';
const messageSummary = object({
  id: positiveId, direction: { type: 'string', enum: ['inbound', 'outbound'] }, address: str, domain: str,
  fromAddress: str, fromName: str, subject: str, preview: str, verificationCode: str,
  status: { type: 'string', description: 'Inbound: pending, received or degraded. Outbound: pending, sent, delivered or failed. sent means the provider accepted at least one external delivery; it is not proof of arrival in the destination inbox.' },
  errorDetail: str, recipientOutcomes: array(object({ address: str, status: { type: 'string', enum: ['delivered', 'sent', 'failed'] }, error: str }, ['error'])),
  recipientsTo: array(str), isRead: bool, isStarred: bool, hasAttachments: bool, size: int, createdAt: date,
}, ['recipientOutcomes', 'recipientsTo']);
const summaryProperties = messageSummary.properties as Record<string, Schema>;
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
    bodyText: str, bodyHtml: str, attachments: array(ref('Attachment')), hasRaw: bool }, ['recipientOutcomes', 'recipientsTo', 'replyTo']),
  MessagePage: page(ref('MessageSummary')), Attachment: attachment, Mailbox: mailbox,
  UserSearchResults: object({ items: array(object({ id: positiveId, username: str, role: { type: 'string', enum: ['admin', 'user'] } })), hasMore: bool }),
  MailboxTransferResult: object({ mailbox: ref('Mailbox'), previousUserId: positiveId, transferred: bool, revokedShares: int }),
  SharedMailbox: object({ mailboxId: positiveId, address: str, domain: str, displayName: str, ownerUsername: str }),
  MailboxShareGrant: object({ mailboxId: positiveId, address: str, domain: str, displayName: str,
    grantees: array(object({ userId: positiveId, username: str, grantedAt: date })) }),
  MailboxAvailability: object({ address: str, available: bool }), SessionUser: user,
  LoginResponse: object({ token: { ...str, description: 'Bearer JWT session token; store securely and never include it in published logs.' }, user: ref('SessionUser') }),
  AdminUser: object({ ...adminUserProperties, status: { type: 'string', enum: ['active', 'disabled'] },
    mailboxCount: int, mailboxes: array(str), apiKeyCount: int, lastLoginAt: nullable(date) }),
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
  PublicConfig: object({ siteTitle: str, registrationMode: { type: 'string', enum: ['closed', 'invite', 'open'] }, domains: array(str), require2fa: bool }),
  SendMailRequest: send,
  ClaimMailboxRequest: fromZod(claimMailboxRequestSchema), UpdateMailboxRequest: fromZod(updateMailboxRequestSchema),
  TransferMailboxRequest: fromZod(transferMailboxRequestSchema),
  MarkReadRequest: fromZod(markReadRequestSchema), MessageIdsRequest: fromZod(deleteMessagesRequestSchema), StarMessagesRequest: fromZod(starMessagesRequestSchema),
  MutationScopeRequest: object({ scope: { type: 'string', enum: ['mine', 'unclaimed'] } }, ['scope']),
  InitMultipartUploadRequest: fromZod(initMultipartUploadSchema), CompleteMultipartUploadRequest: fromZod(completeMultipartUploadSchema),
  LoginRequest: fromZod(loginRequestSchema), RegisterRequest: fromZod(registerRequestSchema), ChangePasswordRequest: fromZod(changePasswordRequestSchema),
  UploadAvatarRequest: fromZod(uploadAvatarRequestSchema), EnableTwoFactorRequest: fromZod(enableTwoFactorRequestSchema), DisableTwoFactorRequest: fromZod(disableTwoFactorRequestSchema),
  CreateUserRequest: fromZod(createUserRequestSchema), UpdateUserRequest: fromZod(updateUserRequestSchema), CreateApiKeyRequest: fromZod(createApiKeyRequestSchema),
  UpdateApiKeyRequest: fromZod(updateApiKeyRequestSchema), CreateInviteRequest: fromZod(createInviteRequestSchema), ReplaceMailboxSharesRequest: fromZod(replaceMailboxSharesRequestSchema),
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
      name: match[1], in: 'path', required: true, schema: match[1] === 'token' ? { type: 'string', minLength: 1 } : positiveId,
    })) } : {}),
    ...Object.fromEntries(Object.entries(methods).map(([method, value]) => [method, {
      ...value, operationId: `${namespace}${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    }])),
  }])) as Paths;
}
export function specInfo(title: string, description: string) {
  return { title, description, version: '1.3.0', license: { name: 'MIT', identifier: 'MIT' },
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
