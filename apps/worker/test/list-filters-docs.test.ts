import { describe, expect, it } from 'vitest';
import { buildSessionOpenApiSpec } from '../src/routes/api-openapi.js';
import { buildOpenApiSpec } from '../src/routes/v1/openapi.js';
import mailDoc from '../../web/public/references/mail.md?raw';

const specs = { api: buildSessionOpenApiSpec('https://mail.example'), v1: buildOpenApiSpec('https://mail.example') };
type Param = { name: string; schema: Record<string, unknown>; description?: string };

describe('列表筛选参数在两份 OpenAPI 与参考文档中一致', () => {
  it.each([['api', '/messages'], ['api', '/messages/sync'], ['v1', '/messages']] as const)('%s %s 带 since/until/from/to/hasCode/hasAttachments', (ns, path) => {
    const params = (specs[ns].paths[path]!.get as { parameters: Param[] }).parameters;
    const byName = new Map(params.map((param) => [param.name, param]));
    for (const name of ['since', 'until', 'from', 'to', 'hasCode', 'hasAttachments']) expect(byName.has(name), name).toBe(true);
    expect(byName.get('since')!.schema.description).toContain('ISO 8601');
    expect(byName.get('until')!.description).toContain('exclusive');
    expect(byName.get('from')!.description).toContain('subdomains excluded');
    expect(byName.get('to')!.description).toContain('To/Cc/Bcc');
    expect(byName.get('hasCode')!.schema.enum).toEqual(['1', 'true', '0', 'false']);
    expect(new Set(params.map((param) => param.name)).size).toBe(params.length);
  });

  it('mail.md 写清格式、边界与口径', () => {
    for (const text of ['`since`', '`until`', '`from`', '`to`', '`hasCode`', '`hasAttachments`', '含边界', '不含边界', '不含子域',
      '正文内联图不算', '纯数字时间戳返回 400', 'hasCode=0']) {
      expect(mailDoc, text).toContain(text);
    }
  });
});
