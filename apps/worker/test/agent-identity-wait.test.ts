import type {
  ApiKeySelf, ApiScope, BatchClaimMailboxResult, ClaimPlan, CreatedApiKey, Mailbox, MailboxAvailability, MessageDetail, MessageSummary,
  Page, SendIdentities, WaitMessageResult,
} from '@hpc-mail/shared';
import { API_SCOPES, MAX_WAIT_ADDRESSES } from '@hpc-mail/shared';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { attachments, hostedDomains, mailboxShares, mailboxes, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { bumpCounter, dayWindow } from '../src/services/rate-counter.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';

const app = createApp();
const db = createDb(env);
const SYSTEM_DOMAINS = ['w2.example', 'w2-private.example'];

async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
function json(token: string, body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
async function data<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
async function failure(response: Response, status: number) {
  const body = await response.json() as { error: { code: string; message: string; fix?: string; docs?: string } };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.error;
}

async function actor(username: string, role: 'admin' | 'user' = 'user') {
  await updateSettings(env, {
    domains: { list: [{ domain: SYSTEM_DOMAINS[0]!, public: true, perUserLimit: 0 }, { domain: SYSTEM_DOMAINS[1]!, public: false, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 200, dailyRecipients: 500 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const [user] = await db.insert(users).values({ username, role, passwordHash: 'x', status: 'active', authVersionMigrated: true }).returning();
  const sid = await createSession(env, user!.id);
  const jwt = await signToken(env.jwt_secret, { sub: user!.id, sid, epoch: 0, uepoch: 0 });
  return { id: user!.id, jwt, key: await keyFor(jwt, [...API_SCOPES]) };
}
async function keyFor(jwt: string, scopes: ApiScope[]) {
  return (await data<CreatedApiKey>(await request('/api/api-keys', json(jwt, { name: `k-${scopes.join('-') || 'none'}`.slice(0, 64), scopes, rateLimit: 600 })), 201)).key;
}
async function own(userId: number, address: string) {
  return (await db.insert(mailboxes).values({ address, domain: address.split('@')[1]!, userId }).returning().get())!;
}
async function inbound(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await db.insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'sender@outside.example', subject: 's', preview: 'p', status: 'received', ...extra,
  }).returning({ id: messages.id }).get())!.id;
}
const head = async () => (await env.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages').first<{ id: number }>())!.id;

describe('发件身份 GET /v1/identities 与 /api/identities', () => {
  it('自己的邮箱按域名状态给 canSend/reason，共享来的只读；普通用户的 domains 只有自己发信就绪的托管域名', async () => {
    const user = await actor('w2-identity-user');
    const owner = await actor('w2-identity-owner');
    const gone = await actor('w2-identity-gone');
    await db.insert(hostedDomains).values([
      { domain: 'w2-ready.example', userId: user.id, status: 'active', sendingStatus: 'ready' },
      { domain: 'w2-waiting.example', userId: user.id, status: 'provisioning', sendingStatus: '' },
      { domain: 'w2-paused.example', userId: user.id, status: 'suspended', sendingStatus: 'ready' },
    ]);
    const sys = await own(user.id, 'a-sys@w2.example');
    const ready = await own(user.id, 'b@w2-ready.example');
    const waiting = await own(user.id, 'c@w2-waiting.example');
    const paused = await own(user.id, 'd@w2-paused.example');
    const shared = await own(owner.id, 'shared@w2.example');
    const hidden = await own(gone.id, 'hidden@w2.example');
    await db.insert(mailboxShares).values([
      { mailboxId: shared.id, userId: user.id, grantedBy: owner.id },
      { mailboxId: hidden.id, userId: user.id, grantedBy: gone.id },
    ]);
    await env.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(gone.id).run();

    const expected: SendIdentities = {
      identities: [
        { kind: 'owned', mailboxId: sys.id, address: sys.address, domain: 'w2.example', displayName: '', canSend: true, reason: null },
        { kind: 'owned', mailboxId: ready.id, address: ready.address, domain: 'w2-ready.example', displayName: '', canSend: true, reason: null },
        { kind: 'owned', mailboxId: waiting.id, address: waiting.address, domain: 'w2-waiting.example', displayName: '', canSend: false, reason: 'hosted_sending_not_ready' },
        { kind: 'owned', mailboxId: paused.id, address: paused.address, domain: 'w2-paused.example', displayName: '', canSend: false, reason: 'hosted_domain_unavailable' },
        { kind: 'shared', mailboxId: shared.id, address: shared.address, domain: 'w2.example', displayName: '', canSend: false, reason: 'shared_readonly' },
      ],
      // 未就绪、暂停的托管域名不能用任意前缀
      domains: [{ domain: 'w2-ready.example', kind: 'hosted', anyLocalPart: true }],
    };
    expect(await data<SendIdentities>(await request('/v1/identities', auth(user.key)))).toEqual(expected);
    expect(await data<SendIdentities>(await request('/api/identities', auth(user.jwt)))).toEqual(expected);

    // 邮箱列表的 canSend 与身份同一判定（只看域名状态）
    for (const [path, token] of [['/v1/mailboxes', user.key], ['/api/mailboxes', user.jwt]] as const) {
      const listed = await data<Mailbox[]>(await request(path, auth(token)));
      expect(Object.fromEntries(listed.map((box) => [box.address, box.canSend]))).toEqual({
        [sys.address]: true, [ready.address]: true, [waiting.address]: false, [paused.address]: false,
      });
    }

    // 发信校验同一判定：错误码不变，附带改正建议与文档锚点
    const error = await failure(await request('/v1/messages', json(user.key, { from: { mailboxId: waiting.id }, to: ['x@outside.example'], subject: 's', text: 't' })), 400);
    expect(error).toMatchObject({ code: 'validation_failed', fix: expect.stringContaining('GET /v1/identities') });
    expect(error.docs).toBe('http://localhost/references/errors.md#forbidden-sender');
  });

  it('管理员 domains 先列全部系统域名（可用任意前缀），别人的邮箱不列出；admin all=1 列表每项带 canSend', async () => {
    const admin = await actor('w2-identity-admin', 'admin');
    const other = await actor('w2-identity-other');
    const mine = await own(admin.id, 'admin-box@w2.example');
    await own(other.id, 'other-box@w2.example');
    const identities = await data<SendIdentities>(await request('/v1/identities', auth(admin.key)));
    // 本文件其他用例造的托管域名、旧域名排在系统域名之后，完整口径见 identity-wait-review.test.ts
    expect(identities.domains.slice(0, SYSTEM_DOMAINS.length)).toEqual(SYSTEM_DOMAINS.map((domain) => ({ domain, kind: 'system', anyLocalPart: true })));
    expect(identities.domains.slice(SYSTEM_DOMAINS.length).every((entry) => entry.kind !== 'system')).toBe(true);
    expect(identities.identities.map((item) => item.address)).toEqual([mine.address]);
    const all = await data<Mailbox[]>(await request('/v1/mailboxes?all=1', auth(admin.key)));
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((box) => typeof box.canSend === 'boolean')).toBe(true);
    expect(all.find((box) => box.address === 'other-box@w2.example')).toMatchObject({ canSend: true, ownerUsername: 'w2-identity-other' });
  });

  it('需要 mail.send 或 mailbox.read 其中之一，否则 403 并指向 forbidden-scope', async () => {
    const user = await actor('w2-identity-scope');
    for (const scopes of [['mail.send'], ['mailbox.read']] as ApiScope[][]) {
      expect((await request('/v1/identities', auth(await keyFor(user.jwt, scopes)))).status, scopes.join()).toBe(200);
    }
    const error = await failure(await request('/v1/identities', auth(await keyFor(user.jwt, ['mail.read', 'mail.write', 'mailbox.write']))), 403);
    expect(error).toMatchObject({ code: 'forbidden', fix: expect.stringContaining('mail.send 或 mailbox.read') });
    expect(error.docs).toBe('http://localhost/references/errors.md#forbidden-scope');
    expect((await request('/api/identities')).status).toBe(401);
  });
});

describe('GET /v1/me', () => {
  it('任何有效 Key 都能自查；今日外发用量随计数变化，配额取设置，重置时间为下一个 UTC 零点', async () => {
    const user = await actor('w2-me-user');
    const key = await keyFor(user.jwt, ['mail.read']);
    const first = await data<ApiKeySelf>(await request('/v1/me', auth(key)));
    const now = new Date();
    expect(first).toEqual({
      key: {
        id: expect.any(Number), name: 'k-mail.read', keyPrefix: key.slice(0, 11), keySuffix: key.slice(-4), scopes: ['mail.read'],
        rateLimit: 600, allowedIps: [], expiresAt: null, createdAt: expect.any(String),
      },
      user: { id: user.id, username: 'w2-me-user', role: 'user' },
      limits: { userRequestsPerMinute: 1200, waitPollsPerMinute: 120 },
      outbound: {
        sent: 0, recipients: 0, dailyLimit: 200, dailyRecipientLimit: 500, exempt: false,
        resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(),
      },
    });
    expect(JSON.stringify(first)).not.toContain(key);
    await bumpCounter(env, 'out', String(user.id), dayWindow(), 3, 7);
    expect((await data<ApiKeySelf>(await request('/v1/me', auth(key)))).outbound).toMatchObject({ sent: 3, recipients: 7 });
    // 昨天的计数不算今天
    await bumpCounter(env, 'out', String(user.id), dayWindow(new Date(Date.now() - 86_400_000)), 50, 50);
    expect((await data<ApiKeySelf>(await request('/v1/me', auth(key)))).outbound).toMatchObject({ sent: 3, recipients: 7 });
    expect((await request('/v1/me')).status).toBe(401);
  });

  it('管理员不受外发配额约束：exempt=true，上限按 0 返回', async () => {
    const admin = await actor('w2-me-admin', 'admin');
    const me = await data<ApiKeySelf>(await request('/v1/me', auth(admin.key)));
    expect(me.user.role).toBe('admin');
    expect(me.outbound).toMatchObject({ dailyLimit: 0, dailyRecipientLimit: 0, exempt: true });
  });
});

describe('C1：批量认领、批量可用性、随机后缀方案开放到 /v1', () => {
  it('scope 分别为 mailbox.write / mailbox.read，结果与 /api 同名接口一致', async () => {
    const user = await actor('w2-c1-user');
    const reader = await keyFor(user.jwt, ['mailbox.read']);
    const writer = await keyFor(user.jwt, ['mailbox.write']);
    const items = [{ localPart: 'w2-c1-a', domain: 'w2.example' }, { localPart: 'w2-c1-b', domain: 'w2.example' }];

    expect((await failure(await request('/v1/mailboxes/availability/batch', json(writer, { items })), 403)).code).toBe('forbidden');
    const availability = await data<MailboxAvailability[]>(await request('/v1/mailboxes/availability/batch', json(reader, { items })));
    expect(availability).toEqual(await data<MailboxAvailability[]>(await request('/api/mailboxes/availability/batch', json(user.jwt, { items }))));
    expect(availability).toEqual(items.map((item) => ({ address: `${item.localPart}@${item.domain}`, available: true })));

    expect((await request('/v1/mailboxes/random-plan?count=2&strategy=uniform', auth(writer))).status).toBe(403);
    const plan = await data<ClaimPlan>(await request('/v1/mailboxes/random-plan?count=2&strategy=uniform', auth(reader)));
    expect(plan).toMatchObject({ strategy: 'uniform', shortfall: 0 });
    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((item) => plan.pool.includes(item.domain))).toBe(true);
    expect((await failure(await request('/v1/mailboxes/random-plan?count=0&strategy=uniform', auth(reader)), 400)).code).toBe('validation_failed');

    expect((await request('/v1/mailboxes/batch', json(reader, { items }))).status).toBe(403);
    const claimed = await data<BatchClaimMailboxResult>(await request('/v1/mailboxes/batch', json(writer, { items: [...items, items[0]] })));
    expect(claimed.claimed.map((box) => box.address)).toEqual(['w2-c1-a@w2.example', 'w2-c1-b@w2.example']);
    expect(claimed).toMatchObject({ taken: [items[0]], notAttempted: [], stoppedBy: null });
    const after = await data<MailboxAvailability[]>(await request('/v1/mailboxes/availability/batch', json(reader, { items })));
    expect(after.map((item) => item.reason)).toEqual(['taken', 'taken']);
  });
});

describe('wait：多地址、domain、include=body', () => {
  it('逗号分隔与重复参数等价；不在地址集合内的新信不返回；跳过不匹配时 scannedThroughId 正确', async () => {
    const user = await actor('w2-wait-multi');
    for (const address of ['w1@w2.example', 'w2@w2.example', 'w3@w2.example']) await own(user.id, address);
    const base = await head();
    const outside = await inbound('w3@w2.example', { fromAddress: 'match@outside.example' });
    const skipped = await inbound('w1@w2.example', { fromAddress: 'noise@outside.example' });
    const target = await inbound('w2@w2.example', { fromAddress: 'match@outside.example', subject: 'target' });
    expect(outside).toBeLessThan(target);

    for (const query of ['address=w1@w2.example,W2@w2.example', 'address=w1@w2.example&address=w2@w2.example']) {
      const found = await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1&from=match@outside.example&${query}`, auth(user.key)));
      expect(found, query).toMatchObject({ message: { id: target, address: 'w2@w2.example' }, scannedThroughId: target });
      expect(found.message).not.toHaveProperty('bodyText');
    }
    // 不带 from：地址集合内最早的一封
    expect(await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1&address=w1@w2.example&address=w2@w2.example`, auth(user.key))))
      .toMatchObject({ message: { id: skipped }, scannedThroughId: skipped });
    // 全部不匹配：超时返回 null，游标推进到最后检查过的那封（集合外的新信不在检查范围）
    expect(await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1&from=none@outside.example&address=w1@w2.example,w2@w2.example`, auth(user.key))))
      .toEqual({ message: null, scannedThroughId: target });
  });

  it(`address 超过 ${MAX_WAIT_ADDRESSES} 个（含重复参数合并后）返回 400；domain 只等该域名下的收件地址`, async () => {
    const user = await actor('w2-wait-domain');
    await own(user.id, 'x@w2.example');
    await own(user.id, 'x@w2-private.example');
    const many = Array.from({ length: MAX_WAIT_ADDRESSES + 1 }, (_, i) => `a${i}@w2.example`);
    expect((await failure(await request(`/v1/messages/wait?timeout=1&address=${many.join(',')}`, auth(user.key)), 400)).code).toBe('validation_failed');
    const repeated = many.map((address) => `address=${address}`).join('&');
    expect((await failure(await request(`/v1/messages/wait?timeout=1&${repeated}`, auth(user.key)), 400)).message).toContain(`最多 ${MAX_WAIT_ADDRESSES} 个`);
    expect((await request(`/v1/messages/wait?timeout=1&address=${many.slice(0, MAX_WAIT_ADDRESSES).join(',')},${many[0]}`, auth(user.key))).status).toBe(200);

    const base = await head();
    await inbound('x@w2.example');
    const wanted = await inbound('x@w2-private.example');
    expect(await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1&domain=w2-private.example`, auth(user.key))))
      .toMatchObject({ message: { id: wanted, domain: 'w2-private.example' }, scannedThroughId: wanted });
    expect((await failure(await request('/v1/messages/wait?timeout=1&domain=not a domain', auth(user.key)), 400)).code).toBe('validation_failed');
  });

  it('include=body 命中时返回与详情相同的结构（附件短期签名），不带时仍是摘要', async () => {
    const user = await actor('w2-wait-body');
    await own(user.id, 'body@w2.example');
    const base = await head();
    const id = await inbound('body@w2.example', {
      subject: 'with body', bodyText: 'full text body', bodyHtml: '<p>hi<img src="cid:logo"></p>',
      recipients: { to: ['body@w2.example'], cc: [], bcc: [] },
    });
    await db.insert(attachments).values([
      { messageId: id, r2Key: `w2/${id}/logo`, filename: 'logo.png', mimeType: 'image/png', size: 10, contentId: 'logo', disposition: 'inline' },
      { messageId: id, r2Key: `w2/${id}/doc`, filename: 'doc.pdf', mimeType: 'application/pdf', size: 20 },
    ]);
    const waited = await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1&include=body`, auth(user.key)));
    const detail = await data<MessageDetail>(await request(`/v1/messages/${id}`, auth(user.key)));
    const strip = (message: MessageDetail) => ({ ...message, bodyHtml: message.bodyHtml.replace(/exp=\d+&sig=[^"]+/g, ''),
      attachments: message.attachments.map((att) => ({ ...att, url: att.url.replace(/exp=\d+&sig=.+$/, '') })) });
    expect(waited.scannedThroughId).toBe(id);
    expect(strip(waited.message as MessageDetail)).toEqual(strip(detail));
    expect(waited.message).toMatchObject({ bodyText: 'full text body', hasAttachments: true, recipients: { to: ['body@w2.example'] } });
    // /v1 短 TTL：签名不超过 5 分钟
    const exp = Number(/exp=(\d+)/.exec((waited.message as MessageDetail).attachments[0]!.url)![1]);
    expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });
});

describe('非法 cursor 返回 400（不再静默当首页）', () => {
  it('邮件列表（/api 与 /v1）、API Key 日志、审计日志；sync 照旧忽略 cursor', async () => {
    const admin = await actor('w2-cursor-admin', 'admin');
    const keys = await data<{ id: number }[]>(await request('/api/api-keys', auth(admin.jwt)));
    const keyId = keys[0]!.id;
    for (const bad of ['abc', '@@@', btoa('0'), btoa('-1'), btoa('x')]) {
      const cursor = encodeURIComponent(bad);
      for (const [path, token] of [
        [`/v1/messages?cursor=${cursor}`, admin.key], [`/api/messages?cursor=${cursor}`, admin.jwt],
        [`/api/api-keys/${keyId}/logs?cursor=${cursor}`, admin.jwt], [`/api/admin/api-keys/${keyId}/logs?cursor=${cursor}`, admin.jwt],
        [`/api/admin/audit-logs?cursor=${cursor}`, admin.jwt],
      ] as const) {
        const error = await failure(await request(path, auth(token)), 400);
        expect(error, path).toMatchObject({ code: 'validation_failed', message: expect.stringContaining('cursor') });
      }
      expect((await request(`/api/messages/sync?cursor=${cursor}`, auth(admin.jwt))).status).toBe(200);
    }
    // 合法游标、空游标照常
    for (const path of [`/v1/messages?cursor=${btoa('99999999')}`, '/v1/messages?cursor=']) {
      expect(await data<Page<MessageSummary>>(await request(path, auth(admin.key)))).toHaveProperty('items');
    }
    expect((await request(`/api/admin/audit-logs?cursor=${btoa('99999999')}`, auth(admin.jwt))).status).toBe(200);
  });
});

describe('CID 内联图：精确替换、inline 标记、hasAttachments 不计内嵌图', () => {
  it('img1 不改坏 img10；被引用并替换的附件 inline=true；列表/wait/线程/详情的 hasAttachments 口径一致', async () => {
    const user = await actor('w2-cid-user');
    await own(user.id, 'cid@w2.example');
    const base = await head();
    const html = '<img src="cid:img1"><img src="cid:img10"><img src="CID:IMG%31"><div style="background:url(cid:img10)"></div><img src="cid:missing">';
    const withImages = await inbound('cid@w2.example', { subject: 'images only', bodyHtml: html });
    const [img1, img10] = await db.insert(attachments).values([
      { messageId: withImages, r2Key: `cid/${withImages}/1`, filename: 'img1.png', mimeType: 'image/png', size: 1, contentId: 'img1', disposition: 'inline' },
      { messageId: withImages, r2Key: `cid/${withImages}/10`, filename: 'img10.png', mimeType: 'image/png', size: 1, contentId: 'img10', disposition: 'inline' },
      { messageId: withImages, r2Key: `cid/${withImages}/u`, filename: 'unused.png', mimeType: 'image/png', size: 1, contentId: 'unused', disposition: 'inline' },
    ]).returning({ id: attachments.id });
    const withFile = await inbound('cid@w2.example', { subject: 'real attachment', bodyHtml: '<img src="cid:sig">' });
    await db.insert(attachments).values([
      { messageId: withFile, r2Key: `cid/${withFile}/sig`, filename: 'sig.png', mimeType: 'image/png', size: 1, contentId: 'sig', disposition: 'inline' },
      { messageId: withFile, r2Key: `cid/${withFile}/doc`, filename: 'doc.pdf', mimeType: 'application/pdf', size: 1 },
    ]);

    for (const [path, token] of [[`/api/messages/${withImages}`, user.jwt], [`/v1/messages/${withImages}`, user.key]] as const) {
      const detail = await data<MessageDetail>(await request(path, auth(token)));
      const url = (id: number) => detail.attachments.find((att) => att.id === id)!.url;
      const escaped = (id: number) => url(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(detail.bodyHtml).toMatch(new RegExp(`^<img src="${escaped(img1!.id)}"><img src="${escaped(img10!.id)}"><img src="${escaped(img1!.id)}"><div style="background:url\\(${escaped(img10!.id)}\\)"></div><img src="cid:missing">$`));
      expect(Object.fromEntries(detail.attachments.map((att) => [att.filename, att.inline]))).toEqual({ 'img1.png': true, 'img10.png': true, 'unused.png': false });
      expect(detail.hasAttachments).toBe(false);
    }
    const fileDetail = await data<MessageDetail>(await request(`/v1/messages/${withFile}`, auth(user.key)));
    expect(fileDetail.hasAttachments).toBe(true);
    expect(Object.fromEntries(fileDetail.attachments.map((att) => [att.filename, att.inline]))).toEqual({ 'sig.png': true, 'doc.pdf': false });

    const listed = await data<Page<MessageSummary>>(await request(`/v1/messages?afterId=${base}`, auth(user.key)));
    expect(Object.fromEntries(listed.items.map((item) => [item.id, item.hasAttachments]))).toEqual({ [withImages]: false, [withFile]: true });
    const waited = await data<WaitMessageResult>(await request(`/v1/messages/wait?afterId=${base}&timeout=1`, auth(user.key)));
    expect(waited.message).toMatchObject({ id: withImages, hasAttachments: false });
    const thread = await data<{ items: MessageSummary[] }>(await request(`/v1/messages/${withFile}/thread`, auth(user.key)));
    expect(thread.items.find((item) => item.id === withFile)?.hasAttachments).toBe(true);
    const imagesThread = await data<{ items: MessageSummary[] }>(await request(`/v1/messages/${withImages}/thread`, auth(user.key)));
    expect(imagesThread.items.find((item) => item.id === withImages)?.hasAttachments).toBe(false);
  });
});
