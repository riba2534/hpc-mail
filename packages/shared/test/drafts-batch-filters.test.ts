import { describe, expect, it } from 'vitest';
import {
  batchSendRequestSchema,
  draftInputSchema,
  draftSendInput,
  internalSendMailSchema,
  isUrlAttachment,
  listDraftsQuerySchema,
  listMessagesQuerySchema,
  MAX_BATCH_SEND_ITEMS,
  sendAtProblem,
  sendDraftRequestSchema,
  sendRequestFingerprint,
  type DraftRequestBody,
  type SendDraftRequest,
  type StoredDraftContent,
} from '../src/index.js';

const base = { from: { mailboxId: 3 }, to: ['e@x.io'], subject: 's', text: 't' };

function firstMessage(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }, input: unknown) {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.error!.issues[0]!.message;
}

describe('URL 附件', () => {
  it('attachments 可混用 base64 与 {url}，按 isUrlAttachment 区分；base64 项的解析结果与指纹不变', () => {
    const parsed = internalSendMailSchema.parse({ ...base, attachments: [
      { filename: 'a.txt', contentType: 'text/plain', content: 'aGVs\nbG8=' },
      { url: 'https://files.example.com/r.pdf?sig=1', filename: 'r.pdf', contentId: 'r' },
    ] });
    expect(parsed.attachments.map(isUrlAttachment)).toEqual([false, true]);
    expect(parsed.attachments[0]).toEqual({ filename: 'a.txt', contentType: 'text/plain', content: 'aGVsbG8=' });
    expect(parsed.attachments[1]).toEqual({ url: 'https://files.example.com/r.pdf?sig=1', filename: 'r.pdf', contentId: 'r' });
    const plain = internalSendMailSchema.parse({ ...base, attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'aGVsbG8=' }] });
    expect(JSON.stringify(sendRequestFingerprint(plain))).toContain('"attachments":[{"filename":"a.txt","contentType":"text/plain","content":"aGVsbG8="}]');
  });

  it('非 https、带账号密码、url 与 content 同时给出都拒绝，并给出可读原因', () => {
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: [{ url: 'http://x.example/a' }] })).toContain('https://');
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: [{ url: 'https://u:p@x.example/a' }] })).toContain('https://');
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: [{ url: 'https://x.example/a', content: 'QUJD' }] }))
      .toBe('附件的 url 与 content 只能二选一');
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: [{ filename: 'a', contentType: 'text/plain', content: '@@' }] }))
      .toBe('附件需为合法 base64');
  });

  it('URL 附件不计入 base64 内联体积，但计入附件个数', () => {
    const urls = Array.from({ length: 11 }, (_, i) => ({ url: `https://x.example/${i}` }));
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: urls })).toMatch(/10/);
    expect(internalSendMailSchema.safeParse({ ...base, attachments: urls.slice(0, 6), attachmentTokens: ['a', 'b', 'c', 'd'] }).success).toBe(true);
    expect(firstMessage(internalSendMailSchema, { ...base, attachments: urls.slice(0, 6), attachmentTokens: ['a', 'b', 'c', 'd', 'e'] }))
      .toBe('附件最多 10 个');
  });
});

describe('列表筛选参数', () => {
  it('since/until 接受日期（UTC 零点）与带时区的日期时间，输出毫秒；拒绝无时区时间与纯数字', () => {
    const q = listMessagesQuerySchema.parse({ since: '2026-11-17', until: '2026-11-17T16:00:00+08:00' });
    expect(q.since).toBe(Date.UTC(2026, 10, 17));
    expect(q.until).toBe(Date.UTC(2026, 10, 17, 8));
    expect(listMessagesQuerySchema.parse({ since: '2026-11-17T08:00:00.123Z' }).since).toBe(Date.UTC(2026, 10, 17, 8, 0, 0, 123));
    for (const bad of ['2026-11-17T08:00:00', '1763366400', '2026-13-01', 'yesterday']) {
      expect(firstMessage(listMessagesQuerySchema, { since: bad }), bad).toContain('ISO 8601');
    }
    expect(firstMessage(listMessagesQuerySchema, { since: '2026-11-18', until: '2026-11-17' })).toBe('since 必须早于 until');
    expect(listMessagesQuerySchema.parse({ since: '', until: '' })).toMatchObject({ since: undefined, until: undefined });
  });

  it('from/to 是完整地址或 @域名（转小写）；hasCode/hasAttachments 为开关', () => {
    const q = listMessagesQuerySchema.parse({ from: '@Example.COM', to: 'Bob@X.io', hasCode: '1', hasAttachments: 'false' });
    expect(q).toMatchObject({ from: '@example.com', to: 'bob@x.io', hasCode: true, hasAttachments: false });
    expect(firstMessage(listMessagesQuerySchema, { from: 'example.com' })).toContain('完整地址或 @域名');
    expect(firstMessage(listMessagesQuerySchema, { to: 'bob' })).toContain('完整地址或 @域名');
  });
});

describe('服务端草稿', () => {
  it('内容都可暂缺：空草稿、只有收件人、没有正文都能保存；null 清空可空字段', () => {
    expect(draftInputSchema.parse({})).toEqual({});
    expect(draftInputSchema.parse({ to: ['Bob <b@x.io>'], from: null, replyToMessageId: null, sendAt: null }))
      .toEqual({ to: [{ address: 'b@x.io', name: 'Bob' }], from: null, replyToMessageId: null, sendAt: null });
  });

  it('保存时仍检查格式与上限：畸形地址、超量收件人、重复 contentId、头部冲突', () => {
    expect(firstMessage(draftInputSchema, { to: ['not-an-address'] })).toContain('收件人地址格式非法');
    expect(firstMessage(draftInputSchema, { to: Array.from({ length: 101 }, (_, i) => `u${i}@x.io`) })).toContain('100');
    expect(firstMessage(draftInputSchema, { attachmentTokens: [{ token: 'a', contentId: 'x' }, { token: 'b', contentId: 'X' }] }))
      .toContain('contentId 重复');
    expect(firstMessage(draftInputSchema, { replyToMessageId: 3, headers: { 'In-Reply-To': '<a@b>' } })).toContain('replyToMessageId');
    expect(firstMessage(draftInputSchema, { sendAt: '2026-11-17 08:00' })).toContain('ISO 8601');
  });

  it('存储内容拼回发信请求后按完整发信请求校验：缺收件人或正文时不能发送', () => {
    const content: StoredDraftContent = {
      from: { mailboxId: 3 }, to: [{ address: 'b@x.io', name: 'Bob' }], cc: [], bcc: [], replyTo: [], subject: 'hi',
      headers: {}, replyToMessageId: null, forwardAttachmentsFrom: null, attachmentTokens: [{ token: 't1', contentId: 'logo' }],
    };
    const parsed = internalSendMailSchema.parse(draftSendInput(content, 'body', ''));
    expect(parsed).toMatchObject({ from: { mailboxId: 3 }, to: [{ address: 'b@x.io', name: 'Bob' }], text: 'body',
      attachmentTokens: [{ token: 't1', contentId: 'logo' }], attachments: [] });
    expect(firstMessage(internalSendMailSchema, draftSendInput({ ...content, to: [] }, 'body', ''))).toBe('至少需要一个收件人');
    expect(firstMessage(internalSendMailSchema, draftSendInput(content, '', ''))).toBe('正文不能为空');
  });

  it('未知字段报错并提示正确字段名（E2：scheduledAt 不能被静默忽略）', () => {
    const result = draftInputSchema.safeParse({ subject: 's', scheduledAt: '2026-11-18T09:00:00Z' });
    expect(result.success).toBe(false);
    const issue = result.error!.issues[0]! as { message: string; params?: { fix?: string } };
    expect(issue.message).toBe('草稿不接受字段：scheduledAt');
    expect(issue.params?.fix).toContain('scheduledAt 应写成 sendAt');
    expect(issue.params?.fix).toContain('草稿可用的字段：from, to');
    expect(firstMessage(draftInputSchema, { foo: 1, bar: 2 })).toBe('草稿不接受字段：foo, bar');
    expect(draftInputSchema.parse({ subject: 's', sendAt: null })).toEqual({ subject: 's', sendAt: null });
  });

  it("E2'：与 Object.prototype 同名的字段不会查到原型上的函数当提示", () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const result = draftInputSchema.safeParse(JSON.parse(`{"${key}": 1}`));
      expect(result.success, key).toBe(false);
      const issue = result.error!.issues[0]! as { message: string; params?: { fix?: string } };
      expect(issue.message, key).toBe(`草稿不接受字段：${key}`);
      expect(issue.params?.fix, key).not.toContain('应写成');
      expect(issue.params?.fix, key).not.toContain('native code');
    }
  });

  it("E2'：立即发送的请求体同样拒绝未知字段并给出提示，不会丢掉 sendAt、version 后照常发出", () => {
    expect(sendDraftRequestSchema.parse({})).toEqual({});
    expect(sendDraftRequestSchema.parse({ expectedVersion: 3 })).toEqual({ expectedVersion: 3 });
    const fixOf = (input: unknown) => {
      const result = sendDraftRequestSchema.safeParse(input);
      expect(result.success).toBe(false);
      return result.error!.issues[0]! as { message: string; params?: { fix?: string; docs?: string } };
    };
    const scheduled = fixOf({ sendAt: '2026-11-18T09:00:00+08:00' });
    expect(scheduled.message).toBe('立即发送不接受字段：sendAt');
    expect(scheduled.params?.fix).toContain('PATCH /drafts/:id');
    expect(fixOf({ version: 3 }).params?.fix).toContain('version 应写成 expectedVersion');
    expect(fixOf({ to: ['b@x.io'] }).params?.fix).toContain('PATCH /drafts/:id');
    expect(fixOf({ toString: 1 }).params?.fix).not.toContain('native code');
  });

  it("E2'：请求体类型不带索引签名，前端写错字段名编译期就报错", () => {
    // @ts-expect-error scheduledAt 不是草稿字段（DraftRequestBody 带索引签名时这里不报错，typecheck 失败）
    const body: DraftRequestBody = { subject: 's', scheduledAt: '2026-11-18T09:00:00Z' };
    // @ts-expect-error version 不是立即发送的字段
    const send: SendDraftRequest = { version: 3 };
    expect(draftInputSchema.safeParse(body).success).toBe(false);
    expect(sendDraftRequestSchema.safeParse(send).success).toBe(false);
  });

  it('sendAt 最早 1 分钟后、最晚 30 天内', () => {
    const now = Date.UTC(2026, 10, 17);
    expect(sendAtProblem(now + 59_000, now)).toContain('1 分钟');
    expect(sendAtProblem(now + 60_000, now)).toBeNull();
    expect(sendAtProblem(now + 30 * 86_400_000, now)).toBeNull();
    expect(sendAtProblem(now + 30 * 86_400_000 + 1, now)).toContain('30 天');
  });

  it('列表查询：status 枚举、limit 默认 30', () => {
    expect(listDraftsQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(listDraftsQuerySchema.parse({ status: 'scheduled', limit: '5', cursor: '' })).toEqual({ status: 'scheduled', limit: 5 });
    expect(listDraftsQuerySchema.safeParse({ status: 'queued' }).success).toBe(false);
  });
});

describe('批量发送外层', () => {
  it(`items 1–${MAX_BATCH_SEND_ITEMS} 项，项内容留给逐项解析`, () => {
    expect(batchSendRequestSchema.parse({ items: [{}, 'x'] }).items).toHaveLength(2);
    expect(firstMessage(batchSendRequestSchema, { items: [] })).toBe('至少需要一项');
    expect(firstMessage(batchSendRequestSchema, { items: Array.from({ length: MAX_BATCH_SEND_ITEMS + 1 }, () => ({})) }))
      .toBe(`一次最多 ${MAX_BATCH_SEND_ITEMS} 项`);
  });
});
