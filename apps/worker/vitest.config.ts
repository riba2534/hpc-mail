import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        // 全部绑定本地模拟（AI 模型调用一律 mock fetch），关闭远程绑定避免要求 CF 凭据
        remoteBindings: false,
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: {
          bindings: {
            jwt_secret: 'test-jwt-secret-for-vitest-only-0000000000',
            TEST_MIGRATIONS: migrations,
          },
          // 只给 rate-limit.test.ts 核对真实 binding 的调用约定；业务 binding（rl_*）在测试里用进程内替身
          ratelimits: {
            TEST_RATE_LIMIT_2: { namespace_id: '990002', simple: { limit: 2, period: 60 } },
            TEST_RATE_LIMIT_1: { namespace_id: '990001', simple: { limit: 1, period: 60 } },
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/guard-credentials.ts', './test/apply-migrations.ts'],
    },
  };
});
