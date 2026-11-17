#!/usr/bin/env node
/**
 * 外发投递回执的部署配置（显式启用：只有设置了 GitHub Variable DELIVERY_EVENTS_QUEUE 才生效，值为队列名）。
 *
 * - `--inject <wrangler.toml>`：「注入 Cloudflare 资源配置」步骤调用，不触网。设置了变量时向 wrangler.toml 注入
 *   `[vars] delivery_events_queue` 与对应的 `[[queues.consumers]]`；没设置时什么也不改，在 Job Summary 写一行「投递回执未启用」。
 * - `--check`：只读预检，在迁移与发布之前调用：按名称列一次 Queue，Token 没有 Queues 权限时失败，
 *   Job Summary 写明缺的是 Queues:Edit。只读接口验证不了写权限，创建失败由下一步兜底。
 * - 默认（确保 Queue 存在）：「部署 Worker」之前调用。已存在直接通过，不存在则创建，并发创建撞名时重新查询确认；
 *   失败时在发布前中止（此时线上仍是旧版本，不需要回滚）。
 * 两者都读 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID；日志只打印队列名与 Cloudflare 的错误码，不打印账户 id。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const PERMISSION_HINT = 'CLOUDFLARE_API_TOKEN 需要 Account → Queues:Edit（或 Workers Scripts:Edit）权限';
/** Cloudflare 队列名：小写字母、数字与连字符 */
const QUEUE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VAR_KEY = 'delivery_events_queue';

class QueueSetupError extends Error {
  constructor(message, permission = false) {
    super(message);
    /** 鉴权错误（Token 无效或缺 Queues 权限） */
    this.permission = permission;
  }
}

/** 读 Variable 的值：空串视为未启用；非法名字抛错 */
export function configuredQueue(value) {
  const name = (value ?? '').trim();
  if (!name) return null;
  if (!QUEUE_NAME_PATTERN.test(name)) throw new QueueSetupError(`DELIVERY_EVENTS_QUEUE「${name}」不是合法的队列名（小写字母、数字与连字符，最长 63 位）`);
  return name;
}

function consumerBlock(name) {
  return [
    '# 外发投递回执（CI 按 DELIVERY_EVENTS_QUEUE 注入）',
    '[[queues.consumers]]',
    `queue = "${name}"`,
    'max_batch_size = 20',
    'max_batch_timeout = 5',
    'max_retries = 5',
    'max_concurrency = 1',
  ].join('\n');
}

/** 注入 Worker 变量与 consumer（幂等：已注入时原样返回） */
export function injectDeliveryEvents(toml, name) {
  if (toml.split('\n').some((line) => line.trim().startsWith(`${VAR_KEY} =`))) return toml;
  const lines = toml.split('\n');
  const vars = lines.findIndex((line) => line.trim() === '[vars]');
  if (vars < 0) throw new QueueSetupError('wrangler.toml 没有 [vars] 段，无法注入 delivery_events_queue');
  lines.splice(vars + 1, 0, `${VAR_KEY} = "${name}"`);
  return `${lines.join('\n').replace(/\n*$/, '')}\n\n${consumerBlock(name)}\n`;
}

async function request(fetchImpl, token, method, path, body) {
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new QueueSetupError(`请求 Cloudflare API 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const detail = errors.map((item) => `${item.code} ${item.message}`).join('; ') || `HTTP ${response.status}`;
  return { ok: response.ok && payload?.success === true, status: response.status, result: payload?.result, detail,
    codes: errors.map((item) => Number(item.code)) };
}

function failure(action, res) {
  // 10000 是 Cloudflare 的鉴权错误码（Token 无效或缺权限）
  const auth = res.status === 401 || res.status === 403 || res.codes.includes(10000);
  return new QueueSetupError(`${action}失败（${res.detail}）${auth ? `：${PERMISSION_HINT}` : ''}`, auth);
}

async function findQueue(fetchImpl, token, accountId, name) {
  const res = await request(fetchImpl, token, 'GET', `/accounts/${accountId}/queues?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw failure(`查询 Queue ${name} `, res);
  return (Array.isArray(res.result) ? res.result : []).find((queue) => queue?.queue_name === name) ?? null;
}

function requireInputs(token, accountId, name) {
  if (!name) throw new QueueSetupError('缺少队列名（DELIVERY_EVENTS_QUEUE）');
  if (!token) throw new QueueSetupError('缺少 CLOUDFLARE_API_TOKEN');
  if (!accountId) throw new QueueSetupError('缺少 CLOUDFLARE_ACCOUNT_ID');
}

/** 只读预检：返回 Queue 是否已存在；Token 缺权限等失败抛出带原因的错误 */
export async function checkDeliveryQueue({ token, accountId, name, fetchImpl = fetch }) {
  requireInputs(token, accountId, name);
  return Boolean(await findQueue(fetchImpl, token, accountId, name));
}

/** 返回 'exists' 或 'created'；失败抛出带原因的错误 */
export async function ensureDeliveryQueue({ token, accountId, name, fetchImpl = fetch }) {
  requireInputs(token, accountId, name);
  if (await findQueue(fetchImpl, token, accountId, name)) return 'exists';
  const created = await request(fetchImpl, token, 'POST', `/accounts/${accountId}/queues`, { queue_name: name });
  if (created.ok) return 'created';
  // 并发部署可能刚好同时创建：再查一次，已存在即视为成功
  if (await findQueue(fetchImpl, token, accountId, name)) return 'exists';
  throw failure(`创建 Queue ${name} `, created);
}

/** 失败时写进 Job Summary 的一行：鉴权错误写明缺 Queues:Edit */
export function failureSummary(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return error instanceof QueueSetupError && error.permission
    ? `投递回执未能启用：CLOUDFLARE_API_TOKEN 缺少 Account → Queues:Edit 权限（${reason}）。补上权限后重新部署，或删除 Variable DELIVERY_EVENTS_QUEUE 关闭投递回执`
    : `投递回执未能启用：${reason}`;
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? process.argv[index + 1] : '';
}

async function main() {
  const name = configuredQueue(process.env.DELIVERY_EVENTS_QUEUE);
  const injectPath = argValue('--inject');
  if (injectPath) {
    if (!name) {
      console.log('::notice::未设置 Variable DELIVERY_EVENTS_QUEUE，投递回执未启用');
      summary('投递回执未启用（未设置 Variable DELIVERY_EVENTS_QUEUE）');
      return;
    }
    writeFileSync(injectPath, injectDeliveryEvents(readFileSync(injectPath, 'utf8'), name));
    console.log(`已注入投递回执 consumer：Queue ${name}`);
    return;
  }
  const inputs = { token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, name };
  try {
    if (process.argv.includes('--check')) {
      const exists = await checkDeliveryQueue(inputs);
      console.log(exists ? `投递回执 Queue ${name} 已存在` : `投递回执 Queue ${name} 尚不存在，发布前创建`);
      return;
    }
    const result = await ensureDeliveryQueue(inputs);
    console.log(result === 'created' ? `已创建投递回执 Queue ${name}` : `投递回执 Queue ${name} 已存在`);
    summary(`投递回执已启用：Queue ${name}`);
  } catch (error) {
    summary(failureSummary(error));
    throw new QueueSetupError(`投递回执 Queue 准备失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
