# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

HPC Mail 是部署在 Cloudflare 上的**多域名多用户邮箱系统**（线上：https://hpc.email）。用 Email Routing + Workers + D1 + KV + R2 组合出完整邮件服务，不依赖传统邮件服务器。核心场景：多域名 catch-all 收件、用户认领邮箱地址后收发、验证码自动提取、开放 REST API 供脚本/AI 调用。

## 常用命令

pnpm workspace monorepo，Node ≥22.12、pnpm 10。

```bash
pnpm install
pnpm dev          # 并行起 worker(:8787, wrangler dev) + web(:3002, vite)，vite 把 /api /v1 代理到 worker
pnpm build        # web 构建 → 产物拷进 apps/worker/dist（Worker 以 assets 形式托管前端）
pnpm test         # 全部包 vitest（pnpm -r test）
pnpm typecheck    # 全部包 tsc（pnpm -r typecheck）

# 单包 / 单测
pnpm --filter @hpc-mail/web test
pnpm --filter @hpc-mail/worker typecheck
pnpm --filter @hpc-mail/web exec vitest run src/features/inbox/use-inbox-filters.test.ts
pnpm --filter @hpc-mail/web exec vitest run -t "回复预填"   # 按测试名

# 数据库（Drizzle 增量迁移）
pnpm --filter @hpc-mail/worker db:generate       # 改 db/schema.ts 后生成 migrations/000N_*.sql
pnpm --filter @hpc-mail/worker db:migrate:local  # 应用到本地 D1
```

没有 ESLint；`tsc` 的 strict + `noUnusedLocals/Parameters` 兼作静态检查。改动前后跑 `typecheck` + `test`。**不要用 `git commit`/`push` 除非用户明确要求**（部署由 push 触发，见下）。

## 架构大图景

三个 workspace，靠共享契约解耦——理解它们的边界是理解全局的关键：

- **`packages/shared`**：前后端**唯一契约来源**。zod schema（请求/响应）+ 类型 + 常量 + 错误码。**worker 用它 `safeParse` 校验输入，web 用它做表单前置校验并导入响应类型**。改接口先改这里，前后端才不漂移。纯源码包、零构建，exports 直指 `src/index.ts`。
- **`apps/worker`**：单个 Cloudflare Worker，`src/index.ts` 导出**三个 handler**——`fetch`（`/api` 内部接口 + `/v1` 开放接口 + 其余路径 fallthrough 到 `env.assets` 托管的前端）、`email`（Email Routing catch-all 收件 → `services/inbound.ts`）、`scheduled`（每日清理）。Hono 4 + Drizzle ORM。
- **`apps/web`**：React 19 + Vite + Tailwind 4 + TanStack Query + react-router 7。构建产物打进 Worker 的 `[assets]` 绑定，**同源部署**（前端请求 `/api` 无跨域）。

### 响应信封约定（前后端都依赖）

成功 = HTTP 2xx + `{ data: ... }`；失败 = HTTP 4xx/5xx + `{ error: { code, message }, requestId }`。web 的 `api/client.ts` 按 `response.ok` 分支、401 自动清 token。列表统一游标分页：`?cursor=&limit=` → `{ items, nextCursor }`。

## 关键设计决策与硬约束

这些是踩过坑或做过权衡的地方，改相关代码前必须知道：

- **邮件可见性靠 `address` 动态关联，`messages` 表不存 `user_id`**。用户「认领」一个地址（`mailboxes` 表一行）即可见该地址**全部历史邮件**（含认领前收到的）。这是需求的核心建模，别退回「收件时固化归属人」的老路。
- **收件域名完全由 `settings.domains.list`（数据库）驱动，没有任何写死 fallback**。`env.domain` 已删除；`services/domain.ts` 的 `getDomains()` 纯读 settings。全新部署初始域名为空（合法状态，管理员在 `/admin/domains` 页手动加）。加域名还需先在 Cloudflare 给该域配 Email Routing catch-all 指向本 Worker。
- **外发只走 Cloudflare `send_email` binding**。`outbound.ts` 单通道；站内互投直接落库。2026-07 线上实测确认：该 binding **已可发送到任意外部地址**（Cloudflare 早期"仅限已验证 destination"的限制已放开，别再按旧限制设计）。（Resend 兜底通道已按需求彻底移除。）
- **D1 单行上限 ~2MB**：正文 >256KB 时 D1 存 64KB 截断预览、完整正文落 R2（`bodyR2Key`）。附件一律 R2（key 前缀 `att/{messageId}/`，删邮件 = 删前缀）。
- **转发/通知按「收件地址所属用户」分流（三层归属）**：域名（默认仅管理员，可 `public` 开放）→ 地址（已认领 / 未认领，**未认领归管理员**）→ 收件后按归属人的**个人偏好**处理。个人偏好存 `users.notify_prefs`（JSON：飞书 / 通用 webhook / 邮箱转发），端点 `/api/me/notify-prefs`。`inbound.ts` / `outbound.ts` 用 `resolveNotifyOwnerIds(address)` 解析 owner（未认领→`getActiveAdminIds`），**按收信当时认领状态结算**。**gmail_forward/feishu/notify_webhook 已从系统设置移除、下放为个人偏好**；管理员未配置时惰性继承旧全局值（`readLegacyGlobalNotify`）。别退回「一份全局配置套所有入站邮件」的老路。
- **管理员看邮件的入口**：个人 `/inbox` 只看自己认领；`/admin/mail` 只看未认领地址（`scope=unclaimed`）；已认领用户的收发件走 `/admin/users/:id/mail`（`scope=user&userId=`）。读接口 admin 缺省不再等于全表；`scope=all` 已删除。
- **收件链路（`inbound.ts`）失败隔离**：只有 D1 落库失败才 throw（触发 SMTP 重试）；邮箱转发同步执行（按 owner 个人转发目标）：原生 `message.forward()` 优先（仅对已验证 destination 生效、原样转发），失败降级 `relayForward`——以 `no-reply@收件域名` 经 `send_email` 中转重发（保留原始标题/正文/附件，Reply-To 指回原发件人）；AI 提码 + 按 owner 个人偏好的飞书/webhook 通知走 `ctx.waitUntil` 且逐个 try/catch。
- **鉴权**：JWT（`sub/sid/epoch/uepoch`）+ KV 会话；改密/禁用 bump `uepoch` 即时踢线，清库 bump `instance_epoch` 全员下线。**RBAC 只有 admin/user 两角色 + `requireAuth`/`requireAdmin` 两中间件**，无 perm 表。
- **`cloudflare:email` 和 `mimetext` 必须在 `outbound.ts` 里动态 `import()`**（静态 import 会让 vitest 的 workerd 加载即崩）；mimetext 用 `mimetext/browser` 入口（避免 nodejs_compat 依赖）。

## 测试注意事项

- **本机（glibc 2.31）跑不了 workerd**，`@cloudflare/vitest-pool-workers` 的集成测试（worker 的 `test/*.test.ts`）本地起不来，只能在 CI（ubuntu-latest）跑。本地只能验证纯逻辑单测和 typecheck。写完 worker 集成测试靠 CI 兜。worker 测试用独立 `wrangler.test.toml`（去掉 miniflare 无法模拟的 `send_email` binding）。
- **vitest-pool-workers 同一测试文件内的用例共享 D1/KV 存储**，不自动隔离。跨用例造数据要么错开（不同地址/用户名），要么在用例开头显式清空（如 `updateSettings(env, { domains: { list: [] } })`）。这是 db.test.ts 里反复出现的 gotcha。

## 部署

单 workflow `.github/workflows/deploy.yml`，**push 到 `main` 自动触发**（改 `apps/**`/`packages/**`/workflow）。流程：参数校验 → 全量 test+typecheck+audit → web 构建（禁 sourcemap）→ 拷进 worker → wrangler dry-run →（仅 workflow_dispatch 勾 `reset_database`）清库 → `d1 migrations apply` → deploy → `wrangler secret put` → 迁移完整性校验 → `seed-admin.mjs`（幂等引导 admin）→ 线上冒烟。

- **`seed-admin.mjs` 不写死域名**（保持「不假定域名」）。清库重建后需**运维层用 API 把现有域名写回 `settings.domains`**，否则站点无可用域名。
- **Cloudflare 资源 ID 不入库**（开源要求）：`wrangler.toml` 用 `__D1_DATABASE_ID__`/`__KV_NAMESPACE_ID__`/`__CUSTOM_DOMAIN__` 占位符，CI 部署前从 GitHub Variables（另有 `CLOUDFLARE_ACCOUNT_ID` 走环境变量）注入真实值；`wrangler.test.toml` 用全零假 ID（miniflare 纯本地模拟）。secrets（jwt_secret 等）经 CI `wrangler secret put` 注入。别把真实 ID 写回任何被追踪文件。
- 部署验证优先用真实 API / 真实浏览器 / 真实邮件（`~/.claude/skills/send-email` 发外部信、agent-browser 驱动 UI），别只靠单测——交付标准是线上成品可用。

## AI Agent 操作指南 `/skill.md`

`apps/web/public/skill.md` 是一份**给外部 AI Agent 的 API 使用说明书**，随前端构建部署到 https://hpc.email/skill.md（Worker assets 直接返回 raw Markdown）。它按 skill-creator 标准写（YAML frontmatter 的 `name` + pushy `description` + imperative 指令），教 AI 用用户名密码登录后完成收发、回复、读验证码等操作。**改动了会影响 AI 使用的 API（端点、字段、认证）时，同步更新这个文件**，保证指引与实现一致。
