/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as WorkerEnv } from '../src/types.js';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_RATE_LIMIT_2: RateLimit;
      TEST_RATE_LIMIT_1: RateLimit;
    }
  }
}

export {};
