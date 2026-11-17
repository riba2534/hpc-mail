import { confirmForwardRequestSchema, updateNotifyPrefsRequestSchema } from '@hpc-mail/shared';
import { array, fromZod, object, okResult, operation, ref, registerSchemas, str, success, type Paths, type Schema } from './openapi-common.js';

/** API Key 的通知配置请求：与会话接口同样的通道对象，但没有 forward 与 password */
function keyNotifyPrefsRequest(): Schema {
  const schema = fromZod(updateNotifyPrefsRequestSchema);
  const { forward: _forward, password: _password, ...properties } = schema.properties as Record<string, Schema>;
  return { ...schema, properties, minProperties: 1,
    description: 'Same channel objects as the session API, without forward: forwarding targets can only be changed in a web session, and a request containing forward returns 403 forbidden. At least one channel.' };
}

registerSchemas({
  ConfirmForwardRequest: fromZod(confirmForwardRequestSchema),
  UpdateKeyNotifyPrefsRequest: keyNotifyPrefsRequest(),
});

const restricted = 'Keys restricted to mailboxes or domains get 403 forbidden (key-restricted): these settings apply to all incoming mail of the account.';

/**
 * API Key 可用的通知配置（/v1/notify-prefs*，notify.read / notify.write）与共享管理（/v1/mailboxes/shares*，mailbox.share）。
 */
export function accountKeyPaths(): Paths {
  return {
    '/notify-prefs': {
      get: operation('getNotifyPrefs', 'Read masked notification preferences', ref('NotifyPrefs'), { scope: 'notify.read',
        description: 'Same masked structure as the session API GET /me/notify-prefs, including forward (read-only for keys) and forwardPending. Secrets are returned as ******.' }),
      put: { ...operation('updateNotifyPrefs', 'Update Feishu, PushDeer or generic webhook notification settings', ref('NotifyPrefs'), { scope: 'notify.write', request: 'UpdateKeyNotifyPrefsRequest',
        errors: ['ForwardSessionOnly', 'KeyRestricted', 'PushKeyReentryRequired', 'ForbiddenScopeMailRead', 'NotifyNeedsAdminScope'],
        description: `These channels push the subject, code and a body excerpt of incoming mail, so the key also needs mail.read; an administrator's settings also cover unclaimed addresses, so an administrator key needs the admin scope (403 otherwise). Replaces only the supplied channels; ****** keeps a stored secret, an empty string clears it. Enabled channels need a complete valid configuration (https public endpoints). forward cannot be changed with an API key: a request containing forward returns 403 forbidden, because forwarding sends every incoming mail elsewhere; ask the user to change it in the web session. ${restricted}` }),
        'x-required-scopes': ['notify.write', 'mail.read'] },
    },
    '/notify-prefs/health': { get: operation('getNotifyHealth', 'Read recent notification delivery health and forwarding quotas', ref('NotificationHealth'), { scope: 'notify.read',
      errors: ['KeyRestricted'],
      description: `Same as the session API. ${restricted}` }) },
    '/notify-prefs/jobs/{id}/retry': { post: operation('retryNotification', 'Retry a failed or unknown notification job', okResult, { scope: 'notify.write',
      errors: ['NotificationNotRetryable', 'KeyRestricted'],
      description: `Same rules as the session API: only failed/unknown mail notification jobs of the key owner, the channel must be enabled; queued, not delivered. ${restricted}` }) },
    '/notify-prefs/feishu-test': { post: operation('testFeishuNotification', 'Send a real Feishu test with the saved settings', okResult, { scope: 'notify.write',
      errors: ['NotificationTestFailed', 'KeyRestricted'],
      description: `Performs an external notification with the saved configuration; failures return an error. ${restricted}` }) },
    '/notify-prefs/pushdeer-test': { post: operation('testPushDeerNotification', 'Send a real PushDeer test with the saved settings', okResult, { scope: 'notify.write',
      errors: ['PushKeyMissing', 'KeyRestricted'],
      description: `Performs an external notification with the saved configuration; failures return an error. ${restricted}` }) },
    '/mailboxes/shares': {
      get: operation('listMailboxShares', 'List grants on mailboxes owned by the key owner', array(ref('MailboxShareGrant')), { scope: 'mailbox.share',
        description: 'Same as the session API GET /mailboxes/shares. A key restricted to mailboxes or domains only sees mailboxes in its range.' }),
      put: operation('replaceMailboxShares', 'Replace the grantees of an owned mailbox', ref('MailboxShareGrant'), { scope: 'mailbox.share', request: 'ReplaceMailboxSharesRequest',
        errors: ['ShareOwnMailboxOnly', 'ShareToOwner', 'GranteeMissing', 'MailboxOwnerChanged', 'KeyRestricted'],
        description: 'userIds replaces the whole list; [] revokes all. Grantees are identified by user id only; there is no user search for API keys (ask the user for the id). At most 100 active users, excluding the owner. expectedOwnerId optionally detects stale ownership with 409. Only mailboxes the key owner owns, even for administrator keys. Shares grant read-only access to non-deleted inbound mail. A restricted key gets 403 for mailboxes outside its range.' }),
    },
    '/mailboxes/shares/batch': { post: operation('shareMailboxes', 'Add the same grantees to several owned mailboxes', array(ref('MailboxShareGrant')), { scope: 'mailbox.share', request: 'BatchShareMailboxesRequest',
      errors: ['ShareOwnMailboxOnly', 'GranteeMissing', 'BatchStateChanged', 'KeyRestricted'],
      description: 'Appends grantees (by user id) to each listed mailbox owned by the key owner; existing grants are kept. A restricted key gets 403 if any mailbox is outside its range.' }) },
    '/mailboxes/shares/{mailboxId}/grantees/{userId}': { delete: operation('revokeMailboxShare', 'Revoke one grantee of an owned mailbox', success, { scope: 'mailbox.share',
      errors: ['KeyRestricted'],
      description: 'A restricted key gets 403 for mailboxes outside its range.' }) },
  };
}

/** 网页会话侧新增的公开路径：/api/forward-confirmations* */
export function accountSessionPaths(): Paths {
  return {
    '/forward-confirmations/confirm': { post: operation('confirmForwardTarget', 'Confirm receiving forwarded mail', object({ address: str }), { public: true, request: 'ConfirmForwardRequest',
      errors: ['ForwardConfirmInvalid', 'ForwardTargetLimit', 'Internal'], example: { address: 'friend@example.net' },
      description: 'Public. The token comes from the confirmation mail sent to a new forwarding target (link /forward/confirm#token=…); after confirmation the address joins the owner’s forwarding targets. Invalid or expired tokens return 404. A user can have at most five targets; 409 when the limit was reached meanwhile.' }) },
  };
}
