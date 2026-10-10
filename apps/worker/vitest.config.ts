import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
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
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
