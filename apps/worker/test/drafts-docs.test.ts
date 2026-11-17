import { DRAFT_STATUSES, MAX_DRAFTS_PER_USER } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import type { Schema } from '../src/routes/openapi-common.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import draftsDoc from '../../web/public/references/drafts.md?raw';
import errorsDoc from '../../web/public/references/errors.md?raw';

const specs = { api: buildSessionOpenApiSpec('https://mail.example'), v1: buildOpenApiSpec('https://mail.example') };
const props = (schema: Schema) => schema.properties as Record<string, Schema>;

describe('草稿与定时发送的 OpenAPI 与参考文档', () => {
  it.each(['api', 'v1'] as const)('%s：/drafts 的六个操作、请求与响应结构', (ns) => {
    const paths = specs[ns].paths;
    expect(Object.keys(paths['/drafts']!)).toEqual(expect.arrayContaining(['get', 'post']));
    expect(Object.keys(paths['/drafts/{id}']!)).toEqual(expect.arrayContaining(['get', 'patch', 'delete']));
    expect(paths['/drafts/{id}/send']).toHaveProperty('post');
    const input = props(specs[ns].components.schemas.DraftInput!);
    for (const name of ['from', 'to', 'subject', 'text', 'html', 'attachments', 'attachmentTokens', 'sendAt', 'expectedVersion']) expect(input, name).toHaveProperty(name);
    expect(input.sendAt!.description).toContain('30 days');
    expect(specs[ns].components.schemas.DraftInput!.required ?? []).toEqual([]);
    const draft = props(specs[ns].components.schemas.Draft!);
    expect(draft.status!.enum).toEqual([...DRAFT_STATUSES]);
    for (const name of ['version', 'sendAt', 'messageId', 'createdVia', 'apiKeyName', 'attachments', 'html']) expect(draft, name).toHaveProperty(name);
    expect(specs[ns].components.schemas.DraftInput!.description).toContain(String(MAX_DRAFTS_PER_USER));
    const send = paths['/drafts/{id}/send']!.post as Schema;
    expect(send.description).toContain('send_in_progress');
    expect((send.responses as Record<string, unknown>)).toHaveProperty('201');
  });

  it('/v1 写需 mail.send、读为 mail.read 或 mail.send，来源邮件另需 mail.read；/api 不声明 scope', () => {
    const v1 = specs.v1.paths;
    expect((v1['/drafts']!.get as Schema)['x-required-scopes-any-of']).toEqual(['mail.read', 'mail.send']);
    expect((v1['/drafts/{id}']!.get as Schema)['x-required-scopes-any-of']).toEqual(['mail.read', 'mail.send']);
    for (const [path, method] of [['/drafts', 'post'], ['/drafts/{id}', 'patch'], ['/drafts/{id}', 'delete'], ['/drafts/{id}/send', 'post']] as const) {
      expect((v1[path]![method] as Schema)['x-required-scopes'], `${method} ${path}`).toEqual(['mail.send']);
    }
    expect((v1['/drafts/{id}/send']!.post as Schema)['x-conditional-scopes']).toEqual([expect.objectContaining({ scope: 'mail.read' })]);
    expect(specs.api.paths['/drafts']!.post).not.toHaveProperty('x-required-scopes');
  });

  it('drafts.md 写清人审、定时精度与复核、附件保留、发送结果与状态；errors.md 有两个草稿错误码', () => {
    for (const text of ['人审后再发', '不要在用户确认之前自己调用发送', '1 分钟内发出', '最晚 30 天', '"sendAt":null', '吊销', '安全状态变化',
      'expectedVersion', 'Idempotency-Key', '写进 `attachmentTokens`', '422 `delivery_failed`', '409 `send_in_progress`', '最多 3 次', '7 天后自动删除',
      '100 份']) {
      expect(draftsDoc, text).toContain(text);
    }
    for (const text of ['## draft_state_conflict', '## draft_limit_reached']) expect(errorsDoc, text).toContain(text);
  });
});
