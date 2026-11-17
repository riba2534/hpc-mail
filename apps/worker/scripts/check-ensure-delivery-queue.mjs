#!/usr/bin/env node
/**
 * ensure-delivery-queue.mjs 自检：用假的 Cloudflare API 覆盖已存在、需创建、并发撞名、缺权限、网络错误与缺环境变量，
 * 并按 CI 的方式执行一次 CLI 入口（缺环境变量时以 ::error:: 非零退出）。随 `pnpm --filter @hpc-mail/worker test` 前置执行。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDeliveryQueue, QUEUE_NAME } from './ensure-delivery-queue.mjs';

const ACCOUNT = 'acct-check';
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
    assert.deepEqual(JSON.parse(init.body), { queue_name: QUEUE_NAME });
    return onCreate ? onCreate(state) : (state.add(QUEUE_NAME), ok({ queue_id: 'id-new', queue_name: QUEUE_NAME }));
  };
  return { fetchImpl, calls };
}
const run = (fetchImpl, overrides = {}) => ensureDeliveryQueue({ token: 'token', accountId: ACCOUNT, fetchImpl, ...overrides });

// 1. 已存在：只查询，不创建
let api = fakeApi({ queues: [QUEUE_NAME, 'other'] });
assert.equal(await run(api.fetchImpl), 'exists');
assert.deepEqual(api.calls, [`GET /client/v4/accounts/${ACCOUNT}/queues`]);

// 2. 不存在：创建
api = fakeApi({ queues: ['other'] });
assert.equal(await run(api.fetchImpl), 'created');
assert.deepEqual(api.calls, [`GET /client/v4/accounts/${ACCOUNT}/queues`, `POST /client/v4/accounts/${ACCOUNT}/queues`]);

// 3. 并发部署撞名：创建报错但再查已存在，视为成功
api = fakeApi({ onCreate: (state) => { state.add(QUEUE_NAME); return fail(409, 11009, 'queue name already taken'); } });
assert.equal(await run(api.fetchImpl), 'exists');
assert.equal(api.calls.length, 3);

// 4. 缺权限：提示需要的权限
api = fakeApi({ onCreate: () => fail(403, 10000, 'Authentication error') });
await assert.rejects(run(api.fetchImpl), /创建 Queue hpc-mail-email-events 失败（10000 Authentication error）：CLOUDFLARE_API_TOKEN 需要 Account → Queues:Edit/);
await assert.rejects(run(async () => fail(403, 10000, 'Authentication error')), /查询 Queue .*Queues:Edit/);

// 5. 其他失败：给出原因，不误报权限
api = fakeApi({ onCreate: () => fail(400, 11000, 'invalid queue name') });
await assert.rejects(run(api.fetchImpl), (error) => /11000 invalid queue name/.test(error.message) && !/Queues:Edit/.test(error.message));

// 6. 网络错误与缺环境变量
await assert.rejects(run(async () => { throw new TypeError('fetch failed'); }), /请求 Cloudflare API 失败：fetch failed/);
await assert.rejects(run(api.fetchImpl, { token: '' }), /缺少 CLOUDFLARE_API_TOKEN/);
await assert.rejects(run(api.fetchImpl, { accountId: '' }), /缺少 CLOUDFLARE_ACCOUNT_ID/);

// 7. CLI 入口：缺环境变量时 ::error:: 并非零退出（不触网）
const script = join(dirname(fileURLToPath(import.meta.url)), 'ensure-delivery-queue.mjs');
const cli = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH } });
assert.equal(cli.status, 1);
assert.match(cli.stdout, /::error::投递回执 Queue 准备失败：缺少 CLOUDFLARE_API_TOKEN/);

console.log('ensure-delivery-queue 自检通过');
