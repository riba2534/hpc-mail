# 草稿与定时发送

## 目录

- [什么时候用草稿](#什么时候用草稿)：人审后再发、定时发送
- [接口](#接口)：创建、读取、列出、修改、删除、立即发送
- [保存草稿](#保存草稿)：字段、缺省与清空、版本保护、幂等创建
- [附件](#附件)：base64、URL 与上传 token 怎样进草稿，修改时怎样保留
- [安排定时发送](#安排定时发送)：`sendAt`、精度、取消、到点复核
- [发送](#发送)：立即发送的结果、状态变化与重试
- [状态与错误](#状态与错误)

shell 示例复用[入口指南](../skill.md)的 `hpc()`、`FROM`、`WORK`。草稿接口在 `/v1/drafts`（API Key）与 `/api/drafts`（JWT，网页用）完全相同。

## 什么时候用草稿

- **人审后再发**：Agent 写好信但需要用户确认时，创建草稿而不是直接发信。草稿出现在网页的「草稿箱」里，标着由哪把 API Key 创建；用户检查、修改后在网页点发送。不要在用户确认之前自己调用发送。
- **定时发送**：带 `sendAt` 创建（或修改）草稿，到点由服务器发出，期间可以修改或取消。
- 只是一次性发信、不需要审核或定时，直接用 `POST /messages`。

## 接口

| 方法与相对路径 | Key scope | 结果 |
|---|---|---|
| `GET /drafts?status=&cursor=&limit=` | `mail.read` 或 `mail.send` | `{items:[草稿摘要...],nextCursor}`，自己的草稿，按 id 倒序 |
| `POST /drafts` | `mail.send` | 201 草稿详情；带 `Idempotency-Key` 时同键同体重放 200 |
| `GET /drafts/:id` | `mail.read` 或 `mail.send` | 草稿详情（含正文与附件） |
| `PATCH /drafts/:id` | `mail.send` | 修改后的草稿详情 |
| `DELETE /drafts/:id` | `mail.send` | `{success:true}`，同时释放它的附件 |
| `POST /drafts/:id/send` | `mail.send` | 与 `POST /messages` 相同：201 发件摘要 / 422 / 4xx；可带 `{expectedVersion}` |

草稿内容带 `replyToMessageId` 或 `forwardAttachmentsFrom` 时，创建、修改与发送都另需 `mail.read`（同直接发信）。只能看到、操作自己的草稿，管理员也一样；别人的草稿 id 返回 404。限定了邮箱或域名范围的 Key 只能看到、操作它自己创建的草稿，发件地址与引用的来源邮件都要在范围内（否则 403，见[错误码](errors.md#key-restricted)）。

草稿摘要字段：`id,status,version,from,to,cc,bcc,subject,preview,attachmentCount,sendAt,messageId,errorDetail,createdVia,apiKeyName,createdAt,updatedAt,sentAt`；详情另有 `replyTo,text,html,headers,replyToMessageId,forwardAttachmentsFrom,attachments`。`createdVia` 为 `api` 时 `apiKeyName` 是创建它的 Key 名称。`from` 是解析后的形式：`{mailboxId}` 或 `{localPart,domain,displayName?}`。

## 保存草稿

请求体字段与[发信](mail.md#发送)相同（`from,to,cc,bcc,replyTo,subject,text,html,headers,replyToMessageId,forwardAttachmentsFrom,attachments,attachmentTokens`），另有 `sendAt` 与 `expectedVersion`。所有字段都可以暂缺：草稿可以先没有收件人、主题或正文，发送或安排定时时才按完整发信请求校验。格式与上限照常检查（畸形地址、收件人合计超过 100、正文超过 1 MiB、`contentId` 重复等返回 400）。

```bash
jq -n --arg from "$FROM" '{from:$from, to:["Bob <bob@example.net>"], subject:"合同确认", html:"<p>请确认附件</p>"}' > "$WORK/draft.json"
DRAFT=$(hpc '/drafts' -X POST -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  --data-binary @"$WORK/draft.json" | jq -er '.data.id')
# 告诉用户：草稿 #$DRAFT 已在网页「草稿箱」等你确认
```

- 创建时缺省的字段为空。修改（`PATCH`）时缺省的字段保持原值；`from`、`replyToMessageId`、`forwardAttachmentsFrom`、`sendAt` 写 `null` 表示清空。`to` 等数组写什么就替换成什么。
- 每次修改 `version` 加 1。网页和其他 Agent 可能同时在改：修改时带上读到的 `expectedVersion`，版本已变时返回 409 `draft_state_conflict`，`details.draftVersion` 是当前版本，重新读取后再改。
- 创建可以带 `Idempotency-Key`（规则同发信）：网络错误后用同一个键、同一请求体重试，得到 200 和原来那份草稿（按它当前的状态），不会多建一份；同一个键用于不同内容返回 409 `idempotency_mismatch`。键按调用方区分，Key 与网页会话互不影响。
- 每人最多 100 份未发送（`sent` 以外）的草稿，超过返回 409 `draft_limit_reached`。

## 附件

- 请求里的 `attachments`（base64 或 [URL 附件](attachments.md#url-附件)）在保存时就转存为上传附件，草稿只记它们的 token；URL 附件在保存时拉取，定时发送用的是当时拉到的内容。`attachmentTokens` 引用已经上传完成的附件。
- 草稿详情的 `attachments` 列出每个附件的 `token,filename,mimeType,size,contentId,disposition`。修改时只要给了 `attachments` 或 `attachmentTokens` 之一，附件集合就整体替换为「本次转存出的 + 本次 `attachmentTokens`」：要保留原有附件，把它们的 token 写进 `attachmentTokens`；不给这两个字段则附件不变。被替换掉的附件随即释放。
- 草稿引用的附件计入每人待发送附件的配额（20 个、100 MiB），引用期间不会按 24 小时过期；同一个附件只能放进一份草稿，不能再被直接发信引用，也不能用 `DELETE /uploads/:token` 删除（409 `draft_state_conflict`），要通过修改草稿把它移出。删除草稿或发送成功后释放。

```bash
# 加一个附件并保留已有的：先读出现有 token
TOKENS=$(hpc "/drafts/$DRAFT" | jq -c '[.data.attachments[].token]')
jq -n --argjson keep "$TOKENS" --rawfile pdf "$WORK/pdf.b64" '{attachmentTokens:$keep,
  attachments:[{filename:"report.pdf",contentType:"application/pdf",content:$pdf}]}' |
  hpc "/drafts/$DRAFT" -X PATCH -H 'Content-Type: application/json' --data-binary @- | jq '.data.attachments'
```

## 安排定时发送

```bash
# 明早 9 点（北京时间）发出；取消定时：PATCH {"sendAt":null}
jq -n '{sendAt:"2026-11-18T09:00:00+08:00"}' |
  hpc "/drafts/$DRAFT" -X PATCH -H 'Content-Type: application/json' --data-binary @- | jq '.data | {status,sendAt}'
```

- `sendAt` 用带时区的 ISO 8601（或只写日期，表示 UTC 零点），最早 1 分钟后、最晚 30 天内（按服务器时间），超出范围返回 400。创建时带 `sendAt`，或修改时设置它，草稿进入 `scheduled`。
- 安排时草稿必须已是完整的发信请求（有 `from`、收件人、主题和正文），否则 400，`message` 以「草稿还不能发送：」开头并指出缺什么。定时中的草稿仍可修改，修改后同样要保持完整；改内容不改 `sendAt` 时不再检查时间范围。
- 精度：服务器每分钟检查一次到期的草稿，到点后 1 分钟内发出（定时任务本身可能再晚几十秒）。一次最多发 20 封，积压的下一分钟继续。
- `PATCH {"sendAt":null}` 取消定时，草稿回到 `draft`；也可以随时用 `POST /drafts/:id/send` 提前发出。
- 到点复核：安排它的 API Key 已被吊销、禁用、过期或范围已不再覆盖发件地址，账户改过密码、被重置或禁用（安全状态变化）时，不会发出，草稿标为 `failed`，`errorDetail` 写明原因；确认后重新安排即可。所以 Agent 安排的定时发送不会在用户撤销 Key 之后继续发出。
- 每日外发配额在实际发送时计算，与直接发信相同；到点时配额已满，草稿标为 `failed`（`errorDetail` 说明），不会自动再试。

## 发送

`POST /drafts/:id/send` 立即发送，结果与 `POST /messages` 完全相同：

- 201：发件摘要（部分收件人失败也是 201，看 `status`、`errorDetail`、`recipientOutcomes`）。草稿变为 `sent`，`messageId` 指向这条发件记录，附件回收。
- 422 `delivery_failed`：每个收件人都被拒收，什么也没发出。草稿变为 `failed`，`messageId` 指向这次失败的发件记录，附件仍归草稿；修正收件人后可以再发送。
- 其他 4xx（内容不完整、发件人无权、配额用尽等）：没有发出，草稿保持原来的状态（定时的仍是定时），`errorDetail` 记下原因。
- 请求体可以省略；代表用户审阅后发送时带上审阅时读到的版本 `{"expectedVersion": N}`：草稿在审阅之后被改过（例如 Agent 又改了收件人）就返回 409 `draft_state_conflict`、不发送，重新读取审阅后再发。网页的发送按钮就是这样做的。
- 每份草稿只会发出一次：已发送的再调用返回 201 和原来的发件摘要；正在发送时返回 409 `send_in_progress`，稍后读取草稿看结果，不要换别的方式重发。草稿发送不用 `Idempotency-Key`。
- 发送途中服务中断时：如果发件记录已经建立（可能已外发），草稿按发件记录定为 `sent` 或 `failed`，绝不自动重发；确认没有外发的，安排过定时的会在下一分钟重试（最多 3 次），其余标 `failed` 由用户决定。

## 状态与错误

| `status` | 含义 | 能做什么 |
|---|---|---|
| `draft` | 已保存，未安排 | 修改、安排定时、发送、删除 |
| `scheduled` | 等到 `sendAt` 发出 | 修改、取消定时、提前发送、删除 |
| `sending` | 正在发送 | 只能读取，等它结束 |
| `sent` | 已执行发送，结果看 `messageId` 对应的发件记录 | 读取、删除（只删草稿，发件记录保留）；7 天后自动删除 |
| `failed` | 没有任何收件人收到（`errorDetail` 说明原因） | 修改后再发送或重新安排、删除 |

错误码见[错误码说明](errors.md)：409 `draft_state_conflict`（状态不允许或版本已变）、409 `draft_limit_reached`、409 `idempotency_mismatch`（创建）、409 `send_in_progress`（发送中）、400 `validation_failed`（不完整、时间超出范围）、以及发信本身的全部错误码。
