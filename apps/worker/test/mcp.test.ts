import { API_SCOPES, MAX_SEND_REQUEST_BYTES, type ApiScope, type CreatedApiKey, type MessageDetail } from '@hpc-mail/shared';
import { MCP_TOOL_NAMES } from '@hpc-mail/shared/mcp';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { apiKeys, apiRequestLogs, messages, users } from '../src/db/schema.js';
import { signToken } from '../src/lib/jwt.js';
import { replyEnvelope } from '../src/routes/mcp/tools.js';
import { createSession } from '../src/services/session.js';
import { updateSettings } from '../src/services/setting.js';
import { grantLegacyAdminScope, TEST_PASSWORD, testPasswordHash } from './key-helpers.js';
import type { Env } from '../src/types.js';
import { fakeRateLimits } from './fake-rate-limits.js';
import wranglerToml from '../wrangler.toml?raw';
import skillDoc from '../../web/public/skill.md?raw';
import llmsDoc from '../../web/public/llms.txt?raw';
import mcpDoc from '../../web/public/references/mcp.md?raw';

const app = createApp();
const db = createDb(env);
const DOMAIN = 'hpc.email';

async function request(path: string, init?: RequestInit, target: Env = env) {
  const ctx = createExecutionContext();
  const response = await app.request(path, init, target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function post(key: string | null, body: unknown, headers: Record<string, string> = {}, target: Env = env) {
  return request('/mcp', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: {
    ...(key === null ? {} : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers,
  } }, target);
}

let rpcId = 0;
interface RpcBody { jsonrpc: string; id: number | string | null; result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } }
async function rpc(key: string, method: string, params?: unknown, status = 200): Promise<RpcBody> {
  const response = await post(key, { jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
  const body = await response.json() as RpcBody;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown> & { error?: { code: string; message: string; fix?: string; docs?: string }; requestId?: string };
  isError?: boolean;
}
async function tool(key: string, name: string, args?: unknown): Promise<ToolResult> {
  const body = await rpc(key, 'tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
  const result = body.result as unknown as ToolResult;
  if (!result.isError) expect(JSON.parse(result.content[0]!.text), 'text 内容与 structuredContent 一致').toEqual(result.structuredContent);
  return result;
}
async function ok<T = Record<string, unknown>>(key: string, name: string, args?: unknown): Promise<T> {
  const result = await tool(key, name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  return result.structuredContent as T;
}
async function toolError(key: string, name: string, args?: unknown) {
  const result = await tool(key, name, args);
  expect(result.isError).toBe(true);
  return result.structuredContent.error!;
}

async function actor(username: string, scopes: ApiScope[] = [...API_SCOPES], role: 'admin' | 'user' = 'user') {
  await updateSettings(env, {
    domains: { list: [{ domain: DOMAIN, public: true, perUserLimit: 0 }] },
    code_extract: { enabled: false, aiEnabled: false },
    quota: { dailyOutbound: 0, dailyRecipients: 0 },
    security: { require2fa: false },
    api: { enabled: true },
  });
  const user = (await db.insert(users).values({ username, role, passwordHash: await testPasswordHash(), status: 'active', authVersionMigrated: true }).returning().get())!;
  const sid = await createSession(env, user.id);
  const jwt = await signToken(env.jwt_secret, { sub: user.id, sid, epoch: 0, uepoch: 0 });
  const keyFor = async (keyScopes: ApiScope[]) => {
    const response = await request('/api/api-keys', { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `mcp-${keyScopes.length}`, scopes: keyScopes.filter((scope) => scope !== 'admin'), rateLimit: 600, password: TEST_PASSWORD }) });
    expect(response.status).toBe(201);
    const created = ((await response.json()) as { data: CreatedApiKey }).data;
    // admin scope 按存量管理员 Key 的形态补上（新建要求 IP 白名单，测试请求不带来源 IP）
    if (role === 'admin' && keyScopes.includes('admin')) await grantLegacyAdminScope(env, created.id);
    return created;
  };
  const key = await keyFor(scopes);
  return { id: user.id, jwt, key: key.key, keyId: key.id, keyFor };
}

async function inbound(address: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await db.insert(messages).values({
    direction: 'inbound', address, domain: address.split('@')[1]!, fromAddress: 'robot@sender.example', subject: 'notice', preview: 'p', status: 'received', ...extra,
  }).returning({ id: messages.id }).get())!.id;
}

describe('MCP 传输与握手', () => {
  it('initialize 协商版本、返回能力与说明；不发会话 ID；Link 指向 MCP 文档', async () => {
    const user = await actor('mcp-init');
    for (const [requested, expected] of [['2025-11-25', '2025-11-25'], ['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2024-01-01', '2025-11-25']]) {
      const response = await post(user.key, { jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(response.headers.get('MCP-Session-Id')).toBeNull();
      expect(response.headers.get('Link')).toBe('</references/mcp.md>; rel="describedby"; type="text/markdown"');
      const body = await response.json() as RpcBody;
      expect(body).toMatchObject({ jsonrpc: '2.0', id: 'init', result: {
        protocolVersion: expected, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hpc-mail', title: 'HPC Mail', websiteUrl: 'http://localhost' },
      } });
      expect(body.result!.instructions).toContain('http://localhost/references/mcp.md');
    }
    const initialized = await post(user.key, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe('');
    const clientResponse = await post(user.key, { jsonrpc: '2.0', id: 5, result: {} });
    expect(clientResponse.status).toBe(202);
    expect((await rpc(user.key, 'ping')).result).toEqual({});
    for (const method of ['resources/list', 'prompts/list', 'no/such']) expect((await rpc(user.key, method)).error).toMatchObject({ code: -32601 });
  });

  it('只接受 POST；校验 Origin、协议版本头、请求体大小与 JSON-RPC 结构', async () => {
    const user = await actor('mcp-transport');
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const response = await request('/mcp', { method, headers: { Authorization: `Bearer ${user.key}`, Accept: 'text/event-stream' } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(user.key, ping, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(user.key, ping, { Origin: 'http://localhost' })).status).toBe(200);
    expect((await post(user.key, ping, { Origin: 'https://hpc.email' })).status).toBe(403);
    expect((await request('/mcp', { method: 'POST', body: JSON.stringify(ping), headers: { Authorization: `Bearer ${user.key}`, Origin: 'https://hpc.email' } }))
      .status).toBe(403);
    const versioned = await post(user.key, ping, { 'MCP-Protocol-Version': '1999-01-01' });
    expect(versioned.status).toBe(400);
    expect(await versioned.json()).toMatchObject({ error: { code: -32600, data: { supported: ['2025-11-25', '2025-06-18', '2025-03-26'] } } });
    expect((await post(user.key, ping, { 'MCP-Protocol-Version': '2025-06-18' })).status).toBe(200);
    expect((await post(user.key, '{}', { 'Content-Length': String(MAX_SEND_REQUEST_BYTES + 64 * 1024 + 1) })).status).toBe(413);

    const malformed = await post(user.key, '{not json');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '请求体不是合法 JSON' } });
    const batch = await post(user.key, [ping, ping]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
    for (const body of [{ id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
      const response = await post(user.key, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    }
  });

  it('鉴权：缺 Key 与格式错误不查库直接 401；无效 Key 的 initialize 401；API 关闭 403；每次 initialize/tools/list 记一条审计', async () => {
    const user = await actor('mcp-auth');
    for (const key of [null, 'not-a-key']) {
      const response = await post(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="hpc-mail"');
      expect(await response.json()).toMatchObject({ id: null, error: { code: -32001, data: { code: 'unauthorized', docs: 'http://localhost/references/mcp.md' } } });
    }
    const unknown = await rpc(`hpcm_${'0'.repeat(64)}`, 'initialize', {}, 401);
    expect(unknown).toMatchObject({ id: rpcId, error: { code: -32001, message: 'API Key 无效', data: { code: 'unauthorized' } } });

    const before = await db.select().from(apiRequestLogs).where(eq(apiRequestLogs.apiKeyId, user.keyId)).all();
    await rpc(user.key, 'initialize', { protocolVersion: '2025-11-25' });
    await rpc(user.key, 'tools/list');
    const logs = (await db.select().from(apiRequestLogs).where(eq(apiRequestLogs.apiKeyId, user.keyId)).all()).slice(before.length);
    expect(logs.map((row) => `${row.method} ${row.path} ${row.statusCode}`)).toEqual(['POST /mcp 200', 'POST /mcp 200']);

    await updateSettings(env, { api: { enabled: false } });
    const closed = await rpc(user.key, 'tools/list', undefined, 403);
    expect(closed.error).toMatchObject({ code: -32001, data: { code: 'forbidden' } });
    await updateSettings(env, { api: { enabled: true } });
  });
});

describe('MCP tools/list', () => {
  it('恰好 10 个工具，inputSchema 由 shared schema 生成，annotations 区分只读、破坏性与外发', async () => {
    const user = await actor('mcp-list');
    const { tools } = (await rpc(user.key, 'tools/list')).result as { tools: Array<{ name: string; title: string; description: string;
      inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }> };
    expect(tools.map((item) => item.name)).toEqual(MCP_TOOL_NAMES);
    for (const item of tools) {
      expect(item.inputSchema.type, item.name).toBe('object');
      expect(item.inputSchema).not.toHaveProperty('$schema');
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.description).toMatch(/\/v1\//);
    }
    const byName = Object.fromEntries(tools.map((item) => [item.name, item]));
    expect(byName.send_email!.inputSchema.required).toEqual(['from', 'to', 'subject']);
    expect(Object.keys(byName.send_email!.inputSchema.properties as object)).toEqual(expect.arrayContaining(['attachmentTokens', 'idempotencyKey', 'response_format']));
    expect(byName.get_me!.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(byName.get_message!.inputSchema.required).toEqual(['messageId']);
    for (const name of ['get_me', 'list_identities', 'list_mailboxes', 'search_messages', 'get_message', 'wait_for_message']) {
      expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
    expect(byName.release_mailbox!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of ['send_email', 'reply_email']) expect(byName[name]!.annotations, name).toMatchObject({ readOnlyHint: false, openWorldHint: true, idempotentHint: false });
    expect(byName.claim_mailbox!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe('MCP 工具调用', () => {
  it('get_me、认领、身份、邮箱列表、发信（幂等）、搜索、读信、释放的完整流程', async () => {
    const user = await actor('mcp-flow');
    const me = await ok<{ user: { username: string }; key: { scopes: string[] }; domains: string[] }>(user.key, 'get_me');
    expect(me.user.username).toBe('mcp-flow');
    expect(me.key.scopes).toEqual(API_SCOPES.filter((scope) => scope !== 'admin'));
    expect(me.domains).toEqual([DOMAIN]);

    const sender = await ok<{ id: number; address: string }>(user.key, 'claim_mailbox', { localPart: 'mcp-flow-a', domain: DOMAIN });
    expect(sender).toEqual({ id: expect.any(Number), address: `mcp-flow-a@${DOMAIN}`, displayName: '' });
    const receiver = await ok<{ id: number; address: string; domain: string; userId: number }>(user.key, 'claim_mailbox',
      { localPart: 'MCP-Flow-B', domain: DOMAIN, response_format: 'detailed' });
    expect(receiver).toMatchObject({ address: `mcp-flow-b@${DOMAIN}`, domain: DOMAIN, userId: user.id });
    expect((await toolError(user.key, 'claim_mailbox', { localPart: 'mcp-flow-a', domain: DOMAIN })).code).toBe('address_taken');

    const identities = await ok<{ identities: unknown[]; domains: unknown[] }>(user.key, 'list_identities');
    expect(identities.identities).toEqual(expect.arrayContaining([{ mailboxId: sender.id, address: sender.address, kind: 'owned', canSend: true, reason: null }]));
    const boxes = await ok<{ mailboxes: unknown[] }>(user.key, 'list_mailboxes');
    expect(boxes.mailboxes).toEqual(expect.arrayContaining([{ id: receiver.id, address: receiver.address, displayName: '', messageCount: 0, canSend: true }]));
    const detailedBoxes = await ok<{ mailboxes: Array<Record<string, unknown>> }>(user.key, 'list_mailboxes', { response_format: 'detailed' });
    expect(detailedBoxes.mailboxes[0]).toHaveProperty('createdAt');

    const long = `${'正文'.repeat(1200)}尾巴`;
    const args = { from: `Flow <${sender.address}>`, to: [receiver.address], subject: 'Hello MCP', text: long, idempotencyKey: 'mcp-flow-once' };
    const sent = await ok<{ id: number; status: string; recipientOutcomes: unknown[] }>(user.key, 'send_email', args);
    expect(sent).toEqual({ id: expect.any(Number), status: 'delivered', address: sender.address, subject: 'Hello MCP',
      recipientOutcomes: [{ address: receiver.address, status: 'delivered' }] });
    expect((await ok<{ id: number }>(user.key, 'send_email', args)).id).toBe(sent.id);
    expect((await toolError(user.key, 'send_email', { ...args, subject: 'changed' })).code).toBe('idempotency_mismatch');

    const found = await ok<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(user.key, 'search_messages',
      { address: receiver.address, direction: 'inbound', limit: 5 });
    expect(found.items).toHaveLength(1);
    const item = found.items[0]!;
    expect(item).toMatchObject({ direction: 'inbound', address: receiver.address, from: sender.address, fromName: 'Flow', subject: 'Hello MCP', isRead: false });
    expect(item).not.toHaveProperty('verificationCode');
    expect([...(item.preview as string)].length).toBeLessThanOrEqual(200);
    const full = await ok<{ items: Array<Record<string, unknown>> }>(user.key, 'search_messages', { q: 'Hello MCP', response_format: 'detailed' });
    expect(full.items.map((entry) => entry.id)).toContain(item.id);
    expect(full.items[0]).toHaveProperty('size');

    const concise = await ok<{ text: string; textTruncated: boolean; to: string[]; attachments: unknown[] }>(user.key, 'get_message', { messageId: item.id });
    expect([...concise.text]).toHaveLength(2000);
    expect(concise).toMatchObject({ textTruncated: true, to: [receiver.address], attachments: [] });
    const detailed = await ok<MessageDetail>(user.key, 'get_message', { messageId: item.id, response_format: 'detailed' });
    expect(detailed.bodyText).toBe(long);
    expect(detailed).toHaveProperty('bodyHtml');

    const released = await ok(user.key, 'release_mailbox', { address: sender.address });
    expect(released).toEqual({ mailboxId: sender.id, success: true, deletedMessages: 0 });
    const purged = await ok(user.key, 'release_mailbox', { mailboxId: receiver.id, deleteHistory: true });
    expect(purged).toEqual({ mailboxId: receiver.id, success: true, deletedMessages: 1 });
    expect(await toolError(user.key, 'release_mailbox', { address: receiver.address })).toMatchObject({ code: 'not_found', fix: expect.stringContaining('list_mailboxes') });
  });

  it('reply_email：回给发件人、Re: 主题、线程头；replyAll 抄送其余收件人；from 可改；HTML 邮件的 concise 正文转纯文本', async () => {
    const user = await actor('mcp-reply');
    const claim = async (localPart: string) => ok<{ id: number; address: string }>(user.key, 'claim_mailbox', { localPart, domain: DOMAIN });
    const [a, b, c, d] = await Promise.all(['mcp-reply-a', 'mcp-reply-b', 'mcp-reply-c', 'mcp-reply-d'].map(claim));
    await ok(user.key, 'send_email', { from: a!.address, to: [b!.address, c!.address], cc: [d!.address], subject: 'Plan', text: 'original' });
    const received = (await ok<{ items: Array<{ id: number }> }>(user.key, 'search_messages', { address: b!.address, direction: 'inbound' })).items[0]!;

    const reply = await ok<{ id: number; status: string; subject: string; recipientOutcomes: Array<{ address: string }> }>(user.key, 'reply_email',
      { messageId: received.id, text: 'reply body', idempotencyKey: 'mcp-reply-1' });
    expect(reply).toMatchObject({ status: 'delivered', address: b!.address, subject: 'Re: Plan', recipientOutcomes: [{ address: a!.address, status: 'delivered' }] });
    const delivered = await db.select().from(messages).where(eq(messages.address, a!.address)).all();
    const replyCopy = delivered.find((row) => row.direction === 'inbound' && row.subject === 'Re: Plan')!;
    const original = await db.select().from(messages).where(eq(messages.id, received.id)).get();
    expect(replyCopy.inReplyTo).toBe(original!.messageId);

    const all = await ok<{ recipientOutcomes: Array<{ address: string }> }>(user.key, 'reply_email',
      { messageId: received.id, text: 'to everyone', replyAll: true, response_format: 'detailed' });
    expect(all.recipientOutcomes.map((entry) => entry.address).sort()).toEqual([a!.address, c!.address, d!.address].sort());
    expect(all).toHaveProperty('size');
    const fromOther = await ok<{ address: string }>(user.key, 'reply_email', { messageId: received.id, text: 'from c', from: c!.address });
    expect(fromOther.address).toBe(c!.address);
    expect(await toolError(user.key, 'reply_email', { messageId: received.id })).toMatchObject({ code: 'validation_failed' });

    await ok(user.key, 'send_email', { from: a!.address, to: [b!.address], subject: 'Html only', html: '<p>Hello <b>HTML</b></p>' });
    const html = (await ok<{ items: Array<{ id: number }> }>(user.key, 'search_messages', { address: b!.address, q: 'Html only' })).items[0]!;
    expect(await ok(user.key, 'get_message', { messageId: html.id })).toMatchObject({ text: 'Hello HTML', textTruncated: false });
  });

  it('replyEnvelope：Reply-To 优先，自己发出的信回给原收件人，replyAll 去重且不带 Bcc', () => {
    const base = { id: 1, direction: 'inbound', address: 'me@x.com', fromAddress: 'boss@y.com', fromName: 'Boss', subject: 'RE: Hi', replyTo: [],
      recipients: { to: ['me@x.com', 'Peer <peer@y.com>'], cc: ['boss@y.com', 'cc@y.com'], bcc: ['hidden@y.com'] } } as unknown as MessageDetail;
    expect(replyEnvelope(base, false)).toEqual({ to: [{ address: 'boss@y.com', name: 'Boss' }], cc: [], subject: 'RE: Hi' });
    expect(replyEnvelope(base, true).cc).toEqual(['Peer <peer@y.com>', 'cc@y.com']);
    expect(replyEnvelope({ ...base, replyTo: ['desk@y.com'], subject: 'Hi' }, false)).toMatchObject({ to: ['desk@y.com'], subject: 'Re: Hi' });
    expect(replyEnvelope({ ...base, direction: 'outbound' }, false).to).toEqual(['me@x.com', 'Peer <peer@y.com>']);
  });

  it('wait_for_message：按 hasCode/from/subjectContains 跳过不匹配的新邮件，超时返回 null 与 scannedThroughId', async () => {
    const user = await actor('mcp-wait');
    const box = await ok<{ address: string }>(user.key, 'claim_mailbox', { localPart: 'mcp-wait', domain: DOMAIN });
    const baseline = await inbound(box.address, { subject: 'old', verificationCode: '000000' });
    const noCode = await inbound(box.address, { subject: 'Your code' });
    const otherSender = await inbound(box.address, { subject: 'Your code', verificationCode: '111111', fromAddress: 'spam@else.example' });
    const hit = await inbound(box.address, { subject: 'Your login code', verificationCode: '424242', verificationLink: 'https://sender.example/v' });
    const found = await ok<{ message: Record<string, unknown>; scannedThroughId: number }>(user.key, 'wait_for_message',
      { address: [box.address], afterId: baseline, hasCode: true, from: '@sender.example', subjectContains: 'login', timeout: 1 });
    expect(found.scannedThroughId).toBe(hit);
    expect(found.message).toMatchObject({ id: hit, verificationCode: '424242', verificationLink: 'https://sender.example/v', from: 'robot@sender.example' });
    expect(noCode).toBeLessThan(otherSender);

    const timeout = await ok<{ message: null; scannedThroughId: number }>(user.key, 'wait_for_message', { address: box.address, afterId: hit, timeout: 1 });
    expect(timeout).toEqual({ message: null, scannedThroughId: hit });
    const late = await inbound(box.address, { subject: 'body please', bodyText: 'full body' });
    const detailed = await ok<{ message: MessageDetail }>(user.key, 'wait_for_message', { afterId: hit, timeout: 1, response_format: 'detailed' });
    expect(detailed.message).toMatchObject({ id: late, bodyText: 'full body', recipients: expect.any(Object) });
  });
});

describe('MCP 权限与错误：与 REST 端点一致', () => {
  it('缺 scope 得到 isError forbidden 与改正建议；参数错误带字段路径；未知工具是协议错误', async () => {
    const user = await actor('mcp-scope', ['mail.read']);
    const send = await toolError(user.key, 'send_email', { from: 'a@hpc.email', to: ['b@hpc.email'], subject: 's', text: 't' });
    expect(send).toMatchObject({ code: 'forbidden', fix: expect.stringContaining('mail.send') });
    const identities = await toolError(user.key, 'list_identities');
    expect(identities.fix).toMatch(/mail\.send.*mailbox\.read/);
    const writer = (await user.keyFor(['mailbox.write'])).key;
    expect(await toolError(writer, 'release_mailbox', { address: 'x@hpc.email' })).toMatchObject({ code: 'forbidden', fix: expect.stringContaining('mailbox.read') });
    const sender = (await user.keyFor(['mail.send'])).key;
    expect(await toolError(sender, 'reply_email', { messageId: 1, text: 'x' })).toMatchObject({ code: 'forbidden', fix: expect.stringContaining('mail.read') });

    const bad = await tool(user.key, 'send_email', { from: 'a@hpc.email', to: 'b@hpc.email', subject: 's' });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toMatchObject({ code: 'validation_failed', message: expect.stringMatching(/^参数 to：/) });
    expect(bad.content[0]!.text).toMatch(/^validation_failed：参数 to：.*\n改正：按 tools\/list/);
    expect(await toolError(user.key, 'release_mailbox', { mailboxId: 1, address: 'a@hpc.email' })).toMatchObject({ code: 'validation_failed' });
    expect(await toolError(user.key, 'search_messages', { unread: 'yes' })).toMatchObject({ code: 'validation_failed', message: expect.stringContaining('unread') });
    expect(await toolError(user.key, 'get_message', { messageId: 999999 })).toMatchObject({ code: 'not_found' });

    expect((await rpc(user.key, 'tools/call', { name: 'nope' })).error).toMatchObject({ code: -32602, message: 'Unknown tool: nope' });
    expect((await rpc(user.key, 'tools/call', { name: 'toString' })).error).toMatchObject({ code: -32602 });
    expect((await rpc(user.key, 'tools/call', { name: 'get_me', arguments: [1] })).error).toMatchObject({ code: -32602 });
    expect((await rpc(user.key, 'tools/call', {})).error).toMatchObject({ code: -32602 });
  });

  it('工具调用只经内部 /v1 请求鉴权一次：审计是对应的 /v1 路径，没有 /mcp 行，限流计数加一', async () => {
    const user = await actor('mcp-once');
    const logs = async () => db.select().from(apiRequestLogs).where(eq(apiRequestLogs.apiKeyId, user.keyId)).all();
    const { env: target, fakes } = fakeRateLimits();
    const beforeLogs = (await logs()).length;
    const called = await post(user.key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_messages', arguments: { limit: 1 } } }, {}, target);
    expect(((await called.json()) as { result?: { isError?: boolean } }).result?.isError).toBeUndefined();
    const added = (await logs()).slice(beforeLogs);
    expect(added.map((row) => `${row.method} ${row.path} ${row.statusCode}`)).toEqual(['GET /v1/messages 200']);
    expect(fakes.rl_api_user.counts.get(String(user.id))).toBe(1);
    const outer = await post(user.key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_me' } }, { 'X-Request-ID': 'mcp-trace-1' });
    expect(outer.headers.get('X-Request-ID')).toBe('mcp-trace-1');
    expect((await logs()).slice(-2).map((row) => row.requestId)).toEqual(['mcp-trace-1', 'mcp-trace-1']);
  });

  it('Key 被吊销或禁用后调用工具返回 HTTP 401', async () => {
    const user = await actor('mcp-revoked');
    await db.update(apiKeys).set({ status: 'disabled' }).where(eq(apiKeys.id, user.keyId));
    const disabled = await post(user.key, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_me' } });
    expect(disabled.status).toBe(401);
    expect(await disabled.json()).toMatchObject({ id: 9, error: { code: -32001, message: 'API Key 已禁用', data: { code: 'unauthorized' } } });
    await db.update(apiKeys).set({ status: 'revoked' }).where(eq(apiKeys.id, user.keyId));
    expect((await post(user.key, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_mailboxes' } })).status).toBe(401);
  });
});

describe('MCP 部署配置与文档', () => {
  it('/mcp 走 Worker：run_worker_first 包含 /mcp', () => {
    const line = (wranglerToml as string).split('\n').find((entry) => entry.startsWith('run_worker_first'))!;
    expect(JSON.parse(line.slice(line.indexOf('[')))).toContain('/mcp');
  });

  it('references/mcp.md 列出全部工具，入口与 llms.txt 指向它', () => {
    for (const name of MCP_TOOL_NAMES) expect(mcpDoc, name).toContain(`| \`${name}\` |`);
    expect(mcpDoc).toContain('https://hpc.email/mcp');
    expect(mcpDoc).toContain('Authorization: Bearer');
    expect(skillDoc).toContain('(references/mcp.md)');
    expect(llmsDoc).toContain('(/references/mcp.md)');
  });
});
