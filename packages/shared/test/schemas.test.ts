import { describe, expect, it } from 'vitest';
import {
  claimMailboxRequestSchema,
  createApiKeyRequestSchema,
  createInviteRequestSchema,
  DEFAULT_SETTINGS,
  feishuSettingSchema,
  listMessagesQuerySchema,
  loginRequestSchema,
  registerRequestSchema,
  sendMailRequestSchema,
  SETTING_SCHEMAS,
  updateSettingsRequestSchema,
  usernameSchema,
} from '../src/index.js';

describe('usernameSchema', () => {
  it('接受合法用户名并小写化', () => {
    expect(usernameSchema.parse('  Alice42 ')).toBe('alice42');
    expect(usernameSchema.parse('a_b-c1')).toBe('a_b-c1');
  });
  it('拒绝非法用户名', () => {
    for (const bad of ['ab', '-abc', '_abc', 'a'.repeat(33), '中文名', 'a b', 'a@b']) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('registerRequestSchema', () => {
  it('密码短于 8 位被拒', () => {
    const r = registerRequestSchema.safeParse({ username: 'tester', password: '1234567' });
    expect(r.success).toBe(false);
  });
  it('inviteCode 可选', () => {
    expect(
      registerRequestSchema.safeParse({ username: 'tester', password: 'password1' }).success,
    ).toBe(true);
    expect(
      registerRequestSchema.safeParse({
        username: 'tester',
        password: 'password1',
        inviteCode: 'ABC123',
      }).success,
    ).toBe(true);
  });
});

describe('loginRequestSchema', () => {
  it('登录密码只要非空（不套注册位数规则）', () => {
    expect(loginRequestSchema.safeParse({ username: 'tester', password: 'x' }).success).toBe(true);
  });
});

describe('claimMailboxRequestSchema', () => {
  it('接受并归一化', () => {
    const r = claimMailboxRequestSchema.parse({ localPart: ' Test.User+tag ', domain: 'HPC.email' });
    expect(r).toEqual({ localPart: 'test.user+tag', domain: 'hpc.email' });
  });
  it('拒绝非法前缀', () => {
    for (const bad of ['.abc', 'abc.', 'a..b以', 'a b', '', 'a'.repeat(65)]) {
      expect(
        claimMailboxRequestSchema.safeParse({ localPart: bad, domain: 'hpc.email' }).success,
        bad,
      ).toBe(false);
    }
  });
});

describe('listMessagesQuerySchema', () => {
  it('默认 limit 且 unread 字符串转布尔', () => {
    const r = listMessagesQuerySchema.parse({ unread: '1' });
    expect(r.limit).toBe(30);
    expect(r.unread).toBe(true);
  });
  it('limit 超上限被拒', () => {
    expect(listMessagesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
  it('scope=user 必须带 userId，不再接受 all', () => {
    expect(listMessagesQuerySchema.safeParse({ scope: 'user' }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ scope: 'user', userId: '3' }).success).toBe(true);
    expect(listMessagesQuerySchema.safeParse({ scope: 'unclaimed' }).success).toBe(true);
    expect(listMessagesQuerySchema.safeParse({ scope: 'all' }).success).toBe(false);
  });
});

describe('sendMailRequestSchema', () => {
  const base = {
    from: { mailboxId: 1 },
    to: ['a@example.com'],
    subject: 'Hi',
    text: 'hello',
  };
  it('接受 mailboxId 形式的 from', () => {
    expect(sendMailRequestSchema.safeParse(base).success).toBe(true);
  });
  it('接受 localPart+domain 形式的 from', () => {
    expect(
      sendMailRequestSchema.safeParse({ ...base, from: { localPart: 'me', domain: 'hpc.email' } })
        .success,
    ).toBe(true);
  });
  it('拒绝 from 两种形式混用或都缺', () => {
    expect(
      sendMailRequestSchema.safeParse({ ...base, from: { mailboxId: 1, localPart: 'x', domain: 'y.com' } })
        .success,
    ).toBe(false);
    expect(sendMailRequestSchema.safeParse({ ...base, from: {} }).success).toBe(false);
  });
  it('拒绝空正文', () => {
    expect(sendMailRequestSchema.safeParse({ ...base, text: undefined }).success).toBe(false);
  });
  it('拒绝超 100 收件人', () => {
    const to = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    expect(sendMailRequestSchema.safeParse({ ...base, to }).success).toBe(false);
  });
  it('拒绝非法 base64 附件与路径穿越文件名', () => {
    expect(
      sendMailRequestSchema.safeParse({
        ...base,
        attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: '!!!' }],
      }).success,
    ).toBe(false);
    expect(
      sendMailRequestSchema.safeParse({
        ...base,
        attachments: [{ filename: '../a.txt', contentType: 'text/plain', content: 'aGk=' }],
      }).success,
    ).toBe(false);
  });
});

describe('settings', () => {
  it('DEFAULT_SETTINGS 全部通过各自 schema', () => {
    for (const [key, schema] of Object.entries(SETTING_SCHEMAS)) {
      expect(
        schema.safeParse(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]).success,
        key,
      ).toBe(true);
    }
  });
  it('register_mode 默认 closed', () => {
    expect(DEFAULT_SETTINGS.register_mode).toBe('closed');
  });
  it('feishu webhook 只接受 https 或空（个人偏好复用同一 schema）', () => {
    const s = feishuSettingSchema;
    expect(s.safeParse({ enabled: true, webhookUrl: 'http://x.com/hook', secret: '' }).success).toBe(false);
    expect(s.safeParse({ enabled: false, webhookUrl: '', secret: '' }).success).toBe(true);
  });
  it('updateSettings 空对象被拒', () => {
    expect(updateSettingsRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('createApiKeyRequestSchema / createInviteRequestSchema', () => {
  it('api key 默认限流且 scope 必填', () => {
    const r = createApiKeyRequestSchema.parse({ name: 'script', scopes: ['mail.read'] });
    expect(r.rateLimit).toBe(120);
    expect(createApiKeyRequestSchema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
  });
  it('邀请码默认单次使用', () => {
    const r = createInviteRequestSchema.parse({});
    expect(r.count).toBe(1);
    expect(r.maxUses).toBe(1);
  });
});
