# 贡献指南

感谢你对 HPC Mail 的兴趣！Issue 和 Pull Request 都欢迎。

## 开发环境

- Node.js ≥ 22.12、pnpm ≥ 10
- `pnpm install` → `pnpm dev`（worker :8787 + web :3002，vite 已把 `/api` `/v1` 代理到 worker）
- 本地收信模拟：`apps/worker/scripts/dev-send-mail.sh otp-plain hello@<你配置的域名>`

## 重要限制：worker 集成测试只能在 CI 跑

`apps/worker/test/*.test.ts` 依赖 `@cloudflare/vitest-plugin`（workerd，原 vitest-pool-workers），宿主机需要 **glibc ≥ 2.32**（Ubuntu 22.04+）。glibc 过旧的机器上这些测试起不来，请依赖 PR 的 CI 结果兜底；`packages/shared` 与 `apps/web` 的单测不受影响，可本地运行。

## 提交 PR 前

1. `pnpm typecheck && pnpm test`（本机跑不了 worker 集成测试时跑其余部分即可）
2. 改接口先改 `packages/shared` 的 zod 契约，前后端从同一来源取类型
3. 改了 `/v1` 开放 API（端点、字段、认证）→ 同步更新 `apps/web/public/skill.md`
4. 数据库改动走 Drizzle 增量迁移（`pnpm --filter @hpc-mail/worker db:generate`），不修改历史迁移文件
5. 项目没有 ESLint：`tsc` 的 strict + `noUnusedLocals/Parameters` 兼作静态检查

提交信息建议使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```text
feat: 支持按域名过滤收件箱
fix: 修复中转转发的 Reply-To 构造
docs: 补充自部署步骤
```
