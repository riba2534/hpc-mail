# Webhook v2：事件推送

## 目录

- [什么时候用](#什么时候用)：替代轮询；与旧版通用 Webhook 的区别
- [管理端点](#管理端点)：接口、过滤、限定范围的 Key
- [事件与载荷](#事件与载荷)：六种事件的 `data`
- [签名与校验](#签名与校验)：Svix 兼容的三个请求头
- [重试、停用与测试](#重试停用与测试)：退避、自动停用、手动重试

## 什么时候用

要在收到新邮件、发信有结果或托管域名状态变化时立即处理，就给自己的 HTTPS 接收端建一个端点，不要高频轮询列表或详情。等某一封验证码这种一次性场景仍可用 `GET /v1/messages/wait`。

网页会话用 `/api/webhooks`（JWT），API Key 用 `/v1/webhooks`（需要 `webhook.write`；创建或修改订阅 `mail.received`、或带正文的端点另需 `mail.read`），两者同形。每个用户最多 10 个端点。个人通知里的「通用 Webhook」是旧版单端点推送，只推新邮件、不重试，过渡期继续可用（见[个人通知](notifications.md#webhook-接收契约)）；新的集成用这里的端点。

## 管理端点

| 方法与路径 | 请求/结果 |
|---|---|
| `GET /webhooks` | 端点数组（不含密钥） |
| `POST /webhooks` | `{url,events,description?,addresses?,domains?,includeBody?}` → 201，带一次性 `secret` |
| `GET /webhooks/:id` | 端点 |
| `PUT /webhooks/:id` | 只改提供的字段；列表整体替换；`enabled:true` 重新启用、`false` 手动停用 |
| `DELETE /webhooks/:id` | 删除端点及其投递记录，`{success:true}` |
| `POST /webhooks/:id/rotate-secret` | 换新密钥立即生效，返回带新 `secret` 的端点 |
| `POST /webhooks/:id/test` | 同步发一条 `webhook.test` 事件 → `{ok,httpStatus,error,durationMs}` |
| `GET /webhooks/:id/deliveries?cursor=&limit=` | 最近投递（新到旧），`{items,nextCursor}` |
| `POST /webhooks/:id/deliveries/:deliveryId/retry` | 重试一条失败的投递 |

```bash
# API="$BASE/v1"，AUTH 为带 webhook.write 与 mail.read 的 Key；HPC_HOOK_URL、HPC_BOX 由用户提供
# 返回的 secret 只出现这一次，保存到接收端的配置里，不要写进报告
jq -n --arg url "$HPC_HOOK_URL" --arg box "$HPC_BOX" \
  '{url:$url,events:["mail.received"],addresses:[$box],description:"agent"}' |
  hpc '/webhooks' -X POST -H 'Content-Type: application/json' --data-binary @- | jq '.data | {id,secretPrefix}'
```

- `url` 必须是公网 HTTPS：内网、保留、链路本地与云元数据地址，带用户名密码的 URL，以及本站自己的主机与系统域名都会 400。
- `events` 至少一个，取值见下节。
- `addresses` 与 `domains` 是「或」关系的过滤：事件涉及的地址在 `addresses` 里，或地址的域名在 `domains` 里才投递；两者都空表示订阅类型的全部事件。托管域名事件只看 `domains`。
- `includeBody:true` 时 `mail.received` 带正文 `text`、`html`（各截断到 65536 字符，`bodyTruncated` 标出），否则只有摘要。
- 限定了邮箱或域名的 Key 只能创建、查看、管理过滤条件非空且全部落在自己范围内的端点（范围外的端点 404，超出范围的过滤 403）。
- 端点能收到的来信跟随最近一次写入它的凭据：网页会话与带 `admin` scope 的管理员 Key 写入的管理员端点也收未认领地址的来信；没有 `admin` scope 的管理员 Key 创建或修改过的端点只收自己认领地址的来信。
- 所属用户被停用后不再产生新投递，待重试的投递也不再发送。
- 修改 `url` 或 `events`（与原值不同）时，该端点未成功的投递（等待中、重试中与失败的）一并作废、清空载荷，不会发往新地址，也不能再手动重试。

## 事件与载荷

请求体统一为 `{"id":"evt_…","type":"<类型>","timestamp":"<ISO>","data":{…}}`，接收端应忽略未知字段与未订阅的类型。

| 类型 | 何时发生，发给谁 | `data` |
|---|---|---|
| `mail.received` | 收到新邮件：地址的认领人；收信时未认领的地址发给启用中的管理员 | `message`：`id,direction,address,domain,fromAddress,fromName,subject,preview,verificationCode,verificationLink,recipients{to,cc},replyTo,attachments[{id,filename,mimeType,size,inline}],createdAt`，`includeBody` 时另有 `text,html,bodyTruncated` |
| `mail.sent` | 发信至少一个收件人成功（`sent` 或站内 `delivered`）：发件人 | `message`：`id,direction,address,domain,fromName,subject,status,errorDetail,recipientOutcomes,recipients{to,cc,bcc},createdAt` |
| `mail.failed` | 发信全部收件人失败：发件人 | 同 `mail.sent`，`status:"failed"` |
| `hosted_domain.activated` | 托管域名可以收信（NS 生效，收件路由与 catch-all 就绪）：域名所有者 | `hostedDomain`：`id,domain,status,zoneStatus,receivingReady,sendingReady` |
| `hosted_domain.sending_ready` | 托管域名发信就绪：所有者 | 同上 |
| `hosted_domain.moved` | 名称服务器不再指向本站或 zone 已不存在：所有者 | 同上 |

`verificationCode`、`verificationLink` 与列表口径一致；链接来自不可信邮件内容，自动访问前核对域名。共享邮箱的成员收不到所有者邮箱的事件。拿到 `mail.received` 后需要附件内容时，用 `GET /v1/messages/{id}/attachments/{attId}` 下载。

## 签名与校验

每个请求带 Svix 兼容的三个头，标准的 Svix 校验库可以直接用：

- `webhook-id`：事件 id（同一事件的所有重试不变），接收端按它去重；
- `webhook-timestamp`：发送时的 Unix 秒，拒绝与当前时间相差超过 5 分钟的请求以防重放；
- `webhook-signature`：`v1,` 加 Base64(HMAC-SHA256(key, `<webhook-id>.<webhook-timestamp>.<原始请求体>`))，`key` 是密钥去掉 `whsec_` 前缀后 Base64 解码的字节。

用原始请求体字节计算，不要重新序列化 JSON，用恒定时间比较。轮换密钥后新密钥立即生效。

## 重试、停用与测试

2xx（10 秒内）算成功；3xx 不跟随，按失败处理。失败按约 1 分钟、5 分钟、30 分钟、2 小时、5 小时、10 小时、10 小时的间隔重试，共 8 次，跨度约一天半；接收端在处理完成后再返回 2xx，重复投递按 `webhook-id` 去重。第 8 次仍失败、且这个事件产生以来端点一次都没成功过时，端点自动停用：`status:"disabled"`，`disabledReason` 说明原因，并通过所有者已配置的飞书或 PushDeer 告知。修好接收端后 `PUT {enabled:true}` 重新启用，再对需要的投递调用 retry（只发一次，同一 `webhook-id`）；停用期间产生的事件不会补发。

`POST /webhooks/:id/test` 同步发一条签好名的 `webhook.test` 事件并返回对方响应，对方失败时也是 HTTP 200、`ok:false`；它不计入投递记录，停用的端点也能测试。终态投递记录保留约 30 天，成功后不再保存载荷。邮件永久删除（含保留期清理、释放并清空历史）时，它的未完成与失败投递随之作废、载荷清空；源邮件已删除（含回收站）的投递不能手动重试（409）。
