import { env } from 'cloudflare:test';

// @cloudflare/vitest-plugin 会把 apps/worker/.dev.vars 读进测试环境。本地 e2e 往里写过真实 Cloudflare 凭据时，
// 「未配置凭据」的用例会拿到真实凭据而失败，漏掉模拟的请求还可能打到站长账户。用例需要凭据时自行在
// runtime env 上注入假值，这里发现基础环境带凭据就直接拒绝运行。
if (env.cf_api_token || env.cf_account_id) {
  throw new Error('测试环境读到了 cf_api_token / cf_account_id（多半来自 apps/worker/.dev.vars），先移走再运行 worker 测试');
}
