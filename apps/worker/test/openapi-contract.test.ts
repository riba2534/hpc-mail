import { MAX_TRANSLATE_BATCH_CHARS, MAX_TRANSLATE_SEGMENT_CHARS, MAX_TRANSLATE_SEGMENTS } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import type { Schema } from '../src/routes/openapi-common.js';

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
    expect(fields.from!.oneOf).toHaveLength(2);
    expect(fields.attachments!.items).toMatchObject({ type: 'object', required: ['filename', 'contentType', 'content'] });
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
      expect(((availability.properties as Record<string, Schema>).reason!).enum).toEqual(['taken', 'reserved', 'quota', 'domain_limit', 'domain_unavailable']);
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
