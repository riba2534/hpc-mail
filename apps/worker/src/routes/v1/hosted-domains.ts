import {
  batchCheckHostedDomainsRequestSchema, batchCreateHostedDomainsRequestSchema, createHostedDomainRequestSchema, hostedDnsRecordInputSchema,
} from '@hpc-mail/shared';
import { Hono, type Context } from 'hono';
import { clientIp, execCtx, ok, parseBody, parseId, parseRecordId } from '../../lib/http.js';
import {
  apiKeyAuth, assertKeyCanUseDomain, keyRestriction, requireScope, restrictedError, restrictionAllowsDomain,
} from '../../middleware/api-key-auth.js';
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

/** Key 所属用户即查看者，管理员 Key 与管理员 JWT 同权；只读接口不写审计 */
function keyViewer(c: Context<AppContext>): Viewer {
  const key = c.get('apiKey')!;
  return { id: key.userId, role: key.role, username: `API Key #${key.id}` };
}

/** 写操作的管理审计记为「用户名（API Key #id）」，与网页操作区分；用户名由鉴权连表读出 */
function keyActor(c: Context<AppContext>): Viewer {
  const key = c.get('apiKey')!;
  return { id: key.userId, role: key.role, username: `${key.username}（API Key #${key.id}）` };
}

/**
 * 限定了邮箱或域名的 Key 只能操作 allowedDomains 里的托管域名。按 id 访问时只看调用者看得到的行（所有者、成员，
 * 有效角色为管理员时全部）：看不到的与不存在一样交给服务层报 404；范围外的 403 只带 id，不带出域名，
 * 否则限定范围的 Key 能按 id 枚举别人托管的域名。
 */
async function assertHostedInKey(c: Context<AppContext>, ids: readonly number[]): Promise<void> {
  const restriction = keyRestriction(c);
  if (!restriction || !ids.length) return;
  const key = c.get('apiKey')!;
  const { results } = await c.env.db.prepare(`SELECT id, domain FROM hosted_domains h WHERE id IN (SELECT value FROM json_each(?1))
      AND (?3 = 'admin' OR h.user_id = ?2 OR EXISTS (SELECT 1 FROM hosted_domain_members m WHERE m.domain_id = h.id AND m.user_id = ?2))`)
    .bind(JSON.stringify(ids), key.userId, key.role).all<{ id: number; domain: string }>();
  const outside = results.find((row) => !restrictionAllowsDomain(restriction, row.domain));
  if (outside) throw restrictedError(`托管域名 #${Number(outside.id)}`);
}

app.get('/', async (c) => {
  requireScope(c, 'domain.read');
  const list = await listMyHostedDomains(c.env, keyViewer(c));
  const restriction = keyRestriction(c);
  return ok(c, restriction ? list.filter((item) => restriction.domains.includes(item.domain)) : list);
});

app.post('/', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, createHostedDomainRequestSchema);
  assertKeyCanUseDomain(c, req.domain);
  return ok(c, await createHostedDomain(c.env, keyActor(c), req.domain, execCtx(c), clientIp(c)), 201);
});

/** 批量添加与批量立即检测：逐项独立结果，单项规则与单个接口相同 */
app.post('/batch', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, batchCreateHostedDomainsRequestSchema);
  for (const domain of req.domains) assertKeyCanUseDomain(c, domain);
  return ok(c, await createHostedDomains(c.env, keyActor(c), req.domains, execCtx(c), clientIp(c)));
});

app.post('/batch-check', async (c) => {
  requireScope(c, 'domain.write');
  const req = await parseBody(c, batchCheckHostedDomainsRequestSchema);
  await assertHostedInKey(c, req.ids);
  return ok(c, await checkHostedDomains(c.env, keyViewer(c), req.ids));
});

app.get('/:id', async (c) => {
  requireScope(c, 'domain.read');
  const id = parseId(c.req.param('id'));
  await assertHostedInKey(c, [id]);
  return ok(c, await getHostedDomain(c.env, keyViewer(c), id));
});

app.post('/:id/check', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  await assertHostedInKey(c, [id]);
  return ok(c, await checkHostedDomain(c.env, keyViewer(c), id, execCtx(c)));
});

app.post('/:id/reconnect', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  await assertHostedInKey(c, [id]);
  return ok(c, await reconnectHostedDomain(c.env, keyActor(c), id, execCtx(c), clientIp(c)));
});

app.get('/:id/dns-records', async (c) => {
  requireScope(c, 'domain.read');
  const id = parseId(c.req.param('id'));
  await assertHostedInKey(c, [id]);
  return ok(c, await listHostedDnsRecords(c.env, keyViewer(c), id));
});

app.post('/:id/dns-records', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const req = await parseBody(c, hostedDnsRecordInputSchema);
  await assertHostedInKey(c, [id]);
  return ok(c, await createHostedDnsRecord(c.env, keyActor(c), id, req, clientIp(c)), 201);
});

app.put('/:id/dns-records/:recordId', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const recordId = parseRecordId(c.req.param('recordId'));
  const req = await parseBody(c, hostedDnsRecordInputSchema);
  await assertHostedInKey(c, [id]);
  return ok(c, await updateHostedDnsRecord(c.env, keyActor(c), id, recordId, req, clientIp(c)));
});

app.delete('/:id/dns-records/:recordId', async (c) => {
  requireScope(c, 'domain.write');
  const id = parseId(c.req.param('id'));
  const recordId = parseRecordId(c.req.param('recordId'));
  await assertHostedInKey(c, [id]);
  await deleteHostedDnsRecord(c.env, keyActor(c), id, recordId, clientIp(c));
  return ok(c, { success: true });
});

export default app;
