#!/usr/bin/env node
/**
 * smoke.sh 与 deploy-probe.sh 的本地自检：起一个模拟线上接口的 HTTP 桩，按场景执行脚本并检查退出码与输出。
 * 覆盖：管理员未开/已开两步验证（含用 ADMIN_TOTP_SECRET 登录）、管理员凭据与线上不符、站点强制两步验证、
 * 发布切换期首页引用旧资源的重试、请求挂住时单请求超时、金丝雀显式启用/外发重试/旧版本收件补发/超时/令牌错误、
 * cron 心跳等待与超时。
 * 需要 bash、curl、jq（CI runner 自带）。用法：node scripts/check-deploy-scripts.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE = join(here, 'smoke.sh');
const PROBE = join(here, 'deploy-probe.sh');
const ADMIN = { id: 1, username: 'site-admin', password: 'p"a\\ss word $1 ok' };
const SMOKE_USER = { id: 2, username: 'ci-smoke', password: '0123456789abcdef0123456789abcdef' };
const BUILD = 'b'.repeat(40);
const CANARY_TOKEN = 'c'.repeat(64);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** 独立实现的 RFC 6238（SHA-1、6 位、30 秒），用来核对 smoke.sh 算出的验证码 */
function totp(secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bitsText = [...secret].map((ch) => alphabet.indexOf(ch).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bitsText.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(counter).digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const totpValid = (code) => [-1, 0, 1].some((w) => totp(TOTP_SECRET, Math.floor(Date.now() / 30000) + w) === code);

let S; // 当前场景状态
const reset = (overrides = {}) => {
  S = {
    adminTotp: false, adminLoginError: null, require2fa: false, oldHomepages: 0, padAssetHeaders: 0, userCanAdmin: false,
    heartbeatAfter: 1, heartbeatOk: true, hangs: {},
    sessions: new Map(), hits: [], homepageHits: 0, sends: [], canaryPolls: 0, healthPolls: 0, logins: [],
    ...overrides,
    // statuses：依次作为每次外发的响应状态，用完后返回 200
    canary: { receiveAfter: 1, staleSends: 0, never: false, statuses: [], ...overrides.canary },
  };
};

const OPENAPI = {
  openapi: '3.1.0',
  paths: {
    '/auth/login': { post: { requestBody: {} } },
    '/admin/settings': { put: {} },
    '/mailboxes/availability': { get: { parameters: [{ name: 'strategy', schema: { enum: ['uniform', 'claude'] } }] } },
    '/admin/mailboxes/{id}/transfer': { post: { 'x-required-role': 'admin' } },
    '/admin/users/search': { get: { 'x-required-role': 'admin' } },
    '/mailboxes/shares': { put: { requestBody: {} } },
    '/mailboxes/shares/{mailboxId}/grantees/{userId}': { delete: {} },
    '/mailboxes/share-users': { get: {} },
    '/admin/mailbox-shares': { put: { 'x-required-role': 'admin' } },
  },
  components: {
    schemas: {
      ClaimMailboxRequest: { properties: { strategy: { enum: ['uniform', 'claude'] } }, required: ['localPart'] },
      MailboxAvailability: { properties: { reason: { enum: ['taken', 'claude_suspended'] } } },
      TransferMailboxRequest: { required: ['userId', 'expectedOwnerId'] },
      AdminUser: { properties: { mailboxPolicy: {}, mailboxPolicyRevision: { type: 'integer' } } },
      UpdateUserRequest: { dependentRequired: { mailboxPolicy: ['expectedMailboxPolicyRevision'] } },
      MailboxShareGrant: { properties: { ownerUserId: { type: 'integer' }, ownerUsername: { type: 'string' } } },
      ReplaceMailboxSharesRequest: { properties: { expectedOwnerId: { type: 'integer' } } },
    },
  },
};

const html = (asset) => `<!doctype html><script type="module" src="/assets/${asset}"></script>`;

function handle(req, body) {
  const url = new URL(req.url, 'http://stub');
  const path = url.pathname;
  const json = (status, data, headers = {}) => [status, { 'content-type': 'application/json', ...headers }, JSON.stringify(data)];
  const error = (status, code) => json(status, { error: { code, message: code }, requestId: 'req-1' });
  const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const user = S.sessions.get(auth);
  S.hits.push({ method: req.method, path: url.pathname + url.search, user: user?.username ?? null });

  if (path === '/') {
    S.homepageHits += 1;
    return [200, { 'content-type': 'text/html' }, html(S.homepageHits <= S.oldHomepages ? 'index-OLD00000.js' : 'index-NEW11111.js')];
  }
  if (path === '/assets/index-NEW11111.js') {
    // padAssetHeaders：在长缓存头之后追加大量响应头，让 `curl | tr | grep -q` 在 grep 提前退出后必然触发 SIGPIPE
    const headers = { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable' };
    for (let i = 0; i < S.padAssetHeaders; i += 1) headers[`x-pad-${i}`] = 'p'.repeat(24);
    return [200, headers, ''];
  }
  if (path.startsWith('/assets/') || path === '/references/missing-smoke-document.md') return [404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found'];
  if (path === '/sw.js') return [200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }, ''];
  if (path === '/skill.md') return [200, { 'content-type': 'text/markdown; charset=utf-8' }, '---\nname: hpc-mail\n---\n'];
  if (path === '/llms.txt') return [200, { 'content-type': 'text/plain' }, '- /skill.md\n'];
  if (path.startsWith('/references/')) return [200, { 'content-type': 'text/markdown; charset=utf-8' }, '# ref'];
  if (path === '/api/config') {
    return json(200, { data: { registrationMode: 'closed', domains: [], require2fa: S.require2fa } }, { 'server-timing': 'app;dur=1', 'x-hpc-build': BUILD });
  }
  if (path === '/api/openapi.json' || path === '/v1/openapi.json') return json(200, OPENAPI);
  if (path === '/v1/status') return error(401, 'unauthorized');
  if (path.startsWith('/v1/')) return error(404, 'not_found');
  if (path === '/api/auth/register') return error(403, 'forbidden');

  if (path === '/api/auth/login') {
    const login = JSON.parse(body || '{}');
    S.logins.push(login);
    const { username, password, totp: code } = login;
    if (username === ADMIN.username && S.adminLoginError) return error(...S.adminLoginError);
    const account = [ADMIN, SMOKE_USER].find((a) => a.username === username && a.password === password);
    if (!account) return error(401, 'bad_credentials');
    // 与 worker 一致：未开两步验证时忽略 totp 字段；开了则缺码 totp_required、错码 bad_credentials
    if (account === ADMIN && S.adminTotp && !code) return error(401, 'totp_required');
    if (account === ADMIN && S.adminTotp && !totpValid(code)) return error(401, 'bad_credentials');
    const token = `tok-${account.username}-${S.sessions.size}`;
    S.sessions.set(token, account);
    return json(200, { data: { token } });
  }
  if (path === '/api/auth/logout') {
    S.sessions.delete(auth);
    return json(200, { data: { ok: true } });
  }

  // 内部探针端点
  if (path.startsWith('/api/internal/')) {
    if (req.headers['x-canary-token'] !== CANARY_TOKEN) return error(404, 'not_found');
    if (path === '/api/internal/canary' && req.method === 'POST') {
      S.sends.push(JSON.parse(body || '{}'));
      const status = S.canary.statuses.shift() ?? 200;
      if (status !== 200) return error(status, 'send_failed');
      const nonce = String(S.sends.length).padStart(32, '0');
      return json(200, { data: { nonce, from: 'canary@a.test', to: 'canary@b.test', build: BUILD, sentAt: 'now' } });
    }
    const canary = path.match(/^\/api\/internal\/canary\/([0-9a-f]{32})$/);
    if (canary) {
      S.canaryPolls += 1;
      const send = Number(canary[1]);
      if (S.canary.never || S.canaryPolls < S.canary.receiveAfter) return json(200, { data: { received: false } });
      return json(200, { data: { received: true, receivedAt: 'now', build: send <= S.canary.staleSends ? 'a'.repeat(40) : BUILD } });
    }
    if (path === '/api/internal/health') {
      S.healthPolls += 1;
      const fresh = S.heartbeatAfter > 0 && S.healthPolls >= S.heartbeatAfter;
      const cron = { at: 'now', build: fresh ? BUILD : 'a'.repeat(40), cron: '*/5 * * * *', ok: !fresh || S.heartbeatOk, failedSteps: fresh && !S.heartbeatOk ? ['hosted_domains.sync'] : [] };
      return json(200, { data: { build: BUILD, cron } });
    }
  }

  if (!user) return error(401, 'unauthorized');
  const isAdmin = user === ADMIN;
  if (path === '/api/auth/me') {
    return json(200, { data: { id: user.id, username: user.username, role: isAdmin ? 'admin' : 'user', twoFactorEnabled: isAdmin && S.adminTotp } });
  }
  if (S.require2fa && !(isAdmin && S.adminTotp)) return error(403, 'totp_setup_required');
  if (path.startsWith('/api/admin/') && !isAdmin && !S.userCanAdmin) return error(403, 'forbidden');
  if (path === '/api/messages') return json(200, { data: { items: isAdmin ? [{ id: 7 }] : [], nextCursor: null } });
  if (path === '/api/messages/7') return json(200, { data: { bodyText: '', attachments: [], replyTo: [] } });
  if (path === '/api/messages/7/thread') return json(200, { data: { items: [] } });
  if (path === '/api/domains') return json(200, { data: isAdmin ? ['a.test'] : [] });
  if (['/api/mailboxes', '/api/mailboxes/shared', '/api/mailboxes/shares', '/api/admin/mailbox-shares'].includes(path)) return json(200, { data: [] });
  if (path === '/api/me/notify-prefs/health') return json(200, { data: { channels: [], forward: { targets: [] } } });
  if (path === '/api/admin/settings') return json(200, { data: { register_mode: 'closed' } });
  if (path === '/api/admin/settings/domain-claude-stats') return json(200, { data: [{ domain: 'a.test', suspended: 0, risk: null }] });
  if (path === '/api/mailboxes/random-plan') return json(200, { data: { strategy: 'claude', items: [], pool: ['a.test'], shortfall: 10 } });
  if (path === '/api/mailboxes/availability') return json(200, { data: { available: true } });
  if (path === '/api/admin/users/search' || path === '/api/mailboxes/share-users') {
    return json(200, { data: { items: [{ id: ADMIN.id, username: ADMIN.username, role: 'admin' }], hasMore: false } });
  }
  if (path === '/api/admin/mailboxes/0/transfer') return error(400, 'validation_failed');
  if (path === '/api/admin/users') return json(200, { data: [{ id: 1, mailboxPolicy: null, mailboxPolicyRevision: 0 }] });
  return error(404, 'not_found');
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    // hangs：路径 → 剩余次数，命中时不响应，模拟线上挂住的连接
    const path = new URL(req.url, 'http://stub').pathname;
    if (S.hangs[path] > 0) {
      S.hangs[path] -= 1;
      S.hits.push({ method: req.method, path, user: null, hung: true });
      return;
    }
    const [status, headers, payload] = handle(req, body);
    res.writeHead(status, headers).end(payload);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE_URL = `http://127.0.0.1:${server.address().port}`;

// 脚本超过 limitMs 没结束就强杀并记为 timeout：挂住本身就是要抓的缺陷
function run(script, args, env, limitMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BASE_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, limitMs);
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status: timedOut ? 'timeout' : status, output }); });
  });
}

const smoke = (env = {}, limitMs) => run(SMOKE, [], {
  ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password, SMOKE_PASSWORD: SMOKE_USER.password,
  SMOKE_ASSET_RETRY_INTERVAL: '0', ...env,
}, limitMs);
const probe = (mode, env = {}, limitMs) => run(PROBE, [mode], {
  CANARY_TOKEN, BUILD_SHA: BUILD, PROBE_POLL_INTERVAL: '0', ...env,
}, limitMs);
// 金丝雀须显式启用；默认用 DEPLOY_CANARY=on（由服务端选域名）
const canary = (env = {}, limitMs) => probe('canary', { DEPLOY_CANARY: 'on', ...env }, limitMs);
const adminHits = () => S.hits.filter((h) => h.user === ADMIN.username && h.path !== '/api/auth/me' && h.path !== '/api/auth/logout');

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('smoke：管理员未开两步验证时执行全部检查', async () => {
  reset();
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /冒烟账号 ci-smoke 真实登录/);
  assert.match(r.output, /普通用户无法访问管理接口/);
  assert.match(r.output, /管理员登出后旧 token 失效/);
  assert.match(r.output, /冒烟全部通过（27 项）/);
  assert.doesNotMatch(r.output, /::(error|warning)::/, '成功路径不应有错误或告警');
  assert.ok(adminHits().some((h) => h.path === '/api/admin/settings'), '管理员检查应已执行');
  assert.equal(S.sessions.size, 0, '两个会话都应已登出');
});

test('smoke：管理员 totp_required 且未配种子时跳过管理员检查，普通用户检查照常', async () => {
  reset({ adminTotp: true });
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::notice::管理员已开启两步验证且未配置 ADMIN_TOTP_SECRET/);
  assert.match(r.output, /普通用户邮件、域名、邮箱与通知接口可读/);
  assert.doesNotMatch(r.output, /当前用户为 admin/);
  assert.deepEqual(adminHits(), []);
  assert.ok(S.hits.some((h) => h.user === 'ci-smoke' && h.path === '/api/admin/settings'), '应校验普通用户越权被拒');
});

test('smoke：配置 ADMIN_TOTP_SECRET 时算出验证码完成管理员登录，种子与验证码不进日志', async () => {
  reset({ adminTotp: true });
  // 小写、带空格的种子也要能用（Authenticator 常见的展示格式）
  let r = await smoke({ ADMIN_TOTP_SECRET: TOTP_SECRET.toLowerCase().replace(/(.{4})/g, '$1 ') });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /冒烟全部通过（27 项）/);
  assert.ok(adminHits().some((h) => h.path === '/api/admin/settings'), '管理员检查应已执行');
  assert.ok(!r.output.toUpperCase().includes(TOTP_SECRET), '种子不能出现在输出里');
  const adminLogin = S.logins.find((l) => l.username === ADMIN.username);
  assert.ok(totpValid(adminLogin.totp), '应提交当前有效的验证码');
  assert.ok(!r.output.includes(adminLogin.totp), '验证码不能出现在输出里');
  // 管理员没开两步验证时多带的 totp 被忽略，照常登录
  reset();
  r = await smoke({ ADMIN_TOTP_SECRET: TOTP_SECRET });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /冒烟全部通过（27 项）/);
});

test('smoke：管理员密码或种子与线上不符时告警并跳过管理员检查，不判失败', async () => {
  reset();
  let r = await smoke({ ADMIN_PASSWORD: 'wrong-password-xx' });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::管理员登录被拒（bad_credentials）：ADMIN_PASSWORD 与线上不符/);
  assert.match(r.output, /冒烟账号登出后旧 token 失效/);
  assert.deepEqual(adminHits(), []);
  reset({ adminTotp: true });
  r = await smoke({ ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::管理员登录被拒（bad_credentials）：ADMIN_PASSWORD 或 ADMIN_TOTP_SECRET 与线上不符/);
  assert.deepEqual(adminHits(), []);
});

test('smoke：管理员登录的其他错误、冒烟账号登录失败、普通用户越权都判失败', async () => {
  reset({ adminLoginError: [403, 'user_disabled'] });
  let r = await smoke();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /管理员登录未返回 token: HTTP 403/);
  reset();
  r = await smoke({ SMOKE_PASSWORD: 'wrong' });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /冒烟账号登录失败/);
  reset({ userCanAdmin: true });
  r = await smoke();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /普通用户访问 \/api\/admin\/settings 未返回 403/);
});

test('smoke：站点强制两步验证时校验拦截并跳过数据接口', async () => {
  reset({ require2fa: true, adminTotp: true });
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /强制两步验证拦截未绑定账号/);
  assert.match(r.output, /::notice::站点开启了强制两步验证，ci-smoke 未绑定/);
});

test('smoke：强制两步验证但管理员未绑定时只告警', async () => {
  reset({ require2fa: true });
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::站点开启了强制两步验证但管理员尚未绑定/);
});

test('smoke：首页引用旧资源 404 时带缓存击穿重试', async () => {
  reset({ oldHomepages: 3 });
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
  assert.equal((r.output.match(/带缓存击穿重取首页/g) ?? []).length, 2, r.output);
  assert.ok(S.hits.some((h) => h.path.startsWith('/?smoke-cache-bust=')), '重试应带缓存击穿参数');
});

test('smoke：响应头很多时检查长缓存不受 pipefail 与 grep -q 提前退出的竞态影响', async () => {
  // 旧写法 `curl | tr | grep -qi` 在 grep 匹配后提前退出，tr 写剩余输出时收到 SIGPIPE，pipefail 下整条判失败
  reset({ padAssetHeaders: 2500 });
  const r = await smoke();
  assert.equal(r.status, 0, r.output);
});

test('smoke：旧资源持续 404 时重试 5 次后失败', async () => {
  reset({ oldHomepages: Infinity });
  const r = await smoke();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /现存静态资源响应异常: \/assets\/index-OLD00000\.js 404/);
  assert.equal(S.homepageHits, 1 + 1 + 5);
});

test('smoke：请求挂住时按单请求超时失败，不拖住整个步骤', async () => {
  for (const path of ['/sw.js', '/api/auth/login', '/api/admin/settings']) {
    reset({ hangs: { [path]: Infinity } });
    const r = await smoke({ SMOKE_CURL_TIMEOUT: '1' }, 8000);
    assert.notEqual(r.status, 'timeout', `${path} 挂住时冒烟没有按时结束\n${r.output}`);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /::error::冒烟失败/, r.output);
  }
});

test('probe canary：未显式启用时跳过并 notice，不外发', async () => {
  reset();
  for (const env of [{}, { CANARY_FROM_DOMAIN: 'a.test' }, { CANARY_TO_DOMAIN: 'b.test' }, { DEPLOY_CANARY: 'off', CANARY_FROM_DOMAIN: 'a.test', CANARY_TO_DOMAIN: 'b.test' }]) {
    const r = await probe('canary', env);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /::notice::收件金丝雀未启用：设置 Variable CANARY_FROM_DOMAIN 与 CANARY_TO_DOMAIN（或 DEPLOY_CANARY=on）后启用/);
  }
  assert.equal(S.sends.length, 0);
});

test('probe canary：设置收发域名或 DEPLOY_CANARY=on 时启用，新版本收件即通过', async () => {
  reset({ canary: { receiveAfter: 3 } });
  let r = await probe('canary', { CANARY_FROM_DOMAIN: 'a.test', CANARY_TO_DOMAIN: 'b.test' });
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /金丝雀已由新版本收件/);
  assert.deepEqual(S.sends, [{ fromDomain: 'a.test', toDomain: 'b.test' }]);
  reset();
  r = await canary();
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(S.sends, [{}]);
});

test('probe canary：外发遇 5xx 或网络错误重试一次，4xx 与重试用尽判失败', async () => {
  reset({ canary: { statuses: [502] } });
  let r = await canary();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::金丝雀外发返回 HTTP 502，0s 后重试一次/);
  assert.equal(S.sends.length, 2);
  reset({ canary: { statuses: [502, 503] } });
  r = await canary();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /金丝雀外发失败: HTTP 503/);
  assert.equal(S.sends.length, 2);
  reset({ canary: { statuses: [400] } });
  r = await canary();
  assert.equal(r.status, 1, r.output);
  assert.equal(S.sends.length, 1, '4xx 不重试');
  reset({ hangs: { '/api/internal/canary': 1 } });
  r = await canary({ PROBE_CURL_TIMEOUT: '1' }, 8000);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /金丝雀外发返回 HTTP 000/);
  assert.equal(S.sends.length, 1);
});

test('probe canary：旧版本收件时补发一次，仍是旧版本或额度已被重试用掉则失败', async () => {
  reset({ canary: { staleSends: 1 } });
  let r = await canary();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::金丝雀由旧版本 build a+ 收件/);
  assert.equal(S.sends.length, 2);
  reset({ canary: { staleSends: 2 } });
  r = await canary();
  assert.equal(r.status, 1, r.output);
  assert.equal(S.sends.length, 2);
  // 第一次外发 502 重试后成功，全站每分钟 2 次额度已用完，旧版本收件不再补发
  reset({ canary: { statuses: [502], staleSends: 2 } });
  r = await canary();
  assert.equal(r.status, 1, r.output);
  assert.equal(S.sends.length, 2);
});

test('probe canary：收件超时、令牌错误判失败', async () => {
  reset({ canary: { never: true } });
  let r = await canary({ CANARY_TIMEOUT: '1', PROBE_POLL_INTERVAL: '0.2' });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /1s 内未收到金丝雀/);
  reset();
  r = await canary({ CANARY_TOKEN: 'd'.repeat(64) });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /令牌与线上 jwt_secret 不符/);
});

test('probe heartbeat：等到新版本心跳；有失败步骤只告警；超时与挂住都按时失败', async () => {
  reset({ heartbeatAfter: 3 });
  let r = await probe('heartbeat');
  assert.equal(r.status, 0, r.output);
  assert.equal(S.healthPolls, 3);
  reset({ heartbeatOk: false });
  r = await probe('heartbeat');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /::warning::新版本 cron 有失败步骤：hosted_domains\.sync/);
  reset({ heartbeatAfter: 0 });
  r = await probe('heartbeat', { HEARTBEAT_TIMEOUT: '1', PROBE_POLL_INTERVAL: '0.2' });
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /1s 内没有等到新版本的 cron 心跳/);
  reset({ hangs: { '/api/internal/health': Infinity } });
  r = await probe('heartbeat', { HEARTBEAT_TIMEOUT: '2', PROBE_CURL_TIMEOUT: '1' }, 8000);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /2s 内没有等到新版本的 cron 心跳/);
});

try {
  for (const [name, fn] of cases) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`部署脚本自检通过（${cases.length} 组用例）`);
} finally {
  server.closeAllConnections();
  server.close();
}
