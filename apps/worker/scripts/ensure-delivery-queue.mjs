#!/usr/bin/env node
/**
 * 确保投递回执 Queue 存在（幂等）：wrangler deploy 对 wrangler.toml 里不存在的 consumer 队列直接失败，
 * CI 在部署前执行。读 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID；已存在直接通过，不存在则创建，
 * 并发创建撞名时重新查询确认。失败以 ::error:: 给出原因并非零退出。
 */
import { pathToFileURL } from 'node:url';

export const QUEUE_NAME = 'hpc-mail-email-events';
const API = 'https://api.cloudflare.com/client/v4';
const PERMISSION_HINT = 'CLOUDFLARE_API_TOKEN 需要 Account → Queues:Edit（或 Workers Scripts:Edit，「Edit Cloudflare Workers」模板已包含）权限';

class QueueSetupError extends Error {}

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
  return new QueueSetupError(`${action}失败（${res.detail}）${auth ? `：${PERMISSION_HINT}` : ''}`);
}

async function findQueue(fetchImpl, token, accountId, name) {
  const res = await request(fetchImpl, token, 'GET', `/accounts/${accountId}/queues?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw failure(`查询 Queue ${name} `, res);
  return (Array.isArray(res.result) ? res.result : []).find((queue) => queue?.queue_name === name) ?? null;
}

/** 返回 'exists' 或 'created'；失败抛出带原因的错误 */
export async function ensureDeliveryQueue({ token, accountId, name = QUEUE_NAME, fetchImpl = fetch }) {
  if (!token) throw new QueueSetupError('缺少 CLOUDFLARE_API_TOKEN');
  if (!accountId) throw new QueueSetupError('缺少 CLOUDFLARE_ACCOUNT_ID');
  if (await findQueue(fetchImpl, token, accountId, name)) return 'exists';
  const created = await request(fetchImpl, token, 'POST', `/accounts/${accountId}/queues`, { queue_name: name });
  if (created.ok) return 'created';
  // 并发部署可能刚好同时创建：再查一次，已存在即视为成功
  if (await findQueue(fetchImpl, token, accountId, name)) return 'exists';
  throw failure(`创建 Queue ${name} `, created);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await ensureDeliveryQueue({ token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID });
    console.log(result === 'created' ? `已创建投递回执 Queue ${QUEUE_NAME}` : `投递回执 Queue ${QUEUE_NAME} 已存在`);
  } catch (error) {
    console.log(`::error::投递回执 Queue 准备失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
