import { describe, expect, it } from 'vitest';
import {
  MAX_HOSTED_DOMAIN_BATCH,
  batchCheckHostedDomainsRequestSchema,
  batchCreateHostedDomainsRequestSchema,
  listMessagesQuerySchema,
  replyMessageRequestSchema,
  waitMessagesQuerySchema,
} from '../src/index.js';
import { MCP_TOOL_NAMES, mcpSearchQuery, mcpToolInputSchemas, mcpWaitQuery } from '../src/schemas/mcp.js';

describe('MCP 工具参数', () => {
  it('工具清单固定为 10 个，参数都能生成 object 类型的 JSON Schema', () => {
    expect(MCP_TOOL_NAMES).toEqual(['get_me', 'list_identities', 'list_mailboxes', 'claim_mailbox', 'release_mailbox',
      'send_email', 'reply_email', 'search_messages', 'get_message', 'wait_for_message']);
    for (const name of MCP_TOOL_NAMES) {
      const schema = mcpToolInputSchemas[name].toJSONSchema({ io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      expect(schema.type, name).toBe('object');
      expect(name).toMatch(/^[a-z_]{1,128}$/);
    }
    expect(mcpToolInputSchemas.get_me.toJSONSchema()).toMatchObject({ additionalProperties: false });
  });

  it('send_email 与 REST 发信体同一组字段，另加 idempotencyKey 与 response_format', () => {
    const schema = mcpToolInputSchemas.send_email.toJSONSchema({ io: 'input', unrepresentable: 'any' }) as {
      properties: Record<string, unknown>; required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html',
      'replyToMessageId', 'forwardAttachmentsFrom', 'replyTo', 'headers', 'attachments', 'attachmentTokens', 'idempotencyKey', 'response_format']));
    expect(schema.required).toEqual(['from', 'to', 'subject']);
    expect(mcpToolInputSchemas.send_email.safeParse({ from: 'a@b.com', to: ['c@d.com'], subject: 's', idempotencyKey: 'has space' }).success).toBe(false);
  });

  it('reply_email 与 POST /v1/messages/:id/reply 的请求体同一组字段，另加 messageId、idempotencyKey 与 response_format', () => {
    const schema = mcpToolInputSchemas.reply_email.toJSONSchema({ io: 'input', unrepresentable: 'any' }) as {
      properties: Record<string, unknown>; required: string[];
    };
    const restFields = Object.keys(replyMessageRequestSchema.shape);
    expect(Object.keys(schema.properties).sort()).toEqual([...restFields, 'messageId', 'idempotencyKey', 'response_format'].sort());
    expect(schema.required).toEqual(['messageId']);
    expect(mcpToolInputSchemas.reply_email.parse({ messageId: 1 })).toMatchObject({ replyAll: false, quote: true });
  });

  it('search_messages 转成的查询串被 GET /v1/messages 的 schema 原样接受', () => {
    const args = mcpToolInputSchemas.search_messages.parse({ q: ' 验证码 ', direction: 'inbound', address: 'Alice@Example.org',
      domain: 'Example.org', unread: true, starred: false, afterId: 5, cursor: 'abc', limit: 7 });
    const query = mcpSearchQuery(args);
    expect(query).toEqual({ q: '验证码', direction: 'inbound', address: 'alice@example.org', domain: 'example.org', cursor: 'abc',
      unread: '1', starred: '0', afterId: '5', limit: '7' });
    expect(listMessagesQuerySchema.parse(query)).toMatchObject({ q: '验证码', unread: true, starred: false, afterId: 5, limit: 7 });
    expect(mcpSearchQuery(mcpToolInputSchemas.search_messages.parse({}))).toEqual({});
    expect(mcpToolInputSchemas.search_messages.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('wait_for_message 转成的查询串被 GET /v1/messages/wait 的 schema 原样接受，detailed 即 include=body', () => {
    const args = mcpToolInputSchemas.wait_for_message.parse({ address: ['A@x.com', 'b@x.com'], from: '@Example.com',
      subjectContains: 'Code', hasCode: true, afterId: 9, timeout: 10, response_format: 'detailed' });
    const query = mcpWaitQuery(args);
    expect(query).toEqual({ afterId: '9', timeout: '10', address: 'a@x.com,b@x.com', from: '@example.com', subjectContains: 'Code',
      hasCode: '1', include: 'body' });
    expect(waitMessagesQuerySchema.parse(query)).toMatchObject({ address: ['a@x.com', 'b@x.com'], hasCode: true, include: 'body', afterId: 9, timeout: 10 });
    expect(mcpWaitQuery(mcpToolInputSchemas.wait_for_message.parse({ address: 'one@x.com' })))
      .toEqual({ afterId: '0', timeout: '25', address: 'one@x.com' });
    expect(mcpToolInputSchemas.wait_for_message.safeParse({ timeout: 51 }).success).toBe(false);
    expect(mcpToolInputSchemas.wait_for_message.safeParse({ address: Array.from({ length: 21 }, (_, i) => `a${i}@x.com`) }).success).toBe(false);
  });

  it('release_mailbox 的 mailboxId 与 address 必须且只能给一个', () => {
    const schema = mcpToolInputSchemas.release_mailbox;
    expect(schema.safeParse({ mailboxId: 3 }).success).toBe(true);
    expect(schema.safeParse({ address: 'a@b.com' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ mailboxId: 3, address: 'a@b.com' }).success).toBe(false);
  });
});

describe('批量托管域名请求', () => {
  it(`单次 1–${MAX_HOSTED_DOMAIN_BATCH} 项，规范化后不能重复`, () => {
    const domains = Array.from({ length: MAX_HOSTED_DOMAIN_BATCH }, (_, i) => `d${i}.example.com`);
    expect(batchCreateHostedDomainsRequestSchema.safeParse({ domains }).success).toBe(true);
    expect(batchCreateHostedDomainsRequestSchema.safeParse({ domains: [...domains, 'extra.example.com'] }).success).toBe(false);
    expect(batchCreateHostedDomainsRequestSchema.safeParse({ domains: [] }).success).toBe(false);
    const duplicate = batchCreateHostedDomainsRequestSchema.safeParse({ domains: ['a.example.com', 'A.Example.com '] });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]).toMatchObject({ path: ['domains', 1], message: expect.stringContaining('a.example.com') });

    const ids = Array.from({ length: MAX_HOSTED_DOMAIN_BATCH }, (_, i) => i + 1);
    expect(batchCheckHostedDomainsRequestSchema.safeParse({ ids }).success).toBe(true);
    expect(batchCheckHostedDomainsRequestSchema.safeParse({ ids: [...ids, 99] }).success).toBe(false);
    expect(batchCheckHostedDomainsRequestSchema.safeParse({ ids: [1, 2, 1] }).success).toBe(false);
    expect(batchCheckHostedDomainsRequestSchema.safeParse({ ids: [0] }).success).toBe(false);
  });
});
