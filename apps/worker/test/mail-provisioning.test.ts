import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingAcceptance, OnboardingChangeEvent } from '../src/db/schema.js';
import { cloudflareCredentials, getZone, type CloudflareCredentials } from '../src/services/cloudflare.js';
import {
  applyMailPlan, dnssecState, gatePlan, inspectMailConfig, lookupRegistrar, planMailChanges, type ApplyHooks, type MailPlan, type ProvisionPolicy,
} from '../src/services/mail-provisioning.js';
import { cfRuntime, fakeCloudflare, FAKE_WORKER, type FakeCloudflare, type FakeZoneSeed } from './support/fake-cloudflare.js';

const creds = cloudflareCredentials(cfRuntime(env)) as CloudflareCredentials;
let cf: FakeCloudflare | null = null;

function setup(zones: FakeZoneSeed[], opts: Parameters<typeof fakeCloudflare>[0] = {}) {
  cf = fakeCloudflare({ ...opts, zones });
  return cf;
}

async function planFor(name: string, policy: ProvisionPolicy = { origin: 'linked' }) {
  const fake = cf!.zoneByName(name)!;
  const zone = (await getZone(creds, fake.id, name))!;
  const inspection = await inspectMailConfig(creds, zone, name);
  const plan = await planMailChanges(inspection, policy);
  return { zone, fake, inspection, plan };
}

function hooks(overrides: Partial<ApplyHooks> = {}) {
  const ledger: OnboardingChangeEvent[] = [];
  let seq = 0;
  const value: ApplyHooks & { ledger: OnboardingChangeEvent[] } = {
    ledger,
    beforeWrite: async () => true,
    record: async (event) => {
      const assigned = event.seq ?? ++seq;
      ledger.push({ ...event, seq: assigned, at: Date.now() });
      return assigned;
    },
    deadline: Date.now() + 60_000,
    ...overrides,
  };
  return value;
}

const acceptAll = (plan: MailPlan): OnboardingAcceptance[] => plan.observed;
const checkOf = (plan: MailPlan, key: string) => plan.checks.find((item) => item.key === key)!;
const apexMx = (content: string, priority = 10) => ({ type: 'MX', name: '', content, priority });

afterEach(() => {
  // 系统路径从不删除 zone、关闭收件路由或删除发信子域
  if (cf) {
    expect(cf.zoneDeletes()).toEqual([]);
    expect(cf.calls.filter((call) => /^DELETE .*\/email\/(routing\/dns|sending\/subdomains)/.test(call))).toEqual([]);
  }
  cf = null;
  vi.unstubAllGlobals();
});

describe('全新 zone', () => {
  it('没有需确认项，一次写完 catch-all、Routing 与发信，复读就绪；再预检无事可做', async () => {
    setup([{ name: 'fresh.test' }]);
    const { inspection, plan } = await planFor('fresh.test');
    expect(plan.verdict).toBe('ready');
    expect(plan.requiredAcks).toEqual([]);
    expect(plan.steps.map((s) => s.kind)).toEqual(['catchAll.put', 'routing.enable', 'sending.create']);
    expect(checkOf(plan, 'dmarc')).toMatchObject({ severity: 'info', state: 'missing' });
    expect(gatePlan(plan, [])).toEqual({ blockers: [], unconfirmed: [] });

    const h = hooks();
    const result = await applyMailPlan(creds, inspection, plan, h);
    expect(result).toMatchObject({ outcome: 'ready', errorCode: '', done: ['catchAll.put', 'routing.enable', 'sending.create'] });
    expect(result.snapshot).toMatchObject({ routing: { state: 'ready' }, catchAll: { state: 'ready' }, sending: { state: 'ready' } });
    expect(h.ledger.filter((e) => e.status === 'started').map((e) => e.kind)).toEqual(['catchAll.put', 'routing.enable', 'sending.create']);
    expect(h.ledger.filter((e) => e.status === 'done')).toHaveLength(3);

    const again = await planFor('fresh.test');
    expect(again.plan).toMatchObject({ ready: true, steps: [], verdict: 'ready' });
  });

  it('zone 未激活：只读 zone，不读邮件配置，结论是等待激活', async () => {
    setup([{ name: 'pending.test', status: 'pending' }]);
    const { plan } = await planFor('pending.test');
    expect(plan.verdict).toBe('pending');
    expect(checkOf(plan, 'zone')).toMatchObject({ severity: 'info', state: 'missing' });
    expect(cf!.calls.filter((c) => c.includes('/email/') || c.includes('/dns_records'))).toEqual([]);
  });

  it('moved、非 full、子域都阻断', async () => {
    setup([{ name: 'moved.test', status: 'moved' }, { name: 'partial.test', type: 'partial' }, { name: 'apex.test' }]);
    expect((await planFor('moved.test')).plan.verdict).toBe('blocked');
    expect((await planFor('partial.test')).plan.verdict).toBe('blocked');
    const zone = (await getZone(creds, cf!.zoneByName('apex.test')!.id, 'apex.test'))!;
    const sub = await planMailChanges(await inspectMailConfig(creds, zone, 'mail.apex.test'), { origin: 'linked' });
    expect(sub.verdict).toBe('blocked');
    expect(checkOf(sub, 'zone').title).toContain('根域');
  });
});

describe('已有邮件服务的 zone', () => {
  const google = (name: string): FakeZoneSeed => ({
    name,
    records: [
      { ...apexMx('smtp.google.com', 1), name },
      { type: 'TXT', name, content: '"v=spf1 include:_spf.google.com ~all"' },
    ],
  });

  it('第三方 MX 是危险确认，合并 SPF、没有 DMARC 需知情确认；确认后删除 MX 并紧接着开启 Routing', async () => {
    setup([google('gmail.test')]);
    const { inspection, plan, fake } = await planFor('gmail.test');
    expect(plan.verdict).toBe('confirm');
    expect(plan.requiredAcks).toEqual(['mx.delete', 'spf.merge', 'dmarc.create']);
    expect(checkOf(plan, 'mx')).toMatchObject({ severity: 'confirm', ack: 'mx.delete', danger: true, records: [{ content: 'smtp.google.com', priority: 1 }] });
    expect(checkOf(plan, 'mx').impact).toContain('smtp.google.com');
    expect(checkOf(plan, 'spf')).toMatchObject({ ack: 'spf.merge', proposed: 'v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all' });
    expect(plan.steps.map((s) => s.kind)).toEqual(['spf.merge', 'catchAll.put', 'mx.delete', 'routing.enable', 'sending.create']);
    expect(gatePlan(plan, []).unconfirmed).toEqual(['mx.delete', 'spf.merge', 'dmarc.create']);

    const h = hooks();
    const result = await applyMailPlan(creds, inspection, plan, h);
    expect(result.outcome).toBe('ready');
    const writes = cf!.writes();
    expect(writes.map((w) => w.replace(fake.id, 'Z').replace(/rec\d+/, 'R'))).toEqual([
      'PATCH /zones/Z/dns_records/R', 'PUT /zones/Z/email/routing/rules/catch_all', 'DELETE /zones/Z/dns_records/R',
      'POST /zones/Z/email/routing/dns', 'POST /zones/Z/email/sending/subdomains',
    ]);
    expect(cf!.recordsOf(fake, 'gmail.test', 'MX').map((r) => r.content).sort()).toEqual(['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net', 'route3.mx.cloudflare.net']);
    expect(cf!.recordsOf(fake, 'gmail.test', 'TXT').map((r) => r.content)).toEqual(['"v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all"']);
    const removed = h.ledger.find((e) => e.kind === 'mx.delete' && e.status === 'started')!;
    expect(removed.before).toMatchObject({ content: 'smtp.google.com', priority: 1 });
    // 删除 MX 后紧接着开启 Routing，中间没有其他写入
    const order = h.ledger.filter((e) => e.status === 'started').map((e) => e.kind);
    expect(order.indexOf('routing.enable')).toBe(order.indexOf('mx.delete') + 1);
  });

  it('null MX 同样是危险确认', async () => {
    setup([{ name: 'nullmx.test', records: [{ ...apexMx('.', 0), name: 'nullmx.test' }] }]);
    const { plan } = await planFor('nullmx.test');
    expect(checkOf(plan, 'mx')).toMatchObject({ ack: 'mx.delete', danger: true });
    expect(checkOf(plan, 'mx').current).toContain('null MX');
    // 有 null MX 说明域名另有安排：没有 DMARC 也要知情确认
    expect(plan.requiredAcks).toContain('dmarc.create');
  });

  it('子域上的 MX 不处理', async () => {
    setup([{ name: 'submx.test', records: [{ ...apexMx('mx.other.example'), name: 'mail.submx.test' }] }]);
    const { plan } = await planFor('submx.test');
    expect(checkOf(plan, 'mx')).toMatchObject({ severity: 'none', state: 'missing' });
  });

  it('catch-all 指向其他 Worker / 转发 / 丢弃：需确认并写出原目标；本站新建的 zone 不需确认', async () => {
    setup([
      { name: 'cw.test', catchAll: { enabled: true, actions: [{ type: 'worker', value: ['other-worker'] }] } },
      { name: 'cf.test', catchAll: { enabled: true, actions: [{ type: 'forward', value: ['me@example.net'] }] } },
      { name: 'cd.test', catchAll: { enabled: true, actions: [{ type: 'drop' }] } },
      { name: 'cc.test', catchAll: { enabled: true, actions: [{ type: 'worker', value: ['other-worker'] }] } },
    ]);
    const worker = checkOf((await planFor('cw.test')).plan, 'catchAll');
    expect(worker).toMatchObject({ ack: 'catchAll.replace', current: '交给 Worker other-worker', proposed: `交给 Worker ${FAKE_WORKER}` });
    expect(worker.impact).toContain('other-worker 将收不到');
    expect(checkOf((await planFor('cf.test')).plan, 'catchAll').impact).toContain('me@example.net');
    expect(checkOf((await planFor('cd.test')).plan, 'catchAll').impact).toContain('丢弃');
    const created = (await planFor('cc.test', { origin: 'created' })).plan;
    expect(checkOf(created, 'catchAll')).toMatchObject({ severity: 'none', state: 'missing' });
    expect(created.steps.map((s) => s.kind)).toContain('catchAll.put');
  });

  it('wrangler 管理的 catch-all 阻断；已指向本站则复用', async () => {
    setup([
      { name: 'wr.test', catchAll: { enabled: true, actions: [{ type: 'worker', value: ['other'] }], source: 'wrangler' } },
      { name: 'ours.test', catchAll: { enabled: true, actions: [{ type: 'worker', value: [FAKE_WORKER] }] } },
    ]);
    const wr = (await planFor('wr.test')).plan;
    expect(wr.verdict).toBe('blocked');
    expect(checkOf(wr, 'catchAll').severity).toBe('blocker');
    const ours = (await planFor('ours.test')).plan;
    expect(checkOf(ours, 'catchAll').state).toBe('ok');
    expect(ours.steps.map((s) => s.kind)).not.toContain('catchAll.put');
  });

  it('多条 SPF、含宏、超过查询上限都阻断', async () => {
    setup([
      { name: 'two.test', records: [{ type: 'TXT', name: 'two.test', content: '"v=spf1 -all"' }, { type: 'TXT', name: 'two.test', content: '"v=spf1 mx -all"' }] },
      { name: 'macro.test', records: [{ type: 'TXT', name: 'macro.test', content: '"v=spf1 exists:%{i}.x.example -all"' }] },
    ]);
    expect(checkOf((await planFor('two.test')).plan, 'spf')).toMatchObject({ severity: 'blocker' });
    const macro = (await planFor('macro.test')).plan;
    expect(checkOf(macro, 'spf')).toMatchObject({ severity: 'blocker' });
    expect(macro.steps.map((s) => s.kind)).not.toContain('spf.merge');
  });

  it('启用中的专用地址规则需知情确认；未启用、指向本站或其他域名的规则不算', async () => {
    const literal = (to: string) => [{ type: 'literal', field: 'to', value: to }];
    setup([{
      name: 'rules.test',
      rules: [
        { id: 'r1', enabled: true, matchers: literal('boss@rules.test'), actions: [{ type: 'forward', value: ['boss@example.net'] }] },
        { id: 'r2', enabled: false, matchers: literal('old@rules.test'), actions: [{ type: 'drop' }] },
        { id: 'r3', enabled: true, matchers: literal('me@rules.test'), actions: [{ type: 'worker', value: [FAKE_WORKER] }] },
        { id: 'r4', enabled: true, matchers: literal('x@sub.rules.test'), actions: [{ type: 'drop' }] },
      ],
    }]);
    const rules = checkOf((await planFor('rules.test')).plan, 'rules');
    expect(rules).toMatchObject({ ack: 'rules.bypass', severity: 'confirm' });
    expect(rules.current).toBe('boss@rules.test → 转发到 boss@example.net');
  });

  it('cf-bounce 或 Routing 的 DKIM selector 上有外来记录时阻断；其他 selector 不冲突', async () => {
    setup([
      { name: 'bounce.test', records: [{ type: 'CNAME', name: 'cf-bounce.bounce.test', content: 'x.example.net' }] },
      { name: 'dkim.test', records: [{ type: 'TXT', name: 'cf2024-1._domainkey.dkim.test', content: '"v=DKIM1; p=x"' }] },
      { name: 'google-dkim.test', records: [{ type: 'TXT', name: 'google._domainkey.google-dkim.test', content: '"v=DKIM1; p=x"' }] },
    ]);
    expect(checkOf((await planFor('bounce.test')).plan, 'sendingRecords').severity).toBe('blocker');
    expect(checkOf((await planFor('dkim.test')).plan, 'dkim').severity).toBe('blocker');
    const other = checkOf((await planFor('google-dkim.test')).plan, 'dkim');
    expect(other).toMatchObject({ severity: 'none' });
    expect(other.title).toContain('google');
  });

  it('账户未开通 Email Sending 阻断；已有 DMARC 时不再确认', async () => {
    setup([{ name: 'nosend.test', records: [{ type: 'TXT', name: '_dmarc.nosend.test', content: '"v=DMARC1; p=none"' }] }], { sendingEnabled: false });
    const { plan } = await planFor('nosend.test');
    expect(checkOf(plan, 'sending')).toMatchObject({ severity: 'blocker' });
    expect(checkOf(plan, 'sending').title).toContain('未开通');
    expect(checkOf(plan, 'dmarc')).toMatchObject({ state: 'ok', severity: 'none' });
  });

  it('发信子域已存在但 DNS 未就绪：只补写记录，不重复创建子域', async () => {
    setup([{ name: 'halfsend.test', sending: { tag: 'tagx' } }]);
    const { inspection, plan } = await planFor('halfsend.test');
    expect(plan.steps.map((s) => s.kind)).toEqual(['catchAll.put', 'routing.enable', 'sending.repair']);
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result.outcome).toBe('ready');
    expect(cf!.calls.filter((c) => c === `POST /zones/${cf!.zoneByName('halfsend.test')!.id}/email/sending/subdomains`)).toEqual([]);
  });
});

describe('读取失败一律是 unknown 并在写入前拦住', () => {
  const cases: [string, RegExp, string, Parameters<FakeCloudflare['fail']>[0]['mode'], number?][] = [
    ['routing', /\/email\/routing$/, 'routing', 'status', 500],
    ['catch-all', /\/catch_all$/, 'catchAll', 'throw'],
    ['rules', /\/email\/routing\/rules$/, 'rules', 'status', 403],
    ['dmarc', /\/dns_records$/, 'mx', 'status', 500],
    ['sending', /\/email\/sending\/subdomains$/, 'sending', 'status', 503],
  ];
  for (const [label, path, key, mode, status] of cases) {
    it(`${label} 读取失败`, async () => {
      setup([{ name: `fail-${label}.test`, records: [{ ...apexMx('mx.other.example'), name: `fail-${label}.test` }] }]);
      cf!.fail({ method: 'GET', path, mode, status, times: 10 });
      const { plan } = await planFor(`fail-${label}.test`);
      expect(plan.verdict).toBe('blocked');
      expect(checkOf(plan, key)).toMatchObject({ state: 'unknown', severity: 'blocker' });
      expect(gatePlan(plan, acceptAll(plan)).blockers.length).toBeGreaterThan(0);
      expect(cf!.writes()).toEqual([]);
    });
  }

  it('记录分页取不全视为未知，不能当作「没有 MX / SPF」', async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({ type: 'TXT', name: 'huge.test', content: `"token-${i}"` }));
    setup([{ name: 'huge.test', records }]);
    const { plan } = await planFor('huge.test');
    expect(checkOf(plan, 'mx')).toMatchObject({ state: 'unknown', severity: 'blocker' });
    expect(checkOf(plan, 'spf')).toMatchObject({ state: 'unknown', severity: 'blocker' });
  });

  it('凭据失效（401）：token 阻断', async () => {
    setup([{ name: 'auth.test' }]);
    cf!.fail({ method: 'GET', path: /\/email\/routing$/, status: 401, code: 1000, times: 5 });
    const { plan } = await planFor('auth.test');
    expect(checkOf(plan, 'token')).toMatchObject({ severity: 'blocker' });
  });
});

describe('观察值与指纹', () => {
  it('远端不变时指纹稳定；需确认项的远端值变了，原确认失效', async () => {
    setup([{ name: 'fp.test', catchAll: { enabled: true, actions: [{ type: 'worker', value: ['w1'] }] } }]);
    const first = (await planFor('fp.test')).plan;
    const second = (await planFor('fp.test')).plan;
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(gatePlan(second, acceptAll(first)).unconfirmed).toEqual([]);
    cf!.zoneByName('fp.test')!.catchAll = { enabled: true, actions: [{ type: 'worker', value: ['w2'] }], source: 'api' };
    const third = (await planFor('fp.test')).plan;
    expect(third.fingerprint).not.toBe(first.fingerprint);
    expect(gatePlan(third, acceptAll(first)).unconfirmed).toEqual(['catchAll.replace']);
    // ack 一致但观察值不同不算确认
    expect(gatePlan(third, [{ ack: 'catchAll.replace', observed: 'x' }]).unconfirmed).toEqual(['catchAll.replace']);
  });
});

describe('写入幂等：结果不明先读远端', () => {
  it('catch-all 写入已生效但响应丢失：读到目标值记完成，不重复写', async () => {
    setup([{ name: 'lost.test' }]);
    const { inspection, plan, fake } = await planFor('lost.test');
    cf!.fail({ method: 'PUT', path: /catch_all$/, mode: 'apply-then-throw' });
    const h = hooks();
    const result = await applyMailPlan(creds, inspection, plan, h);
    expect(result.outcome).toBe('ready');
    expect(cf!.calls.filter((c) => c === `PUT /zones/${fake.id}/email/routing/rules/catch_all`)).toHaveLength(1);
    expect(h.ledger.filter((e) => e.kind === 'catchAll.put').map((e) => e.status)).toEqual(['started', 'done']);
  });

  it('SPF 写入返回不可解析的 2xx：读到合并结果记完成', async () => {
    setup([{ name: 'unread.test', records: [{ type: 'TXT', name: 'unread.test', content: 'v=spf1 mx -all' }] }]);
    const { inspection, plan } = await planFor('unread.test');
    cf!.fail({ method: 'PATCH', path: /dns_records/, mode: 'unreadable' });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result.done).toContain('spf.merge');
    expect(cf!.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(1);
    expect(cf!.recordsOf(cf!.zoneByName('unread.test')!, 'unread.test', 'TXT')[0]!.content).toBe('v=spf1 include:_spf.mx.cloudflare.net mx -all');
  });

  it('创建发信子域超时且没有生效：按名称查不到才重试 1 次', async () => {
    setup([{ name: 'retry.test' }]);
    const { inspection, plan, fake } = await planFor('retry.test');
    cf!.fail({ method: 'POST', path: /\/email\/sending\/subdomains$/, mode: 'throw' });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result.outcome).toBe('ready');
    expect(cf!.calls.filter((c) => c === `POST /zones/${fake.id}/email/sending/subdomains`)).toHaveLength(2);
  });

  it('删除 MX 已生效但响应丢失：读到 404 记完成', async () => {
    setup([{ name: 'mxlost.test', records: [{ ...apexMx('mx.other.example'), name: 'mxlost.test' }] }]);
    const { inspection, plan } = await planFor('mxlost.test');
    cf!.fail({ method: 'DELETE', path: /dns_records/, mode: 'apply-then-throw' });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result.outcome).toBe('ready');
    expect(result.done).toEqual(expect.arrayContaining(['mx.delete', 'routing.enable']));
  });

  it('结果不明且远端被改成第三种值：停止并要求重新确认，后续步骤不执行', async () => {
    setup([{ name: 'drift.test' }]);
    const { inspection, plan, fake } = await planFor('drift.test');
    cf!.fail({ method: 'PUT', path: /catch_all$/, mode: 'throw' });
    cf!.onCall({ method: 'GET', path: /catch_all$/ }, () => {
      fake.catchAll = { enabled: true, actions: [{ type: 'forward', value: ['x@example.net'] }], source: 'api' };
    });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'needs_confirmation', failedStep: 'catchAll.put' });
    expect(cf!.calls.some((c) => c.startsWith('POST') && c.includes('/email/routing/dns'))).toBe(false);
  });
});

describe('MX 删除与 Routing 的衔接', () => {
  it('删除 MX 后开启 Routing 失败：blocked + mx_removed_routing_pending', async () => {
    setup([{ name: 'gap.test', records: [{ ...apexMx('mx.other.example'), name: 'gap.test' }] }]);
    const { inspection, plan } = await planFor('gap.test');
    cf!.fail({ method: 'POST', path: /\/email\/routing\/dns$/, status: 500, times: 2 });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'blocked', errorCode: 'mx_removed_routing_pending', failedStep: 'routing.enable' });
    expect(result.error).toContain('MX 已删除');
  });

  it('开启 Routing 时又出现第三方 MX（2008）：要求重新确认', async () => {
    setup([{ name: 'race.test' }]);
    const { inspection, plan, fake } = await planFor('race.test');
    cf!.onCall({ method: 'POST', path: /\/email\/routing\/dns$/ }, () => {
      cf!.record(fake, { type: 'MX', name: 'race.test', content: 'mx.sneaky.example', priority: 5 });
    });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'needs_confirmation', errorCode: 'mx_conflict' });
  });

  it('Routing 未开启时 catch-all 写不进去：降级为开启 Routing 后立即重做', async () => {
    setup([{ name: 'order.test' }], { catchAllRequiresRouting: true });
    const { inspection, plan, fake } = await planFor('order.test');
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result.outcome).toBe('ready');
    const writes = cf!.writes().map((w) => w.replace(`/zones/${fake.id}`, ''));
    expect(writes.slice(0, 3)).toEqual(['PUT /email/routing/rules/catch_all', 'POST /email/routing/dns', 'PUT /email/routing/rules/catch_all']);
  });
});

describe('门禁、权限与中断', () => {
  it('beforeWrite 返回 false（租约丢失或已取消）：不再发起任何写入', async () => {
    setup([{ name: 'stop.test' }]);
    const { inspection, plan } = await planFor('stop.test');
    const result = await applyMailPlan(creds, inspection, plan, hooks({ beforeWrite: async () => false }));
    expect(result.outcome).toBe('stopped');
    expect(cf!.writes()).toEqual([]);
  });

  it('第二步之前失去租约：只完成第一步', async () => {
    setup([{ name: 'stop2.test' }]);
    const { inspection, plan } = await planFor('stop2.test');
    let allowed = 1;
    const result = await applyMailPlan(creds, inspection, plan, hooks({ beforeWrite: async () => allowed-- > 0 }));
    expect(result).toMatchObject({ outcome: 'stopped', done: ['catchAll.put'] });
    expect(cf!.writes()).toHaveLength(1);
  });

  it('超过截止时间不开始新的写入', async () => {
    setup([{ name: 'late.test' }]);
    const { inspection, plan } = await planFor('late.test');
    const result = await applyMailPlan(creds, inspection, plan, hooks({ deadline: Date.now() - 1 }));
    expect(result.outcome).toBe('stopped');
    expect(cf!.writes()).toEqual([]);
  });

  it('写入 403：缺少权限，blocked 并写出需要补的权限', async () => {
    setup([{ name: 'perm.test' }]);
    const { inspection, plan } = await planFor('perm.test');
    cf!.fail({ method: 'PUT', path: /catch_all$/, status: 403, code: 10000 });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'blocked', errorCode: 'cf_permission', failedStep: 'catchAll.put' });
    expect(result.error).toContain('Email Routing Rules');
  });

  it('写入 429：transient 并带 retry-after', async () => {
    setup([{ name: 'busy.test' }]);
    const { inspection, plan } = await planFor('busy.test');
    cf!.fail({ method: 'POST', path: /\/email\/sending\/subdomains$/, status: 429, code: 10004, retryAfter: 120 });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'transient', errorCode: 'cf_transient', retryAfter: 120, failedStep: 'sending.create' });
  });

  it('发信 DNS 补写返回 409：外来冲突记录，blocked', async () => {
    setup([{ name: 'conflict.test', sending: { tag: 'tagc' } }]);
    const { inspection, plan } = await planFor('conflict.test');
    cf!.fail({ method: 'POST', path: /\/subdomains\/tagc\/dns$/, status: 409, code: 81057 });
    const result = await applyMailPlan(creds, inspection, plan, hooks());
    expect(result).toMatchObject({ outcome: 'blocked', errorCode: 'sending_dns_conflict' });
  });
});

describe('RDAP 与 DNSSEC', () => {
  it('RDAP 识别注册商；查不到或服务故障都是未知', async () => {
    setup([], { registrars: { 'bought.test': 'Cloudflare, Inc.', 'outside.test': 'Example Registrar LLC' } });
    expect(await lookupRegistrar('bought.test')).toEqual({ name: 'Cloudflare, Inc.', cloudflare: true });
    expect(await lookupRegistrar('outside.test')).toEqual({ name: 'Example Registrar LLC', cloudflare: false });
    expect(await lookupRegistrar('missing.test')).toEqual({ name: null, cloudflare: null });
    vi.unstubAllGlobals();
    cf = fakeCloudflare({ rdapDown: true });
    expect(await lookupRegistrar('bought.test')).toEqual({ name: null, cloudflare: null });
  });

  it('DNSSEC 三态：检测失败不等于未开启', async () => {
    setup([], { ds: ['signed.test'] });
    expect(await dnssecState('signed.test')).toBe('on');
    expect(await dnssecState('plain.test')).toBe('off');
    for (const doh of ['servfail', 'http500', 'throw'] as const) {
      vi.unstubAllGlobals();
      cf = fakeCloudflare({ doh });
      expect(await dnssecState('signed.test')).toBe('unknown');
    }
  });
});
