import { describe, expect, it } from 'vitest';
import {
  checkCustomHeaders,
  internalSendMailSchema,
  isValidMailAddress,
  MAX_WAIT_ADDRESSES,
  parseMailAddress,
  quotaSettingSchema,
  sendMailRequestSchema,
  sendRequestFingerprint,
  waitMessagesQuerySchema,
  type IssueErrorParams,
} from '../src/index.js';

const base = { from: { mailboxId: 3 }, to: ['e@x.io'], subject: 's', text: 't' };

function firstIssue(input: unknown) {
  const result = internalSendMailSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('unreachable');
  return result.error.issues[0]! as { message: string; params?: IssueErrorParams; path: PropertyKey[] };
}

describe('旧写法的幂等指纹与上线前逐字节一致', () => {
  // 下面三条字符串是新字段上线前（main caabacf）同样输入的 JSON.stringify(schema.parse(input))
  it('base64 附件、token、replyToMessageId、显示名', () => {
    const parsed = internalSendMailSchema.parse({
      from: { localPart: 'Bot', domain: 'Example.com', displayName: ' Bot ' }, to: ['A@x.com'], subject: ' hi ', text: 'body',
      attachmentTokens: ['t1'], attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'aGVs\nbG8=' }], replyToMessageId: 5,
    });
    expect(JSON.stringify(sendRequestFingerprint(parsed))).toBe('{"from":{"localPart":"bot","domain":"example.com","displayName":"Bot"},"to":["a@x.com"],"cc":[],"bcc":[],"subject":"hi","text":"body","replyToMessageId":5,"attachments":[{"filename":"a.txt","contentType":"text/plain","content":"aGVsbG8="}],"attachmentTokens":["t1"]}');
  });
  it('只有抄送密送与 HTML', () => {
    const parsed = internalSendMailSchema.parse({ from: { mailboxId: 3 }, to: [], cc: ['c@y.org'], bcc: ['d@z.net'], subject: 's', html: '<p>x</p>' });
    expect(JSON.stringify(sendRequestFingerprint(parsed))).toBe('{"from":{"mailboxId":3},"to":[],"cc":["c@y.org"],"bcc":["d@z.net"],"subject":"s","html":"<p>x</p>","attachments":[],"attachmentTokens":[]}');
  });
  it('base64-only 契约', () => {
    expect(JSON.stringify(sendRequestFingerprint(sendMailRequestSchema.parse(base))))
      .toBe('{"from":{"mailboxId":3},"to":["e@x.io"],"cc":[],"bcc":[],"subject":"s","text":"t","attachments":[]}');
  });
  it('新字段参与指纹：显示名、replyTo、headers、带内联参数的 token', () => {
    const parsed = internalSendMailSchema.parse({
      ...base, to: ['Eve <e@x.io>'], replyTo: ['r@x.io'], headers: { 'x-tag': '1' },
      attachmentTokens: [{ token: 't1', contentId: 'logo' }],
    });
    const fingerprint = sendRequestFingerprint(parsed);
    expect(fingerprint.to).toEqual([{ address: 'e@x.io', name: 'Eve' }]);
    expect(fingerprint.replyTo).toEqual(['r@x.io']);
    expect(fingerprint.headers).toEqual({ 'X-tag': '1' });
    expect(fingerprint.attachmentTokens).toEqual([{ token: 't1', contentId: 'logo' }]);
    const empty = sendRequestFingerprint(internalSendMailSchema.parse({ ...base, replyTo: [], headers: {} }));
    expect(empty).not.toHaveProperty('replyTo');
    expect(empty).not.toHaveProperty('headers');
  });
});

describe('地址写法', () => {
  it('解析纯地址、显示名、带引号的显示名与对象写法', () => {
    expect(parseMailAddress('  A@Example.COM ')).toEqual({ address: 'a@example.com', name: '' });
    expect(parseMailAddress('Alice Smith <alice@example.com>')).toEqual({ address: 'alice@example.com', name: 'Alice Smith' });
    expect(parseMailAddress('"Doe, John \\"JD\\"" <j@example.com>')).toEqual({ address: 'j@example.com', name: 'Doe, John "JD"' });
    expect(parseMailAddress('<j@example.com>')).toEqual({ address: 'j@example.com', name: '' });
    expect(parseMailAddress('张三 <z@例子.com>')).toBeNull();
    expect(parseMailAddress('张三 <z@xn--fsqu00a.com>')).toEqual({ address: 'z@xn--fsqu00a.com', name: '张三' });
    expect(parseMailAddress({ address: 'B@x.io', name: ' Bob ' })).toEqual({ address: 'b@x.io', name: 'Bob' });
  });
  it('畸形地址不再当作地址放行', () => {
    for (const bad of ['alice<a@b.com', 'a@b.com>', 'a b@c.com', 'a@b', 'a@-b.com', 'a..b@c.com', '.a@c.com', 'a@b.c',
      '"x"@b.com', 'a@b.com, c@d.com', 'x <a@b.com> y', 'Evil\r\nBcc: x@y.com <a@b.com>', 'a@[127.0.0.1]']) {
      expect(parseMailAddress(bad), bad).toBeNull();
    }
    expect(isValidMailAddress('a+tag@sub.example.co')).toBe(true);
    expect(isValidMailAddress(`${'a'.repeat(65)}@b.com`)).toBe(false);
  });
  it('收件人数组接受三种写法并输出 {address, name}', () => {
    const parsed = internalSendMailSchema.parse({ ...base, to: ['a@x.io', 'Bob <b@x.io>', { address: 'c@x.io', name: 'Carl' }], cc: [{ address: 'd@x.io' }] });
    expect(parsed.to).toEqual([{ address: 'a@x.io', name: '' }, { address: 'b@x.io', name: 'Bob' }, { address: 'c@x.io', name: 'Carl' }]);
    expect(parsed.cc).toEqual([{ address: 'd@x.io', name: '' }]);
    expect(firstIssue({ ...base, to: ['alice<a@b.com'] }).message).toContain('收件人地址格式非法');
    expect(firstIssue({ ...base, bcc: ['x'.repeat(65) + ' <a@b.com>'] }).message).toContain('显示名不能超过');
  });
  it('from 四种写法；字符串写法输出 localPart+domain', () => {
    expect(internalSendMailSchema.parse({ ...base, from: 'Support Bot <Bot@Example.com>' }).from)
      .toEqual({ localPart: 'bot', domain: 'example.com', displayName: 'Support Bot' });
    expect(internalSendMailSchema.parse({ ...base, from: 'bot@example.com' }).from).toEqual({ localPart: 'bot', domain: 'example.com' });
    expect(internalSendMailSchema.parse({ ...base, from: { address: 'bot@example.com', name: 'B' } }).from)
      .toEqual({ localPart: 'bot', domain: 'example.com', displayName: 'B' });
    expect(internalSendMailSchema.parse({ ...base, from: { mailboxId: 9, displayName: 'D' } }).from).toEqual({ mailboxId: 9, displayName: 'D' });
    expect(firstIssue({ ...base, from: { mailboxId: 1, localPart: 'a', domain: 'b.com' } }).message).toContain('之一');
    expect(firstIssue({ ...base, from: 'not an address' }).message).toContain('from 地址格式非法');
    expect(firstIssue({ ...base, from: "o'brien@example.com" }).message).toContain('/v1/identities');
  });
  it('replyTo 最多 10 个', () => {
    expect(internalSendMailSchema.parse({ ...base, replyTo: ['Help <h@x.io>'] }).replyTo).toEqual([{ address: 'h@x.io', name: 'Help' }]);
    expect(internalSendMailSchema.safeParse({ ...base, replyTo: Array.from({ length: 11 }, (_, i) => `r${i}@x.io`) }).success).toBe(false);
  });
});

describe('自定义邮件头', () => {
  it('白名单头规范大小写，X- 头统一前缀', () => {
    const result = checkCustomHeaders({ 'x-campaign': 'a', 'list-unsubscribe': '<https://u.example/x>, <mailto:u@x.io>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'auto-submitted': 'auto-generated', importance: 'High' });
    expect(result).toEqual({ ok: true, headers: {
      'X-campaign': 'a', 'List-Unsubscribe': '<https://u.example/x>, <mailto:u@x.io>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated', Importance: 'High',
    } });
  });
  it('平台头、专用字段头与非白名单头一次列出，错误码 header_not_allowed', () => {
    const result = checkCustomHeaders({ 'Message-ID': '<a@b>', From: 'x@y.z', 'ARC-Seal': 'x', 'X-ok': '1', Sender: 'x@y.z', 'X Bad': '1' });
    expect(result).toMatchObject({ ok: false, code: 'header_not_allowed', headers: ['Message-ID', 'From', 'ARC-Seal', 'Sender', 'X Bad'] });
    expect(result.ok ? '' : result.message).toContain('请改用请求字段 from');
  });
  it('取值问题报 validation_failed 并指出头名称', () => {
    const cases: [Record<string, string>, string][] = [
      [{ 'X-A': 'a\r\nBcc: x@y.z' }, '换行'],
      [{ 'X-A': ' ' }, '不能为空'],
      [{ 'X-A': 'a'.repeat(2049) }, '2048'],
      [{ 'X-A': '1', 'x-a': '2' }, '重复'],
      [{ Precedence: 'urgent' }, 'bulk'],
      [{ 'List-Unsubscribe': '<http://u.example/x>' }, 'https'],
      [{ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, 'List-Unsubscribe'],
      [{ 'List-Unsubscribe': '<mailto:u@x.io>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, 'https'],
      [{ 'List-Unsubscribe': '<https://u.example>', 'List-Unsubscribe-Post': 'one-click' }, 'One-Click'],
      [{ 'In-Reply-To': 'abc@x' }, 'message-id'],
      [{ References: '<a@x> b@x' }, 'message-id'],
      [{ 'List-Id': '列表 <l.x.io>' }, 'ASCII'],
    ];
    for (const [headers, fragment] of cases) {
      const result = checkCustomHeaders(headers);
      expect(result.ok, JSON.stringify(headers)).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('validation_failed');
        expect(result.message).toContain(fragment);
        expect(result.headers.length).toBeGreaterThan(0);
      }
    }
    expect(checkCustomHeaders({ Comments: '中文备注', 'X-Note': '中文' }).ok).toBe(true);
  });
  it('非 X- 头最多 20 个、总量 16KB', () => {
    const twentyOne: Record<string, string> = {};
    for (const name of ['In-Reply-To', 'References', 'Thread-Index', 'Thread-Topic', 'List-Unsubscribe', 'List-Id', 'List-Archive', 'List-Help',
      'List-Owner', 'List-Post', 'List-Subscribe', 'Precedence', 'Auto-Submitted', 'Content-Language', 'Keywords', 'Comments', 'Importance',
      'Priority', 'Sensitivity', 'Organization', 'Archived-At']) twentyOne[name] = 'x';
    Object.assign(twentyOne, { 'In-Reply-To': '<a@b>', References: '<a@b>', 'List-Unsubscribe': '<https://u.example>', Precedence: 'bulk',
      Importance: 'low', Priority: 'normal', Sensitivity: 'private' });
    const tooMany = checkCustomHeaders(twentyOne);
    expect(tooMany.ok ? '' : tooMany.message).toContain('最多 20');
    const big = checkCustomHeaders(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`X-H${i}`, 'v'.repeat(2000)])));
    expect(big.ok ? '' : big.message).toContain('16384');
  });
  it('schema 把错误码与被拒头放进 issue params；replyToMessageId 与 In-Reply-To 冲突', () => {
    const issue = firstIssue({ ...base, headers: { 'Message-ID': '<a@b>' } });
    expect(issue.params).toMatchObject({ errorCode: 'header_not_allowed', details: { headers: ['Message-ID'] } });
    expect(issue.params?.docs).toBe('/references/errors.md#header_not_allowed');
    expect(firstIssue({ ...base, headers: { 'X-A': '' } }).params?.errorCode).toBe('validation_failed');
    expect(firstIssue({ ...base, replyToMessageId: 3, headers: { 'In-Reply-To': '<a@b>' } }).message).toContain('不能同时提供');
    expect(internalSendMailSchema.parse({ ...base, headers: { 'In-Reply-To': '<a@b>', References: '<z@b> <a@b>' } }).headers)
      .toEqual({ 'In-Reply-To': '<a@b>', References: '<z@b> <a@b>' });
  });
});

describe('内联附件与体积', () => {
  const att = { filename: 'logo.png', contentType: 'image/png', content: 'aGk=' };
  it('contentId 去掉尖括号；inline 必须有 contentId；contentId 不能重复（含 token）', () => {
    expect(internalSendMailSchema.parse({ ...base, attachments: [{ ...att, contentId: '<logo@x>', disposition: 'inline' }] }).attachments[0])
      .toMatchObject({ contentId: 'logo@x', disposition: 'inline' });
    expect(firstIssue({ ...base, attachments: [{ ...att, disposition: 'inline' }] }).message).toContain('需要 contentId');
    expect(firstIssue({ ...base, attachments: [{ ...att, contentId: 'a' }], attachmentTokens: [{ token: 't', contentId: 'A' }] }).message).toContain('重复');
    expect(internalSendMailSchema.safeParse({ ...base, attachments: [{ ...att, contentId: 'a b' }] }).success).toBe(false);
    expect(internalSendMailSchema.parse({ ...base, attachmentTokens: ['t1', { token: 't2', contentId: 'c', disposition: 'inline' }] }).attachmentTokens)
      .toEqual([{ token: 't1' }, { token: 't2', contentId: 'c', disposition: 'inline' }]);
  });
  it('base64 内联附件合计超过 10MB 报 payload_too_large 并指向上传', () => {
    const content = 'A'.repeat(Math.ceil((10 * 1024 * 1024 + 3) / 3) * 4);
    const issue = firstIssue({ ...base, attachments: [{ ...att, content }] });
    expect(issue.params).toMatchObject({ errorCode: 'payload_too_large' });
    expect(issue.params?.fix).toContain('/v1/uploads');
    const atLimit = 'A'.repeat(Math.floor((10 * 1024 * 1024) / 3) * 4);
    expect(internalSendMailSchema.safeParse({ ...base, attachments: [{ ...att, content: atLimit }] }).success).toBe(true);
  });
});

describe('wait 参数', () => {
  it('address 逗号分隔、去重、上限；domain 与 include', () => {
    const parsed = waitMessagesQuerySchema.parse({ address: 'A@x.io, b@x.io,a@x.io', domain: 'X.io', include: 'body' });
    expect(parsed).toMatchObject({ address: ['a@x.io', 'b@x.io'], domain: 'x.io', include: 'body' });
    expect(waitMessagesQuerySchema.parse({ address: '' }).address).toBeUndefined();
    const many = Array.from({ length: MAX_WAIT_ADDRESSES + 1 }, (_, i) => `a${i}@x.io`).join(',');
    expect(waitMessagesQuerySchema.safeParse({ address: many }).success).toBe(false);
    expect(waitMessagesQuerySchema.safeParse({ address: 'a@x.io,bad' }).success).toBe(false);
    expect(waitMessagesQuerySchema.safeParse({ include: 'attachments' }).success).toBe(false);
  });
});

describe('转发中转配额设置', () => {
  it('旧配置缺新字段时取缺省值', () => {
    expect(quotaSettingSchema.parse({ dailyOutbound: 1, dailyRecipients: 2 })).toEqual({ dailyOutbound: 1, dailyRecipients: 2, relayDaily: 300, relayPerUserDaily: 50 });
  });
});
