import { ERROR_STATUS } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import { OPERATION_ID_PATTERN, describePaths, exampleOf, operation, str, type Schema } from '../src/routes/openapi-common.js';
// @ts-expect-error Vite 的 ?raw 导入：仓库根的 Spectral 规则集
import spectralRuleset from '../../../.spectral.yaml?raw';

/**
 * 两份 OpenAPI 的质量约束（CI 里另由 Spectral 按 .spectral.yaml 检查同样的规则）：
 * operationId 是唯一的「动词+名词」，每个接口显式声明 security，成功与失败响应都有示例且符合 schema。
 */
const origin = 'https://mail.example';
const specs = { api: buildSessionOpenApiSpec(origin), v1: buildOpenApiSpec(origin) };
interface Spec { components: { schemas: Record<string, Schema>; examples: Record<string, unknown> } }
type Namespace = keyof typeof specs;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];

interface Media { schema: Schema; example?: unknown; examples?: Record<string, { $ref?: string; value?: unknown }> }
interface Response { description: string; content?: Record<string, Media>; headers?: Record<string, Schema> }
interface Op { operationId?: string; security?: Schema[]; parameters?: Schema[]; description?: string; responses: Record<string, Response> }

/** 按路径与方法取一个 operation */
function opAt(namespace: Namespace, path: string, method: string): Op {
  return (specs[namespace].paths as unknown as Record<string, Record<string, Op>>)[path]![method]!;
}
function operations(namespace: Namespace): Array<{ label: string; op: Op }> {
  return Object.entries(specs[namespace].paths).flatMap(([path, item]) => Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, op]) => ({ label: `${method.toUpperCase()} /${namespace}${path}`, op: op as unknown as Op })));
}

/** 只覆盖两份规范用到的 JSON Schema 关键字；遇到未知的校验关键字直接报错，避免静默放过 */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const FORMATS: Record<string, (value: string) => boolean> = {
  'date-time': value => !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value),
  uri: value => { try { return Boolean(new URL(value).protocol); } catch { return false; } },
  ipv4: value => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value),
  ipv6: value => value.includes(':'),
  binary: () => true,
  starts_with: () => true,
};
function validate(spec: Spec, schema: Schema, value: unknown, at = '$'): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`${at}: ${message}`);
  const typeOf = (item: unknown) => item === null ? 'null' : Array.isArray(item) ? 'array'
    : typeof item === 'number' ? (Number.isInteger(item) ? 'integer' : 'number') : typeof item;
  for (const [keyword, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword) || keyword.startsWith('x-')) continue;
    switch (keyword) {
      case '$ref': {
        const name = String(rule).replace('#/components/schemas/', '');
        const target = (spec.components.schemas as Record<string, Schema>)[name];
        if (!target) fail(`unresolved ${String(rule)}`);
        else errors.push(...validate(spec, target, value, at));
        break;
      }
      case 'type': {
        const types = Array.isArray(rule) ? rule as string[] : [rule as string];
        const actual = typeOf(value);
        if (!types.some(type => type === actual || (type === 'number' && actual === 'integer'))) fail(`expected ${types.join('|')}, got ${actual}`);
        break;
      }
      case 'enum': if (!(rule as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(value))) fail(`not in enum ${JSON.stringify(rule)}`); break;
      case 'const': if (JSON.stringify(rule) !== JSON.stringify(value)) fail(`expected const ${JSON.stringify(rule)}`); break;
      case 'anyOf': if (!(rule as Schema[]).some(item => validate(spec, item, value, at).length === 0)) fail('matches no anyOf variant'); break;
      case 'oneOf': {
        const matches = (rule as Schema[]).filter(item => validate(spec, item, value, at).length === 0).length;
        if (matches !== 1) fail(`matches ${matches} oneOf variants`);
        break;
      }
      case 'not': if (validate(spec, rule as Schema, value, at).length === 0) fail('matches not'); break;
      case 'properties':
        if (typeOf(value) === 'object') {
          for (const [key, sub] of Object.entries(rule as Record<string, Schema>)) {
            if (key in (value as object)) errors.push(...validate(spec, sub, (value as Record<string, unknown>)[key], `${at}.${key}`));
          }
        }
        break;
      case 'required':
        if (typeOf(value) === 'object') for (const key of rule as string[]) if (!(key in (value as object))) fail(`missing ${key}`);
        break;
      case 'additionalProperties':
        if (typeOf(value) === 'object') {
          const known = Object.keys((schema.properties as Schema | undefined) ?? {});
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (known.includes(key)) continue;
            if (rule === false) fail(`unexpected property ${key}`);
            else if (typeof rule === 'object') errors.push(...validate(spec, rule as Schema, item, `${at}.${key}`));
          }
        }
        break;
      case 'dependentRequired':
        if (typeOf(value) === 'object') {
          for (const [key, needed] of Object.entries(rule as Record<string, string[]>)) {
            if (key in (value as object)) for (const other of needed) if (!(other in (value as object))) fail(`${key} requires ${other}`);
          }
        }
        break;
      case 'items': if (Array.isArray(value)) value.forEach((item, index) => errors.push(...validate(spec, rule as Schema, item, `${at}[${index}]`))); break;
      case 'minItems': if (Array.isArray(value) && value.length < Number(rule)) fail(`fewer than ${String(rule)} items`); break;
      case 'maxItems': if (Array.isArray(value) && value.length > Number(rule)) fail(`more than ${String(rule)} items`); break;
      case 'minLength': if (typeof value === 'string' && [...value].length < Number(rule)) fail(`shorter than ${String(rule)}`); break;
      case 'maxLength': if (typeof value === 'string' && [...value].length > Number(rule)) fail(`longer than ${String(rule)}`); break;
      case 'pattern': if (typeof value === 'string' && !new RegExp(String(rule), 'u').test(value)) fail(`does not match ${String(rule)}`); break;
      case 'format':
        if (typeof value === 'string') {
          const check = FORMATS[String(rule)];
          if (!check) fail(`unknown format ${String(rule)}`);
          else if (!check(value)) fail(`not a ${String(rule)}`);
        }
        break;
      case 'minimum': if (typeof value === 'number' && value < Number(rule)) fail(`below ${String(rule)}`); break;
      case 'maximum': if (typeof value === 'number' && value > Number(rule)) fail(`above ${String(rule)}`); break;
      case 'exclusiveMinimum': if (typeof value === 'number' && value <= Number(rule)) fail(`not above ${String(rule)}`); break;
      default: throw new Error(`validator does not support ${keyword} (${at})`);
    }
  }
  return errors;
}
/** 媒体类型上的示例：example，或 examples 中每一项（$ref 解析到 components.examples） */
function mediaExamples(spec: Spec, media: Media): Array<{ name: string; value: unknown }> {
  if ('example' in media) return [{ name: 'example', value: media.example }];
  return Object.entries(media.examples ?? {}).map(([name, item]) => {
    if (item.$ref === undefined) return { name, value: item.value };
    const target = (spec.components.examples as Record<string, { value: unknown }>)[item.$ref.replace('#/components/examples/', '')];
    if (!target) throw new Error(`unresolved example ${item.$ref}`);
    return { name, value: target.value };
  });
}

describe('OpenAPI 质量约束：operationId、security 与示例', () => {
  it.each(['api', 'v1'] as const)('%s：每个 operation 有唯一的「动词+名词」operationId', namespace => {
    const ids = operations(namespace).map(({ label, op }) => {
      expect(op.operationId, label).toMatch(OPERATION_ID_PATTERN);
      return op.operationId!;
    });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('两份规范里同一操作同名，发信与共用的批量、上传接口一致', () => {
    const id = (namespace: Namespace, path: string, method: string) => opAt(namespace, path, method).operationId;
    expect(id('api', '/messages/send', 'post')).toBe('sendMessage');
    expect(id('v1', '/messages', 'post')).toBe('sendMessage');
    for (const [path, method] of [['/messages', 'get'], ['/messages/{id}', 'get'], ['/mailboxes', 'post'], ['/mailboxes/batch', 'post'], ['/uploads', 'post']] as const) {
      expect(id('v1', path, method), path).toBe(id('api', path, method));
    }
  });

  it('Spectral 规则集的动词表与 OPERATION_ID_PATTERN 一致，并以 error 级别检查示例与 security', () => {
    const match = /match: "([^"]+)"/.exec(spectralRuleset as string);
    expect(match?.[1]).toBe(OPERATION_ID_PATTERN.source);
    for (const rule of ['hpc-operation-id-verb-noun', 'hpc-operation-security', 'hpc-success-example', 'hpc-error-example']) {
      expect(spectralRuleset as string, rule).toMatch(new RegExp(`\\n  ${rule}:\\n(?:    .*\\n)*?    severity: error\\n`));
    }
    for (const rule of ['operation-operationId', 'operation-operationId-unique', 'oas3-valid-media-example', 'oas3-valid-schema-example']) {
      expect(spectralRuleset as string, rule).toContain(`\n  ${rule}: error\n`);
    }
  });

  it.each(['api', 'v1'] as const)('%s：每个 operation 显式声明 security，公开接口只有这几个', namespace => {
    const scheme = namespace === 'api' ? 'sessionToken' : 'apiKey';
    const open: string[] = [];
    for (const { label, op } of operations(namespace)) {
      expect(Array.isArray(op.security), label).toBe(true);
      if (op.security!.length === 0) open.push(label);
      else if (label !== 'GET /api/attachments/{id}') expect(op.security, label).toEqual([{ [scheme]: [] }]);
    }
    expect(open.sort()).toEqual(namespace === 'api'
      ? ['GET /api/avatar/{userId}', 'GET /api/config', 'GET /api/openapi.json', 'POST /api/auth/login', 'POST /api/auth/register',
        'POST /api/forward-confirmations/confirm']
      : ['GET /v1/openapi.json']);
    expect(opAt('api', '/attachments/{id}', 'get').security).toEqual([{ sessionToken: [] }, { attachmentSignature: [], attachmentExpiry: [] }]);
  });

  it.each(['api', 'v1'] as const)('%s：每个成功响应的每种媒体类型都有符合 schema 的示例', namespace => {
    const spec = specs[namespace];
    for (const { label, op } of operations(namespace)) {
      const successes = Object.entries(op.responses).filter(([status]) => status.startsWith('2'));
      expect(successes.length, label).toBeGreaterThan(0);
      for (const [status, response] of successes) {
        for (const [type, media] of Object.entries(response.content ?? {})) {
          const examples = mediaExamples(spec, media);
          expect(examples.length, `${label} ${status} ${type}`).toBeGreaterThan(0);
          for (const { value } of examples) expect(validate(spec, media.schema, value), `${label} ${status} ${type}`).toEqual([]);
        }
      }
    }
  });

  it.each(['api', 'v1'] as const)('%s：每个 operation 至少一个失败示例，错误码与状态码一致且符合错误信封', namespace => {
    const spec = specs[namespace];
    const errorSchema = { $ref: '#/components/schemas/Error' };
    for (const { label, op } of operations(namespace)) {
      let count = 0;
      for (const [status, response] of Object.entries(op.responses).filter(([code]) => /^[45]/.test(code))) {
        const media = response.content?.['application/json'];
        if (!media) continue;
        for (const { name, value } of mediaExamples(spec, media)) {
          count++;
          const code = (value as { error: { code: keyof typeof ERROR_STATUS } }).error.code;
          expect(String(ERROR_STATUS[code]), `${label} ${status} ${name}`).toBe(status);
          expect(validate(spec, errorSchema, value), `${label} ${name}`).toEqual([]);
        }
      }
      expect(count, label).toBeGreaterThan(0);
    }
  });

  it.each(['api', 'v1'] as const)('%s：需要认证的接口带 401 与 429 示例，带路径参数的接口带 404 示例', namespace => {
    const [unauthorized, limited] = namespace === 'api' ? ['UnauthorizedSession', 'RateLimitedSession'] : ['UnauthorizedApiKey', 'RateLimitedApiKey'];
    for (const [path, item] of Object.entries(specs[namespace].paths)) {
      for (const [method, value] of Object.entries(item).filter(([key]) => METHODS.includes(key))) {
        const op = value as unknown as Op;
        const names = (status: string) => Object.keys(op.responses[status]?.content?.['application/json']?.examples ?? {});
        if (op.security!.length) {
          expect(names('401'), `${method} ${path}`).toContain(unauthorized);
          expect(names('429'), `${method} ${path}`).toContain(limited);
        }
        if (path.includes('{')) expect(names('404').some(name => name.startsWith('NotFound')), `${method} ${path}`).toBe(true);
      }
    }
    const scoped = opAt('v1', '/messages/{id}', 'get');
    expect(Object.keys(scoped.responses['403']!.content!['application/json']!.examples!)).toContain('ForbiddenScopeMailRead');
    const admin = opAt('api', '/admin/users', 'get');
    expect(Object.keys(admin.responses['403']!.content!['application/json']!.examples!)).toContain('ForbiddenAdmin');
  });

  it('失败示例的 fix/docs 与真实错误信封一致：docs 按请求 origin 补成绝对 URL，source_unavailable 带 details.source', () => {
    const examples = specs.v1.components.examples as Record<string, { value: { error: Record<string, unknown> } }>;
    expect(examples.ForbiddenScopeMailRead!.value.error).toMatchObject({ code: 'forbidden', message: '需要 API scope: mail.read',
      docs: `${origin}/references/errors.md#forbidden-scope`, fix: expect.stringContaining('mail.read') });
    expect(examples.RateLimitedApiKey!.value.error.docs).toBe(`${origin}/references/errors.md#rate_limited`);
    expect(examples.SourceUnavailableReply!.value.error).toMatchObject({ code: 'source_unavailable', details: { source: 'reply' } });
    expect(examples.SourceUnavailableForward!.value.error).toMatchObject({ details: { source: 'forward' } });
    expect(examples.DeliveryFailed!.value.error).toMatchObject({ details: { messageId: expect.any(Number), recipientOutcomes: [expect.objectContaining({ status: 'failed' })] } });
    // 只输出引用到的示例
    const referenced = new Set(JSON.stringify(specs.v1.paths).match(/#\/components\/examples\/[A-Za-z0-9]+/g)!.map(ref => ref.split('/').pop()));
    expect(Object.keys(examples).sort()).toEqual([...referenced].sort());
  });

  it('详情 GET /messages/{id}：弱 ETag、Cache-Control、If-None-Match 与 304', () => {
    for (const [namespace, bucket] of [['api', 'hourly'], ['v1', 'every minute']] as const) {
      const detail = opAt(namespace, '/messages/{id}', 'get');
      const header = (detail.parameters as Array<{ name: string; in: string; required: boolean }>).find(param => param.name === 'If-None-Match');
      expect(header, namespace).toMatchObject({ in: 'header', required: false });
      for (const status of ['200', '304']) {
        expect(detail.responses[status]!.headers, `${namespace} ${status}`).toMatchObject({
          ETag: { schema: { type: 'string', pattern: '^W/".+"$' } }, 'Cache-Control': { schema: { const: 'private, no-cache' } } });
      }
      expect(detail.responses['304']).not.toHaveProperty('content');
      expect(detail.description, namespace).toContain('304 Not Modified');
      expect(detail.description, namespace).toContain(bucket);
    }
    expect(opAt('v1', '/messages/{id}', 'get').description).toContain('one row per key, route, status and minute');
    const log = specs.api.components.schemas.ApiRequestLog!;
    expect((log.properties as Record<string, Schema>).count).toMatchObject({ type: 'integer', minimum: 1 });
    expect(log.description).toContain('304');
  });

  it('新增接口时：带路径参数的资源要登记 404 示例，未知的失败示例名会在构建时报错', () => {
    const widget = { get: operation('getWidget', 'Read a widget', str) };
    expect(() => describePaths({ '/widgets/{id}': widget }, { security: [], errors: [] })).toThrow(/NOT_FOUND_BY_RESOURCE/);
    expect(() => operation('getWidget', 'Read a widget', str, { errors: ['NoSuchExample' as 'Internal'] })).toThrow(/unknown error example/);
    expect(exampleOf({ type: 'object', required: ['domain', 'count'], properties: {
      domain: { type: 'string', pattern: '^[a-z]+\\.[a-z]{2,}$' }, count: { type: 'integer', minimum: 0, maximum: 5 } } }))
      .toEqual({ domain: 'example.org', count: 1 });
  });
});
