# 个人通知与邮箱转发

网页会话（JWT `/api/me/notify-prefs`）可管理全部四类配置；API Key 用 `/v1/notify-prefs` 读写飞书、PushDeer、通用 Webhook，**邮箱转发目标只能网页会话修改**（配置后所有来信都会外发）。所有 shell 请求复用 [入口指南](../skill.md) 的函数，设 `API` 与 `AUTH` 为对应鉴权。配置测试、手动重试和新增转发目标可能向外部服务/邮箱发送数据，按用户已授权的任务执行；仅查询设置/健康不包含测试授权。要按事件类型、地址或域名订阅收信、发信结果和托管域名状态，用 [Webhook v2](webhooks.md)，比这里的通用 Webhook 更完整。

| 方法与 `/api` 路径 | 请求/结果 |
|---|---|
| `GET /me/notify-prefs` | 当前用户四类偏好，secret/PushKey 掩码，另附 `forwardPending`（等待确认的转发目标） |
| `PUT /me/notify-prefs` | 至少一个完整通道对象；仅替换提供的通道，其余保留；新增转发目标或打开转发时带 `password`；返回掩码偏好与 `forwardPending` |
| `POST /forward-confirmations/confirm` | 公开；`{token}`（确认信里的链接）→ `{address}`；无效或过期 404 |
| `POST /me/notify-prefs/feishu-test` | 无正文；使用**已保存**个人飞书配置发送测试，成功 `{ok:true}` |
| `POST /me/notify-prefs/pushdeer-test` | 无正文；使用已保存 PushDeer 配置发送测试，成功 `{ok:true}` |
| `GET /me/notify-prefs/health` | 最近投递状态、待处理/失败数量、转发配额，无密钥/正文 |
| `POST /me/notify-prefs/jobs/:id/retry` | 无正文；符合条件时 `{ok:true}`，表示排队而不是已送达 |

API Key 版本（路径相对 `/v1`，`AUTH` 为 Key）：

| 方法与路径 | scope | 请求/结果 |
|---|---|---|
| `GET /notify-prefs` | `notify.read` | 与上面 GET 相同（掩码，`forward` 只读） |
| `PUT /notify-prefs` | `notify.write` + `mail.read` | 只能带 `feishu`/`pushdeer`/`webhook`；带 `forward` 返回 403。这些通道会推送来信主题、验证码与正文摘要，所以另需 `mail.read`；管理员的个人配置也作用于未认领地址的来信，管理员账户的 Key 还需带 `admin` scope，否则 403 |
| `POST /notify-prefs/feishu-test`、`/pushdeer-test` | `notify.write` | 同上，用已保存配置真实发送 |
| `GET /notify-prefs/health` | `notify.read` | 同上 |
| `POST /notify-prefs/jobs/:id/retry` | `notify.write` | 同上 |

限定了邮箱或域名的 Key 只能 GET 偏好，修改、测试、健康与重试返回 403（这些配置作用于账户的全部来信）。

没有 webhook-test 或 forward-test 接口（Webhook v2 端点有自己的测试接口）。修改偏好本身不补发历史邮件、不对所有旧邮件执行通知，也不改其他用户偏好。普通用户的通知/转发只作用于自己认领地址在收信时的新邮件；管理员个人配置还作用于收信时未认领地址与相应系统通知。共享 grantee 不因共享自动获得推送。

## 四类配置

```json
{
  "feishu":{"enabled":false,"webhookUrl":"","secret":"","contentLevel":"summary"},
  "pushdeer":{"enabled":false,"endpoint":"","pushkey":""},
  "webhook":{"enabled":false,"url":"","secret":""},
  "forward":{"enabled":false,"addresses":[]}
}
```

PUT 可只带其中一个通道，通道对象不能只带任意叶子补丁；先 GET 并构造完整新对象（去掉响应里的 `forwardPending`）。`enabled` 必填；`forward.addresses` 必填，是期望的完整目标列表，最多 5 个完整邮箱。`feishu.contentLevel` 为 `code_only|summary|full`，默认 summary。以下例子仅更改飞书内容等级并保留其他已存字段：

```bash
CURRENT_PREFS=$(hpc '/me/notify-prefs')
jq '{feishu:(.data.feishu + {contentLevel:"code_only"})}' <<< "$CURRENT_PREFS" |
  hpc '/me/notify-prefs' -X PUT -H 'Content-Type: application/json' --data-binary @-
```

掩码 `"******"` 表示保留已存密钥，`""` 表示清除，不是“空值不更新”。省略整个通道才保留全部配置；secret 默认为空，因此提交不含 secret 的完整通道可能清掉旧密钥。读取后修改一项时保留掩码值，只有用户要求清除时才明确传空。secret、pushkey 最多 128 字符，不在报告中回显真实值。

- **飞书**：HTTPS 飞书/Lark 自定义机器人 URL（服务器检查平台 host 与 hook 路径），可带机器人签名 secret。`code_only` 推送元信息与提取到的验证码，不含正文；没有提取码的邮件仍可通知。summary 正文最多 200 字符，full 最多约 4000 字符，并非原始 `.eml` 传输。测试会发送外部卡片，测试成功需平台 HTTP 与业务 code 均成功。
- **PushDeer**：官方 `https://api2.pushdeer.com` 或自建实例端点及有效 PushKey；启用时需非空 PushKey。端点空串回落官方，当前服务接受 HTTP 或 HTTPS 的公网 origin、拒绝常见内网 host；建议 HTTPS。服务只取 URL 的 origin，路径/query/URL 用户密码不作为 PushDeer 认证配置；实际请求为该 origin 的 `/message/push`，认证用 pushkey。用掩码沿用已存 PushKey 时，端点的 origin 与路径必须与已保存的一致（末尾斜杠视为相同，空串视为官方端点），否则返回 400 `validation_failed`，需要重新填写 PushKey。
- **通用 Webhook**：HTTPS 公网接收端，不能内网或 URL 用户密码。固定 HPC Mail 事件格式，Bark/ntfy 等需自建适配，不能宣称其原生接口直接兼容。
- **邮箱转发**：最多 5 个目标，启用时至少一个（已确认或等待确认）。**新目标要目标邮箱确认后才生效**：`forward.addresses` 里新出现的地址不会立即写入，而是向它发一封确认信（`no-reply@系统域名` 发出，72 小时有效），出现在 `forwardPending`；目标邮箱的主人打开信里的链接点确认后才加入 `forward.addresses` 并开始转发。已确认的地址保留，列表里去掉的待确认地址撤销确认；同一地址在有效期内重复保存不重发。每个用户每天最多发 20 封确认信（429）。新增目标或把转发从关改为开时，请求体要带当前密码 `password`（403 `reauth_required`/`reauth_failed`）；关闭转发、删除目标不需要。升级前已配置的目标视为已确认。Cloudflare 已验证 destination 可以原样 forward；未验证目标会用收件域 `no-reply@domain` 中转重发（带 `Auto-Submitted: auto-forwarded`，Reply-To 指回原发件人），邮件呈现/附件可能不同；不是保证保留全部原始 MIME。中转重发另受管理员设置的全站与每位归属人每日上限约束（未认领地址的来信共用一个全站额度），超限时该次转发跳过；归属人账户停用后不再转发。配置中目标仍应是用户授权的地址。外发大附件可能变下载链接，详见附件参考。

## Webhook 接收契约

新邮件时 `POST`，`Content-Type: application/json`，结构如下（值为示例）：

```json
{"event":"mail.received","message":{"id":123,"address":"box@example.org","fromAddress":"sender@example.net","fromName":"Sender","subject":"验证码","verificationCode":"123456","verificationLink":"","preview":"摘要","createdAt":"2026-10-05T00:00:00.000Z"}}
```

`verificationLink` 是收件时识别出的验证/登录链接，没有则为空串；接收端应忽略未知字段。链接来自不可信邮件内容，接收端自动访问前须核对域名。

配置非空 secret 时：`X-HPC-Signature = Base64(HMAC-SHA256(UTF8(secret), 原始 JSON request-body 字节))`。不是 `sha256=hex`，不是重序列化 JSON 后签名；接收端先保存原始 body，以同一 UTF-8 密钥计算并恒定时间比较。过渡期同时带 Svix 兼容的 `webhook-id`（`msg_<邮件 id>`）、`webhook-timestamp`、`webhook-signature`，算法同 [Webhook v2](webhooks.md#签名与校验)，只是这里的密钥按 UTF-8 字节使用（以 `whsec_` 开头的按 Base64 解码）；`X-HPC-Signature` 会在过渡期后移除，新接收端按 Svix 头校验。未配 secret 就不带签名头。payload 没有全文、Token，不应凭空要求不存在字段；可按 `webhook-id` 或 `event/message.id/address` 去重。Webhook 发送约 10 秒超时，不自动重试；需要重试、事件过滤或发信结果推送时改用 [Webhook v2](webhooks.md)。若用户要求集成接收端，也需相应系统的授权。

## 健康、重试与转发配额

`health.data.channels` 四个通道，每项 `channel,enabled,latest,pendingCount,failedCount`；latest 可为 null，非 null 为：

```text
id, messageId (测试为 null), target, status,
attempts, maxAttempts, lastError, lastHttpStatus,
createdAt, updatedAt, nextAttemptAt, lastAttemptAt
```

status 为 `pending|processing|succeeded|failed|skipped|unknown`。pending/processing 是待处理；succeeded 是本通道已确认成功；skipped 常为当前策略/配置导致不发送；unknown 是处理超时或副作用结果待确认，不能当作已失败。`pendingCount` 包括 processing，`failedCount` 包括 unknown。健康仅提供各通道最近一次与汇总，不是所有 job 的分页查询接口；测试结果也会记录。

中转转发（`no-reply@收件域名` 重发）交给 Cloudflare 后记为 `succeeded`；收件域名有投递回执订阅时，若之后在 Cloudflare 侧最终退信、失败或被拒，该 forward 任务会改为 `failed`，`lastError` 为「Cloudflare 侧最终投递失败：<SMTP 应答或原因>」，`forward` 通道的 `latest` 与 `failedCount` 随之体现。回执通常在几秒到几分钟内到达，刚显示 `succeeded` 的中转转发之后仍可能变为 `failed`。原样 forward（已验证 destination）没有这类回执，`succeeded` 只表示已交给 Cloudflare。

飞书/PushDeer 每条最多 3 次自动尝试，失败退避；Webhook 默认 1 次且不自动重试，避免不支持幂等的接收端重复执行。队列/通知失败不回滚已成功收件。新 IP 登录告警按个人飞书/PushDeer 配置发送，是系统事件，并非所有渠道同样适用。

手动 retry 必须是当前用户 job、通道当前 enabled、status 为 failed 或 unknown、messageId 非 null，且 channel 不是 forward。unknown 先核对接收端是否已收到，用户确认需重试时才提交，可能重复通知；已成功/处理中 retry 会拒绝。测试行应调用对应测试接口，forward 应核对收件情况后按用户要求手工转发原邮件，不能 job retry 自动重发。返回 ok 后重新查 health 确认真实投递结果；源邮件已被永久删除时不再推送，任务转为 skipped。邮件永久删除时其通知任务的内容一并清空，已成功或跳过的任务也不保留推送内容。终结通知记录约 30 天后清理。

`health.data.forward` 为 `domainLimit,targetLimit,windowEndsAt,targets:[{address,attempts,remaining}],domains:[{domain,attempts,remaining}]`。当前单收件域 500 次/日、单转发目标 200 次/日，按 UTC 日结算；这是实例共用的尝试计数，其他用户同一目标/域也会占用，不是仅本用户额度，失败尝试也可能消耗。以实时 remaining 与窗口时间为准，不靠改用户/Key/目标规避限额。超限或失败不意味着原邮件没有保存在邮箱，应读取原邮件并报告转发情况。
