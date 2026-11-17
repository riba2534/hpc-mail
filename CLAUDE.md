# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

HPC Mail 是部署在 Cloudflare 上的**多域名多用户邮箱系统**（线上：https://hpc.email）。用 Email Routing + Workers + D1 + KV + R2 组合出完整邮件服务，不依赖传统邮件服务器。核心场景：多域名 catch-all 收件、用户认领邮箱地址后收发、验证码自动提取、开放 REST API 供脚本/AI 调用。

## 常用命令

pnpm workspace monorepo，Node ≥22.12、pnpm 10。

```bash
pnpm install
pnpm dev          # 并行起 worker(:8787, wrangler dev --local) + web(:3002, vite)，vite 只把 /api、/v1 路径代理到 worker
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

没有 ESLint；`tsc` 的 strict + `noUnusedLocals/Parameters` 兼作静态检查。改动前后跑 `typecheck` + `test`。`pnpm-workspace.yaml` 开了 `verifyDepsBeforeRun: error`：依赖与锁文件不一致时 pnpm run/exec 直接报错，先 `pnpm install`。**不要用 `git commit`/`push` 除非用户明确要求**（部署由 push 触发，见下）。

## 架构大图景

三个 workspace，靠共享契约解耦——理解它们的边界是理解全局的关键：

- **`packages/shared`**：前后端**唯一契约来源**。zod schema（请求/响应）+ 类型 + 常量 + 错误码。**worker 用它 `safeParse` 校验输入，web 用它做表单前置校验并导入响应类型**。改接口先改这里，前后端才不漂移。纯源码包、零构建，exports 直指 `src/index.ts`。
- **`apps/worker`**：单个 Cloudflare Worker，`src/index.ts` 导出**三个 handler**——`fetch`（`/api` 内部接口 + `/v1` 开放接口 + 其余路径 fallthrough 到 `env.assets` 托管的前端）、`email`（Email Routing catch-all 收件 → `services/inbound.ts`）、`scheduled`（每 5 分钟处理通知与对象清理，每日维护邮件保留策略）。Hono 4 + Drizzle ORM。
- **`apps/web`**：React 19 + Vite + Tailwind 4 + TanStack Query + react-router 7。构建产物打进 Worker 的 `[assets]` 绑定，**同源部署**（前端请求 `/api` 无跨域）。

### 响应信封约定（前后端都依赖）

成功 = HTTP 2xx + `{ data: ... }`；失败 = HTTP 4xx/5xx + `{ error: { code, message }, requestId }`。web 的 `api/client.ts` 按 `response.ok` 分支、401 自动清 token。列表统一游标分页：`?cursor=&limit=` → `{ items, nextCursor }`。

## 关键设计决策与硬约束

这些是踩过坑或做过权衡的地方，改相关代码前必须知道：

- **邮件可见性靠 `address` 动态关联，`messages` 表不存 `user_id`**。用户「认领」一个地址（`mailboxes` 表一行）即可见该地址**全部历史邮件**（含认领前收到的）。这是需求的核心建模，别退回「收件时固化归属人」的老路。
- **收件域名完全由 `settings.domains.list`（数据库）驱动，没有任何写死 fallback**。`env.domain` 已删除；`services/domain.ts` 的 `getDomains()` 纯读 settings。全新部署初始域名为空（合法状态，管理员在 `/admin/domains` 页手动加）。加域名还需先在 Cloudflare 给该域配 Email Routing catch-all 指向本 Worker。
- **外发只走 Cloudflare `send_email` binding**。`outbound.ts` 单通道；站内互投直接落库。2026-07 线上实测确认：该 binding **已可发送到任意外部地址**（Cloudflare 早期"仅限已验证 destination"的限制已放开，别再按旧限制设计）；前提是 Workers Paid 计划，Free 计划只能发往账户内已验证地址（README 已注明）。（Resend 兜底通道已按需求彻底移除。）
- **D1 单行上限 ~2MB**：正文 >256KB 时 D1 存 64KB 截断预览、完整正文落 R2（`bodyR2Key`）。附件一律 R2（key 前缀 `att/{messageId}/`）。删除邮件时，D1 元数据和 `storage_cleanup_jobs` 在同一事务中变更；R2 删除放进 `waitUntil`（无 ctx 时同步）和 cron，不在请求里逐个等待，失败保留清理台账重试。共享附件或 `external_attachment_links` 的 90 天引用存续期间保留对象。
- **转发/通知按「收件地址所属用户」分流（三层归属）**：域名（默认仅管理员，可 `public` 开放）→ 地址（已认领 / 未认领，**未认领归管理员**）→ 收件后按归属人的**个人偏好**处理。个人偏好存 `users.notify_prefs`（JSON：飞书 / 通用 webhook / 邮箱转发），端点 `/api/me/notify-prefs`。`outbound.ts` 用 `resolveNotifyOwnerIds(address)` 解析 owner，`inbound.ts` 把同源的 `NOTIFY_OWNER_IDS_SQL` 与去重、偏好查询合进 Ack 前的同一个 batch（未认领→全部启用管理员），**按收信当时认领状态结算**。**gmail_forward/feishu/notify_webhook 已从系统设置移除、下放为个人偏好**；管理员未配置时惰性继承旧全局值（`readLegacyGlobalNotify`）。别退回「一份全局配置套所有入站邮件」的老路。
- **管理员看邮件的入口**：个人 `/inbox` 只看自己认领；`/admin/mail` 只看未认领地址（`scope=unclaimed`）；已认领用户的收发件走 `/admin/users/:id/mail`（`scope=user&userId=`）。读接口 admin 缺省不再等于全表；`scope=all` 已删除。
- **收件链路（`inbound.ts`）失败隔离**：原始 .eml、完整正文或附件持久化失败会 throw（触发 SMTP 重试）；稳定 ingestKey 支持 pending/degraded 修复，转为完整状态的单个请求才进入后处理。邮箱转发异步独立执行（按 owner 个人转发目标）：原生 `message.forward()` 优先（仅对已验证 destination 生效、原样转发），失败降级 `relayForward`——以 `no-reply@收件域名` 经 `send_email` 中转重发（保留原始标题/正文/附件，Reply-To 指回原发件人）；AI 提码和通知走 `ctx.waitUntil`；`notification_jobs` 使用收件时 `notify_owner_ids` 快照、去重键、独立 10 秒超时及有限重试，Webhook 默认不自动重试。处理租约结果不明标 unknown，不自动重复外发。快照不参与邮件可见性。停在 pending 超过 15 分钟的入站行由 cron `inbound.repair`（`services/inbound-repair.ts`）用 R2 原文合成一封邮件重走 `handleInbound` 自愈：先核对 ingestKey，对不上、原文缺失或被拒收直接标 degraded，失败 6 次也标 degraded（原因保留「保存失败」，发件方原样重投仍可修复）；degraded 行只补通知不转发。
- **鉴权**：JWT（`sub/sid/uepoch`，旧令牌里的 `epoch` 忽略）+ D1 `sessions` 强一致会话，会话寿命与 JWT 同为 7 天；改密/禁用原子 bump `users.auth_version` 即时踢线。会话与鉴权版本只写 D1，KV 不参与鉴权（过渡期双写与慢路径已删除；`users.auth_version_migrated` 已废弃，0030 迁移全部置 1，建户时仍写 1 供回滚）；会话只认 D1 且必须属于令牌声明的用户，**不能从 KV 惰性迁入**（2026-10-11 换库时，旧库切换窗口签发的令牌曾借此落到新库同 id 的另一个用户上）。换库要么在切换前冻结注册，要么切换后立刻对比补录并核对自增 id 冲突。**RBAC 只有 admin/user 两角色 + `requireAuth`/`requireAdmin` 两中间件**，无 perm 表。
- **延迟主因是 Worker 到 D1 的往返次数**（D1 主库单区域，SQL 本身亚毫秒）。`requireAuth` 把会话、用户、security 设置和两条限流计数合成一个 `db.batch`；`/v1` 鉴权写入同样批量，审计日志走 `waitUntil`。新增中间件或热路径时别再加串行 D1/KV 往返；会话与用户状态不得加 TTL 缓存（改密即时踢线）。settings 只有 15 秒 isolate 内存缓存，未命中直读 D1，不再经过 KV（低流量下 KV 未命中率高，反而多一次 100ms 以上的往返）；`settingsQuery` 可把读取并进调用方的 batch。`/api/config` 等展示走缓存；`/api/domains`（认领弹窗的前端闸门）与域名认领等强一致校验用 `getSettingsFresh`，与其他读取并行或合批，不额外加层。
- **Placement 由 CI 按 GitHub Variable `PLACEMENT_REGION` 注入**（模板不写死，各部署 D1 位置不同）；placement 只作用于 fetch，email/scheduled 不受影响。**不能从 `run_worker_first` 删掉 `/assets/*`**：数组形式下缺失路径会 SPA 回退为 200 HTML（线上实测）；部署时 `scripts/inject-asset-routes.mjs` 为现存文件注入 `!/assets/<文件>` 排除规则走边缘直出，缺失文件仍进 Worker 返回 404（总条目上限 100）。`build:assets` 末尾跑 `inject-asset-routes.mjs --check`：所需条数 ≥85 告警、>95 构建失败；部署注入超限时按体积优先部分注入。产物文件逼近上限时先合并小 chunk，不要改成按构建号目录排除（每次发版全部资源重新下载）或 `not_found_handling="none"`（深链与刷新都绕到 placement 区域）。
- **D1 没有 STAT4，规划器常选错索引**（ANALYZE 无效）。带 `ORDER BY id DESC LIMIT` 的列表，规划器会为省排序沿 `idx_messages_live` 倒扫全站，邮件少的用户要扫到底；默认视图因此按可见地址取数：收件/未读/已发送用 `INDEXED BY idx_messages_visible`（direction、is_read 等值，未指定的列补成全取值 IN，每段按 id 有序，取够即停），全部/翻页/按地址/联系人用 `INDEXED BY idx_messages_address_deleted_id`，读取量约为地址数 × limit。带 domain/星标/搜索/回收站以及未认领、审计他人的视图逐地址扫反而更慢，保持原计划。其他场景用 `INDEXED BY`（通知补录）或一元 `+domain` 压掉错误索引；改索引或查询前跑 EXPLAIN 回归（`test/explain-regression.test.ts`、`test/perf-optimizations.test.ts`）。
- **/api 未读数封顶 1000**（界面只显示到 99+/999+），`/v1/messages/unread-count` 是对外契约，保持精确。
- **用户托管域名（`hosted_domains` 表，与 `settings.domains.list` 互斥）**：用户填域名 → Worker 用站长 Cloudflare 凭据（secrets `cf_api_token`/`cf_account_id`，CI 从可选的 `CF_HOSTED_DOMAINS_TOKEN` 注入）在站长账户建 zone，只操作自己记录的 `zone_id`、**从不接管账户里已有的 zone**；NS 生效后 cron（`hosted_domains.sync`）补齐 Email Routing（pending zone 开不了，返回 2009）、catch-all 与 Email Sending。**未认领地址的来信在收件 batch 内先 `HOSTED_AUTO_CLAIM_SQL` 认领给域名所有者**（站内投递同理），自动认领默认不限数量（`hosted_domains.autoClaimLimit` 为 0），管理员设了正数上限时达到后新地址拒收；暂停/删除中拒收。Cloudflare 对不存在的 zone 返回 403/9109（与无权限难分），判定 zone 已不存在前必须按名称列账户 zone 确认；超时/5xx/429 保留原状态。托管域名地址不计入全站每人上限，认领守卫改为复核域名状态 + 所有者/成员/管理员；成员（`hosted_domain_members`）只获认领权，看不到他人邮件。删除域名会永久删除该域全部邮件并释放地址，添加前要求本站没有该域的历史地址或邮件（防止继承他人历史）。Cloudflare 在账户 >50 个 zone 且 pending 多于 active 时禁止新增，pending 额度靠 `hosted_domains` 设置兜底。
- **托管域名 DNS 解析**：所有者与管理员经 `/api/hosted-domains/:id/dns-records` 直接读写该域名 zone 的 Cloudflare 记录，不落 D1；只看 Worker 是否有 CF 凭据，不受 `hosted_domains.enabled` 开关影响，pending 期间即可添加（改 NS 前先补网站记录）。邮箱占用的记录只读、新记录不能与之冲突，规则在 shared `hosted-dns.ts`，前后端共用：根域 MX 与 SPF、`_dmarc`、`*._domainkey`、`cf-bounce` 子域，根域另禁止 CNAME。**根域 SPF 与 `_dmarc` 在 Cloudflare 上没有 `read_only` 标记**（2026-10 线上实测），不能只看 meta。只做 DNS-only，不开放代理：代理流量挂在站长账户名下，滥用会连累整个账户。全站共用一个 CF Token（1200 次/5 分钟），所以解析接口每人每分钟限 30 次请求，全站另按实际 CF 调用次数计（列表 1、增删改 2）每分钟限 150 次，且只计能走到 Cloudflare 的请求（SQL guard 复核权限与状态，无关用户刷 404 占不了额度）；每域最多 100 条非邮箱记录。
- **邮箱共享**：用户可通过 `/api/mailboxes/shares` 共享自己的邮箱，管理员通过 `/api/admin/mailbox-shares` 管理全站任意已认领邮箱；接收人可为启用中的用户或管理员，不能包含所有者。共享只授权未删除来信，所有者禁用时隐藏，角色变化保留，释放/过户时撤销；不参与通知归属。
- **共享邮件的已读状态属于所有者**：成员的已读/未读操作、全部已读都不生效，未读数与 `unread=1` 筛选也不含共享邮件；前端按已读样式显示共享邮件。
- **验证链接**：入站时由 `services/link-extract.ts` 提取到 `messages.verification_link`（宁缺毋滥，与提码同一开关，不回填历史）；前端比对链接域名与发件域，不一致时提示。
- **AI 只走管理后台配置的 OpenAI 兼容模型**（`settings.ai_model`，如 DeepSeek），不再使用 Workers AI binding。验证码兜底（仅在命中验证码关键词且正则未识别时调用）与邮件翻译共用 `services/ai-provider.ts`；DeepSeek 必须带 `thinking: {type: 'disabled'}`（否则慢且贵）；workerd 的 fetch 不支持 `redirect: 'error'`，用 `manual` 并把 3xx 当失败。apiKey 回显为 `SECRET_MASK`，审计不记录。译文缓存在 `message_translations`，必须随 `purgeStatements` 一起删除（永久删除、保留期清理、释放并清空历史共用这条路径）。
- **`cloudflare:email` 和 `mimetext` 必须在 `outbound.ts` 里动态 `import()`**（静态 import 会让 vitest 的 workerd 加载即崩）；mimetext 用 `mimetext/browser` 入口（避免 nodejs_compat 依赖）。

## 前端约定

- 页面懒加载用 `src/app/route-modules.ts` 的 `preloadable` 登记、router 里 `page()` 注册，**不要用 `React.lazy`**（Suspense 300ms 揭示节流会拖慢热启动）；chunk 失败由 `chunk-reload.ts` 自动刷新一次。
- 入口与登录页不静态引入 `@hpc-mail/shared` 运行时值或重依赖（登录路由 JS 约 109KB br）；新依赖按需动态加载。关键路径只需要常量时从零依赖子路径 `@hpc-mail/shared/constants` 导入（主入口会带上全部 zod）；web 构建后 `scripts/check-bundle.mjs` 断言入口、app-shell、inbox-page 不静态依赖 zod。Radix Tooltip 已移除，提示用原生 `title`。
- `boot-prefetch.ts` 启动时并行预取会话、外壳与路由 chunk、收件箱数据，queryKey 与页面共用 `messageListQueryOptions` 等定义（`boot-prefetch.test.tsx` 校验一致）。写操作后用 `features/inbox/message-cache.ts` 就地更新缓存，别整体 invalidate `messages.root`。列表每 20 秒只轮询 `GET /api/messages/sync`（`{unread, head}`），`head` 与已加载首页的 `head` 不同才重拉；有列表视图轮询时 unread-count 暂停自身轮询（`pauseUnreadCountPolling`）。详情页标已读带 `includeUnread`，直接写入返回的未读数；上一封/下一封只在 j/k 翻阅时预取同方向一封，列表悬停 250ms 才预取且只保留一个在途。批量认领与批量可用性检查各用一个请求（`/api/mailboxes/batch`、`/api/mailboxes/availability/batch`），不要在前端逐个调用单个接口。

## 测试注意事项

- **本机当前可运行 workerd 集成测试**（2026-10-05 验证 Node 26 / glibc 2.43）。低版本 glibc 环境需在 CI（ubuntu-latest）运行。worker 测试用独立 `wrangler.test.toml`（去掉 miniflare 无法模拟的 `send_email` binding）。
- **本地 D1 与线上一样限制单条语句 100 个绑定参数**（`test/d1-param-limit.test.ts` 有哨兵）：满额输入（100 个 id、50 个邀请码等）要有用例走到；drizzle 会把带默认值的列也绑定成参数，多行插入按每行实际参数数分批。
- worker 测试插件是 `@cloudflare/vitest-plugin`（原 vitest-pool-workers）。测试运行时总强开 nodejs_compat，生产靠 wrangler.toml 的 `no_nodejs_compat`/`no_nodejs_compat_v2` 关闭（compatibility_date 2026-08-04 起默认开启），由 `test/compat-config.test.ts` 守护两份 wrangler 配置一致。
- **同一测试文件内的用例共享 D1/KV 存储**，不自动隔离。跨用例造数据要么错开（不同地址/用户名），要么在用例开头显式清空（如 `updateSettings(env, { domains: { list: [] } })`）。这是 db.test.ts 里反复出现的 gotcha。
- **`apps/worker/.dev.vars` 会被测试插件读入测试环境**。本地 e2e 往里写真实 `cf_api_token` 后，「没有凭据」类用例会拿到真实凭据而失败；跑 worker 测试前先移走。

## 部署

单 workflow `.github/workflows/deploy.yml`，**push 到 `main` 自动触发**（改 `apps/**`/`packages/**`/workflow）。流程：参数校验 → 全量 test+typecheck+audit → web 构建（禁 sourcemap）→ 拷进 worker → wrangler dry-run →（仅 workflow_dispatch 勾 `reset_database`）清库 → `d1 migrations apply` → deploy → `wrangler secret put` → 迁移完整性校验 → `seed-admin.mjs`（幂等引导 admin）→ 线上冒烟。

- **`seed-admin.mjs` 不写死域名**（保持「不假定域名」）。清库重建后需**运维层用 API 把现有域名写回 `settings.domains`**，否则站点无可用域名。
- **Cloudflare 资源 ID 不入库**（开源要求）：`wrangler.toml` 用 `__D1_DATABASE_ID__`/`__KV_NAMESPACE_ID__`/`__CUSTOM_DOMAIN__` 占位符，CI 部署前从 GitHub Variables（另有 `CLOUDFLARE_ACCOUNT_ID` 走环境变量）注入真实值；`wrangler.test.toml` 用全零假 ID（miniflare 纯本地模拟）。secrets（jwt_secret 等）经 CI `wrangler secret put` 注入。别把真实 ID 写回任何被追踪文件。
- 部署验证优先用真实 API / 真实浏览器 / 真实邮件（`~/.claude/skills/send-email` 发外部信、agent-browser 驱动 UI），别只靠单测——交付标准是线上成品可用。

## AI Agent 操作指南 `/skill.md`

`apps/web/public/skill.md` 是一份**给外部 AI Agent 的 API 使用说明书**，随前端构建部署到 https://hpc.email/skill.md（Worker assets 直接返回 raw Markdown）。YAML frontmatter 的 `name` 和 `description` 应准确说明目标系统及触发条件；入口说明认证选择和完整能力地图，详细参数和示例放入其链接的主题参考。API Key 用 `/v1`，JWT 用 `/api`；账户设置及管理员功能只使用 JWT，不扩张邮箱 Key 的权限。**改动了会影响 AI 使用的 API（端点、字段、认证）时，同步更新技能、参考文档和对应 OpenAPI**，保证指引与实现一致。

- `/llms.txt`、首页 HTML 链接和 API 响应 `Link` 头提供文档发现入口；`/api/openapi.json` 与 `/v1/openapi.json` 分别描述会话和 API Key 接口，公开返回原始 OpenAPI JSON（不包 `{data}`）。两份描述均以请求站点 origin 为 server，适用于自部署。
- 邮件 `scope` 必须显式校验，query/body 同时指定时必须一致；非法值不能静默退回个人邮箱。未知 API 返回统一 JSON 错误信封；缺失 Markdown 文档不能返回 SPA HTML 冒充技能正文。
- `wrangler.toml` 的 `assets.run_worker_first` 必须包含 `/skill.md`、`/references/*` 和 `/llms.txt`，使编码及缺失文档处理在生产生效；新增文档目录时同步维护，不能只测试 Worker handler。

- 域名更新必须带 `expectedDomainsRevision`，旧快照返回 409；管理配置和认领校验直读 D1，避免 KV 陈旧配置允许已移除域名被认领。
- 管理员邮箱过户用 `/api/admin/mailboxes/:id/transfer`（JWT），带 `userId/expectedOwnerId`；所有权、旧共享撤销、管理审计同一 D1 事务，保留全部地址历史。过户不经过释放，不受普通认领限制；相同目标重试不重复清共享。收信时通知快照不随过户重写。
- 发件结果包含每个目标的 `recipientOutcomes`；补发保留 To/Cc/Bcc 分组，只重试失败目标。Idempotency-Key 在副作用开始前关联发件行；完成回填失败不能变成请求发送失败或重新投递。
- `/api/config` 返回 `X-HPC-Build`；CI 等待该值等于本次提交 SHA 后才执行线上冒烟。
