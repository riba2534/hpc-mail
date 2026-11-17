#!/usr/bin/env node
/**
 * ensure-delivery-queue.mjs 自检：随 `pnpm --filter @hpc-mail/worker test` 前置执行，不触网。
 * - 没设 DELIVERY_EVENTS_QUEUE：--inject 不改 wrangler.toml，Job Summary 写「投递回执未启用」；
 * - 设了：--inject 注入 Worker 变量与 consumer（幂等）；--check 只读预检，缺 Queues 权限时失败并在 Summary 写明；
 *   确保 Queue 存在覆盖已存在、需创建、并发撞名、缺权限、网络错误、缺环境变量；非法队列名报错。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeliveryQueue, configuredQueue, ensureDeliveryQueue, failureSummary, injectDeliveryEvents } from './ensure-delivery-queue.mjs';

const ACCOUNT = 'acct-check';
const QUEUE = 'hpc-mail-email-events';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (result) => json({ success: true, errors: [], result });
const fail = (status, code, message) => json({ success: false, errors: [{ code, message }], result: null }, status);

/** 有状态的假 API：queues 为当前已有的队列名；onCreate 决定 POST 的结果 */
function fakeApi({ queues = [], onCreate } = {}) {
  const calls = [];
  const state = new Set(queues);
  const fetchImpl = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${pathname}`);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer token');
    assert.equal(pathname, `/client/v4/accounts/${ACCOUNT}/queues`);
    if (method === 'GET') {
      const name = searchParams.get('name');
      return ok([...state].filter((item) => item === name).map((item) => ({ queue_id: `id-${item}`, queue_name: item })));
    }
    assert.deepEqual(JSON.parse(init.body), { queue_name: QUEUE });
    return onCreate ? onCreate(state) : (state.add(QUEUE), ok({ queue_id: 'id-new', queue_name: QUEUE }));
  };
  return { fetchImpl, calls };
}
const run = (fetchImpl, overrides = {}) => ensureDeliveryQueue({ token: 'token', accountId: ACCOUNT, name: QUEUE, fetchImpl, ...overrides });

// 1. 已存在：只查询，不创建
let api = fakeApi({ queues: [QUEUE, 'other'] });
assert.equal(await run(api.fetchImpl), 'exists');
assert.deepEqual(api.calls, [`GET /client/v4/accounts/${ACCOUNT}/queues`]);

// 2. 不存在：创建
api = fakeApi({ queues: ['other'] });
assert.equal(await run(api.fetchImpl), 'created');
assert.deepEqual(api.calls, [`GET /client/v4/accounts/${ACCOUNT}/queues`, `POST /client/v4/accounts/${ACCOUNT}/queues`]);

// 3. 并发部署撞名：创建报错但再查已存在，视为成功
api = fakeApi({ onCreate: (state) => { state.add(QUEUE); return fail(409, 11009, 'queue name already taken'); } });
assert.equal(await run(api.fetchImpl), 'exists');
assert.equal(api.calls.length, 3);

// 4. 缺权限：提示需要的权限
api = fakeApi({ onCreate: () => fail(403, 10000, 'Authentication error') });
await assert.rejects(run(api.fetchImpl), /创建 Queue hpc-mail-email-events 失败（10000 Authentication error）：CLOUDFLARE_API_TOKEN 需要 Account → Queues:Edit/);
await assert.rejects(run(async () => fail(403, 10000, 'Authentication error')), /查询 Queue .*Queues:Edit/);

// 5. 其他失败：给出原因，不误报权限
api = fakeApi({ onCreate: () => fail(400, 11000, 'invalid queue name') });
await assert.rejects(run(api.fetchImpl), (error) => /11000 invalid queue name/.test(error.message) && !/Queues:Edit/.test(error.message));

// 6. 网络错误与缺参数
await assert.rejects(run(async () => { throw new TypeError('fetch failed'); }), /请求 Cloudflare API 失败：fetch failed/);
await assert.rejects(run(api.fetchImpl, { token: '' }), /缺少 CLOUDFLARE_API_TOKEN/);
await assert.rejects(run(api.fetchImpl, { accountId: '' }), /缺少 CLOUDFLARE_ACCOUNT_ID/);
await assert.rejects(run(api.fetchImpl, { name: '' }), /缺少队列名/);

// 6b. 只读预检：只列一次 Queue、不创建；缺权限的错误在 Summary 里写明 Queues:Edit，其他错误不误报权限
api = fakeApi({ queues: [QUEUE] });
assert.equal(await checkDeliveryQueue({ token: 'token', accountId: ACCOUNT, name: QUEUE, fetchImpl: api.fetchImpl }), true);
api = fakeApi();
assert.equal(await checkDeliveryQueue({ token: 'token', accountId: ACCOUNT, name: QUEUE, fetchImpl: api.fetchImpl }), false);
assert.deepEqual(api.calls, [`GET /client/v4/accounts/${ACCOUNT}/queues`]);
const denied = await checkDeliveryQueue({ token: 'token', accountId: ACCOUNT, name: QUEUE,
  fetchImpl: async () => fail(403, 10000, 'Authentication error') }).catch((error) => error);
assert.match(failureSummary(denied), /^投递回执未能启用：CLOUDFLARE_API_TOKEN 缺少 Account → Queues:Edit 权限/);
const offline = await checkDeliveryQueue({ token: 'token', accountId: ACCOUNT, name: QUEUE,
  fetchImpl: async () => { throw new TypeError('fetch failed'); } }).catch((error) => error);
assert.equal(failureSummary(offline), '投递回执未能启用：请求 Cloudflare API 失败：fetch failed');

// 7. 队列名：空即未启用，非法名报错
assert.equal(configuredQueue(''), null);
assert.equal(configuredQueue('  '), null);
assert.equal(configuredQueue(undefined), null);
assert.equal(configuredQueue(` ${QUEUE} `), QUEUE);
assert.throws(() => configuredQueue('Bad_Queue'), /不是合法的队列名/);

// 8. 注入：只加 [vars] 的一行与本 Queue 的 consumer，其他配置原样保留；幂等
const toml = [
  'name = "fixture"', '', '[vars]', 'site_origin = "https://example.test"', '',
  '[[queues.consumers]]', 'queue = "other-queue"', 'max_batch_size = 1', '',
  '[assets]', 'directory = "./dist"', '',
].join('\n');
const injected = injectDeliveryEvents(toml, QUEUE);
assert.match(injected, /\[vars\]\ndelivery_events_queue = "hpc-mail-email-events"\nsite_origin/);
assert.match(injected, /\[\[queues\.consumers\]\]\nqueue = "hpc-mail-email-events"\nmax_batch_size = 20\nmax_batch_timeout = 5\nmax_retries = 5\nmax_concurrency = 1\n$/);
assert.equal(injectDeliveryEvents(injected, QUEUE), injected);
assert.ok(injected.includes('queue = "other-queue"') && injected.includes('[assets]') && injected.includes('site_origin'));
assert.throws(() => injectDeliveryEvents('name = "x"\n', QUEUE), /没有 \[vars\] 段/);

// 9. CLI：按 CI 的方式执行（不触网）
const script = join(dirname(fileURLToPath(import.meta.url)), 'ensure-delivery-queue.mjs');
const work = mkdtempSync(join(tmpdir(), 'hpc-delivery-queue-'));
try {
  const config = join(work, 'wrangler.toml');
  const summaryFile = join(work, 'summary.md');
  const cli = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryFile, ...extra } });

  // 9a. 没设 Variable：注入步骤不改配置，Summary 写「投递回执未启用」
  writeFileSync(config, toml);
  writeFileSync(summaryFile, '');
  let res = cli(['--inject', config], { DELIVERY_EVENTS_QUEUE: '' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /::notice::未设置 Variable DELIVERY_EVENTS_QUEUE，投递回执未启用/);
  assert.equal(readFileSync(config, 'utf8'), toml);
  assert.match(readFileSync(summaryFile, 'utf8'), /^投递回执未启用/);

  // 9b. 设了 Variable：注入变量与 consumer
  res = cli(['--inject', config], { DELIVERY_EVENTS_QUEUE: QUEUE });
  assert.equal(res.status, 0);
  assert.equal(readFileSync(config, 'utf8'), injected);

  // 9c. 设了 Variable 但 Token 不可用（这里缺 Token）：预检与确保 Queue 都以 ::error:: 非零退出，Summary 写明原因
  for (const args of [['--check'], []]) {
    writeFileSync(summaryFile, '');
    res = cli(args, { DELIVERY_EVENTS_QUEUE: QUEUE });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::投递回执 Queue 准备失败：缺少 CLOUDFLARE_API_TOKEN/);
    assert.match(readFileSync(summaryFile, 'utf8'), /^投递回执未能启用：缺少 CLOUDFLARE_API_TOKEN/);
  }

  // 9d. 非法队列名报错
  res = cli(['--inject', config], { DELIVERY_EVENTS_QUEUE: 'Bad_Queue' });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /::error::DELIVERY_EVENTS_QUEUE「Bad_Queue」不是合法的队列名/);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('ensure-delivery-queue 自检通过');
