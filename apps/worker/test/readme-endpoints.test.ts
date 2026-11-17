import { describe, expect, it } from 'vitest';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import readme from '../../../README.md?raw';
import contributing from '../../../CONTRIBUTING.md?raw';

const specs = { '/v1': buildOpenApiSpec('https://mail.example'), '/api': buildSessionOpenApiSpec('https://mail.example') };

/** 仓库文档里写成 `METHOD /v1/...` 或 `METHOD /api/...`（方法可用 | 连写）的端点 */
function documentedEndpoints(doc: string): { method: string; prefix: '/v1' | '/api'; path: string }[] {
  return [...doc.matchAll(/`((?:GET|POST|PUT|DELETE)(?:\|(?:GET|POST|PUT|DELETE))*) (\/v1|\/api)(\/[^`\s?]*)`/g)].flatMap((match) =>
    match[1]!.split('|').map((method) => ({
      method: method.toLowerCase(),
      prefix: match[2] as '/v1' | '/api',
      path: match[3]!.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/$/, ''),
    })));
}

describe('README 与 CONTRIBUTING 里的端点都存在于 OpenAPI（R63）', () => {
  it.each([['README.md', readme], ['CONTRIBUTING.md', contributing]])('%s', (_name, doc) => {
    for (const { method, prefix, path } of documentedEndpoints(doc)) {
      const operations = (specs[prefix].paths as Record<string, Record<string, unknown> | undefined>)[path];
      expect(operations?.[method], `${method.toUpperCase()} ${prefix}${path}`).toBeDefined();
    }
  });

  it('README 至少写出了常用的 /v1 端点', () => {
    expect(documentedEndpoints(readme).length).toBeGreaterThanOrEqual(8);
  });
});
