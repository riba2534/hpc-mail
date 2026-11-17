import {
  batchCheckHostedDomainsRequestSchema, batchCreateHostedDomainsRequestSchema, createHostedDomainRequestSchema, hostedDnsRecordInputSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId, parseRecordId } from '../../lib/http.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { checkHostedDomain, createHostedDomain, getHostedDomain, listMyHostedDomains, reconnectHostedDomain } from '../../services/hosted-domain.js';
import { checkHostedDomains, createHostedDomains } from '../../services/hosted-domain-batch.js';
import { createHostedDnsRecord, deleteHostedDnsRecord, listHostedDnsRecords, updateHostedDnsRecord } from '../../services/hosted-dns.js';
import type { AppContext, AuthUser } from '../../types.js';

type Viewer = Pick<AuthUser, 'id' | 'username' | 'role'>;

/**
 * 托管域名（API Key）：查看、添加（含批量）、立即检测（含批量）、重新接入与 DNS 解析，与 /api 同名接口共用 service，权限、额度、限流与审计一致。
 * 删除（永久删除该域全部邮件）、改成员上限、成员管理与过户只能用 JWT，这里不挂载。
 */
const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);

/** Key 所属用户即查看者，管理员 Key 与管理员 JWT 同权；只读接口不写审计，不查用户名 */
function keyViewer(c: Context<AppContext>): Viewer {
  const key = c.get('apiKey')!;
  return { id: key.userId, role: key.role, username: `API Key #${key.id}` };
}

/** 写操作的管理审计记为「用户名（API Key #id）」，与网页操作区分 */
async function keyActor(c: Context<AppContext>): Promise<Viewer> {
  const viewer = keyViewer(c);
  const username = await c.env.db.prepare('SELECT username FROM users WHERE id = ?').bind(viewer.id).first<string>('username');
  return { ...viewer, username: `${username ?? `user#${viewer.id}`}（${viewer.username}）` };
}

app.get('/', async (c) => {
  requireScope(c, 'domain.read');
  return ok(c, await listMyHostedDomains(c.env, keyViewer(c)));
});

app.post('/', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, createHostedDomainRequestSchema);
  return ok(c, await createHostedDomain(c.env, await keyActor(c), req.domain, execCtx(c), clientIp(c)), 201);
});

/** 批量添加与批量立即检测：逐项独立结果，单项规则与单个接口相同 */
app.post('/batch', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, batchCreateHostedDomainsRequestSchema);
  return ok(c, await createHostedDomains(c.env, await keyActor(c), req.domains, execCtx(c), clientIp(c)));
});

app.post('/batch-check', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, batchCheckHostedDomainsRequestSchema);
  return ok(c, await checkHostedDomains(c.env, keyViewer(c), req.ids));
});

app.get('/:id', async (c) => {
  requireScope(c, 'domain.read');
  return ok(c, await getHostedDomain(c.env, keyViewer(c), parseId(c.req.param('id'))));
});

app.post('/:id/check', async (c) => {
  requireScope(c, 'domain.write');
  return ok(c, await checkHostedDomain(c.env, keyViewer(c), parseId(c.req.param('id')), execCtx(c)));
});

app.post('/:id/reconnect', async (c) => {
  requireScope(c, 'domain.write');
  return ok(c, await reconnectHostedDomain(c.env, await keyActor(c), parseId(c.req.param('id')), execCtx(c), clientIp(c)));
});

app.get('/:id/dns-records', async (c) => {
  requireScope(c, 'domain.read');
  return ok(c, await listHostedDnsRecords(c.env, keyViewer(c), parseId(c.req.param('id'))));
});

app.post('/:id/dns-records', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, hostedDnsRecordInputSchema);
  return ok(c, await createHostedDnsRecord(c.env, await keyActor(c), id, req, clientIp(c)), 201);
});

app.put('/:id/dns-records/:recordId', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const recordId = parseRecordId(c.req.param('recordId'));
  const req = await parseBody(c, hostedDnsRecordInputSchema);
  return ok(c, await updateHostedDnsRecord(c.env, await keyActor(c), id, recordId, req, clientIp(c)));
});

app.delete('/:id/dns-records/:recordId', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const recordId = parseRecordId(c.req.param('recordId'));
  await deleteHostedDnsRecord(c.env, await keyActor(c), id, recordId, clientIp(c));
  return ok(c, { success: true });
});

export default app;
