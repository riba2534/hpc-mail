import {
  ALLOWED_CUSTOM_HEADERS, MAX_INLINE_ATTACHMENT_TOTAL_BYTES, MAX_REPLY_TO, MAX_SEND_REQUEST_BYTES, MAX_TRANSLATE_BATCH_CHARS,
  MAX_TRANSLATE_SEGMENT_CHARS, MAX_TRANSLATE_SEGMENTS, OUTBOUND_STATUSES, internalSendMailSchema,
} from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import type { Schema } from '../src/routes/openapi-common.js';
import { MAX_HOSTED_CHECKS_PER_MINUTE, MAX_HOSTED_CREATES_PER_MINUTE, MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE } from '../src/services/hosted-domain.js';
import skillDoc from '../../web/public/skill.md?raw';
import llmsDoc from '../../web/public/llms.txt?raw';
import administrationDoc from '../../web/public/references/administration.md?raw';
import attachmentsDoc from '../../web/public/references/attachments.md?raw';
import authDoc from '../../web/public/references/auth-and-http.md?raw';
import errorsDoc from '../../web/public/references/errors.md?raw';
import mailDoc from '../../web/public/references/mail.md?raw';
import mailboxesDoc from '../../web/public/references/mailboxes-and-domains.md?raw';
import notificationsDoc from '../../web/public/references/notifications.md?raw';

const app = createApp();
const origin = 'https://mail.example';
const specs = { api: buildSessionOpenApiSpec(origin), v1: buildOpenApiSpec(origin) };
const methods = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);

function operations(namespace: keyof typeof specs) {
  return Object.entries(specs[namespace].paths).flatMap(([path, item]) => Object.keys(item)
    .filter(method => methods.has(method)).map(method => `${method.toUpperCase()} /${namespace}${path}`));
}
function visit(value: unknown, callback: (value: Schema) => void) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) value.forEach(item => visit(item, callback));
  else { callback(value as Schema); Object.values(value).forEach(item => visit(item, callback)); }
}

describe('OpenAPI routes and public contracts', () => {
  it('publishes 999 as the batch claim, availability and random-plan upper bound', () => {
    const batch = specs.api.components.schemas.BatchMailboxRequest!;
    expect((batch.properties as Record<string, Schema>).items).toMatchObject({ minItems: 1, maxItems: 999 });
    const params = specs.api.paths['/mailboxes/random-plan']!.get!.parameters as Array<{ name: string; schema: Schema }>;
    expect(params.find((param) => param.name === 'count')?.schema).toMatchObject({ minimum: 1, maximum: 999 });
    for (const path of ['/mailboxes/batch', '/mailboxes/availability/batch']) {
      expect(specs.api.paths[path]!.post!.requestBody).toMatchObject({ content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchMailboxRequest' } } } });
    }
  });
  it('publishes the optional zero-suspension strategy consistently in JWT and API Key requests', () => {
    for (const spec of Object.values(specs)) {
      const request = spec.components.schemas.ClaimMailboxRequest!;
      expect((request.properties as Record<string, Schema>).strategy).toMatchObject({ enum: ['uniform', 'claude'] });
      expect(request.required).not.toContain('strategy');
      const params = spec.paths['/mailboxes/availability']!.get!.parameters as Array<{ name: string; required: boolean; schema: Schema }>;
      expect(params.find((param) => param.name === 'strategy')).toMatchObject({ required: false, schema: { enum: ['uniform', 'claude'] } });
      expect((spec.components.schemas.MailboxAvailability!.properties as Record<string, Schema>).reason!.enum).toContain('claude_suspended');
    }
    const batchItem = ((specs.api.components.schemas.BatchMailboxRequest!.properties as Record<string, Schema>).items!.items as Schema);
    expect((batchItem.properties as Record<string, Schema>).strategy).toMatchObject({ enum: ['uniform', 'claude'] });
    const risk = (specs.api.components.schemas.DomainClaudeStats!.properties as Record<string, Schema>).risk!;
    expect(risk).toMatchObject({ anyOf: [{ enum: expect.arrayContaining(['suspended']) }, { type: 'null' }] });
    const settings = specs.api.components.schemas.Settings!;
    const rules = (settings.properties as Record<string, Schema>).claim_random!.properties as Record<string, Schema>;
    expect(rules.paidSuspendedLimit!.deprecated).toBe(true);
    expect(rules.suspendedPercent!.deprecated).toBe(true);
  });

  it('documents hosted-domain DNS records with string record ids and one input variant per supported type', () => {
    const params = specs.api.paths['/hosted-domains/{id}/dns-records/{recordId}']!.parameters as unknown as Array<{ name: string; schema: Schema }>;
    expect(params.find((param) => param.name === 'recordId')?.schema).toMatchObject({ type: 'string', pattern: '^[0-9a-f]{32}$' });
    const input = specs.api.components.schemas.HostedDnsRecordInput!;
    expect((input.oneOf as Schema[]).map((variant) => ((variant.properties as Record<string, Schema>).type as Schema).const))
      .toEqual(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA']);
    const [a, aaaa] = (input.oneOf as Schema[]).map((variant) => (variant.properties as Record<string, Schema>).content);
    expect(a).toEqual({ type: 'string', format: 'ipv4' });
    expect(aaaa).toEqual({ type: 'string', format: 'ipv6' });
    const record = specs.api.components.schemas.HostedDnsRecord!.properties as Record<string, Schema>;
    expect(record.kind).toMatchObject({ enum: ['user', 'mail', 'readonly'] });
    // 响应原样返回 readonly CAA 的取值，请求体仍只接受表单支持的 flags 与 tag
    const caaResponse = ((record.caa!.anyOf as Schema[])[0]!.properties as Record<string, Schema>);
    expect(caaResponse.flags).toEqual({ type: 'integer', minimum: 0 });
    expect(caaResponse.tag).toEqual({ type: 'string' });
    const caaInput = (((input.oneOf as Schema[]).at(-1)!.properties as Record<string, Schema>).caa!.properties as Record<string, Schema>);
    expect(caaInput.tag).toMatchObject({ enum: ['issue', 'issuewild', 'iodef'] });
    expect(specs.v1.paths).not.toHaveProperty('/hosted-domains/{id}/dns-records');
  });

  it('describes every mounted endpoint and does not invent unimplemented endpoints', () => {
    const mounted = [...new Set(app.routes.filter(route => methods.has(route.method.toLowerCase()) && !route.path.includes('*'))
      .map(route => `${route.method} ${route.path.replace(/\/$/, '').replace(/:([^/]+)/g, '{$1}')}`))].sort();
    expect([...operations('api'), ...operations('v1')].sort()).toEqual(mounted);
  });

  it.each(['api', 'v1'] as const)('publishes the %s specification without authentication or a data envelope', async namespace => {
    const ctx = createExecutionContext();
    const response = await app.request(`${origin}/${namespace}/openapi.json`, {}, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as typeof specs.api;
    expect(body.openapi).toBe('3.1.0');
    expect(body.servers[0]?.url).toBe(`${origin}/${namespace}`);
    expect(body).not.toHaveProperty('data');
    expect(body.paths).toHaveProperty('/uploads/multipart/{token}/complete');
    expect(body['x-relatedApis']).toHaveLength(1);
  });

  it('resolves every schema reference and declares every path parameter exactly once', () => {
    for (const spec of Object.values(specs)) {
      visit(spec, item => {
        if (typeof item.$ref === 'string') {
          const name = item.$ref.replace('#/components/schemas/', '');
          expect(item.$ref).toBe(`#/components/schemas/${name}`);
          expect(spec.components.schemas).toHaveProperty(name);
        }
      });
      for (const [path, item] of Object.entries(spec.paths)) {
        const params = (item.parameters as unknown as Array<{ name: string; in: string; required: boolean }> | undefined) ?? [];
        expect(params.filter(param => param.in === 'path').map(param => param.name).sort())
          .toEqual(Array.from(path.matchAll(/\{([^}]+)\}/g), match => match[1]).sort());
        expect(params.every(param => param.required)).toBe(true);
      }
    }
  });

  it('keeps operation ids unique across both authentication APIs', () => {
    const ids = Object.values(specs).flatMap(spec => Object.values(spec.paths).flatMap(item => Object.entries(item)
      .filter(([method]) => methods.has(method)).map(([, operation]) => operation.operationId)));
    expect(ids.every(id => typeof id === 'string')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents auth boundaries and scopes without granting admin functions to API keys', () => {
    expect(specs.api.security).toEqual([{ sessionToken: [] }]);
    expect(specs.api.paths['/auth/login']?.post?.security).toEqual([]);
    expect(specs.api.paths['/admin/settings']?.put?.['x-required-role']).toBe('admin');
    expect(specs.v1.paths).not.toHaveProperty('/admin/settings');
    expect(specs.v1.paths['/messages']?.post?.['x-required-scopes']).toEqual(['mail.send']);
    expect(specs.v1.paths['/uploads']?.post?.['x-required-scopes']).toEqual(['mail.send']);
    expect(specs.v1.paths['/mailboxes']?.post?.['x-required-scopes']).toEqual(['mailbox.write']);
    expect(specs.api.paths['/attachments/{id}']?.get?.security).toEqual([{ sessionToken: [] }, { attachmentSignature: [], attachmentExpiry: [] }]);
  });

  it('describes concrete responses including distinct domain envelopes, partial results and pagination', () => {
    const dataSchema = (operation: Schema, status = '200') => {
      const responses = operation.responses as Record<string, { content: Record<string, { schema: { properties: { data: Schema } } }> }>;
      return responses[status]!.content['application/json']!.schema.properties.data;
    };
    expect(dataSchema(specs.api.paths['/domains']!.get!).type).toBe('array');
    expect(dataSchema(specs.v1.paths['/domains']!.get!).properties).toHaveProperty('domains');
    expect(dataSchema(specs.v1.paths['/messages']!.get!)).toEqual({ $ref: '#/components/schemas/MessagePage' });
    expect(dataSchema(specs.v1.paths['/messages']!.post!, '201')).toEqual({ $ref: '#/components/schemas/MessageSummary' });
    expect(specs.v1.components.schemas.MessageSummary!.properties).toHaveProperty('recipientOutcomes');
    expect(specs.v1.components.schemas.MessageDetail!.properties).toHaveProperty('replyTo');
    expect(specs.v1.components.schemas.MessagePage!.required).toEqual(['items', 'nextCursor']);
  });

  it('documents usable send/upload/domain-CAS inputs rather than empty schemas', () => {
    const send = specs.v1.components.schemas.SendMailRequest!;
    const fields = send.properties as Record<string, Schema>;
    expect(send.required).toEqual(expect.arrayContaining(['from', 'to', 'subject']));
    expect(fields.from!.oneOf).toHaveLength(4);
    expect(fields.from).not.toHaveProperty('anyOf');
    const [base64Item, urlItem] = (fields.attachments!.items as Schema).anyOf as Schema[];
    expect(base64Item).toMatchObject({ type: 'object', required: ['filename', 'contentType', 'content'] });
    expect(urlItem).toMatchObject({ type: 'object', required: ['url'] });
    expect(fields.attachmentTokens).toMatchObject({ type: 'array', maxItems: 10 });
    expect(send['x-max-body-utf8-bytes']).toBe(1048576);
    const update = specs.api.components.schemas.UpdateSettingsRequest!;
    expect(update.dependentRequired).toEqual({ domains: ['expectedDomainsRevision'] });
    const domains = (update.properties as Record<string, Schema>).domains!;
    const entries = (domains.properties as Record<string, Schema>).list!.items as Schema;
    expect(entries.anyOf).toHaveLength(2);
    expect(specs.api.components.schemas.InitMultipartUploadRequest!.required).toEqual(['filename', 'mimeType', 'size']);
    for (const spec of Object.values(specs)) {
      const readAll = spec.paths['/messages/read-all']!.post!.requestBody as { required: boolean };
      expect(readAll.required).toBe(false);
      const params = spec.paths['/messages']!.get!.parameters as Array<{ name: string; schema: Schema }>;
      expect(params.find(param => param.name === 'afterId')?.schema.minimum).toBe(0);
    }
  });

  it('documents wait filters, verification links, trash timestamps, read-all filters and availability reasons', () => {
    const wait = specs.v1.paths['/messages/wait']!.get!;
    const waitParams = (wait.parameters as Array<{ name: string }>).map(param => param.name);
    expect(waitParams).toEqual(expect.arrayContaining(['from', 'subjectContains', 'hasCode', 'afterId']));
    const waitData = ((wait.responses as Record<string, { content: Record<string, { schema: { properties: { data: Schema } } }> }>)['200']!
      .content['application/json']!.schema.properties.data);
    expect(waitData.required).toEqual(['message', 'scannedThroughId']);
    for (const spec of Object.values(specs)) {
      const summary = spec.components.schemas.MessageSummary!;
      expect(summary.properties).toHaveProperty('verificationLink');
      expect(summary.properties).toHaveProperty('deletedAt');
      expect(summary.required).not.toContain('verificationLink');
      expect(summary.required).not.toContain('deletedAt');
      expect(spec.components.schemas.MessageDetail!.properties).toHaveProperty('verificationLink');
      expect(spec.components.schemas.MessageDetail!.properties).not.toHaveProperty('deletedAt');
      const readAll = spec.paths['/messages/read-all']!.post!.requestBody as { content: Record<string, { schema: Schema }> };
      expect(readAll.content['application/json']!.schema).toEqual({ $ref: '#/components/schemas/MarkAllReadRequest' });
      expect(Object.keys(spec.components.schemas.MarkAllReadRequest!.properties as Schema).sort()).toEqual(['address', 'domain', 'q', 'scope']);
      const availability = spec.components.schemas.MailboxAvailability!;
      expect(((availability.properties as Record<string, Schema>).reason!).enum).toEqual(['taken', 'reserved', 'quota', 'domain_limit', 'domain_unavailable', 'claude_suspended']);
      expect(availability.required).toEqual(['address', 'available']);
      expect(spec.components.schemas).not.toHaveProperty('MutationScopeRequest');
    }
  });

  it('documents JWT-only translation, its limits and the write-only provider key', () => {
    const translate = specs.api.paths['/messages/{id}/translate']!.post!;
    expect((translate.parameters as Array<{ name: string }>).map(param => param.name)).toEqual(['scope', 'userId']);
    expect(translate.requestBody).toMatchObject({ required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TranslateMessageRequest' } } } });
    expect(specs.v1.paths).not.toHaveProperty('/messages/{id}/translate');
    expect(specs.v1.components.schemas).not.toHaveProperty('MessageTranslation');
    const test = specs.api.paths['/admin/settings/ai-model-test']!.post!;
    expect(test['x-required-role']).toBe('admin');
    expect((test.requestBody as { required: boolean }).required).toBe(false);
    const schemas = specs.api.components.schemas;
    expect(schemas.TranslateMessageRequest!['x-max-total-chars']).toBe(MAX_TRANSLATE_BATCH_CHARS);
    expect((schemas.TranslateMessageRequest!.properties as Record<string, Schema>).segments).toMatchObject({ maxItems: MAX_TRANSLATE_SEGMENTS, items: { maxLength: MAX_TRANSLATE_SEGMENT_CHARS } });
    expect(schemas.MessageTranslation!.required).toEqual(['translations', 'cached', 'skipped']);
    expect(schemas.AiModelTestResult!.required).toEqual(['ok', 'latencyMs', 'sample']);
    expect(schemas.PublicConfig!.required).toContain('translationEnabled');
    for (const name of ['Settings', 'UpdateSettingsRequest']) {
      const properties = schemas[name]!.properties as Record<string, Schema>;
      expect(properties.ai_model!.description).toContain('verification-code fallback');
      expect(((properties.ai_model!.properties as Record<string, Schema>).apiKey!).description).toContain('******');
      expect(Object.keys(properties.translation!.properties as Schema).sort()).toEqual(['dailyCharsPerUser', 'enabled']);
    }
  });

  it('describes structured errors with request ids and avoids publishing plaintext credentials', async () => {
    const ctx = createExecutionContext();
    const response = await app.request('/api/unknown-openapi-test-route', {}, env, ctx);
    await waitOnExecutionContext(ctx);
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'not_found' }, requestId: expect.any(String) });
    const metadata = specs.api.components.schemas.ApiKeySummary!.properties as Record<string, Schema>;
    expect(metadata).not.toHaveProperty('key');
    expect(specs.api.components.schemas.NotifyPrefs!.description).toContain('******');
    const serialized = JSON.stringify(specs);
    expect(serialized).not.toContain(env.jwt_secret);
    expect(serialized).not.toContain('PDU_SYNTHETIC_TEST');
  });
});

describe('Phase-0 hardening is reflected in both OpenAPI documents', () => {
  const dataOf = (operation: Schema, status = '200') => {
    const responses = operation.responses as Record<string, { content: Record<string, { schema: { properties: { data: Schema } } }> }>;
    return responses[status]!.content['application/json']!.schema.properties.data;
  };

  it('publishes the split idempotency error codes and the X-Request-ID format', () => {
    for (const spec of Object.values(specs)) {
      const error = spec.components.schemas.Error!.properties as Record<string, Schema>;
      const code = (error.error!.properties as Record<string, Schema>).code!;
      expect(code.enum).toEqual(expect.arrayContaining(['idempotency_mismatch', 'send_in_progress']));
      expect(code.description).toContain('send_in_progress');
      expect(error.requestId!.description).toContain('^[A-Za-z0-9._:-]{1,64}$');
      expect(spec.info.description).toContain('X-Request-ID');
    }
    const header = (specs.v1.paths['/messages']!.post!.parameters as Array<{ name: string; description: string }>)
      .find(param => param.name === 'Idempotency-Key')!;
    expect(header.description).toContain('idempotency_mismatch');
    expect(header.description).toContain('send_in_progress');
  });

  it('requires mail.read for reply/forward sources and corrects the sender identity rules', () => {
    const send = specs.v1.paths['/messages']!.post!;
    expect(send['x-required-scopes']).toEqual(['mail.send']);
    expect(send['x-conditional-scopes']).toEqual([{ scope: 'mail.read', when: expect.stringContaining('forwardAttachmentsFrom') }]);
    const description = specs.v1.components.schemas.SendMailRequest!.description as string;
    expect(description).toContain('404 source_unavailable');
    expect(description).toContain('A missing sender mailboxId stays 404 not_found');
    for (const spec of Object.values(specs)) {
      const error = spec.components.schemas.Error!.properties as Record<string, Schema>;
      const code = (error.error!.properties as Record<string, Schema>).code!;
      expect(code.enum).toContain('source_unavailable');
      expect(code.description).toContain('source_unavailable (404)');
    }
    expect(specs.v1.paths['/messages/{id}']!.get!.description).toContain('expire after 5 minutes');
    expect(specs.api.paths['/messages/{id}']!.get!.description).toContain('valid for 1–2 hours');
    expect(specs.v1.info.description).toContain('（账户级）');
    expect(description).toContain('Administrators may use any claimed mailbox');
    expect(description).toContain('hosted domain');
    expect(description).not.toContain('A mailboxId must belong to the caller');
  });

  it('documents the unread-count scope as mine only', () => {
    const params = specs.v1.paths['/messages/unread-count']!.get!.parameters as Array<{ name: string; required: boolean; schema: Schema }>;
    expect(params).toEqual([expect.objectContaining({ name: 'scope', required: false, schema: { type: 'string', enum: ['mine'] } })]);
  });

  it('documents API key revocation on password change and administrator reset', () => {
    const request = specs.api.components.schemas.ChangePasswordRequest!;
    expect((request.properties as Record<string, Schema>).revokeApiKeys).toMatchObject({ type: 'boolean', default: true });
    expect(request.required).not.toContain('revokeApiKeys');
    expect(dataOf(specs.api.paths['/auth/password']!.put!)).toEqual({ $ref: '#/components/schemas/ChangePasswordResponse' });
    expect(specs.api.components.schemas.ChangePasswordResponse!.required).toEqual(['token', 'user', 'revokedApiKeys']);
    expect(specs.api.paths['/admin/users/{id}']!.put!.description).toContain('revokes every API key');
  });

  it('documents hosted-domain creation/check limits and scoped JWT attachment downloads', () => {
    const create = specs.api.paths['/hosted-domains']!.post!.description as string;
    const check = specs.api.paths['/hosted-domains/{id}/check']!.post!.description as string;
    expect(create).toContain(`More than ${MAX_HOSTED_CREATES_PER_MINUTE} attempts per user per minute`);
    expect(check).toContain(`More than ${MAX_HOSTED_CHECKS_PER_MINUTE} requests per user per minute`);
    for (const text of [create, check, specs.api.paths['/hosted-domains/{id}/dns-records']!.get!.description as string]) {
      expect(text).toContain('429 rate_limited');
      expect(text).toContain(`${MAX_HOSTED_DNS_SITE_CALLS_PER_MINUTE}`);
    }
    for (const description of [specs.api.paths['/admin/settings/ai-model-test']!.post!.description,
      ((specs.api.components.schemas.UpdateSettingsRequest!.properties as Record<string, Schema>).ai_model!.properties as Record<string, Schema>).apiKey!.description]) {
      expect(description).toContain('400 validation_failed');
    }
    const params = (specs.api.paths['/attachments/{id}']!.get!.parameters as Array<{ name: string }>).map(param => param.name);
    expect(params).toEqual(['exp', 'sig', 'scope', 'userId']);
  });
});

describe('Agent 接口第 1 期反映在 OpenAPI 中', () => {
  const dataOf = (operation: Schema) => {
    const responses = operation.responses as Record<string, { content: Record<string, { schema: { properties: { data: Schema } } }> }>;
    return responses['200']!.content['application/json']!.schema.properties.data;
  };

  it('发件身份、/v1/me 与邮箱 canSend', () => {
    expect(dataOf(specs.api.paths['/identities']!.get!)).toEqual({ $ref: '#/components/schemas/SendIdentities' });
    const identities = specs.v1.paths['/identities']!.get!;
    expect(dataOf(identities)).toEqual({ $ref: '#/components/schemas/SendIdentities' });
    expect(identities['x-required-scopes-any-of']).toEqual(['mail.send', 'mailbox.read']);
    const entry = ((specs.v1.components.schemas.SendIdentities!.properties as Record<string, Schema>).identities!.items as Schema).properties as Record<string, Schema>;
    expect((entry.reason!.anyOf as Schema[])[0]!.enum).toEqual(['hosted_sending_not_ready', 'hosted_domain_unavailable', 'shared_readonly']);
    const me = specs.v1.paths['/me']!.get!;
    expect(me).not.toHaveProperty('x-required-scopes');
    expect(dataOf(me)).toEqual({ $ref: '#/components/schemas/ApiKeySelf' });
    expect(specs.v1.components.schemas.ApiKeySelf!.required).toEqual(['key', 'user', 'limits', 'outbound']);
    expect(specs.api.components.schemas).not.toHaveProperty('ApiKeySelf');
    for (const spec of Object.values(specs)) {
      expect(spec.components.schemas.Mailbox!.properties).toHaveProperty('canSend');
      expect(spec.components.schemas.Mailbox!.required).not.toContain('canSend');
    }
  });

  it('批量认领、批量可用性、随机后缀方案在 /v1 按 scope 开放，与 /api 同形', () => {
    const scopes = { '/mailboxes/batch': ['post', 'mailbox.write'], '/mailboxes/availability/batch': ['post', 'mailbox.read'], '/mailboxes/random-plan': ['get', 'mailbox.read'] } as const;
    for (const [path, [method, scope]] of Object.entries(scopes)) {
      const v1 = specs.v1.paths[path]![method]!;
      const api = specs.api.paths[path]![method]!;
      expect(v1['x-required-scopes'], path).toEqual([scope]);
      expect(api, path).not.toHaveProperty('x-required-scopes');
      expect(v1.responses, path).toEqual(api.responses);
      expect(v1.requestBody, path).toEqual(api.requestBody);
      expect(v1.parameters, path).toEqual(api.parameters);
    }
  });

  it('wait 的多地址、domain、include=body，内联附件标记与非法 cursor', () => {
    const wait = specs.v1.paths['/messages/wait']!.get!;
    const params = Object.fromEntries((wait.parameters as Array<{ name: string; schema: Schema; description?: string }>).map(param => [param.name, param]));
    expect(params.address!.description).toContain('repeat the parameter');
    expect(params.domain!.schema).toMatchObject({ type: 'string', pattern: expect.any(String) });
    expect(params.include!.schema).toEqual({ type: 'string', enum: ['body'] });
    const message = (dataOf(wait).properties as Record<string, Schema>).message!;
    expect(message.anyOf).toEqual([{ $ref: '#/components/schemas/MessageSummary' }, { $ref: '#/components/schemas/MessageDetail' }, { type: 'null' }]);
    for (const spec of Object.values(specs)) {
      expect((spec.components.schemas.Attachment!.properties as Record<string, Schema>).inline).toMatchObject({ type: 'boolean' });
      const outcome = ((spec.components.schemas.MessageSummary!.properties as Record<string, Schema>).recipientOutcomes!.items as Schema).properties as Record<string, Schema>;
      expect(outcome.status!.enum).toContain('unknown');
    }
    const cursors = [specs.v1.paths['/messages']!.get!, specs.api.paths['/messages']!.get!, specs.api.paths['/admin/audit-logs']!.get!, specs.api.paths['/api-keys/{id}/logs']!.get!]
      .map(operation => (operation.parameters as Array<{ name: string; description: string }>).find(param => param.name === 'cursor')!.description);
    for (const description of cursors) expect(description).toContain('400 validation_failed');
  });
});

describe('第 1 期发信契约在两份 OpenAPI 与 Agent 文档中一致', () => {
  const props = (schema: Schema) => schema.properties as Record<string, Schema>;

  it('发信请求：from 四种写法、MailAddress 收件人、replyTo、headers 规则、内联附件与 token 对象', () => {
    for (const spec of Object.values(specs)) {
      const send = spec.components.schemas.SendMailRequest!;
      const fields = props(send);
      expect((fields.from!.oneOf as Schema[]).map(variant => variant.title))
        .toEqual(['Mailbox id', 'Local part and domain', 'Address string', 'Address object']);
      for (const name of ['to', 'cc', 'bcc', 'replyTo']) expect(fields[name]!.items, name).toEqual({ $ref: '#/components/schemas/MailAddress' });
      expect(fields.replyTo!.maxItems).toBe(MAX_REPLY_TO);
      expect(spec.components.schemas.MailAddress!.oneOf).toHaveLength(2);
      expect(fields.headers).toMatchObject({ type: 'object', 'x-allowed-headers': ALLOWED_CUSTOM_HEADERS });
      for (const text of ['header_not_allowed', 'details.headers', 'replyToMessageId']) expect(fields.headers!.description).toContain(text);
      const attachment = props(((fields.attachments!.items as Schema).anyOf as Schema[])[0]!);
      expect(attachment.contentId!.description).toContain('cid:');
      expect(attachment.disposition).toMatchObject({ enum: ['attachment', 'inline'] });
      const [token, tokenObject] = (fields.attachmentTokens!.items as Schema).oneOf as Schema[];
      expect(token).toMatchObject({ type: 'string' });
      expect(props(tokenObject!)).toHaveProperty('contentId');
      expect(send['x-max-inline-attachment-bytes']).toBe(MAX_INLINE_ATTACHMENT_TOTAL_BYTES);
      expect(send['x-max-request-bytes']).toBe(MAX_SEND_REQUEST_BYTES);
    }
    expect(specs.api.components.schemas.SendMailRequest).toEqual(specs.v1.components.schemas.SendMailRequest);
  });

  it('错误信封带可选的 fix/docs/details，错误码含 header_not_allowed 与 delivery_failed', () => {
    for (const spec of Object.values(specs)) {
      const envelope = props(spec.components.schemas.Error!).error!;
      const error = props(envelope);
      expect(error.code!.enum).toEqual(expect.arrayContaining(['header_not_allowed', 'delivery_failed', 'payload_too_large']));
      for (const text of ['header_not_allowed (400)', 'delivery_failed (422)', 'payload_too_large (413)']) expect(error.code!.description).toContain(text);
      expect(envelope.required).toEqual(['code', 'message']);
      expect(Object.keys(props(error.details!))).toEqual(['headers', 'messageId', 'recipientOutcomes', 'url', 'draftStatus', 'draftVersion']);
      expect(error.docs).toMatchObject({ format: 'uri' });
    }
  });

  it('两个发信端点：201 只表示至少一个收件人成功，400/413/422/500 有发信专属说明，/api 与 /v1 一致', () => {
    const v1 = specs.v1.paths['/messages']!.post!;
    const api = specs.api.paths['/messages/send']!.post!;
    expect(v1.responses).toEqual(api.responses);
    for (const operation of [v1, api]) {
      const responses = operation.responses as Record<string, { description: string }>;
      expect(operation.description).toContain('at least one recipient succeeded');
      expect(operation.description).not.toMatch(/total (recipient|delivery) failure/);
      expect(responses['400']!.description).toContain('header_not_allowed');
      expect(responses['413']!.description).toContain('before parsing');
      expect(responses['422']!.description).toContain('delivery_failed');
      expect(responses['500']!.description).toContain('Idempotency-Key');
    }
    expect(api).not.toHaveProperty('x-conditional-scopes');
    expect(api).not.toHaveProperty('x-required-scopes');
  });

  it('发件状态与逐收件人结果写明 pending 与 unknown', () => {
    for (const spec of Object.values(specs)) {
      const summary = props(spec.components.schemas.MessageSummary!);
      expect(summary.status!['x-outbound-values']).toEqual(OUTBOUND_STATUSES);
      for (const status of OUTBOUND_STATUSES) expect(summary.status!.description).toContain(status);
      expect(props(summary.recipientOutcomes!.items as Schema).status!.description).toContain('unknown');
    }
  });

  it('Agent 文档写明第 1 期的发件身份、自查、发信格式与错误码', () => {
    for (const text of ['GET /me', 'GET /identities', 'canSend', 'delivery_failed', 'header_not_allowed', 'In-Reply-To', 'replyTo',
      'contentId', 'cid:', 'include=body', 'error.fix', 'POST /mailboxes/batch', 'unknown']) {
      expect(skillDoc, text).toContain(text);
    }
    for (const anchor of ['validation_failed', 'header_not_allowed', 'payload_too_large', 'forbidden-scope', 'forbidden-sender',
      'idempotency_mismatch', 'send_in_progress', 'source_unavailable', 'delivery_failed', 'rate_limited']) {
      expect(errorsDoc).toMatch(new RegExp(`^## ${anchor}$`, 'm'));
    }
    expect(llmsDoc).toContain('/references/errors.md');
    for (const heading of ['### 发件身份', '### 收件人与显示名', '### 自定义邮件头', '### 结果与状态']) expect(mailDoc).toContain(`\n${heading}\n`);
    for (const header of ALLOWED_CUSTOM_HEADERS) expect(mailDoc, header).toContain(`\`${header}\``);
    expect(mailDoc).toContain('include=body');
    expect(attachmentsDoc).toContain('\n## 内联图片\n');
    expect(mailboxesDoc).toContain('\n## 发件身份\n');
    expect(authDoc).toContain('GET /v1/me');
  });

  it('文档里的完整发信请求示例都能通过发信 schema', () => {
    const examples = [mailDoc, attachmentsDoc].flatMap(doc => [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]!))
      .filter(block => block.includes('"from"'));
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const block of examples) {
      const parsed = internalSendMailSchema.safeParse(JSON.parse(block));
      expect(parsed.success, `${block}\n${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('超过 100 行的参考文件开头有目录', () => {
    const references = { administration: administrationDoc, attachments: attachmentsDoc, auth: authDoc, errors: errorsDoc,
      mail: mailDoc, mailboxes: mailboxesDoc, notifications: notificationsDoc };
    for (const [name, doc] of Object.entries(references)) {
      if (doc.split('\n').length > 100) expect(doc.split('\n').slice(0, 5).join('\n'), name).toContain('## 目录');
    }
  });
});

/**
 * Agent 文档里写到的端点必须真实存在：skill.md 的 hpc 调用按 /v1 核对，
 * 「`METHOD /path`」与带 /v1、/api 前缀的路径按对应规格核对，相对链接与锚点必须能解析。
 */
describe('Agent docs reference only real endpoints and anchors', () => {
  const docs: Record<string, string> = {
    'skill.md': skillDoc, 'llms.txt': llmsDoc,
    'references/administration.md': administrationDoc, 'references/attachments.md': attachmentsDoc,
    'references/auth-and-http.md': authDoc, 'references/errors.md': errorsDoc, 'references/mail.md': mailDoc,
    'references/mailboxes-and-domains.md': mailboxesDoc, 'references/notifications.md': notificationsDoc,
  };
  /** 文档故意写出的不存在端点（提醒 Agent 不要调用），必须确实不存在 */
  const documentedAsMissing = ['POST /messages/{id}'];
  type Namespace = keyof typeof specs;
  const isParam = (segment: string) => /^[:$<{]/.test(segment);

  function resolve(method: string | null, rawPath: string, namespaces: Namespace[]): string[] {
    let path = rawPath.replace(/\\\|/g, '|').split('?')[0]!.replace(/\/$/, '');
    let candidates = namespaces;
    for (const namespace of ['v1', 'api'] as const) {
      if (path.startsWith(`/${namespace}/`)) { path = path.slice(namespace.length + 1); candidates = [namespace]; }
    }
    // 末段写成 a|b|c 时逐个展开
    const segments = path.split('/');
    const last = segments.pop()!;
    return last.split('|').flatMap((variant) => {
      const wanted = [...segments, variant];
      const found = candidates.some(namespace => Object.entries(specs[namespace].paths).some(([specPath, item]) => {
        const actual = specPath.split('/');
        return actual.length === wanted.length
          && actual.every((segment, index) => segment.startsWith('{') ? isParam(wanted[index]!) : segment === wanted[index])
          && (method === null || method.toLowerCase() in item);
      }));
      return found ? [] : [`${method ?? 'ANY'} ${wanted.join('/')} (${candidates.join('|')})`];
    });
  }

  const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

  it('every documented endpoint exists in the OpenAPI document of its API', () => {
    const missing: string[] = [];
    for (const [name, content] of Object.entries(docs)) {
      const namespaces: Namespace[] = name === 'skill.md' ? ['v1', 'api'] : ['api', 'v1'];
      for (const match of content.matchAll(/`(GET|POST|PUT|DELETE|PATCH) (\/[^`\s]*)`/g)) {
        if (/[…*]/.test(match[2]!)) continue;
        const label = `${match[1]} ${match[2]!.split('?')[0]!.replace(/:[A-Za-z]+/g, '{}')}`;
        if (documentedAsMissing.some(entry => entry.replace(/\{[^}]+\}/g, '{}') === label)) continue;
        missing.push(...resolve(match[1]!, match[2]!, namespaces).map(item => `${name}: ${item}`));
      }
      for (const match of content.matchAll(/`(\/(?:v1|api)\/[^`\s]*)`/g)) {
        if (/[…*<]/.test(match[1]!)) continue;
        missing.push(...resolve(null, match[1]!, namespaces).map(item => `${name}: ${item}`));
      }
      // shell 示例里的 hpc 调用：入口指南全部走 /v1；参考文件里 API 可能是 /v1 或 /api
      for (const match of content.matchAll(/\bhpc\s+(['"])(\/[^'"]*)\1((?:[^\n]*\\\n)*[^\n]*)/g)) {
        const method = /-X\s+(POST|PUT|DELETE|PATCH)\b/.exec(match[3]!)?.[1] ?? 'GET';
        missing.push(...resolve(method, match[2]!, name === 'skill.md' ? ['v1'] : ['api', 'v1']).map(item => `${name}: hpc ${item}`));
      }
    }
    expect(missing).toEqual([]);
    for (const entry of documentedAsMissing) {
      const [method, path] = entry.split(' ') as [string, string];
      for (const spec of Object.values(specs)) expect(spec.paths[path]?.[method.toLowerCase()]).toBeUndefined();
    }
  });

  it('skill.md keeps the phase-0 entry structure within the size budget', () => {
    const frontmatter = /^---\nname: hpc-mail\ndescription: (.+)\n---\n/.exec(skillDoc);
    expect(frontmatter).not.toBeNull();
    expect([...frontmatter![1]!].length).toBeLessThanOrEqual(1024);
    expect(frontmatter![1]).not.toMatch(/管理员|admin/i);
    expect(skillDoc.split('\n').length).toBeLessThanOrEqual(170);
    for (const recipe of ['①', '②', '③', '④', '⑤', '⑥']) expect(skillDoc).toMatch(new RegExp(`^### ${recipe} `, 'm'));
    for (const field of ['scannedThroughId', 'recipientOutcomes', 'Idempotency-Key', 'send_in_progress', 'idempotency_mismatch', 'afterId', 'nextCursor']) {
      expect(skillDoc).toContain(field);
    }
  });

  it('relative links resolve to shipped documents and existing headings', () => {
    const headings = Object.fromEntries(Object.entries(docs).map(([name, content]) =>
      [name, new Set([...content.matchAll(/^#{1,6} (.+)$/gm)].map(match => slug(match[1]!)))]));
    const broken: string[] = [];
    for (const [name, content] of Object.entries(docs)) {
      for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]!;
        if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
        const [file, anchor] = target.split('#') as [string, string | undefined];
        const base = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
        const resolved = file === '' ? name : (base + file).replace(/[^/]+\/\.\.\//g, '');
        if (!(resolved in docs)) { broken.push(`${name}: ${target}`); continue; }
        if (anchor && !headings[resolved]!.has(decodeURIComponent(anchor))) broken.push(`${name}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
