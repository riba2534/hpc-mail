# 错误码与改正方法

## 目录

- 发信与请求：[validation_failed](#validation_failed)、[header_not_allowed](#header_not_allowed)、[payload_too_large](#payload_too_large)、[idempotency_mismatch](#idempotency_mismatch)、[send_in_progress](#send_in_progress)、[source_unavailable](#source_unavailable)、[from_required](#from_required)、[delivery_failed](#delivery_failed)、[recipient_suppressed](#recipient_suppressed)、[rate_limited](#rate_limited)
- 权限：[forbidden-scope](#forbidden-scope)、[forbidden-sender](#forbidden-sender)、[key-restricted](#key-restricted)、[reauth_required](#reauth_required)、[reauth_failed](#reauth_failed)
- URL 附件与草稿：[attachment_url_forbidden](#attachment_url_forbidden)、[attachment_url_fetch_failed](#attachment_url_fetch_failed)、[draft_state_conflict](#draft_state_conflict)、[draft_limit_reached](#draft_limit_reached)
- [其他错误码](#其他错误码)

失败响应统一为 HTTP 4xx/5xx 加错误信封：

```json
{ "error": { "code": "header_not_allowed", "message": "…", "fix": "…", "docs": "https://<站点>/references/errors.md#header_not_allowed", "details": { "headers": ["Message-ID"] } }, "requestId": "…" }
```

- `code` 稳定，按它分支；`message` 是给人看的中文说明，可能调整措辞。
- `fix`（可选）是可以直接照做的改正建议；`docs`（可选）指向本页对应小节，按请求的站点补成绝对 URL。
- `details`（可选）是结构化补充：`headers` 列出出问题的邮件头；`messageId` 与 `recipientOutcomes` 出现在 `delivery_failed` 上；`suppressed` 出现在 `recipient_suppressed` 上；`url` 出现在 URL 附件的错误上；`draftStatus` 与 `draftVersion` 出现在 `draft_state_conflict` 上。
- 报告问题时附上 `requestId`（与响应头 `X-Request-ID` 相同）。

下面各节对应 `docs` 链接的锚点；其余错误码见文末[其他错误码](#其他错误码)。

## validation_failed

请求参数不合法（HTTP 400），`message` 指出第一个出错的字段。修正后重试；外发前的 400 不会发出邮件，同一个 `Idempotency-Key` 可以继续用。发信时常见原因：

- `from` 不是四种写法之一（`{mailboxId}`、`{localPart,domain}`、`"Name <a@b>"`、`{address,name}`），或地址不属于本站；托管域名的发信尚未就绪。
- 收件人地址畸形（如 `alice<a@b.com`）、To/Cc/Bcc 合计为 0 或超过 100、`replyTo` 超过 10 个、显示名超过 64 字符。
- 邮件头取值不合法（换行、超长、重复、枚举值或格式不对），此时带 `details.headers`；`replyToMessageId` 与 `headers` 的 `In-Reply-To`/`References` 同时出现。
- 附件超过 10 个、`contentId` 重复、`disposition:"inline"` 却没有 `contentId`、上传 token 不存在或尚未完成。
- 列表的 `cursor` 不是服务器返回的值。

## header_not_allowed

`headers` 里有不允许的邮件头（HTTP 400），`details.headers` 列出全部被拒的头。只允许 `X-` 开头的头与白名单头（`In-Reply-To`、`References`、`List-Unsubscribe`、`List-Unsubscribe-Post`、`List-Id` 等 `List-*`、`Precedence`、`Auto-Submitted`、`Importance`、`Priority`、`Sensitivity`、`Organization`、`Keywords`、`Comments`、`Content-Language` 等，完整名单见[自定义邮件头](mail.md#自定义邮件头)）。`Message-ID`、`Date` 等由平台生成；`From`、`To`、`Cc`、`Bcc`、`Subject`、`Reply-To` 用请求里对应的字段。去掉 `details.headers` 里的头后重试。头的取值不合法（换行、超长、重复、枚举值不对）时错误码是 `validation_failed`，同样带 `details.headers`。

## payload_too_large

请求或附件超过上限（HTTP 413），没有发出。base64 内联附件合计不超过 10 MiB，整个发信请求体不超过 16 MiB（超过时在解析前直接拒绝）；更大的文件先用 `POST /v1/uploads`（JWT 用 `POST /api/uploads`，大于 10 MiB 走分片）上传拿到 token，再在 `attachmentTokens` 里引用。所有附件合计不超过 50 MiB，超过时只能减少附件。详见[附件](attachments.md#大小与数量限制)。

## forbidden-scope

API Key 缺少接口要求的 scope（HTTP 403 `forbidden`），`fix` 写明缺哪个。`GET /v1/me` 查看当前 Key 的 scopes；Key 不能给自己加 scope，要由用户在网页的 API Key 页面（或用 JWT 调 `PUT /api/api-keys/:id`）修改，或换用带该 scope 的 Key。带 `replyToMessageId` 或 `forwardAttachmentsFrom` 发信时除 `mail.send` 外还需要 `mail.read`；`GET /v1/identities` 需要 `mail.send` 或 `mailbox.read` 之一。托管域名接口查看需要 `domain.read`，添加、检测、重新接入与改 DNS 需要 `domain.write`。

## forbidden-sender

无权使用这个发件地址（HTTP 403 `forbidden`）；发件地址在托管域名上、而该域的发信尚未就绪或已停用时是 HTTP 400 `validation_failed`，也指向本节。先调 `GET /v1/identities`（JWT 用 `GET /api/identities`），从 `canSend=true` 的地址里选一个作为 `from`；共享给你的邮箱只能读，不能发信。`canSend=false` 时按 `reason` 处理：`hosted_sending_not_ready` 等托管域名发信开通，`hosted_domain_unavailable` 联系域名所有者。要用新地址发信，先认领它（`POST /v1/mailboxes`）。

## idempotency_mismatch

同一个 `Idempotency-Key` 已用于内容不同的发信（HTTP 409）。当前内容一定没有用这个 Key 发出：先确认原发送是否就是想要的那封，新内容换一个新 Key 再发送。重试时请求体要逐字段一致，包括收件人顺序与显示名。

## send_in_progress

同一个 `Idempotency-Key` 的发送正在处理或结果待确认（HTTP 409）。不要换 Key 重发；用 `GET /v1/messages?direction=outbound` 查看发送结果，稍后用同一个 Key 重试可以拿到原结果。发件记录停在 `pending` 超过 1 小时会被标为 `unknown`，之后同一个 Key 返回 201 与 `status:"unknown"`；`unknown` 的收件人可能已经收到，补发前先确认。

## source_unavailable

`replyToMessageId` 或 `forwardAttachmentsFrom` 引用的原邮件、或回复/转发接口路径里的原邮件不存在、不可见，或附件已丢失（HTTP 404）。`details.source` 指明是哪一个：`reply` 是回复的原邮件（`replyToMessageId` 或回复接口路径里的 id），`forward` 是转发的原邮件或它的附件；`replyToMessageId` 与 `forwardAttachmentsFrom` 都带时只去掉对应的那个。去掉这个字段（或改用普通发送）后可以作为新邮件发送，丢失的附件需要重新附上。回复站外邮件不用 `replyToMessageId`，改在 `headers` 里写 `In-Reply-To`/`References`。

## from_required

回复或转发没给 `from`，而缺省的发件地址——原信的收件地址——不是你能用的发件身份（HTTP 400 `from_required`），典型情况是原信在别人共享给你的邮箱里。在请求的 `from` 写自己的地址（写法同普通发送），先调 `GET /v1/identities` 从 `canSend=true` 的项里选。显式给了 `from` 但无权使用时是 403 `forbidden`，见 [forbidden-sender](#forbidden-sender)。

## delivery_failed

全部收件人都明确失败，没有任何一份投递成功（HTTP 422）：发信服务逐个拒收，或服务端在开始投递前出错。结果不明的收件人（超时、网络错误）不算失败，那种情况返回 201 与 `status:"unknown"`。`details.messageId` 是已记录的发件行（在 `direction=outbound` 列表里可见），`details.recipientOutcomes` 给出每个收件人的失败原因。这次不占当日外发配额。同一个 `Idempotency-Key` 重试会返回同样的错误；按原因修正收件人后换新 Key 重发。只有部分收件人失败时仍返回 201，结果在 `recipientOutcomes` 里，只补发 `failed` 的地址。

## recipient_suppressed

全部收件人都在本站抑制名单里（HTTP 422）：此前从同一发信域名发给他们的信被退回，或被标为垃圾邮件。什么也没有发出，没有创建发件记录，不占当日外发配额，`Idempotency-Key` 已释放，改正后可以继续用。`details.suppressed` 每项为 `{address,reason,sendingDomain,since,expiresAt}`：`reason` 为 `hard_bounce`（永久退信，地址或域名不可用）、`soft_bounce`（临时失败且重试耗尽）或 `complaint`（收件人投诉）；`expiresAt` 是自动解除时间，null 表示需管理员解除。

换用其他收件人，或等 `expiresAt` 自动解除；对方地址恢复后由管理员在抑制名单中解除（`DELETE /api/admin/suppressions/:id`，见[管理员功能](administration.md#投递回执与抑制名单)）。不要为绕过名单改用其他发信域名。只有部分收件人被抑制时照常发送其余收件人（201），被抑制的收件人在 `recipientOutcomes` 里为 `failed` 并带 `code:"recipient_suppressed"`，补发时去掉它们。各类条目的期限与部分抑制的细节见[抑制名单](mail.md#抑制名单)。

## rate_limited

请求频率或配额超限（HTTP 429）。`/v1` 的 message 区分范围：「API 调用频率超限」是这把 Key 超限，「API 调用频率超限（账户级）」是同一用户所有 Key 合计超限，「API 总调用频率超限」是全站繁忙。每日外发配额、待发送附件配额、托管域名添加与立即检测的频率限制也用这个码。按 `X-RateLimit-Reset` 或错误信息稍后重试，设总期限，不要换 Key 绕过账户级限制；`GET /v1/me` 查看速率上限与今日外发用量（`outbound.resetsAt` 是配额重置时间）。各级限额见[限流](auth-and-http.md#错误与限流)。

## key-restricted

这把 Key 限定了可用的邮箱或域名（HTTP 403 `forbidden`），请求涉及的地址、邮箱或域名不在范围内。`GET /v1/me` 的 `key.allowedMailboxIds`、`key.allowedDomains` 列出范围；只限定了邮箱的 Key 不能认领新地址。列表、等待、未读数等读取只返回范围内的邮件，不会报这个错；按 id 读取、回复或转发范围外的邮件与不可见一样返回 404。按 id 指定的邮箱或托管域名在范围外时，错误信息只带 id；别人的托管域名与不存在一样返回 404。换用覆盖该地址的 Key，或请用户在网页「API Key」页面调整范围。

## reauth_required

网页会话（JWT）的敏感操作需要在请求体里带当前登录密码 `password`（HTTP 403）：创建 API Key、新增或启用邮箱转发目标、开启或关闭两步验证。向用户索取当前密码后带上重试；不要把密码写进日志或报告。

## reauth_failed

`password` 与当前登录密码不符（HTTP 403，网页会话不会因此失效）；改密接口 `PUT /api/auth/password` 的 `oldPassword` 错误同样返回它。同一会话 15 分钟内失败 5 次后（改密与其他重新验证合计）返回 429 `rate_limited`，等窗口结束再试；计数按会话，不影响同一账户的其他会话。

## attachment_url_forbidden

URL 附件的地址不允许拉取（HTTP 400），没有发出，`details.url` 是被拒的地址（重定向时是跳转目标）。只接受公网可访问的 `https://` 地址，默认端口 443，地址里不能带账号密码；IP 字面量或域名解析结果落在内网、回环、链路本地（含云元数据 `169.254.169.254`）、CGNAT、组播、保留或文档网段时拒绝，`localhost`、`*.local`、`*.internal` 等内网主机名与本站自身的地址也拒绝。重定向的每一跳都按同样规则检查。内网或本站的文件先下载，再用 `POST /v1/uploads`（JWT 用 `POST /api/uploads`）上传后写进 `attachmentTokens`。详见[附件](attachments.md#url-附件)。

## attachment_url_fetch_failed

URL 附件拉取失败（HTTP 422），没有发出，`details.url` 是出错的地址。`message` 写明原因：DNS 解析失败或解析不到地址、连接失败、超过 15 秒未完成、对方返回非 2xx、重定向超过 3 次或没有跳转地址、内容为空、实际长度与 `Content-Length` 不符。错误信息不包含对方返回的正文。确认地址能公开访问（预签名链接未过期、不需要登录）后重试；同一个 `Idempotency-Key` 可以继续用。也可以先下载再走上传 token。

## draft_state_conflict

草稿当前的状态不允许这个操作，或 `expectedVersion` 与当前版本不同（HTTP 409），`details.draftStatus` 与 `details.draftVersion` 给出当前状态与版本。发送中（`sending`）的草稿不能修改或删除，等它结束；已发送（`sent`）的草稿不能修改，结果看 `messageId` 对应的发件记录；版本不同说明有人（网页或其他 Agent）先改过，先 `GET /drafts/:id` 读取最新内容再修改。被草稿引用的上传附件不能用 `DELETE /uploads/:token` 删除，也是这个错误码：通过修改草稿移除它。详见[草稿与定时发送](drafts.md)。

## draft_limit_reached

未发送（`sent` 以外）的草稿已达每人 100 份的上限（HTTP 409）。先发送或删除不需要的草稿（`GET /drafts?status=draft` 列出），再创建。已发送的草稿保留 7 天后自动删除，不计入上限。

## 其他错误码

| HTTP / code | 含义与处理 |
|---|---|
| 401 `unauthorized` | 凭证缺失、无效、过期、被禁用或已吊销；Key 与 JWT 不能互换 |
| 404 `not_found` | 资源不存在或不在可见范围；发件 `mailboxId` 不存在也是它 |
| 409 `address_taken` | 认领的地址已被占用，换前缀 |
| 409 `conflict` | 并发冲突或版本过期：重新读取当前状态再决定 |
| 500 `internal`、网络超时 | 读操作可有限退避重试；发信用同一个 `Idempotency-Key` 与同一请求体重试取回结果；其他变更先读回状态 |

登录、注册与两步验证相关的错误码（`bad_credentials`、`totp_required`、`totp_setup_required`、`user_disabled`、`registration_closed`、`invite_invalid`）见[鉴权与错误](auth-and-http.md#错误与限流)。
