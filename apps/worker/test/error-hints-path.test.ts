import type { ApiErrorBody } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { DEFAULT_ERROR_HINTS, onError } from '../src/middleware/error.js';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import type { AppContext } from '../src/types.js';

const origin = 'https://mail.example';
const probe = new Hono<AppContext>();
probe.onError(onError);
for (const prefix of ['/api', '/v1']) {
  probe.get(`${prefix}/limited`, () => { throw new AppError('rate_limited', 'slow down'); });
  probe.get(`${prefix}/too-large`, () => { throw new AppError('payload_too_large', 'too large'); });
  probe.get(`${prefix}/custom`, () => { throw new AppError('rate_limited', 'slow down', { fix: 'custom fix' }); });
}
const errorOf = async (path: string) => ((await (await probe.request(`${origin}${path}`)).json()) as ApiErrorBody).error;

describe('429/413 的默认建议按路径区分（S3）', () => {
  it('/v1 用面向 API Key 的建议', async () => {
    expect((await errorOf('/v1/limited')).fix).toBe(DEFAULT_ERROR_HINTS.rate_limited!.fix);
    expect((await errorOf('/v1/limited')).fix).toContain('/v1/me');
    expect((await errorOf('/v1/too-large')).fix).toBe(DEFAULT_ERROR_HINTS.payload_too_large!.fix);
  });

  it('网页会话（/api）不提 Key 与 /v1 端点，文档锚点照旧', async () => {
    for (const path of ['/api/limited', '/api/too-large']) {
      const error = await errorOf(path);
      expect(error.fix, path).toBeTruthy();
      expect(error.fix, path).not.toMatch(/\/v1|Key/);
      expect(error.docs, path).toMatch(/\/references\/errors\.md#(rate_limited|payload_too_large)$/);
    }
    expect((await errorOf('/api/too-large')).fix).toContain('/api/uploads');
  });

  it('两份 OpenAPI 的 429/413 失败示例与各自路径的默认建议一致', () => {
    const examplesOf = (spec: { components: { examples: Record<string, { value: { error: ApiErrorBody['error'] } }> } }, code: string) =>
      Object.values(spec.components.examples).map((example) => example.value.error).filter((error) => error.code === code && !error.fix?.includes('custom'));
    const session = buildSessionOpenApiSpec(origin) as unknown as Parameters<typeof examplesOf>[0];
    const v1 = buildOpenApiSpec(origin) as unknown as Parameters<typeof examplesOf>[0];
    for (const code of ['rate_limited', 'payload_too_large']) {
      const apiExamples = examplesOf(session, code);
      expect(apiExamples.length, code).toBeGreaterThan(0);
      for (const error of apiExamples) expect(error.fix, code).not.toMatch(/\/v1|Key/);
      expect(examplesOf(v1, code).some((error) => error.fix?.includes('/v1')), code).toBe(true);
    }
  });

  it('抛错处给了建议时两条路径都以抛错处为准', async () => {
    expect((await errorOf('/api/custom')).fix).toBe('custom fix');
    expect((await errorOf('/v1/custom')).fix).toBe('custom fix');
  });
});
