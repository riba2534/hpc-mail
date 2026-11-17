#!/usr/bin/env node
/**
 * 把两份 OpenAPI 导出成 JSON，供仓库根的 Spectral 规则集（.spectral.yaml）检查：
 *   node apps/worker/scripts/export-openapi.mjs <输出目录>
 * 生成 <输出目录>/api.json（/api/openapi.json）与 <输出目录>/v1.json（/v1/openapi.json）。
 *
 * 构建代码直接 import @hpc-mail/shared 的 TS 源码与 worker 的 service 模块，这里借 vitest 自带的 Vite
 * 在 Node 里按测试同样的规则转译加载（不经过 workerd，模块顶层没有 Workers 专属调用）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViteServer } from 'vitest/node';

const outDir = process.argv[2];
if (!outDir) {
  console.error('用法：node apps/worker/scripts/export-openapi.mjs <输出目录>');
  process.exit(2);
}
const origin = 'https://mail.example';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createViteServer({
  root, configFile: false, logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false },
});
try {
  const { buildSessionOpenApiSpec } = await server.ssrLoadModule('/src/routes/api-openapi.ts');
  const { buildOpenApiSpec } = await server.ssrLoadModule('/src/routes/v1/openapi.ts');
  mkdirSync(outDir, { recursive: true });
  for (const [name, spec] of [['api', buildSessionOpenApiSpec(origin)], ['v1', buildOpenApiSpec(origin)]]) {
    const file = path.join(outDir, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
    console.log(`${file}: ${Object.keys(spec.paths).length} paths`);
  }
} finally {
  await server.close();
}
