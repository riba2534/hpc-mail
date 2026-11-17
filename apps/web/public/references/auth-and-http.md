# 鉴权、请求与 API Keys

## 目录

- [请求约定](#请求约定)：响应信封、分页、请求头、CORS
- [登录与 bootstrap](#登录与-bootstrap)：JWT 登录、两步验证、账户接口
- [Key-only 与长期自动化](#key-only-与长期自动化)：scopes、限定邮箱或域名、admin scope、`/v1/me` 自查、创建与管理 API Key
- [错误与限流](#错误与限流)：登录与账户相关错误码、各级限流；其余错误码的改正方法见[错误码说明](errors.md)

## 请求约定

本文件的 shell 示例复用 [入口指南](../skill.md) 中的 `BASE`、`UA`、`hpc()`；设定 `API` 和 `AUTH` 为所需鉴权。JSON 成功响应为 `{ "data": ... }`。分页为 `{ "data": { "items": [...], "nextCursor": "..." | null } }`；邮箱、Key、用户、邀请码等列表直接是 `data` 数组。默认页大小 30、最大 100；不要自己解析/生成不透明 `cursor`，始终把服务器返回值 URL 编码后带到下一页并保留原过滤条件；无法解码的 `cursor` 返回 400 `validation_failed`。邮件列表按 ID 倒序。

失败响应为 `{ "error": { "code", "message", "fix"?, "docs"?, "details"? }, "requestId" }`：程序按稳定的 `code` 分支，先照 `fix` 修正；各字段含义与每个错误码的改正方法见[错误码说明](errors.md)。

每个响应都带 `X-Request-ID` 头，与错误体的 `requestId` 相同，报告问题时附上。请求可自带 `X-Request-ID` 便于关联日志，但只接受 1–64 位字母、数字和 `. _ : -`（`^[A-Za-z0-9._:-]{1,64}$`），不符合时服务端改用自己生成的 UUID，以响应头为准。下载附件、原始 `.eml` 与头像返回二进制，不包 `{data}`；OpenAPI JSON 也不包信封。

写 JSON 带 `Content-Type: application/json`。查询参数用 HTTP 库或 `curl --get --data-urlencode` 编码；正文用 JSON 序列化器，勿拼接用户文本。所有示例使用稳定 `User-Agent: HPC-Mail-Agent/1.0`。若返回 HTML/Cloudflare Challenge，先核对状态与 Content-Type 并报告边缘拦截；它不是业务 JSON，也不能据此反复重试凭证。

`/v1` 支持跨源浏览器 CORS 与 Authorization/Content-Type/Idempotency-Key；`/api` JWT 不开放跨源 CORS，请用同源网页或服务端 HTTP 客户端（curl/Python 不受浏览器 CORS 限制）。浏览器跨源 fetch 被拒绝不能推断业务 API 没有该功能。

## 登录与 bootstrap

公开 `GET /api/config` 返回 `siteTitle`、`registrationMode`（`closed|invite|open`）、`domains`（仅公开域）、`require2fa`、`translationEnabled`（AI 翻译已启用且 AI 模型已配置）。登录不要求 Key：

```bash
# 需用户提供 HPC_USERNAME、HPC_PASSWORD；启用 2FA 时还需 HPC_TOTP
AUTH=$(
  jq -n '{username:env.HPC_USERNAME,password:env.HPC_PASSWORD} +
    (if (env.HPC_TOTP // "") != "" then {totp:env.HPC_TOTP} else {} end)' |
  curl --silent --show-error --fail-with-body --max-time 30 -A "$UA" \
    -H 'Content-Type: application/json' --data-binary @- "$BASE/api/auth/login" |
  jq -er '.data.token // error((.error.code // "login_failed") + ": " +
    (.error.message // "登录没有返回 token") + "; requestId=" + (.requestId // "unknown"))'
) || exit 1
API="$BASE/api"
hpc '/auth/me'
```

成功返回 `{data:{token,user}}`，`user` 含 `id,username,role,createdAt,avatarUrl,twoFactorEnabled`。JWT 默认有效期 7 天，也可能提前因登出、密码变更、账户禁用/删除或会话撤销失效；没有 refresh-token 接口。401 时重新登录需有效凭证，不无限尝试密码。

启用 2FA 的用户需在登录 JSON 的 `totp` 提供当前 6 位码或一次性恢复码。`totp_required` 表示需要追加码；恢复码成功使用后即消耗。同一个 6 位码只能用一次（登录或启用用过之后，再用同一个或更早的码返回 `bad_credentials`），连续两次登录要等下一个码。不要替用户生成/猜测验证码。

`totp_setup_required` 是 403：登录已成功，但站点要求未绑定用户先启用 2FA；保留 JWT，可经 API 完成绑定。此时只放行 `/auth/me`、`/auth/logout`、`/auth/2fa/*` 与公开配置。绑定是账户安全变更，需适用的用户授权。

| 方法与 `/api` 路径 | 请求与结果 |
|---|---|
| `POST /auth/register` | `{username,password,inviteCode?}`；按注册模式接受，成功 201 同登录结构，不自动认领邮箱 |
| `GET /auth/me` | 当前 `SessionUser` |
| `POST /auth/logout` | 撤销当前会话；`{success:true}` |
| `PUT /auth/password` | `{oldPassword,newPassword,revokeApiKeys?}`；返回 `{token,user,revokedApiKeys}`，新 token 立即替换旧 JWT，其他旧会话失效。`revokeApiKeys` 默认 true：同时吊销本人全部未吊销的 API Key，`revokedApiKeys` 为吊销数量；传 false 保留 Key（数量为 0）。账户可能已泄露时保持默认 |
| `POST /auth/avatar` | `{contentType,image}`；`image` 为无 `data:` 前缀的 base64，PNG/JPEG/WebP，解码最多 2 MiB；返回更新后的用户 |
| `DELETE /auth/avatar` | 返回用户，`avatarUrl:null` |
| `GET /avatar/:userId` | 公开二进制头像；优先用用户返回的带版本 URL |
| `POST /auth/2fa/setup` | `{password}`（当前密码，缺少或错误返回 403 `reauth_required`/`reauth_failed`）；返回 `{secret,otpauthUri}`，只登记，尚未启用；重复 setup 会替换待绑定密钥 |
| `POST /auth/2fa/enable` | `{code:"123456"}`；用 setup 密钥的有效 TOTP 校验（错误 400），201 返回 `{recoveryCodes:[...],token}`，仅这次能获得明文恢复码；其他会话全部失效，`token` 立即替换当前 JWT |
| `POST /auth/2fa/disable` | `{password}`（只接受当前密码，TOTP 码与恢复码都不能关闭）；返回 `{success:true,token}`，其他会话全部失效，`token` 替换当前 JWT |

用户名为 3–32 位小写字母/数字/`_`/`-`，以字母或数字开始；创建/注册/新密码 8–128 位。在用户私有渠道保存 TOTP 密钥与恢复码，勿写入公开报告。站点强制 2FA 时关闭后会重新触发绑定要求，不应把此路径当绕过策略的方法。

## Key-only 与长期自动化

已有 `hpcm_` Key 可直接访问 `/v1`，无需 bootstrap 登录。Key 的所属用户当前状态、邮箱归属/共享仍决定访问权。系统关闭开放 API、Key 被禁用/吊销/过期、来源 IP 不匹配均会拒绝；已吊销的 Key 与不存在的 Key 一样返回 401 `unauthorized`。用户改密码（默认）或管理员重置该用户密码时，其全部 Key 被吊销，需要重新创建。Key 不能登录或管理会话、创建或修改 Key、改密码、开关两步验证、修改邮箱转发目标，也不能调用 `/api/admin/*`；托管域名可以用 Key 查看、添加、检测、重新接入和改 DNS，删除、成员上限、成员与过户只用 JWT。

| Scope | 能力 |
|---|---|
| `mail.read` | 邮件列表/详情/线程/原始档/附件、联系人、未读计数、长轮询；读取草稿（`mail.send` 也可） |
| `mail.write` | 已读/全读、个人星标、软删除、恢复、永久删除 |
| `mail.send` | 发信（含回复、转发、批量）、草稿与定时发送、独立附件上传/取消上传；发件身份 `GET /v1/identities`。引用原信（`replyToMessageId`、`forwardAttachmentsFrom`、回复与转发接口）另需 `mail.read` |
| `mailbox.read` | 自有/共享邮箱列表、地址可用性（含批量）、随机后缀方案；发件身份 `GET /v1/identities` |
| `mailbox.write` | 认领（含批量）、邮箱显示名、释放及可选清除历史 |
| `domain.read` | 自己拥有或被共享的托管域名列表、接入进度，托管域名的 DNS 记录 |
| `domain.write` | 接入（添加，含批量）托管域名、立即检测（含批量）、重新接入、增改删 DNS 记录；见[用 API Key 接入](mailboxes-and-domains.md#用-api-key-接入) |
| `mailbox.share` | 管理自己邮箱的共享（只按 userId，不提供用户搜索） |
| `webhook.write` | 管理 Webhook v2 端点、测试发送、查看与重试投递，见 [Webhook](webhooks.md) |
| `notify.read` | 读取个人通知配置（飞书、PushDeer、通用 Webhook；转发目标只读）与投递健康 |
| `notify.write` | 修改飞书、PushDeer、通用 Webhook，发送测试，手动重试通知任务；邮箱转发目标只能网页会话修改 |
| `admin` | 管理员能力开关，见下文 |

**管理员能力要显式授予。** 只有所属用户是管理员、且 Key 带 `admin` scope 时，这把 Key 才按管理员执行（`scope=unclaimed/user`、`all=1`、用任意 `mailboxId` 或系统域名任意前缀发信、不受外发配额）；没有它的管理员 Key 与普通用户完全一样。`admin` 只有管理员能授予，且必须同时设置 `allowedIps` 与不超过 90 天的 `expiresAt`（否则 400；普通用户授予 403）。升级前已存在的管理员 Key 已自动带上 `admin`，照常可用；之后修改它的 scopes、白名单或有效期时按新规则校验。`GET /v1/me` 的 `key.effectiveRole` 是这把 Key 实际的执行角色。

**限定邮箱或域名。** `allowedMailboxIds`（认领行 id，来自 `GET /api/mailboxes`）与 `allowedDomains` 都为空表示不限；否则地址的域名在 `allowedDomains` 中，或该地址当前认领行的 id 在 `allowedMailboxIds` 中，才在范围内。范围外的邮件在列表、等待、未读数、联系人里不出现，按 id 读取返回 404，批量标记、删除静默跳过；请求里显式给出范围外的 `address`、`domain`、发件地址、回复或转发来源、邮箱 id 返回 403 `forbidden`（文档锚点 [key-restricted](errors.md#key-restricted)）。只限定了邮箱的 Key 不能认领新地址，`GET /v1/domains` 为空；限定了域名的 Key 只能在这些域名认领，新地址立即可用。释放后重新认领同一地址会得到新 id，旧 Key 不再覆盖它。限定了范围的 Key 只能读取通知配置，不能修改、测试、重试，也不能看投递健康；Webhook 端点必须带落在范围内的地址或域名过滤；共享只能管理范围内的邮箱；托管域名接口只能看到、添加、检测 `allowedDomains` 里的域名；随机后缀方案不可用；MCP 工具经 `/v1` 执行，同样受限。只给某个 Agent 一个地址时，用限定邮箱的 Key。

`GET /v1/identities` 有 `mail.send` 或 `mailbox.read` 其中之一即可，返回能用哪些地址发信，见[发件身份](mailboxes-and-domains.md#发件身份)。

`GET /v1/me` 是 Key 的自查接口，任一有效 Key 都能调用，不要求 scope：

```bash
hpc '/me' | jq '.data'
# {"key":{"id":7,"name":"agent","keyPrefix":"hpcm_1a2b","keySuffix":"9f0e","scopes":["mail.read","mail.send"],"rateLimit":120,
#   "allowedIps":[],"expiresAt":null,"createdAt":"…","allowedMailboxIds":[42],"allowedDomains":[],"effectiveRole":"user"},
#  "user":{"id":3,"username":"alice","role":"user"},
#  "limits":{"userRequestsPerMinute":1200,"waitPollsPerMinute":120},
#  "outbound":{"sent":4,"recipients":9,"dailyLimit":50,"dailyRecipientLimit":200,"exempt":false,"resetsAt":"2026-11-18T00:00:00.000Z"}}
```

- `key`：当前 Key 的元数据（不含明文），`rateLimit` 是这把 Key 每分钟请求上限；`id` 也是幂等记录的隔离单位；`allowedMailboxIds/allowedDomains` 是限定范围，`effectiveRole` 是执行角色（`user.role` 是账户角色）。
- `limits`：同一用户所有 Key 合计每分钟请求上限、`/v1/messages/wait` 每用户每分钟轮询次数上限。
- `outbound`：所属用户今天（UTC 自然日）的外发用量，网页与所有 Key 合计。每次发信 `sent` 加 1、`recipients` 加去重后的收件人数；全部收件人失败的那次会退还。上限为 0 表示不限，两个上限都为 0 时不计数；按管理员执行的 Key（`effectiveRole=admin`）不受外发配额约束，`exempt:true` 且上限按 0 返回。`resetsAt` 是下一个 UTC 零点。超出时发信返回 429 `rate_limited`。

`GET /v1/status` 返回 `{status:"operational",userId,role,scopes}`（`role` 是执行角色）；`GET /v1/domains` 返回 `{domains:[...]}`，是当前可认领的域名（限定了范围的 Key 只返回 `allowedDomains` 里的）；均只需任一有效 Key，无独立 scope。域名范围：普通用户默认是公开的系统域名，管理员为其设置了专属邮箱权限时改为专属名单中的系统域名（可含非公开域名）；管理员看到配置中的全部系统域名。系统域名之后附上已生效的托管域名：普通用户为自己拥有或作为成员的，管理员为全部。已从列表移除、但仍有存量邮箱的旧域名不在其中，需从邮箱列表发现。

要创建 Key，先用 JWT 登录且完成必要 2FA，再经 `/api/api-keys` 操作，请求体必须带当前登录密码 `password`（缺少 403 `reauth_required`，错误 403 `reauth_failed`，15 分钟内错 5 次后 429）。只按任务授予最小 scopes，用户仅要查验证码时通常选 `mail.read`；若还要认领可加 `mailbox.read/mailbox.write`，无需自动加 `mail.send`；要用 API 接入自有域名时加 `domain.read/domain.write`，`domain.write` 能改该用户托管域名的 DNS，不需要时不授予；只服务一个地址的 Agent 再加 `allowedMailboxIds`。网页创建 Key 默认预设为「只读收信」（`mail.read`、`mailbox.read`），「完全访问」预设也不含 `admin`。新建和长期保留 Key 应符合用户对自动化的授权。

```bash
# 当前 API="$BASE/api"、AUTH 为 JWT；HPC_PASSWORD 由用户提供，HPC_MAILBOX_ID 来自 GET /mailboxes
# 完整 key 仅在创建成功时返回一次；将响应留在受保护的运行状态，不把明文 key 与密码输出到公开报告
KEY_RESPONSE=$(jq -n --arg password "$HPC_PASSWORD" --argjson box "$HPC_MAILBOX_ID" \
  '{name:"验证码读取",scopes:["mail.read"],rateLimit:60,allowedIps:[],allowedMailboxIds:[$box],password:$password}' \
  | hpc '/api-keys' -X POST -H 'Content-Type: application/json' --data-binary @-)
```

创建的 `{data}` 为元数据加 `key` 明文；受保护地保存 `.data.key`。列表和后续读取只能获得 `keyPrefix/keySuffix`，无法找回明文。

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /api-keys` | 当前用户未吊销 Key 数组 |
| `POST /api-keys` | `{name,scopes,password,rateLimit?,allowedIps?,expiresAt?,allowedMailboxIds?,allowedDomains?}` → 201 新 Key |
| `GET /api-keys/:id` | 自己的 Key 元数据 |
| `PUT /api-keys/:id` | 至少一个 `name/scopes/rateLimit/allowedIps/status/expiresAt/allowedMailboxIds/allowedDomains`；`status:active\|disabled`；两个限定列表整体替换；返回元数据 |
| `DELETE /api-keys/:id` | 吊销，不能通过重新启用恢复；`{success:true}` |
| `GET /api-keys/:id/logs?cursor=…&limit=30` | 自己 Key 的调用审计分页 |

`name` 1–64 字符；`scopes` 非空且只接受上表中的值，已有 Key 不会自动获得新增的 scope；`allowedMailboxIds` 最多 100 个且必须是自己当前认领的邮箱（否则 400），`allowedDomains` 最多 20 个；每用户最多 10 个未吊销 Key（禁用也占名额）。`rateLimit` 每分钟 1–600，创建默认 120。`allowedIps` 最多 32 个 IPv4/IPv6 或 CIDR；`[]` 不限制 IP。创建 `expiresAt` 为未来 ISO 8601 时间，不传即不过期；更新明确 `null` 改为不过期，未传保持。Key 调用审计含 `id,requestId,method,path,statusCode,ip,durationMs,createdAt`，无请求正文和凭证明文；`path` 是归一化后的路由（数字 ID 段写成 `:id`，最长 256 字符）。被拒绝的请求（Key 禁用或过期、IP 不在白名单、用户停用、超出限流）同一 Key 每分钟最多记一条，其余只计数；已吊销的 Key 不再记录。保留约 90 天。

## 错误与限流

先看错误信封里的 `fix`。下表只列登录与账户相关的错误码；权限、发信、附件、草稿、限流等错误码见[错误码说明](errors.md)，`reauth_required`/`reauth_failed` 见其中[对应小节](errors.md#reauth_required)。

| HTTP / code | 处理 |
|---|---|
| 400 `invite_invalid` | 修正邀请码，不原样循环 |
| 401 `bad_credentials`、`totp_required` | 核对凭证/获取必要 TOTP；同一来源 IP、以及同一用户名加 IP 的登录错误各最多 5 次/15 分钟窗口（IPv6 按 /64 计），勿试探 |
| 403 `user_disabled`、`registration_closed` | 账户停用或注册关闭；不换身份绕过 |
| 403 `totp_setup_required` | 见上文 API 绑定流程 |

429 `rate_limited` 的 message 含义见[错误码说明](errors.md#rate_limited)。`/v1` 响应可能带 `X-RateLimit-Limit/Remaining/Reset`：Limit 是这把 Key 的每分钟上限；Remaining 是估计的剩余次数（上界），未归零时也可能 429；Reset 为下一分钟 Unix 秒数，是近似的窗口边界。除每 Key 限额，还有用户合计 1200 次/分钟、实例 10000 次/分钟，已超出 Key 或用户限额的请求不计入实例限额；长轮询内部查库按用户额外限 120 次/分钟，不能靠多个 Key 放大。JWT 业务请求也限流（用户 600、实例 5000 次/分钟，超出用户限额的请求同样不计入实例限额）。这些每分钟限流由 Cloudflare 各节点分别近似计数，可能略早或略晚触发，不要按上限把请求打满。注册每 IP 10 次/小时，含失败尝试。所有轮询/重试设总体期限，无法确定结果就报告待确认及 requestId。
