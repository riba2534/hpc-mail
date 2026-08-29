---
name: hpc-mail
description: 通过 HTTP API 操作 HPC Mail（https://hpc.email）多域名邮箱系统——接收邮件并读取自动提取的验证码、发送与回复邮件、认领和管理邮箱地址、搜索邮件、下载附件。当你拿到 HPC Mail 的用户名和密码，或被要求「在 hpc.email 上收发邮件」「查收/获取邮箱验证码」「用某个 @hpc.email 之类的地址发信或回信」「自动化邮箱操作」时，务必使用本 skill——即使用户只说「帮我查一下验证码」「发封邮件」而没有点名 HPC Mail，只要目标邮箱属于本系统的域名，就按本文指引调用 API。
---

# HPC Mail — AI Agent 操作指南

你（AI Agent）拿到本站的**用户名**和**密码**后，照本文档即可完成邮箱的收发、回复、接收验证码等全部操作。所有接口都是标准 HTTP + JSON，用 `curl` 或任意 HTTP 客户端即可调用。

- **站点地址（Base URL）**：`https://hpc.email`（下文示例里的 `$BASE`）
- **本文档地址**：`https://hpc.email/skill.md`
- **你需要的凭据**：用户名 + 密码（由站点管理员提供给你）

> 本系统开源可自部署，本文档随每个部署实例分发。若你是从其他域名获取到本文件，`$BASE` 就是那个域名——把下文示例中的 `https://hpc.email` 全部替换为它即可，API 完全一致。

理解这套 API 的关键在于：**邮箱地址与登录身份是分离的**。你用用户名密码登录得到一个访问令牌，令牌代表「你这个账户」；而收发邮件用的是一个个「邮箱地址」（如 `bot@hpc.email`），需要先认领才能归你专用。搞清这一点，后面的操作就都顺理成章。

## 核心概念

- **平台账户**：用用户名 + 密码登录的身份，和具体邮箱地址分开。
- **邮箱地址**：形如 `任意前缀@某个系统域名`（例如 `bot@hpc.email`）。普通账户要先**认领**一个地址才能用它收发；地址全局唯一，认领后专属于你。管理员账户可直接用任意地址收发，无需认领。
- **验证码自动提取**：发到你地址的邮件，系统会自动把其中的验证码解析到 `verificationCode` 字段——这是接码类任务的核心，通常你不必再自己解析正文。
- **发件限制**：普通账户只能用自己认领的地址作为发件人；管理员不受限。

## 第一步：登录拿到访问令牌

所有后续请求都要带这个令牌，所以先做这一步。

```bash
curl -s -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"你的用户名","password":"你的密码"}'
# → { "data": { "token": "eyJ...(JWT)", "user": { "id": 1, "username": "...", "role": "user" } } }
```

记下 `data.token`（下文记作 `$TOKEN`）。之后每个请求都加请求头 `Authorization: Bearer $TOKEN`。令牌有效期 7 天；长期无人值守请改用文末的 API Key + `/v1`。

## 响应格式约定

理解这个约定，你才能正确判断每次调用成没成功、结果在哪：

- **成功**：HTTP 2xx，响应体 `{ "data": ... }`，你要的内容在 `data` 里。
- **失败**：HTTP 4xx/5xx，响应体 `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`。读 `error.message` 了解原因，`code` 是机器可读错误码（见文末）。
- **邮件列表**用游标分页：请求带 `?cursor=&limit=`（都可省略，省略即第一页、默认每页 30 条），返回 `{ "data": { "items": [...], "nextCursor": "字符串或 null" } }`。`nextCursor` 非 null 时，把它作为下一页的 `cursor` 继续拉。
- **注意**：`/api/mailboxes`、`/api/domains`、`/api/api-keys`、`/v1/mailboxes` 这几个**不分页**，`data` 直接就是数组，没有 `items` 字段——别去取 `data.items`。

## 任务：接收邮件 / 读取验证码（最常见）

这是绝大多数自动化任务的核心。拉取收件箱最新邮件：

```bash
curl -s "$BASE/api/messages?direction=inbound&limit=10" -H "Authorization: Bearer $TOKEN"
```

返回的每封邮件（`data.items[]`）含这些关键字段：

| 字段 | 含义 |
|------|------|
| `id` | 邮件 id，取详情/回复时用 |
| `fromAddress` / `fromName` | 发件人 |
| `address` | 收到该邮件的本站地址 |
| `subject` / `preview` | 主题 / 正文摘要 |
| **`verificationCode`** | **系统自动提取的验证码**（无则为空字符串） |
| `isRead` / `isStarred` / `hasAttachments` | 已读 / 星标 / 有附件 |
| `createdAt` | 收件时间 |

**接码时优先读 `verificationCode`**，命中即可，通常不必解析正文。只看某个地址收到的信，加 `&address=bot@hpc.email`。看完整正文与附件用详情接口：

```bash
curl -s $BASE/api/messages/123 -H "Authorization: Bearer $TOKEN"
# → data 含 bodyText、bodyHtml、verificationCode、recipients、attachments[]（每个附件带可下载的 url）
```

### 轮询等待验证码到达

触发某操作后，验证码邮件通常几秒内到。按地址轮询，读到即停。为避免读到**旧**验证码，先记下当前最新邮件 id，只认比它更新的邮件。

**关键：每次拉一整页（`limit=10`）并遍历所有 `id > LAST` 的新邮件**，而不是只看最新一封——否则验证码邮件之后若又进来一封别的邮件（如营销/通知），只看第一封就会漏掉验证码。

```bash
ADDR="bot@hpc.email"
LAST=$(curl -s "$BASE/api/messages?direction=inbound&address=$ADDR&limit=1" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import json,sys;i=json.load(sys.stdin)['data']['items'];print(i[0]['id'] if i else 0)")
# ……在此触发会产生验证码邮件的操作……
for i in $(seq 1 20); do
  CODE=$(curl -s "$BASE/api/messages?direction=inbound&address=$ADDR&limit=10" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import json,sys,os
last=int(os.environ['LAST'])
items=json.load(sys.stdin)['data']['items']
# items 按 id 降序；取 id>last 且有验证码里最新的一封
for m in items:
    if m['id']>last and m['verificationCode']:
        print(m['verificationCode']); break")
  if [ -n "$CODE" ]; then echo "验证码：$CODE"; break; fi
  sleep 3
done
```

> `/v1`（API Key）用户可用长轮询端点 `GET /v1/messages/wait?address=<地址>&afterId=<LAST>&timeout=25` 一步到位，服务端 hold 到有新邮件即返回，免去自己写轮询循环（见文末进阶）。

## 任务：发送邮件

```bash
curl -s -X POST $BASE/api/messages/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "from": { "localPart": "bot", "domain": "hpc.email" },
    "to": ["someone@example.com"],
    "subject": "你好",
    "text": "这是纯文本正文"
  }'
```

- `from` 二选一：`{"localPart":"bot","domain":"hpc.email"}` 或 `{"mailboxId":5}`（用你认领的地址）。
- 正文 `text`（纯文本）和 `html` 至少给一个；可选 `cc` / `bcc` 数组、`attachments`。
- **附件结构**：`attachments` 是数组，每项 `{"filename":"a.pdf","contentType":"application/pdf","content":"<base64>"}`，`content` 为不含 `data:` 前缀的 base64（**允许换行**，`base64 file.pdf` / Python `base64.encodebytes()` 那种 76 字符折行的多行输出可直接用）；单次 ≤10 个、单文件 ≤50MB、合计 ≤50MB。
- **外发大小限制**：发到本系统域名之外的邮箱（外部地址）走 Cloudflare 发信通道，单封邮件（含附件、base64 编码后）阈值 4MiB —— 因为 base64 会把体积撑大约 1/3，**原始附件超过约 3MB 就会走转链接**。未超阈值的附件直接内嵌发出；超出则附件自动转为 90 天有效的下载链接注入正文（收件人点链接下载），不会报错。注意该链接指向这封「已发送」邮件的附件，发件人若把这封邮件彻底删除，链接会提前失效。站内 `@<系统域名>` 地址走站内存储，附件内嵌、不受此限。
- 收件人若也是本站域名，即时站内投递；站外地址经 Cloudflare 发送到任意外部邮箱，个别收件人失败会在 `errorDetail` 里注明。
- **判断是否真的发出去了**：成功响应的 `data` 是一封 outbound 邮件，看它的 `status` 与 `errorDetail`——`status:"failed"` 表示全部失败（此时 HTTP 也是错误码）；`status:"sent"` 但 `errorDetail` 非空表示**部分收件人失败**（`errorDetail` 里列出失败地址与原因），别把它当作全部送达。

## 任务：回复邮件

回复的要点是带上 `replyToMessageId`（原邮件 id），系统会自动注入邮件线程头（In-Reply-To / References），让回复正确挂到原对话上。把 `to` 设为原发件人、主题加 `Re:`：

```bash
curl -s -X POST $BASE/api/messages/send \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "from": { "localPart": "bot", "domain": "hpc.email" },
    "to": ["原发件人@example.com"],
    "subject": "Re: 原主题",
    "text": "我的回复内容。\n\n----- 原始邮件 -----\n> 原文引用...",
    "replyToMessageId": 123
  }'
```

## 任务：认领 / 管理邮箱地址

普通账户收发前需先认领地址（管理员可跳过）。先查可用域名（此接口无需登录）：

```bash
curl -s $BASE/api/config
# → data.domains 是可认领的系统域名列表
```

查地址是否可用并认领：

```bash
curl -s "$BASE/api/mailboxes/availability?localPart=bot&domain=hpc.email" -H "Authorization: Bearer $TOKEN"
# → { "data": { "address": "bot@hpc.email", "available": true } }
curl -s -X POST $BASE/api/mailboxes -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"localPart":"bot","domain":"hpc.email"}'
```

查看已认领地址：`GET /api/mailboxes`（管理员加 `?all=1` 看全站）。释放地址：`DELETE /api/mailboxes/:id`。

## 任务：标记 / 搜索 / 下载附件

```bash
# 标记已读（isRead:false 则标未读）、星标（starred:false 取消）、删除
curl -s -X POST $BASE/api/messages/read   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ids":[123],"isRead":true}'
curl -s -X POST $BASE/api/messages/star   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ids":[123],"starred":true}'
curl -s -X POST $BASE/api/messages/delete -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"ids":[123]}'
```

**管理员注意**：这三个批量接口默认只作用于**你自己认领的地址**下的邮件（防止漏传参数误改他人邮件）。
清理未认领地址的信时显式加 `"scope":"unclaimed"`（或 query `?scope=unclaimed`），例如 `{"ids":[123],"isRead":true,"scope":"unclaimed"}`。
不再支持 `scope=all`（会 400）。`/v1` 的同名接口用法一致。一次最多传 500 个 id。

管理员列未认领收件：`GET /api/messages?scope=unclaimed&direction=inbound`。
查看某用户已认领地址：`GET /api/messages?scope=user&userId=20`。

搜索用 `GET /api/messages` 的 query 参数组合：`direction`（inbound/outbound）、`address`、`domain`、`unread=1`、`starred=1`、`q`（关键词，匹配主题/发件人/**正文**）、`cursor`/`limit`（limit 最大 100）。例：搜正文含 invoice 的未读收件 → `?direction=inbound&unread=1&q=invoice`。

下载附件：邮件详情 `data.attachments[]` 每项有短期签名 `url`，`curl -s "$BASE<url>" -o file` 即可。

## 完整接口速查

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 登录拿 token |
| GET | `/api/auth/me` | 当前账户信息 |
| GET | `/api/config` | 公开配置（可用域名、注册模式）|
| GET / POST | `/api/mailboxes` | 我的地址 / 认领 `{localPart,domain}` |
| GET | `/api/mailboxes/availability?localPart=&domain=` | 查地址可否认领 |
| DELETE | `/api/mailboxes/:id` | 释放地址 |
| GET | `/api/messages` | 收发件列表（过滤参数见「搜索」）|
| GET | `/api/messages/:id` | 邮件详情（正文 + 验证码 + 附件）|
| POST | `/api/messages/send` | 发送 / 回复（带 `replyToMessageId`）|
| POST | `/api/messages/read` `/star` `/delete` | 批量已读 / 星标 / 删除 `{ids,...}` |
| GET | `/api/attachments/:id` | 下载附件 |

## 错误码参考

| code | HTTP | 含义与应对 |
|------|------|------|
| `bad_credentials` | 401 | 登录时用户名或密码错误 → 核对凭据（注意与 `unauthorized` 区分：这是登录失败，不是 token 问题）|
| `unauthorized` | 401 | 未登录 / token 或 API Key 失效、过期、被禁用 → 重新登录或更换 key |
| `forbidden` | 403 | 无权限（如用非自己认领的地址发件、来源 IP 不在白名单、缺少 API scope）|
| `user_disabled` | 403 | 账户已被管理员禁用 |
| `registration_closed` | 403 | 当前未开放注册 |
| `validation_failed` | 400 | 参数不合法（如域名不在系统列表）|
| `invite_invalid` | 400 | 邀请码无效 / 已用尽 / 已过期 |
| `address_taken` | 409 | 认领的地址已被占用，换一个前缀 |
| `conflict` | 409 | 资源冲突（如用户名已存在）|
| `not_found` | 404 | 资源不存在 |
| `totp_required` | 401 | 该账号开了两步验证，登录请求需带 `totp`（6 位动态码或恢复码）→ 用 `{"username":..,"password":..,"totp":"123456"}` 重试 |
| `totp_setup_required` | 403 | 站点强制要求两步验证而该账号尚未绑定 → 需先在网页端完成绑定，脚本无法自行绕过（此时除绑定相关接口外都会返回它）|
| `rate_limited` | 429 | 频率超限，稍后重试（响应带 `X-RateLimit-*`）|
| `payload_too_large` | 413 | 请求体过大（如附件超限）|
| `internal` | 500 | 服务端错误，可重试 |

## 进阶：用 API Key + /v1 做长期自动化

若需长期无人值守运行，建议创建 **API Key** 后改用 `/v1` 系列接口（专为脚本设计，带独立限流与调用审计），而不是反复用用户名密码登录。

```bash
# 用 $TOKEN 创建 key，data.key 是完整密钥（形如 hpcm_xxxx），只返回这一次，务必保存
curl -s -X POST $BASE/api/api-keys -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-agent","scopes":["mail.read","mail.write","mail.send","mailbox.read","mailbox.write"]}'
```

**scope 说明**：`mail.read`（读邮件/验证码）、`mail.write`（标记已读、删除邮件）、`mail.send`（发信/回复）、`mailbox.read`（列邮箱）、`mailbox.write`（认领/释放）。按需最小授权。

之后用 `Authorization: Bearer hpcm_xxxx` 调用 `/v1`：

| 方法 | 路径 | scope | 说明 |
|------|------|-------|------|
| GET | `/v1/status` | — | 探活，返回 key 的 userId/role/scopes |
| GET | `/v1/domains` | — | 可用系统域名 |
| GET / POST | `/v1/mailboxes` | mailbox.read / mailbox.write | 列出 / 认领邮箱 |
| GET | `/v1/messages` | mail.read | 收发件列表（过滤参数同 `/api`）|
| GET | `/v1/messages/wait?address=&afterId=&timeout=25` | mail.read | **长轮询**：hold 到有 `id>afterId` 的新邮件即返回，专为等验证码设计 |
| GET | `/v1/messages/:id` | mail.read | 详情（含 verificationCode）|
| GET | `/v1/messages/:id/attachments/:attId` | mail.read | 下载附件 |
| POST | `/v1/messages` | mail.send | 发送 / 回复（body 同上；带 `Idempotency-Key: <唯一串>` 头可去重，24h 内同 key 重试不重复发信）|
| POST | `/v1/messages/read` | mail.write | 批量标记已读 `{ids,isRead}` |
| POST | `/v1/messages/delete` | mail.write | 批量删除 `{ids}` |

`/v1` 响应带 `X-RateLimit-*` 头，超限返回 429。完整机器可读描述见 `GET https://hpc.email/v1/openapi.json`（OpenAPI 3.1，无需鉴权）。

> 管理员另可在后台配置**通用 Webhook**：新邮件时系统会 POST JSON（`{event:"mail.received", message:{...}}`，带 `X-HPC-Signature` HMAC-SHA256 签名头）到你的 HTTPS 端点，比轮询更实时。

### 用长轮询高效等验证码（推荐）

有 `mail.write`/`mail.read` 的 key 不必自己写轮询循环，用 wait 端点一步到位——服务端最多 hold `timeout` 秒，一有新邮件立即返回：

```bash
ADDR="bot@hpc.email"
# 先拿当前最新 id 作为基线
LAST=$(curl -s "$BASE/v1/messages?direction=inbound&address=$ADDR&limit=1" \
  -H "Authorization: Bearer $KEY" \
  | python3 -c "import json,sys;i=json.load(sys.stdin)['data']['items'];print(i[0]['id'] if i else 0)")
# ……触发验证码邮件……
# 长轮询：返回第一封 id>LAST 的新邮件（含 verificationCode），或 timeout 后返回 {message:null}
curl -s "$BASE/v1/messages/wait?address=$ADDR&afterId=$LAST&timeout=25" \
  -H "Authorization: Bearer $KEY"
# → { "data": { "message": { "id":.., "verificationCode":"482913", ... } } }  命中
# → { "data": { "message": null } }  超时未等到，再调一次即可
```

---

**一句话流程**：登录拿 token → 认领或选定一个地址 → `GET /api/messages` 收信读 `verificationCode` → `POST /api/messages/send` 发信/回复。
