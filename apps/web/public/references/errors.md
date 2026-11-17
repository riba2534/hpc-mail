# 错误码与改正方法

失败响应统一为 HTTP 4xx/5xx 加错误信封：

```json
{ "error": { "code": "header_not_allowed", "message": "…", "fix": "…", "docs": "https://<站点>/references/errors.md#header_not_allowed", "details": { "headers": ["Message-ID"] } }, "requestId": "…" }
```

- `code` 稳定，按它分支；`message` 是给人看的中文说明，可能调整措辞。
- `fix`（可选）是可以直接照做的改正建议；`docs`（可选）指向本页对应小节，按请求的站点补成绝对 URL。
- `details`（可选）是结构化补充：`headers` 列出出问题的邮件头；`messageId` 与 `recipientOutcomes` 出现在 `delivery_failed` 上。
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

API Key 缺少接口要求的 scope（HTTP 403 `forbidden`），`fix` 写明缺哪个。`GET /v1/me` 查看当前 Key 的 scopes；Key 不能给自己加 scope，要由用户在网页的 API Key 页面（或用 JWT 调 `PUT /api/api-keys/:id`）修改，或换用带该 scope 的 Key。带 `replyToMessageId` 或 `forwardAttachmentsFrom` 发信时除 `mail.send` 外还需要 `mail.read`；`GET /v1/identities` 需要 `mail.send` 或 `mailbox.read` 之一。

## forbidden-sender

无权使用这个发件地址（HTTP 403 `forbidden`）；发件地址在托管域名上、而该域的发信尚未就绪或已停用时是 HTTP 400 `validation_failed`，也指向本节。先调 `GET /v1/identities`（JWT 用 `GET /api/identities`），从 `canSend=true` 的地址里选一个作为 `from`；共享给你的邮箱只能读，不能发信。`canSend=false` 时按 `reason` 处理：`hosted_sending_not_ready` 等托管域名发信开通，`hosted_domain_unavailable` 联系域名所有者。要用新地址发信，先认领它（`POST /v1/mailboxes`）。

## idempotency_mismatch

同一个 `Idempotency-Key` 已用于内容不同的发信（HTTP 409）。当前内容一定没有用这个 Key 发出：先确认原发送是否就是想要的那封，新内容换一个新 Key 再发送。重试时请求体要逐字段一致，包括收件人顺序与显示名。

## send_in_progress

同一个 `Idempotency-Key` 的发送正在处理或结果待确认（HTTP 409）。不要换 Key 重发；用 `GET /v1/messages?direction=outbound` 查看发送结果，稍后用同一个 Key 重试可以拿到原结果。发件记录停在 `pending` 超过 1 小时会被标为 `unknown`，之后同一个 Key 返回 201 与 `status:"unknown"`；`unknown` 的收件人可能已经收到，补发前先确认。

## source_unavailable

`replyToMessageId` 或 `forwardAttachmentsFrom` 引用的原邮件不存在、不可见，或附件已丢失（HTTP 404）。`details.source` 指明是哪一个：`reply` 是 `replyToMessageId`，`forward` 是 `forwardAttachmentsFrom` 或它的附件；两个字段都带时只去掉对应的那个。去掉这个字段后可以作为新邮件发送，丢失的附件需要重新附上。回复站外邮件不用 `replyToMessageId`，改在 `headers` 里写 `In-Reply-To`/`References`。

## delivery_failed

全部收件人都被明确拒收，没有任何一份投递成功（HTTP 422）。`details.messageId` 是已记录的发件行（在 `direction=outbound` 列表里可见），`details.recipientOutcomes` 给出每个收件人的失败原因。这次不占当日外发配额。同一个 `Idempotency-Key` 重试会返回同样的错误；按原因修正收件人后换新 Key 重发。只有部分收件人失败时仍返回 201，结果在 `recipientOutcomes` 里，只补发 `failed` 的地址。

## rate_limited

请求频率或每日外发配额超限（HTTP 429）。按 `X-RateLimit-Reset` 或错误信息稍后重试，设总期限，不要换 Key 绕过账户级限制；`GET /v1/me` 查看速率上限与今日外发用量（`outbound.resetsAt` 是配额重置时间）。

## 其他错误码

| HTTP / code | 含义与处理 |
|---|---|
| 401 `unauthorized` | 凭证缺失、无效、过期、被禁用或已吊销；Key 与 JWT 不能互换 |
| 404 `not_found` | 资源不存在或不在可见范围；发件 `mailboxId` 不存在也是它 |
| 409 `address_taken` | 认领的地址已被占用，换前缀 |
| 409 `conflict` | 并发冲突或版本过期：重新读取当前状态再决定 |
| 500 `internal` | 服务端错误。发信时用同一个 `Idempotency-Key` 与同一请求体重试取回结果（可能继续发送，也可能得到 422 `delivery_failed`）；其他变更先读回状态 |

登录、注册与两步验证相关的错误码（`bad_credentials`、`totp_required`、`totp_setup_required`、`user_disabled`、`registration_closed`、`invite_invalid`）见[鉴权与错误](auth-and-http.md#错误与限流)。
