# 鉴权、请求与 API Keys

按任务定位：[请求约定](#请求约定)、[登录与-bootstrap](#登录与-bootstrap)、[Key-与长期自动化](#key-only-与长期自动化)、[错误与限流](#错误与限流)。

## 请求约定

本文件的 shell 示例复用 [入口指南](../skill.md) 中的 `BASE`、`UA`、`hpc()`；设定 `API` 和 `AUTH` 为所需鉴权。JSON 成功响应为 `{ "data": ... }`。分页为 `{ "data": { "items": [...], "nextCursor": "..." | null } }`；邮箱、Key、用户、邀请码等列表直接是 `data` 数组。默认页大小 30、最大 100；不要自己解析/生成不透明 `cursor`，始终把服务器返回值 URL 编码后带到下一页并保留原过滤条件。邮件列表按 ID 倒序。

失败响应为 `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`。`X-Request-ID` 可用于追踪。下载附件、原始 `.eml` 与头像返回二进制，不包 `{data}`；OpenAPI JSON 也不包信封。

写 JSON 带 `Content-Type: application/json`。查询参数用 HTTP 库或 `curl --get --data-urlencode` 编码；正文用 JSON 序列化器，勿拼接用户文本。所有示例使用稳定 `User-Agent: HPC-Mail-Agent/1.0`。若返回 HTML/Cloudflare Challenge，先核对状态与 Content-Type 并报告边缘拦截；它不是业务 JSON，也不能据此反复重试凭证。

`/v1` 支持跨源浏览器 CORS 与 Authorization/Content-Type/Idempotency-Key；`/api` JWT 不开放跨源 CORS，请用同源网页或服务端 HTTP 客户端（curl/Python 不受浏览器 CORS 限制）。浏览器跨源 fetch 被拒绝不能推断业务 API 没有该功能。

## 登录与 bootstrap

公开 `GET /api/config` 返回 `siteTitle`、`registrationMode`（`closed|invite|open`）、`domains`（仅公开域）、`require2fa`。登录不要求 Key：

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
| `PUT /auth/password` | `{oldPassword,newPassword}`；返回新 `{token,user}`，立即替换旧 JWT，其他旧会话失效 |
| `POST /auth/avatar` | `{contentType,image}`；`image` 为无 `data:` 前缀的 base64，PNG/JPEG/WebP，解码最多 2 MiB；返回更新后的用户 |
| `DELETE /auth/avatar` | 返回用户，`avatarUrl:null` |
| `GET /avatar/:userId` | 公开二进制头像；优先用用户返回的带版本 URL |
| `POST /auth/2fa/setup` | 无正文；返回 `{secret,otpauthUri}`，只登记，尚未启用；重复 setup 会替换待绑定密钥 |
| `POST /auth/2fa/enable` | `{code:"123456"}`；用 setup 密钥的有效 TOTP 校验，201 返回 `{recoveryCodes:[...]}`，仅这次能获得明文恢复码 |
| `POST /auth/2fa/disable` | `{password}` 或 `{code}`（当前 TOTP）；返回 `{success:true}`，恢复码不能用于此操作 |

用户名为 3–32 位小写字母/数字/`_`/`-`，以字母或数字开始；创建/注册/新密码 8–128 位。在用户私有渠道保存 TOTP 密钥与恢复码，勿写入公开报告。站点强制 2FA 时关闭后会重新触发绑定要求，不应把此路径当绕过策略的方法。

## Key-only 与长期自动化

已有 `hpcm_` Key 可直接访问 `/v1`，无需 bootstrap 登录。Key 的所属用户当前角色、状态、邮箱归属/共享仍决定访问权；scopes 不是管理员权限。系统关闭开放 API、Key 被禁用/吊销/过期、来源 IP 不匹配均会拒绝；Key 不能创建 Key、改密码、配置个人通知或管理用户/域名/共享。

| Scope | 能力 |
|---|---|
| `mail.read` | 邮件列表/详情/线程/原始档/附件、联系人、未读计数、长轮询 |
| `mail.write` | 已读/全读、个人星标、软删除、恢复、永久删除 |
| `mail.send` | 发信及独立附件上传/取消上传 |
| `mailbox.read` | 自有/共享邮箱列表、地址可用性 |
| `mailbox.write` | 认领、邮箱显示名、释放及可选清除历史 |

`GET /v1/status` 返回 `{status:"operational",userId,role,scopes}`；`GET /v1/domains` 返回 `{domains:[...]}`；均只需任一有效 Key，无独立 scope。普通用户看到公开域，管理员看到配置中的全部域；存量旧邮箱域需另从邮箱列表发现。

要创建 Key，先用 JWT 登录且完成必要 2FA，再经 `/api/api-keys` 操作。只按任务授予最小 scopes，用户仅要查验证码时通常选 `mail.read`；若还要认领可加 `mailbox.read/mailbox.write`，无需自动加 `mail.send`。新建和长期保留 Key 应符合用户对自动化的授权。

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

`name` 1–64 字符；`scopes` 非空且只接受上表五个；每用户最多 10 个未吊销 Key（禁用也占名额）。`rateLimit` 每分钟 1–600，创建默认 120。`allowedIps` 最多 32 个 IPv4/IPv6 或 CIDR；`[]` 不限制 IP。创建 `expiresAt` 为未来 ISO 8601 时间，不传即不过期；更新明确 `null` 改为不过期，未传保持。Key 调用审计含 `id,requestId,method,path,statusCode,ip,durationMs,createdAt`，无请求正文和凭证明文；保留约 90 天。

## 错误与限流

| HTTP / code | 处理 |
|---|---|
| 400 `validation_failed`、`invite_invalid` | 修正字段或邀请码，不原样循环 |
| 401 `bad_credentials`、`totp_required` | 核对凭证/获取必要 TOTP；登录错误最多 5 次/15 分钟窗口，勿试探 |
| 401 `unauthorized` | JWT 会话无效，或 Key 无效/过期/禁用；依原鉴权方式处理 |
| 403 `forbidden`、`user_disabled`、`registration_closed` | 权限/策略/状态阻止；不换身份绕过 |
| 403 `totp_setup_required` | 见 API 绑定流程 |
| 404 `not_found` | 资源不存在或不在可见范围；核对 ID/作用域 |
| 409 `address_taken` | 地址被占用；可用性检查只是提示，最终以认领结果为准 |
| 409 `conflict` | 域名并发冲突重新读配置；发件冲突先读回原结果，绝不自动换发送 Key |
| 413 `payload_too_large` | 核对正文/附件限制，或小上传改分片 |
| 429 `rate_limited` | 按 reset/消息退避并受总截止时间限制；外发日配额、上传草稿限额也会用此码 |
| 500 `internal`、网络超时、非 JSON | 读操作可有限退避重试；发送按相同幂等请求查结果，其他变更先读回状态 |

`/v1` 响应可能带 `X-RateLimit-Limit/Remaining/Reset`，Reset 为下一分钟 Unix 秒数。除每 Key 限额，还有用户合计 1200 次/分钟、实例 10000 次/分钟；长轮询内部查库按用户额外限 120 次/分钟，不能靠多个 Key 放大。JWT 业务请求也限流（用户 600、实例 5000 次/分钟）。注册每 IP 10 次/小时，含失败尝试。所有轮询/重试设总体期限，无法确定结果就报告待确认及 requestId。
