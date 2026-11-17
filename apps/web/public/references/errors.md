# 错误码与改正方法

失败响应统一为 HTTP 4xx/5xx 加错误信封：

```json
{ "error": { "code": "header_not_allowed", "message": "…", "fix": "…", "docs": "https://<站点>/references/errors.md#header_not_allowed", "details": { "headers": ["Message-ID"] } }, "requestId": "…" }
```

- `code` 稳定，按它分支；`message` 是给人看的中文说明，可能调整措辞。
- `fix`（可选）是可以直接照做的改正建议；`docs`（可选）指向本页对应小节。
- `details`（可选）是结构化补充：`headers` 列出出问题的邮件头；`messageId` 与 `recipientOutcomes` 出现在 `delivery_failed` 上。
- 报告问题时附上 `requestId`。

## validation_failed

请求参数不合法（HTTP 400），`message` 指出第一个出错的字段。修正后重试；同一个 `Idempotency-Key` 可以继续用。

## header_not_allowed

`headers` 里有不允许的邮件头（HTTP 400），`details.headers` 列出全部被拒的头。只允许 `X-` 开头的头与白名单头（`In-Reply-To`、`References`、`List-Unsubscribe`、`List-Unsubscribe-Post`、`List-Id` 等 `List-*`、`Precedence`、`Auto-Submitted`、`Importance`、`Priority`、`Sensitivity`、`Organization`、`Keywords`、`Comments`、`Content-Language` 等）。`Message-ID`、`Date` 等由平台生成；`From`、`To`、`Cc`、`Bcc`、`Subject`、`Reply-To` 用请求里对应的字段。头的取值不合法（换行、超长、重复、枚举值不对）时错误码是 `validation_failed`，同样带 `details.headers`。

## payload_too_large

请求或附件超过上限（HTTP 413）。base64 内联附件合计不超过 10MB；更大的文件先用 `POST /v1/uploads` 上传拿到 token，再在 `attachmentTokens` 里引用（token 附件合计不超过 50MB）。

## forbidden-scope

API Key 缺少接口要求的 scope（HTTP 403 `forbidden`）。`GET /v1/me` 查看当前 Key 的 scopes；scope 只能在网页的 API Key 页面修改。

## forbidden-sender

无权使用这个发件地址（HTTP 403 `forbidden`）。先调 `GET /v1/identities`，从 `canSend=true` 的地址里选一个作为 `from`；共享给你的邮箱只能读，不能发信。

## idempotency_mismatch

同一个 `Idempotency-Key` 已用于内容不同的发信（HTTP 409）。当前内容一定没有用这个 Key 发出：换一个新 Key 再发送。

## send_in_progress

同一个 `Idempotency-Key` 的发送正在处理或结果待确认（HTTP 409）。不要换 Key 重发；用 `GET /v1/messages?direction=outbound` 查看发送结果，稍后用同一个 Key 重试可以拿到原结果。

## source_unavailable

`replyToMessageId` 或 `forwardAttachmentsFrom` 引用的原邮件不存在、不可见，或附件已丢失（HTTP 404）。去掉这个字段后可以作为新邮件发送。

## delivery_failed

全部收件人都被明确拒收，没有任何一份投递成功（HTTP 422）。`details.messageId` 是已记录的发件行，`details.recipientOutcomes` 给出每个收件人的失败原因。同一个 `Idempotency-Key` 重试会返回同样的错误；修正后换新 Key 重发。只有部分收件人失败时仍返回 201，结果在 `recipientOutcomes` 里。

## rate_limited

请求频率或每日外发配额超限（HTTP 429）。按 `X-RateLimit-Reset` 稍后重试；`GET /v1/me` 查看速率上限与今日外发用量。
