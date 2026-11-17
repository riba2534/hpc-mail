# 贡献指南

感谢你对 HPC Mail 的兴趣！Issue 和 Pull Request 都欢迎。

## 开发环境

- Node.js ≥ 22.12、pnpm ≥ 10
- `pnpm install` → `pnpm dev`（worker :8787 + web :3002，vite 已把 `/api` `/v1` 代理到 worker）
- 本地收信模拟：`apps/worker/scripts/dev-send-mail.sh otp-plain hello@<你配置的域名>`

## worker 集成测试的环境要求

`apps/worker/test/*.test.ts` 依赖 `@cloudflare/vitest-pool-workers`（workerd），宿主机需要 **glibc ≥ 2.32**（Ubuntu 22.04+），满足时可以本机运行。glibc 过旧的机器上这些测试起不来，请依赖 PR 的 CI 结果兜底；`packages/shared` 与 `apps/web` 的单测不受影响。

`apps/worker/.dev.vars` 会被测试环境读入：里面写了真实凭据（如 `cf_api_token`）时，「没有凭据」类用例会失败，跑 worker 测试前先移走。同一测试文件内的用例共享 D1/KV，造数据时错开用户名与地址。

## 提交 PR 前

1. `pnpm typecheck && pnpm test`（本机跑不了 worker 集成测试时跑其余部分即可）；改了查询要跑 EXPLAIN 回归（`apps/worker/test/explain-regression.test.ts`）
2. 改接口先改 `packages/shared` 的 zod 契约，前后端从同一来源取类型
3. 改了会影响 AI 使用的 API（`/v1` 与 `/api` 的端点、字段、认证）→ 同步更新 `apps/web/public/skill.md`、`apps/web/public/references/` 下对应的参考文档与 OpenAPI 描述
4. 数据库改动走 Drizzle 增量迁移（`pnpm --filter @hpc-mail/worker db:generate`），不修改历史迁移文件；迁移先于代码部署执行，必须与上一版代码兼容（不 DROP/RENAME 列和表、不整表重建）
5. 项目没有 ESLint：`tsc` 的 strict + `noUnusedLocals/Parameters` 兼作静态检查

提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```text
feat: 支持按域名过滤收件箱
fix: 修复中转转发的 Reply-To 构造
docs: 补充自部署步骤
```
