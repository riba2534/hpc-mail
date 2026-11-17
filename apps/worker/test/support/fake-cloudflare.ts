/**
 * 系统域名接入测试共用的有状态假 Cloudflare（含 DoH 与 RDAP）。托管域名测试保留各自的 fake，不迁移。
 *
 * 行为按线上实测校准（2026-11-03，见 ~/Downloads/hpc-mail-system-domain-research/01-线上现状盘点.md §6）：
 * - 从未开启 Routing 的 zone：GET email/routing 返回 200，enabled=false、status=unconfigured；
 * - 从未配置的 catch-all：GET 返回 200，enabled=false、action drop、source=api；
 * - catch-all 带 source 字段（api / wrangler）；
 * - Sending 子域列表不带状态，状态要另查 dns/status；
 * - 不存在或 Token 看不到的 zone 返回 403/9109（与无权限难以区分）；pending zone 开启 Routing 返回 2009；
 *   根域传 name 返回 2007；根域有第三方 MX 时开启 Routing 返回 2008（Cloudflare 文档）。
 * 除 api.cloudflare.com、cloudflare-dns.com、RDAP（data.iana.org 与 rdap.fake.test）以外的请求一律 throw，防止用例连到真实网络。
 */
import type { Env } from '../../src/types.js';
import { vi } from 'vitest';

export const FAKE_ACCOUNT = 'acct-test';
export const FAKE_TOKEN = 'test-token';
export const FAKE_WORKER = 'hpc-cloud-mail';

/** 注入假凭据的运行时 env（基础 env 不带凭据，guard-credentials.ts 保证） */
export function cfRuntime(base: Env, extra: Partial<Env> = {}): Env {
  return { ...base, cf_api_token: FAKE_TOKEN, cf_account_id: FAKE_ACCOUNT, worker_name: FAKE_WORKER, ...extra };
}

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl: number;
  meta?: Record<string, unknown>;
  comment?: string | null;
}

export interface FakeRule {
  id: string;
  name?: string;
  enabled: boolean;
  priority?: number;
  matchers: { type: string; field?: string; value?: string }[];
  actions: { type: string; value?: string[] }[];
  source?: string;
}

export interface FakeZone {
  id: string;
  name: string;
  status: 'initializing' | 'pending' | 'active' | 'moved';
  type: string;
  paused: boolean;
  account: string;
  /** false：Token 范围外（列表不返回，直接访问 403/9109，但建同名 zone 返回 1061） */
  visible: boolean;
  createdOn: string;
  activatedOn: string | null;
  nameServers: string[];
  routingEnabled: boolean;
  catchAll: { enabled: boolean; actions: { type: string; value?: string[] }[]; source: string; name?: string };
  rules: FakeRule[];
  records: Map<string, FakeRecord>;
  sending: { tag: string; name: string; enabled: boolean } | null;
}

export interface FakeZoneSeed {
  id?: string;
  name: string;
  status?: FakeZone['status'];
  type?: string;
  paused?: boolean;
  account?: string;
  visible?: boolean;
  createdOn?: string;
  routingEnabled?: boolean;
  catchAll?: Partial<FakeZone['catchAll']> | null;
  rules?: FakeRule[];
  records?: (Omit<FakeRecord, 'id' | 'ttl'> & { id?: string; ttl?: number })[];
  sending?: { tag?: string; name?: string; enabled?: boolean } | null;
}

export interface FakeFailure {
  method?: string;
  /** 匹配去掉 /client/v4 前缀后的路径（不含查询串） */
  path: RegExp;
  /**
   * status：直接返回 status/code，不改状态；throw：请求未发出（超时，CloudflareApiError status 0）；
   * apply-then-throw：远端已生效但响应丢失；unreadable：远端已生效、返回 200 但响应体不是 JSON
   */
  mode?: 'status' | 'throw' | 'apply-then-throw' | 'unreadable';
  status?: number;
  code?: number;
  message?: string;
  /** 429 时的 retry-after 秒数 */
  retryAfter?: number;
  times?: number;
}

export interface FakeOptions {
  zones?: FakeZoneSeed[];
  /** DoH：父域发布 DS 的域名（DNSSEC 已开启） */
  ds?: string[];
  /** DoH 故障：servfail 返回 Status 2；http500；throw 网络错误 */
  doh?: 'ok' | 'servfail' | 'http500' | 'throw';
  /** RDAP：域名 → 注册商名称；未列出的域名返回 404 */
  registrars?: Record<string, string>;
  /** RDAP 整体故障 */
  rdapDown?: boolean;
  /** active 且未开启 Routing 时 PUT catch-all 失败（模拟需要先开启 Routing，返回 400/2020） */
  catchAllRequiresRouting?: boolean;
  /** 账户已开通 Email Sending；false 时子域接口返回 403/10105 */
  sendingEnabled?: boolean;
}

const CF_MX = (n: number) => `route${n}.mx.cloudflare.net`;
const CF_SPF_INCLUDE = 'include:_spf.mx.cloudflare.net';
const unquote = (content: string) => content.replace(/^"|"$/g, '').replace(/"\s*"/g, '');
const isSpfRecord = (r: FakeRecord) => r.type === 'TXT' && /^v=spf1(\s|$)/i.test(unquote(r.content));
const isCfMx = (r: FakeRecord) => r.type === 'MX' && r.content.toLowerCase().replace(/\.$/, '').endsWith('.mx.cloudflare.net');

let zoneCounter = 0;
/** 32 位小写十六进制的 zone id */
export function fakeZoneId(): string {
  zoneCounter += 1;
  return `${Date.now().toString(16)}${zoneCounter.toString(16)}`.padStart(32, 'a').slice(-32);
}

export function fakeCloudflare(opts: FakeOptions = {}) {
  const zones = new Map<string, FakeZone>();
  /** 每次请求 `METHOD /path`（不含 /client/v4 与查询串） */
  const calls: string[] = [];
  const requests: { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null }[] = [];
  const failures: (FakeFailure & { left: number })[] = [];
  const hooks: { method?: string; path: RegExp; run: () => unknown; left: number }[] = [];
  let recordSeq = 0;
  let tagSeq = 0;
  let ruleSeq = 0;
  const sendingEnabled = opts.sendingEnabled ?? true;

  const newRecordId = () => `rec${(++recordSeq).toString().padStart(6, '0')}`;
  function addZone(seed: FakeZoneSeed): FakeZone {
    const zone: FakeZone = {
      id: seed.id ?? fakeZoneId(),
      name: seed.name,
      status: seed.status ?? 'active',
      type: seed.type ?? 'full',
      paused: seed.paused ?? false,
      account: seed.account ?? FAKE_ACCOUNT,
      visible: seed.visible ?? true,
      createdOn: seed.createdOn ?? '2026-01-01T00:00:00.000Z',
      activatedOn: (seed.status ?? 'active') === 'active' ? '2026-01-02T00:00:00.000Z' : null,
      nameServers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
      routingEnabled: seed.routingEnabled ?? false,
      catchAll: { enabled: false, actions: [{ type: 'drop' }], source: 'api', ...(seed.catchAll ?? {}) },
      rules: seed.rules ?? [],
      records: new Map(),
      sending: seed.sending ? { tag: seed.sending.tag ?? `tag${++tagSeq}`, name: seed.sending.name ?? seed.name, enabled: seed.sending.enabled ?? true } : null,
    };
    for (const r of seed.records ?? []) {
      const id = r.id ?? newRecordId();
      zone.records.set(id, { ttl: 1, ...r, id });
    }
    zones.set(zone.id, zone);
    return zone;
  }
  for (const seed of opts.zones ?? []) addZone(seed);

  const records = (zone: FakeZone) => [...zone.records.values()];
  const apex = (zone: FakeZone) => records(zone).filter((r) => r.name === zone.name);
  const foreignMx = (zone: FakeZone) => apex(zone).filter((r) => r.type === 'MX' && !isCfMx(r));
  const spfOk = (zone: FakeZone) => {
    const spf = apex(zone).filter(isSpfRecord);
    return spf.length === 1 && unquote(spf[0]!.content).toLowerCase().includes(CF_SPF_INCLUDE);
  };
  const routingView = (zone: FakeZone) => {
    if (!zone.routingEnabled) return { enabled: false, status: 'unconfigured', name: zone.name };
    const mxOk = apex(zone).some(isCfMx) && foreignMx(zone).length === 0;
    return { enabled: true, status: mxOk && spfOk(zone) ? 'ready' : 'misconfigured', name: zone.name, support_subaddress: false };
  };
  const bounceNames = (zone: FakeZone) => [`cf-bounce.${zone.name}`, `cf-bounce._domainkey.${zone.name}`];
  const sendingStatus = (zone: FakeZone) => {
    if (!zone.sending) return null;
    const owned = records(zone).filter((r) => bounceNames(zone).includes(r.name));
    if (owned.some((r) => !r.meta?.sending)) return { status: 'misconfigured', errors: [{ code: 'conflicting_record' }] };
    return { status: owned.length >= 2 ? 'ready' : 'unconfigured', errors: [] };
  };
  const writeSendingRecords = (zone: FakeZone) => {
    const meta = { read_only: true, sending: true };
    const add = (r: Omit<FakeRecord, 'id' | 'ttl'>) => {
      if (records(zone).some((x) => x.name === r.name && x.type === r.type && x.content === r.content)) return;
      const id = newRecordId();
      zone.records.set(id, { ...r, id, ttl: 1 });
    };
    add({ type: 'MX', name: `cf-bounce.${zone.name}`, content: CF_MX(1), priority: 10, meta });
    add({ type: 'TXT', name: `cf-bounce.${zone.name}`, content: `"v=spf1 ${CF_SPF_INCLUDE} ~all"`, meta });
    add({ type: 'TXT', name: `cf-bounce._domainkey.${zone.name}`, content: '"v=DKIM1; p=MIIB"', meta });
    // Cloudflare 文档：没有 DMARC 时新增 p=reject，已有的保持不变
    if (!records(zone).some((r) => r.name === `_dmarc.${zone.name}`)) {
      add({ type: 'TXT', name: `_dmarc.${zone.name}`, content: '"v=DMARC1; p=reject;"', meta: {} });
    }
  };
  const zoneView = (zone: FakeZone) => ({
    id: zone.id, name: zone.name, status: zone.status, type: zone.type, paused: zone.paused,
    account: { id: zone.account, name: 'Test Account' }, name_servers: zone.nameServers,
    original_name_servers: ['ns1.registrar.example', 'ns2.registrar.example'], original_registrar: null,
    activated_on: zone.activatedOn, created_on: zone.createdOn,
  });
  const ruleView = (rule: FakeRule) => ({ priority: 0, source: 'api', name: '', ...rule });

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const ok = (result: unknown, extra: Record<string, unknown> = {}) => json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
    json({ success: false, errors: [{ code, message }], messages: [], result: null }, status, headers);
  const page = <T>(items: T[], query: URLSearchParams, max = 50) => {
    const perPage = Math.min(Number(query.get('per_page') ?? 20) || 20, max);
    const pageNo = Math.max(Number(query.get('page') ?? 1) || 1, 1);
    const slice = items.slice((pageNo - 1) * perPage, pageNo * perPage);
    return ok(slice, { result_info: { page: pageNo, per_page: perPage, count: slice.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / perPage)) } });
  };

  function handleCloudflare(method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): Response {
    if (path === `/accounts/${FAKE_ACCOUNT}/tokens/verify` || path === '/user/tokens/verify') return ok({ id: 'tok', status: 'active' });
    if (path === '/zones' && method === 'GET') {
      const name = query.get('name');
      const status = query.get('status');
      const account = query.get('account.id');
      const list = [...zones.values()]
        .filter((z) => z.visible && (!account || z.account === account) && (!name || z.name === name) && (!status || z.status === status))
        .sort((a, b) => a.name.localeCompare(b.name));
      return page(list.map(zoneView), query);
    }
    if (path === '/zones' && method === 'POST') {
      const name = String(body.name);
      if ([...zones.values()].some((z) => z.name === name)) return fail(400, 1061, `${name} already exists`);
      const zone = addZone({ name, status: 'pending', createdOn: new Date().toISOString() });
      return ok(zoneView(zone));
    }
    const match = path.match(/^\/zones\/([^/]+)(\/.*)?$/);
    const zone = match ? zones.get(match[1]!) : undefined;
    if (!match) return fail(400, 9999, `unexpected ${method} ${path}`);
    if (!zone || !zone.visible || zone.account !== FAKE_ACCOUNT) return fail(403, 9109, 'Invalid zone identifier');
    const rest = match[2] ?? '';
    if (rest === '' && method === 'GET') return ok(zoneView(zone));
    if (rest === '' && method === 'DELETE') { zones.delete(zone.id); return ok({ id: zone.id }); }
    if (rest === '/activation_check' && method === 'PUT') return ok({ id: zone.id });

    if (rest === '/email/routing' && method === 'GET') return ok(routingView(zone));
    if (rest === '/email/routing/dns' && method === 'POST') {
      if (zone.status !== 'active') return fail(400, 2009, 'Active zone required');
      if (body.name !== undefined && !String(body.name).endsWith(`.${zone.name}`)) {
        return fail(400, 2007, `Invalid Input: must be a subdomains of ${zone.name}`);
      }
      if (foreignMx(zone).length) return fail(400, 2008, 'Non-Cloudflare MX records exist');
      for (const n of [1, 2, 3]) {
        if (!apex(zone).some((r) => r.type === 'MX' && r.content === CF_MX(n))) {
          const id = newRecordId();
          zone.records.set(id, { id, type: 'MX', name: zone.name, content: CF_MX(n), priority: n * 10, ttl: 1, meta: { read_only: true, email_routing: true } });
        }
      }
      // 没有 SPF 时由 Cloudflare 创建；已有 SPF 不新建第二条（缺 include 时状态为 misconfigured）
      if (!apex(zone).some(isSpfRecord)) {
        const id = newRecordId();
        zone.records.set(id, { id, type: 'TXT', name: zone.name, content: `"v=spf1 ${CF_SPF_INCLUDE} ~all"`, ttl: 1, meta: { email_routing: true } });
      }
      if (!records(zone).some((r) => r.name === `cf2024-1._domainkey.${zone.name}`)) {
        const id = newRecordId();
        zone.records.set(id, { id, type: 'TXT', name: `cf2024-1._domainkey.${zone.name}`, content: '"v=DKIM1; h=sha256; k=rsa; p=MIIB"', ttl: 1, meta: { read_only: true, email_routing: true } });
      }
      zone.routingEnabled = true;
      return ok(routingView(zone));
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'GET') {
      return ok({ id: `catchall-${zone.id}`, matchers: [{ type: 'all' }], name: zone.catchAll.name ?? '', ...zone.catchAll });
    }
    if (rest === '/email/routing/rules/catch_all' && method === 'PUT') {
      if (opts.catchAllRequiresRouting && !zone.routingEnabled) return fail(400, 2020, 'Email Routing is not enabled for this zone');
      zone.catchAll = { enabled: Boolean(body.enabled), actions: (body.actions as FakeZone['catchAll']['actions']) ?? [], source: 'api', name: String(body.name ?? '') };
      return ok({ id: `catchall-${zone.id}`, matchers: [{ type: 'all' }], ...zone.catchAll });
    }
    if (rest === '/email/routing/rules' && method === 'GET') return page(zone.rules.map(ruleView), query);
    if (rest === '/email/routing/rules' && method === 'POST') {
      const rule = { id: `rule${++ruleSeq}`, enabled: true, matchers: [], actions: [], ...body } as FakeRule;
      zone.rules.push(rule);
      return ok(ruleView(rule));
    }

    if (rest === '/dns_records' && method === 'GET') {
      const exact = query.get('name.exact')?.toLowerCase();
      const endsWith = query.get('name.endswith')?.toLowerCase();
      const type = query.get('type');
      const list = records(zone).filter((r) => (!exact || r.name.toLowerCase() === exact)
        && (!endsWith || r.name.toLowerCase().endsWith(endsWith)) && (!type || r.type === type));
      return page(list, query, 5000);
    }
    if (rest === '/dns_records' && method === 'POST') {
      const id = newRecordId();
      const record: FakeRecord = { id, type: String(body.type), name: String(body.name), content: String(body.content ?? ''), ttl: Number(body.ttl ?? 1), meta: {} };
      if (body.priority !== undefined) record.priority = Number(body.priority);
      zone.records.set(id, record);
      return ok(record);
    }
    const recordMatch = rest.match(/^\/dns_records\/([^/]+)$/);
    if (recordMatch) {
      const record = zone.records.get(recordMatch[1]!);
      if (!record) return fail(404, 81044, 'Record does not exist.');
      if (method === 'GET') return ok(record);
      if (method === 'PATCH') {
        Object.assign(record, Object.fromEntries(Object.entries(body).filter(([k]) => ['content', 'ttl', 'priority', 'comment'].includes(k))));
        return ok(record);
      }
      if (method === 'DELETE') { zone.records.delete(record.id); return ok({ id: record.id }); }
    }

    if (rest.startsWith('/email/sending') && !sendingEnabled) return fail(403, 10105, 'Email Sending is not enabled for this account');
    if (rest === '/email/sending/subdomains' && method === 'GET') {
      // 与线上一致：列表不带状态
      return ok(zone.sending ? [{ tag: zone.sending.tag, name: zone.sending.name, enabled: zone.sending.enabled, dkim_selector: 'cf-bounce', return_path_domain: `cf-bounce.${zone.name}` }] : []);
    }
    if (rest === '/email/sending/subdomains' && method === 'POST') {
      const name = String(body.name);
      if (zone.sending && zone.sending.name === name) zone.sending.enabled = true;
      else zone.sending = { tag: `tag${++tagSeq}`, name, enabled: true };
      if (zone.status === 'active' && !records(zone).some((r) => bounceNames(zone).includes(r.name) && !r.meta?.sending)) writeSendingRecords(zone);
      return ok({ tag: zone.sending.tag, name: zone.sending.name, enabled: true });
    }
    const sending = rest.match(/^\/email\/sending\/subdomains\/([^/]+)(\/.*)?$/);
    if (sending) {
      if (!zone.sending || zone.sending.tag !== sending[1]) return fail(404, 10000, 'not_found');
      if (sending[2] === '/dns/status' && method === 'GET') return ok({ ...sendingStatus(zone)!, records: [] });
      if (sending[2] === '/dns' && method === 'POST') {
        if (zone.status !== 'active') return fail(400, 2009, 'Active zone required');
        if (records(zone).some((r) => bounceNames(zone).includes(r.name) && !r.meta?.sending)) return fail(409, 81057, 'conflicting record exists');
        writeSendingRecords(zone);
        return ok({ ...sendingStatus(zone)!, records: [] });
      }
      if (!sending[2] && method === 'GET') return ok({ tag: zone.sending.tag, name: zone.sending.name, enabled: zone.sending.enabled });
      if (!sending[2] && method === 'DELETE') { zone.sending = null; return ok({}); }
    }
    return fail(400, 9999, `unexpected ${method} ${path}`);
  }

  function handleDoh(url: URL): Response {
    if (opts.doh === 'throw') throw new TypeError('network error');
    if (opts.doh === 'http500') return new Response('oops', { status: 500 });
    if (opts.doh === 'servfail') return json({ Status: 2 });
    const name = url.searchParams.get('name') ?? '';
    const type = url.searchParams.get('type');
    if (type === 'DS') return json({ Status: 0, Answer: opts.ds?.includes(name) ? [{ name, type: 43, data: '2371 13 2 ABC' }] : [] });
    return json({ Status: 0, Answer: [] });
  }

  function handleRdap(url: URL): Response {
    if (opts.rdapDown) throw new TypeError('rdap unavailable');
    if (url.hostname === 'data.iana.org') {
      return json({ version: '1.0', services: [[['test', 'com', 'org', 'net', 'email'], ['https://rdap.fake.test/']]] });
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/domain\//, '')).toLowerCase();
    const registrar = opts.registrars?.[name];
    if (!registrar) return json({ errorCode: 404, title: 'Not Found' }, 404);
    return json({
      objectClassName: 'domain', ldhName: name,
      entities: [{ objectClassName: 'entity', roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', registrar]]] }],
    });
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.hostname === 'cloudflare-dns.com') return handleDoh(url);
    if (url.hostname === 'data.iana.org' || url.hostname === 'rdap.fake.test') return handleRdap(url);
    if (url.origin !== 'https://api.cloudflare.com') throw new Error(`fake-cloudflare: unexpected request to ${url.href}`);
    if (new Headers(init?.headers).get('Authorization') !== `Bearer ${FAKE_TOKEN}`) return fail(401, 1000, 'Invalid API Token');
    const path = url.pathname.replace('/client/v4', '');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push(`${method} ${path}`);
    requests.push({ method, path, query: url.searchParams, body });
    for (const hook of hooks) {
      if (hook.left > 0 && (!hook.method || hook.method === method) && hook.path.test(path)) {
        hook.left -= 1;
        await hook.run();
      }
    }
    const failure = failures.find((f) => f.left > 0 && (!f.method || f.method === method) && f.path.test(path));
    if (failure) {
      failure.left -= 1;
      const mode = failure.mode ?? 'status';
      if (mode === 'throw') throw new Error('The operation was aborted due to timeout');
      if (mode === 'status') {
        return fail(failure.status ?? 500, failure.code ?? 0, failure.message ?? 'injected failure',
          failure.retryAfter ? { 'retry-after': String(failure.retryAfter) } : {});
      }
      handleCloudflare(method, path, url.searchParams, body ?? {});
      if (mode === 'apply-then-throw') throw new Error('The operation was aborted due to timeout');
      return new Response('<html>bad gateway</html>', { status: 200 });
    }
    return handleCloudflare(method, path, url.searchParams, body ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    zones,
    calls,
    requests,
    fetchMock,
    addZone,
    zoneByName: (name: string) => [...zones.values()].find((zone) => zone.name === name),
    /** 非 GET 的调用 */
    writes: () => calls.filter((call) => !call.startsWith('GET ')),
    /** 指向某个 zone 的写入 */
    writesTo: (zoneId: string) => calls.filter((call) => !call.startsWith('GET ') && call.includes(`/zones/${zoneId}`)),
    /** 是否删除过 zone（系统路径只允许取消时删除本任务创建、未激活的 zone） */
    zoneDeletes: () => calls.filter((call) => /^DELETE \/zones\/[^/]+$/.test(call)),
    fail(failure: FakeFailure) { failures.push({ ...failure, left: failure.times ?? 1 }); },
    /** 在匹配的请求被处理前执行（插入竞态） */
    onCall(rule: { method?: string; path: RegExp; times?: number }, run: () => unknown) { hooks.push({ ...rule, run, left: rule.times ?? 1 }); },
    record(zone: FakeZone, r: Omit<FakeRecord, 'id' | 'ttl'> & { ttl?: number }): FakeRecord {
      const id = newRecordId();
      const record = { ttl: 1, ...r, id };
      zone.records.set(id, record);
      return record;
    },
    recordsOf: (zone: FakeZone, name?: string, type?: string) =>
      [...zone.records.values()].filter((r) => (!name || r.name === name) && (!type || r.type === type)),
  };
}

export type FakeCloudflare = ReturnType<typeof fakeCloudflare>;
