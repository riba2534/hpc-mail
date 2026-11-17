import { MAX_BATCH_SEND_ITEMS } from '@hpc-mail/shared';
import { describe, expect, it } from 'vitest';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import type { Schema } from '../src/routes/openapi-common.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import attachmentsDoc from '../../web/public/references/attachments.md?raw';
import errorsDoc from '../../web/public/references/errors.md?raw';
import mailDoc from '../../web/public/references/mail.md?raw';

const specs = { api: buildSessionOpenApiSpec('https://mail.example'), v1: buildOpenApiSpec('https://mail.example') };
const props = (schema: Schema) => schema.properties as Record<string, Schema>;

describe('URL 附件与批量发送的 OpenAPI 与参考文档', () => {
  it.each(['api', 'v1'] as const)('%s：attachments 的 URL 一支写清规则，错误码与 details.url 有说明', (ns) => {
    const send = specs[ns].components.schemas.SendMailRequest!;
    const [base64, url] = (props(send).attachments!.items as Schema).anyOf as Schema[];
    expect(props(base64!)).not.toHaveProperty('url');
    expect(props(url!)).not.toHaveProperty('content');
    expect(url!.required).toEqual(['url']);
    for (const text of ['443', '169.254.169.254', 'attachment_url_forbidden', 'attachment_url_fetch_failed', '3 redirects', '15 seconds', 'details.url']) {
      expect(props(url!).url!.description, text).toContain(text);
    }
    expect(props(url!).filename!.description).toContain('Content-Disposition');
    const error = props(props(specs[ns].components.schemas.Error!).error!);
    expect((error.code as Schema).enum).toEqual(expect.arrayContaining(['attachment_url_forbidden', 'attachment_url_fetch_failed']));
    expect(props(error.details!)).toHaveProperty('url');
  });

  it('/v1/messages/batch：请求最多 20 项、每项是发信请求加 idempotencyKey，结果逐项给出；只在 /v1', () => {
    const op = specs.v1.paths['/messages/batch']!.post as Schema;
    expect(op['x-required-scopes']).toEqual(['mail.send']);
    expect(op.description).toContain('HTTP 200');
    expect((op.parameters as Schema[]).map((p) => p.name)).toEqual(['Idempotency-Key']);
    const request = specs.v1.components.schemas.BatchSendRequest!;
    expect(props(request).items).toMatchObject({ minItems: 1, maxItems: MAX_BATCH_SEND_ITEMS });
    const item = (props(request).items!.items as Schema).allOf as Schema[];
    expect(item[0]).toEqual({ $ref: '#/components/schemas/SendMailRequest' });
    expect(props(item[1]!).idempotencyKey).toMatchObject({ maxLength: 128 });
    const result = props(specs.v1.components.schemas.BatchSendResult!);
    const entry = props(result.items!.items as Schema);
    expect(Object.keys(entry)).toEqual(['index', 'ok', 'httpStatus', 'idempotencyKey', 'message', 'error']);
    expect(props(entry.error!)).toHaveProperty('code');
    expect(specs.api.paths).not.toHaveProperty('/messages/batch');
  });

  it('参考文档写清 URL 附件与批量发送的规则', () => {
    for (const text of ['## URL 附件', '`attachment_url_forbidden`', '`attachment_url_fetch_failed`', '15 秒', '3 次重定向', '10 MiB', '`details.url`']) {
      expect(attachmentsDoc, text).toContain(text);
    }
    for (const text of ['### 批量发送', 'POST /v1/messages/batch', '最多 20 封', 'HTTP 200', '`K:i`', '429 `rate_limited`', 'idempotencyKey']) {
      expect(mailDoc, text).toContain(text);
    }
    for (const text of ['## attachment_url_forbidden', '## attachment_url_fetch_failed']) expect(errorsDoc, text).toContain(text);
  });
});
