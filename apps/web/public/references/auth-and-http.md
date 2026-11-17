# 鉴权、请求与 API Keys

## 目录

- [请求约定](#请求约定)：成功与错误信封（`fix`、`docs`、`details`）、分页、请求头、CORS
- [登录与 bootstrap](#登录与-bootstrap)：JWT 登录、两步验证、账户接口
- [Key-only 与长期自动化](#key-only-与长期自动化)：scopes、`/v1/me` 自查、创建与管理 API Key
- [错误与限流](#错误与限流)：常见错误码的处理与各级限流；逐个错误码的改正方法见[错误码说明](errors.md)

## 请求约定

本文件的 shell 示例复用 [入口指南](../skill.md) 中的 `BASE`、`UA`、`hpc()`；设定 `API` 和 `AUTH` 为所需鉴权。JSON 成功响应为 `{ "data": ... }`。分页为 `{ "data": { "items": [...], "nextCursor": "..." | null } }`；邮箱、Key、用户、邀请码等列表直接是 `data` 数组。默认页大小 30、最大 100；不要自己解析/生成不透明 `cursor`，始终把服务器返回值 URL 编码后带到下一页并保留原过滤条件；无法解码的 `cursor` 返回 400 `validation_failed`。邮件列表按 ID 倒序。

失败响应为 `{ "error": { "code", "message", "fix"?, "docs"?, "details"? }, "requestId" }`：

```json
{"error":{"code":"forbidden","message":"需要 API scope: mailbox.read","fix":"这把 Key 缺少 scope mailbox.read：……（GET /v1/me 可查看当前 scopes）","docs":"https://hpc.email/references/errors.md#forbidden-scope"},"requestId":"…"}
```

- `code` 稳定，程序按它分支；`message` 是中文说明，措辞可能调整。
- `fix`（可选）是可以直接照做的改正建议，例如缺哪个 scope、先调哪个接口。
- `docs`（可选）是本站[错误码说明](errors.md)对应小节的绝对 URL，自部署实例指向自己。
- `details`（可选）是结构化补充：`headers` 列出出问题的邮件头；`messageId`、`recipientOutcomes` 出现在 422 `delivery_failed` 上。

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

启用 2FA 的用户需在登录 JSON 的 `totp` 提供当前 6 位码或一次性恢复码。`totp_required` 表示需要追加码；恢复码成功使用后即消耗。不要替用户生成/猜测验证码。

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
| `POST /auth/2fa/setup` | 无正文；返回 `{secret,otpauthUri}`，只登记，尚未启用；重复 setup 会替换待绑定密钥 |
| `POST /auth/2fa/enable` | `{code:"123456"}`；用 setup 密钥的有效 TOTP 校验，201 返回 `{recoveryCodes:[...]}`，仅这次能获得明文恢复码 |
| `POST /auth/2fa/disable` | `{password}` 或 `{code}`（当前 TOTP）；返回 `{success:true}`，恢复码不能用于此操作 |

用户名为 3–32 位小写字母/数字/`_`/`-`，以字母或数字开始；创建/注册/新密码 8–128 位。在用户私有渠道保存 TOTP 密钥与恢复码，勿写入公开报告。站点强制 2FA 时关闭后会重新触发绑定要求，不应把此路径当绕过策略的方法。

## Key-only 与长期自动化

已有 `hpcm_` Key 可直接访问 `/v1`，无需 bootstrap 登录。Key 的所属用户当前角色、状态、邮箱归属/共享仍决定访问权；scopes 不是管理员权限。系统关闭开放 API、Key 被禁用/吊销/过期、来源 IP 不匹配均会拒绝；已吊销的 Key 与不存在的 Key 一样返回 401 `unauthorized`。用户改密码（默认）或管理员重置该用户密码时，其全部 Key 被吊销，需要重新创建。Key 不能创建 Key、改密码、配置个人通知或管理用户/系统域名/共享；托管域名可以用 Key 查看、添加、检测和改 DNS，删除、成员与过户仍只用 JWT。

| Scope | 能力 |
|---|---|
| `mail.read` | 邮件列表/详情/线程/原始档/附件、联系人、未读计数、长轮询 |
| `mail.write` | 已读/全读、个人星标、软删除、恢复、永久删除 |
| `mail.send` | 发信及独立附件上传/取消上传；发件身份 `GET /v1/identities` |
| `mailbox.read` | 自有/共享邮箱列表、地址可用性（含批量）、随机后缀方案；发件身份 `GET /v1/identities` |
| `mailbox.write` | 认领（含批量）、邮箱显示名、释放及可选清除历史 |
| `domain.read` | 自己拥有或被共享的托管域名列表、接入进度，托管域名的 DNS 记录 |
| `domain.write` | 接入（添加）托管域名、立即检测、增改删 DNS 记录；见[用 API Key 接入](mailboxes-and-domains.md#用-api-key-接入) |

`GET /v1/identities` 有 `mail.send` 或 `mailbox.read` 其中之一即可，返回能用哪些地址发信，见[发件身份](mailboxes-and-domains.md#发件身份)。

`GET /v1/me` 是 Key 的自查接口，任一有效 Key 都能调用，不要求 scope：

```bash
hpc '/me' | jq '.data'
# {"key":{"id":7,"name":"agent","keyPrefix":"hpcm_1a2b","keySuffix":"9f0e","scopes":["mail.read","mail.send"],"rateLimit":120,
#   "allowedIps":[],"expiresAt":null,"createdAt":"…"},"user":{"id":3,"username":"alice","role":"user"},
#  "limits":{"userRequestsPerMinute":1200,"waitPollsPerMinute":120},
#  "outbound":{"sent":4,"recipients":9,"dailyLimit":50,"dailyRecipientLimit":200,"exempt":false,"resetsAt":"2026-11-18T00:00:00.000Z"}}
```

- `key`：当前 Key 的元数据（不含明文），`rateLimit` 是这把 Key 每分钟请求上限；`id` 也是幂等记录的隔离单位。
- `limits`：同一用户所有 Key 合计每分钟请求上限、`/v1/messages/wait` 每用户每分钟轮询次数上限。
- `outbound`：所属用户今天（UTC 自然日）的外发用量，网页与所有 Key 合计。每次发信 `sent` 加 1、`recipients` 加去重后的收件人数；全部收件人失败的那次会退还。上限为 0 表示不限，两个上限都为 0 时不计数；管理员不受外发配额约束，`exempt:true` 且上限按 0 返回。`resetsAt` 是下一个 UTC 零点。超出时发信返回 429 `rate_limited`。

`GET /v1/status` 返回 `{status:"operational",userId,role,scopes}`；`GET /v1/domains` 返回 `{domains:[...]}`，是当前可认领的域名；均只需任一有效 Key，无独立 scope。域名范围：普通用户默认是公开的系统域名，管理员为其设置了专属邮箱权限时改为专属名单中的系统域名（可含非公开域名）；管理员看到配置中的全部系统域名。系统域名之后附上已生效的托管域名：普通用户为自己拥有或作为成员的，管理员为全部。已从列表移除、但仍有存量邮箱的旧域名不在其中，需从邮箱列表发现。

要创建 Key，先用 JWT 登录且完成必要 2FA，再经 `/api/api-keys` 操作。只按任务授予最小 scopes，用户仅要查验证码时通常选 `mail.read`；若还要认领可加 `mailbox.read/mailbox.write`，无需自动加 `mail.send`；要用 API 接入自有域名时加 `domain.read/domain.write`，`domain.write` 能改该用户托管域名的 DNS，不需要时不授予。新建和长期保留 Key 应符合用户对自动化的授权。

```bash
# 当前 API="$BASE/api"、AUTH 为 JWT；完整 key 仅在创建成功时返回一次
# 将响应留在受保护的运行状态，不把明文 key 输出到公开报告
KEY_RESPONSE=$(hpc '/api-keys' -X POST -H 'Content-Type: application/json' \
  --data-binary '{"name":"验证码读取","scopes":["mail.read"],"rateLimit":60,"allowedIps":[]}')
```

创建的 `{data}` 为元数据加 `key` 明文；受保护地保存 `.data.key`。列表和后续读取只能获得 `keyPrefix/keySuffix`，无法找回明文。

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /api-keys` | 当前用户未吊销 Key 数组 |
| `POST /api-keys` | `{name,scopes,rateLimit?,allowedIps?,expiresAt?}` → 201 新 Key |
| `GET /api-keys/:id` | 自己的 Key 元数据 |
| `PUT /api-keys/:id` | 至少一个 `name/scopes/rateLimit/allowedIps/status/expiresAt`；`status:active\|disabled`；返回元数据 |
| `DELETE /api-keys/:id` | 吊销，不能通过重新启用恢复；`{success:true}` |
| `GET /api-keys/:id/logs?cursor=…&limit=30` | 自己 Key 的调用审计分页 |

`name` 1–64 字符；`scopes` 非空且只接受上表中的值，已有 Key 不会自动获得新增的 scope；每用户最多 10 个未吊销 Key（禁用也占名额）。`rateLimit` 每分钟 1–600，创建默认 120。`allowedIps` 最多 32 个 IPv4/IPv6 或 CIDR；`[]` 不限制 IP。创建 `expiresAt` 为未来 ISO 8601 时间，不传即不过期；更新明确 `null` 改为不过期，未传保持。Key 调用审计含 `id,requestId,method,path,statusCode,ip,durationMs,createdAt`，无请求正文和凭证明文；`path` 是归一化后的路由（数字 ID 段写成 `:id`，最长 256 字符）。被拒绝的请求（Key 禁用或过期、IP 不在白名单、用户停用、超出限流）同一 Key 每分钟最多记一条，其余只计数；已吊销的 Key 不再记录。保留约 90 天。

## 错误与限流

先看错误信封里的 `fix`；发信相关错误码的完整说明与改正方法见[错误码说明](errors.md)。

| HTTP / code | 处理 |
|---|---|
| 400 `validation_failed`、`invite_invalid` | 修正字段或邀请码，不原样循环 |
| 400 `header_not_allowed` | 发信 `headers` 里有不允许的头，`details.headers` 列出全部；只保留 `X-*` 与白名单头 |
| 401 `bad_credentials`、`totp_required` | 核对凭证/获取必要 TOTP；同一来源 IP、以及同一用户名加 IP 的登录错误各最多 5 次/15 分钟窗口（IPv6 按 /64 计），勿试探 |
| 401 `unauthorized` | JWT 会话无效，或 Key 无效/过期/禁用；依原鉴权方式处理 |
| 403 `forbidden`、`user_disabled`、`registration_closed` | 权限/策略/状态阻止；不换身份绕过。Key 缺 scope 或发件地址无权时 `fix` 说明该怎么做 |
| 403 `totp_setup_required` | 见 API 绑定流程 |
| 404 `not_found` | 资源不存在或不在可见范围；核对 ID/作用域 |
| 404 `source_unavailable` | 回复或转发引用的原邮件不存在、不可见，或原附件已丢失；去掉 `replyToMessageId`/`forwardAttachmentsFrom` 后可作为新邮件发送 |
| 409 `address_taken` | 地址被占用；可用性检查只是提示，最终以认领结果为准 |
| 409 `conflict` | 并发冲突或版本过期：重新读取当前状态再决定 |
| 409 `send_in_progress` | 同一 Idempotency-Key 的发送仍在处理或结果待确认：查已发送邮件核对，稍后用同一 Key 重试，绝不换 Key 重发 |
| 409 `idempotency_mismatch` | 该 Idempotency-Key 已用于不同的发信内容：先核对原发送，新内容换新 Key |
| 413 `payload_too_large` | 核对正文/附件限制：发信请求体最多 16 MiB、base64 附件合计 10 MiB，更大的文件先上传再用 token；单次直传超过 10 MiB 改分片 |
| 422 `delivery_failed` | 发信的每个收件人都被拒收，没有发出；`details.recipientOutcomes` 给原因。同一 Idempotency-Key 重试仍是 422，修正后换新 Key |
| 429 `rate_limited` | 按 reset/消息退避并受总截止时间限制。`/v1` 的 message 区分范围：「API 调用频率超限」是这把 Key 超限，「API 调用频率超限（账户级）」是同一用户所有 Key 合计超限，「API 总调用频率超限」是全站繁忙；换 Key 不能绕过账户级限制。外发日配额（`GET /v1/me` 的 `outbound` 显示今日用量与重置时间）、上传草稿限额、托管域名添加与立即检测的频率限制也会用此码 |
| 500 `internal`、网络超时、非 JSON | 读操作可有限退避重试；发送按相同幂等请求查结果，其他变更先读回状态 |

`/v1` 响应可能带 `X-RateLimit-Limit/Remaining/Reset`：Limit 是这把 Key 的每分钟上限；Remaining 是估计的剩余次数（上界），未归零时也可能 429；Reset 为下一分钟 Unix 秒数，是近似的窗口边界。除每 Key 限额，还有用户合计 1200 次/分钟、实例 10000 次/分钟，已超出 Key 或用户限额的请求不计入实例限额；长轮询内部查库按用户额外限 120 次/分钟，不能靠多个 Key 放大。JWT 业务请求也限流（用户 600、实例 5000 次/分钟，超出用户限额的请求同样不计入实例限额）。这些每分钟限流由 Cloudflare 各节点分别近似计数，可能略早或略晚触发，不要按上限把请求打满。注册每 IP 10 次/小时，含失败尝试。所有轮询/重试设总体期限，无法确定结果就报告待确认及 requestId。
