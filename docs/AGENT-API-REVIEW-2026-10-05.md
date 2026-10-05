# Agent 操作能力审查（2026-10-05）

审查基线为 `e234377`。从线上读取的 `/skill.md` 与该提交完全一致；使用明确 User-Agent 可访问线上技能、公开配置及 `/v1/openapi.json`。同时对照网页 API 调用、Worker 路由、共享请求 schema 和权限实现。

## 结论与修复

网页的服务端业务已经有 HTTP 接口，但原指南没有覆盖全部功能，长期自动化使用的 API Key 接口也有缺口。不能把“网页功能有 `/api`”解释为“同一个 API Key 可以做全部操作”：账户安全、个人通知和管理员配置需要 JWT 及对应账户权限。

| 原问题 | 影响 | 修复 |
| --- | --- | --- |
| 技能描述过度触发，入口只要求用户名密码 | 普通邮箱请求可能误选本系统；已有 Key 的 Agent 被误导去登录 | 描述明确系统与授权边界，入口先选择 Key 或 JWT |
| 宣称 `mailbox.write` 可释放邮箱，实际 `/v1` 没有 DELETE | Agent 按说明请求得到 404 | 补全地址可用性、显示名及释放接口 |
| `/v1` 缺星标、恢复、永久删除、全读、线程、原文、联系人、未读计数及上传 | 长期任务被迫切换到密码会话 | 按现有 mail/mailbox scopes 补齐常用操作，复用上传实现与所属账号校验 |
| JWT 批量操作接受 body.scope 却忽略它，部分详情默默忽略非法 scope | 指定范围与实际变更范围不一致 | 统一 query/body 校验；冲突或非法范围返回 400，普通用户的管理员范围返回 403 |
| 清历史的 `deleteHistory=true` 在 JWT 接口被默默当 false | 释放后可能由下一个认领者继承原本要求删除的历史 | 两种认证共用布尔解析，支持 1/true/0/false；非法拼写拒绝且不释放 |
| 错误 base64 长度通过 schema 后抛 500 | Agent 把输入错误误判为服务器故障，继续重试 | 参数预检和解码防守均返回 validation_failed 400 |
| 回复例子漏幂等头，2FA 写成只能网页操作；验证码例子不能覆盖突发与异步提码 | 重复投递、无法完成安全配置、错过目标验证码 | 补完整认证和安全流程，保存原请求与幂等键，分页/长轮询按匹配与截止时间处理 |
| 通知、共享管理、域名 CAS、Key 审计、账户与管理员能力未完整描述 | Agent 无法发现已有 API | 精简入口加六份按任务读取的主题参考，给出参数、权限及结果 |
| OpenAPI 缺请求及响应契约，JWT 无完整机器规格 | API 客户端无法可靠构造请求和解析结果 | 完整 `/v1/openapi.json`，新增 `/api/openapi.json`，请求从共享 schema 导出并补跨字段约束 |
| 未知 API 返回纯文本 404；缺失 `.md` 可被 SPA HTML 当正文返回 | Agent JSON 解析失败或把错误页当技能 | 统一 JSON 错误信封，缺失 Markdown 明确 404 |
| 技能缺发现入口 | 从首页或 API 进入时难以找到说明 | 新增 `/llms.txt`、HTML 描述链接及 API 响应 Link 头 |
| 生产静态资产优先路由未覆盖参考文档 | 中文文档缺少 UTF-8 声明；缺失参考文档返回 200 HTML，即使 Worker 单测通过 | 补齐 worker-first 路由、发现入口编码，以及部署冒烟中的六份参考文档和缺失文档验证 |

## 功能与认证覆盖

| 功能 | API Key | JWT / 管理员 JWT |
| --- | --- | --- |
| 邮件列表、搜索、验证码、线程、原始档、附件、联系人、未读计数 | `/v1/messages…`，mail.read | `/api/messages…` |
| 长轮询等待新信 | `/v1/messages/wait`，mail.read | JWT 使用增量列表轮询 |
| 发送、回复、转发、失败目标补发 | `POST /v1/messages`，mail.send | `POST /api/messages/send` |
| 已读、全读、个人星标、删除、恢复、永久删除 | `/v1/messages…`，mail.write | `/api/messages…` |
| 独立上传、分片上传、取消草稿附件、Token 发件 | `/v1/uploads…`，mail.send | `/api/uploads…` |
| 自有及共享邮箱、可用性查询 | `/v1/mailboxes…`，mailbox.read | `/api/mailboxes…` |
| 认领、显示名、释放及可选清除历史 | `/v1/mailboxes…`，mailbox.write | `/api/mailboxes…` |
| 个人通知、邮箱转发、状态与人工重试 | 使用 JWT | `/api/me/notify-prefs…` |
| 登录、注册、登出、改密、头像、2FA | 使用 JWT 流程 | `/api/auth…` |
| Key 创建、更新、禁用、吊销、自有审计 | 使用 JWT | `/api/api-keys…` |
| 多域名及策略、接入检查、邮箱共享名单 | 使用管理员 JWT | `/api/admin/settings…`、`/api/admin/mailbox-shares…` |
| 用户、邀请码、全站 Key 和管理审计 | 使用管理员 JWT | `/api/admin/users…`、`/invites…`、`/api-keys…`、`/audit-logs…` |
| 审阅未认领地址或指定用户邮件 | 管理员 Key + mail.read + 显式 scope | 管理员 JWT + 显式 scope；他人邮件只读 |

共享授予未删除入站邮件可见性，可维护共同已读状态和个人星标；不授予发件、删信、改邮箱、释放邮箱或通知归属。Key 不新增账户/管理 scopes，也不能把 JWT 和 Key 互换使用。

## 明确的边界

- 默认发件身份、草稿正文、待确认发送上下文、图片信任及布局是浏览器本地状态，没有服务器 CRUD。Agent 应在自己的受保护状态中保存这些上下文；附件 Token 是服务端资源。
- 添加系统域名只更新本站配置。DNS、Cloudflare Email Routing catch-all 和 WAF 由 Cloudflare 管理 API/控制台处理，不属于本站业务 API。
- 默认 Python User-Agent 的 API 请求仍会被现有 Cloudflare Browser Integrity Check 拒绝。指南明确设置 User-Agent 和非 JSON 边缘响应处理；此前修正规则因 Token 缺 WAF 编辑权限返回 403，本站代码不能绕过该拦截。
- 发送响应的 `sent` 只表示外部发送被提供方接受。外部收件箱实际送达与第三方推送不能由 HTTP 2xx 或模拟证明。

验证采用本地 workerd 的真实 HTTP 请求、正式回归测试、机器规格 lint、示例离线执行及部署后线上冒烟。测试不向真实外部邮箱或第三方推送端点发送消息。

## 验证结果

- API Key 规格：26 个路径、29 个 HTTP 操作；JWT 规格：56 个路径、69 个 HTTP 操作。共 98 个操作与 Hono 实际挂载路由双向匹配，且两份规格的 operationId 全部唯一。
- 正式测试：shared 25、web 103、worker 218，共 346 项通过；类型检查通过。新增 workerd HTTP 集成覆盖 Key 创建、认领/释放、附件上传与下载、站内回复、幂等重放、线程/原文、邮件维护、共享与 scope 边界、取消长轮询、布尔参数及非法 base64。
- 两份 OpenAPI 的 Redocly recommended lint 均无错误和警告；技能 frontmatter、30 个本地参考链接、shell/Python/JSON 示例语法通过。
- 本地 Wrangler 启用实际静态资源绑定及 worker-first 配置，11 个 HTTP 检查通过：技能、发现入口、全部六份参考文档内容及 UTF-8，缺失参考文档 404，两个 API 根路径 JSON 404；这些文档检查也纳入部署冒烟。
- 独立 Agent 执行 20 项本地 HTTP fixture 检验，另复测登录失败停止、迟到验证码截止、错误码/requestId 保留和上传失败取消。附件回复在模拟提交后断开响应、刷新进程及同用户 JWT 续期时只投递一次。
- 示例本地 fixture 与隔离 workerd 不证明外部真实邮件/通知送达。生产版本、文档和只读 API 的验证以本次 main 提交的自动部署与冒烟记录为准。
