import {
  createWebhookEndpointRequestSchema,
  MAX_WEBHOOK_ENDPOINTS_PER_USER,
  updateWebhookEndpointRequestSchema,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
} from '@hpc-mail/shared';
import {
  array, bool, date, fromZod, int, nullable, object, operation, page, pageQuery, positiveId, ref, registerSchemas, str, success, type Paths,
} from './openapi-common.js';

const eventType = { type: 'string', enum: WEBHOOK_EVENT_TYPES };
const endpoint = object({
  id: positiveId, url: str, description: str, events: array(eventType),
  addresses: { ...array(str), description: 'Address filter; OR-ed with domains. Both empty: every event of the subscribed types. Hosted-domain events only match domains.' },
  domains: array(str), includeBody: { ...bool, description: 'mail.received carries message.text and message.html (each truncated to 65536 characters, bodyTruncated tells).' },
  status: { type: 'string', enum: ['active', 'disabled'] },
  disabledReason: { ...str, description: 'Empty when disabled by hand; explains an automatic disable after consecutive failures.' },
  consecutiveFailures: int, lastSuccessAt: nullable(date), lastFailureAt: nullable(date),
  secretPrefix: { ...str, description: 'whsec_ plus 4 characters of the signing secret, to check the receiver configuration.' },
  createdAt: date, updatedAt: date,
});

registerSchemas({
  WebhookEndpoint: endpoint,
  CreatedWebhookEndpoint: object({ ...(endpoint.properties as Record<string, Record<string, unknown>>),
    secret: { ...str, description: 'Signing secret (whsec_ + base64 of 32 random bytes), returned only on create and rotate. Store it securely.' } }),
  WebhookDelivery: object({
    id: positiveId, endpointId: positiveId, eventId: { ...str, description: 'The webhook-id header; unchanged across retries.' }, eventType,
    status: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'failed'] }, attempts: int, maxAttempts: positiveId,
    nextAttemptAt: nullable(date), lastAttemptAt: nullable(date), lastError: str, lastHttpStatus: nullable(int), createdAt: date,
  }),
  WebhookTestResult: object({ ok: bool, httpStatus: nullable(int), error: str, durationMs: int }),
  CreateWebhookEndpointRequest: fromZod(createWebhookEndpointRequestSchema),
  UpdateWebhookEndpointRequest: fromZod(updateWebhookEndpointRequestSchema),
});

const contract = `Events are POSTed as JSON {id,type,timestamp,data} with Svix-compatible headers webhook-id (the event id, stable across retries; deduplicate on it), webhook-timestamp (unix seconds) and webhook-signature "v1,<base64 HMAC-SHA256 of '<id>.<timestamp>.<body>' keyed with the base64-decoded secret after whsec_>"; standard Svix libraries verify it. Any 2xx within 10 seconds is success; redirects are not followed. Failures are retried with backoff for ${WEBHOOK_MAX_ATTEMPTS} attempts in total (about 1.5 days); when the last automatic attempt fails and the endpoint had no success since that event, the endpoint is disabled (disabledReason) and the owner is told through their Feishu/PushDeer settings. Event types: ${WEBHOOK_EVENT_TYPES.join(', ')}.`;

/**
 * Webhook v2 端点的 OpenAPI 路径：kind=api 为网页会话 /api/webhooks，kind=v1 为 API Key /v1/webhooks（webhook.write）。
 */
export function webhookPaths(kind: 'api' | 'v1'): Paths {
  const scope = kind === 'v1' ? 'webhook.write' : undefined;
  const restricted = kind === 'v1'
    ? ' A key restricted to mailboxes or domains only sees and manages endpoints whose filters are non-empty and inside its range (others are 404; creating or updating outside it is 403).' : '';
  return {
    '/webhooks': {
      get: operation('List Webhook v2 endpoints', array(ref('WebhookEndpoint')), { scope, description: `Endpoints of the caller, without secrets.${restricted}` }),
      post: operation('Create a Webhook v2 endpoint', ref('CreatedWebhookEndpoint'), { scope, request: 'CreateWebhookEndpointRequest', status: 201,
        description: `At most ${MAX_WEBHOOK_ENDPOINTS_PER_USER} endpoints per user (403 beyond). url must be https on a public host: private, reserved, link-local and metadata addresses, URL credentials and this site's own hosts and system domains are rejected with 400. ${contract}${restricted}` }),
    },
    '/webhooks/{id}': {
      get: operation('Read a Webhook v2 endpoint', ref('WebhookEndpoint'), { scope }),
      put: operation('Update a Webhook v2 endpoint', ref('WebhookEndpoint'), { scope, request: 'UpdateWebhookEndpointRequest',
        description: `Only supplied fields change; lists replace the whole list. enabled:true re-enables an endpoint (clearing disabledReason and the failure count); failed deliveries are not resent automatically, retry them explicitly.${restricted}` }),
      delete: operation('Delete a Webhook v2 endpoint and its delivery records', success, { scope }),
    },
    '/webhooks/{id}/rotate-secret': { post: operation('Rotate the signing secret', ref('CreatedWebhookEndpoint'), { scope,
      description: 'The new secret takes effect immediately for every following attempt and is returned only here.' }) },
    '/webhooks/{id}/test': { post: operation('Send a webhook.test event now', ref('WebhookTestResult'), { scope,
      description: 'Synchronously sends {type:"webhook.test"} signed like real events and reports the receiver response; a failing receiver is still HTTP 200 with ok=false. Works on disabled endpoints; not recorded as a delivery.' }) },
    '/webhooks/{id}/deliveries': { get: operation('List recent deliveries of an endpoint', page(ref('WebhookDelivery')), { scope, parameters: pageQuery,
      description: 'Newest first; terminal records are kept about 30 days. Payloads are not returned.' }) },
    '/webhooks/{id}/deliveries/{deliveryId}/retry': { post: operation('Retry a failed delivery once', ref('WebhookDelivery'), { scope,
      description: 'Only failed deliveries of an active endpoint (409 otherwise); sends one more attempt with the same webhook-id. Deliveries whose source message was purged cannot be retried.' }) },
  };
}
