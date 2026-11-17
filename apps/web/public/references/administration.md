# 管理员功能

## 目录

- [用户与邮件审阅](#用户与邮件审阅)：用户管理、审阅他人邮件
- [用户专属邮箱权限](#用户专属邮箱权限)：按用户限定可认领域名与额度
- [强制过户邮箱](#强制过户邮箱)：把邮箱连同历史转给另一个用户
- [邀请码](#邀请码)
- [系统设置与域名](#系统设置与域名)：设置项、外发与中转配额、系统域名
- [投递回执与抑制名单](#投递回执与抑制名单)：回执订阅状态、抑制名单的查看与解除
- [Key 与管理审计](#key-与管理审计)

所有 `/api/admin/*` 必须有效 **管理员 JWT**，API Key 的五个 scopes 不提供这些权限。调用先 `GET /api/auth/me` 核对当前角色；没有管理员权限时报告限制，不换身份、猜测他人 ID 或通过 `/v1` 规避。shell 示例复用 [入口指南](../skill.md)，设 `API="$BASE/api"`、`AUTH` 为管理员 JWT。

## 用户与邮件审阅

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/users` | 全部用户数组 |
| `GET /admin/users/search?q=…&excludeUserId=…&limit=20` | 按用户名搜索启用中的用户，忽略大小写；可排除当前主人；limit 1–20，默认 20；返回 `{items:[{id,username,role}],hasMore}` |
| `POST /admin/users` | `{username,password,role?}`，role 默认 user，可 admin；201 新用户，不自动认领邮箱 |
| `PUT /admin/users/:id` | 至少一个 `status:active\|disabled`、`role:user\|admin`、`password`（重置密码）、`mailboxPolicy`（邮箱权限）；修改邮箱权限需带 `expectedMailboxPolicyRevision`；返回更新后的用户 |
| `DELETE /admin/users/:id` | `{success:true}`，不可恢复；账户与其邮箱/共享/Key/星标关联撤销，邮件历史仍按地址保留 |

用户含 `id,username,role,status,mailboxCount,mailboxes,mailboxPolicy,mailboxPolicyRevision,apiKeyCount,createdAt,lastLoginAt,avatarUrl`。建户/重置密码约束见鉴权参考。不能禁用或删除自己；不能移除最后一个启用中的管理员。禁用/重置密码撤销旧会话，禁用期间 Key 也被拒绝；重置密码还会吊销该用户全部 API Key 并记管理审计，用户需重新创建 Key。角色变化保留已有共享，存量邮箱仍存在，新认领/发件按当前角色校验。

## 用户专属邮箱权限

管理员在网页「用户管理 → 更多操作 → 邮箱权限」切换公共/专属配置。API 先 `GET /api/admin/users` 读取目标用户的 `mailboxPolicyRevision`，再更新：

```json
{
  "expectedMailboxPolicyRevision": 0,
  "mailboxPolicy": {
    "perUserLimit": 10,
    "domains": [
      {"domain": "a.example", "perUserLimit": 3},
      {"domain": "b.example", "perUserLimit": 7}
    ]
  }
}
```

`mailboxPolicy` 非空时完整替代公共域名范围、总数量和每域数量配置，不与公共域名取并集，也不取公共额度的较小值。可授权非公开域名，但域名必须已存在于系统配置。额度均为 0–10000 整数，0 表示不限；空 `domains` 表示不能新增认领邮箱。系统保留前缀仍对普通用户生效；管理员始终豁免。公共配置改变不覆盖专属配置，系统移除域名后该域名不能继续新增认领。

恢复公共配置提交 `{"mailboxPolicy":null,"expectedMailboxPolicyRevision":当前版本}`。保存和角色变更都会增加 `mailboxPolicyRevision`；409 时重新读取并核对当前配置，不能仅换版本强行覆盖陈旧草稿。普通用户不能修改自己的权限，API Key 也不能调用管理接口。认领与过户在写入时复核目标权限版本、域名版本和数量，避免并发突破限制。

权限收紧、删除域名授权或恢复公共配置不会释放已有邮箱、删除邮件或撤销已有邮箱的收发能力；所有名下邮箱继续计入总额度，超额时不能新增。只读共享邮箱不计入认领额度。专属权限只作用于邮箱认领与新增过户，不替代每日外发、翻译、注册、2FA 等系统规则。用户应从自己的 `/api/domains` 或 `/v1/domains` 查询可认领域名，公开 `/api/config` 不包含个人权限。

## 强制过户邮箱

管理员 JWT 可 `POST /api/admin/mailboxes/:id/transfer`，将任意现有已认领邮箱直接转给指定的启用中用户（普通用户或管理员）。自己或别人认领的均可；此操作不经过未认领状态。目标普通用户有专属邮箱权限时，域名范围、系统保留前缀、总数和单域名数量必须符合其权限，超出时先调整配置。目标用户使用公共配置或为管理员时，保留原有强制过户豁免。它不创建尚未存在的邮箱。

先读 `GET /api/mailboxes?all=1`（已知邮箱 ID 时用 `GET /api/admin/mailboxes/:id`，不存在返回 404）核对邮箱 `id,address,userId`，再用 `GET /api/admin/users/search?q=用户名&excludeUserId=当前主人ID` 查找目标用户。q 为 1–32 字符的用户名片段，完全匹配优先，其次前缀和其他包含匹配；hasMore=true 时继续补充用户名缩小范围。body 为 `{userId:目标用户ID,expectedOwnerId:列表中的当前主人ID}`，两者必须是正整数。

```bash
# API="$BASE/api"，AUTH 为管理员 JWT；三个 ID 均来自上面的实际查询
jq -n --argjson userId "$HPC_TARGET_USER_ID" --argjson ownerId "$HPC_CURRENT_OWNER_ID" \
  '{userId:$userId,expectedOwnerId:$ownerId}' |
  hpc "/admin/mailboxes/$HPC_MAILBOX_ID/transfer" -X POST \
    -H 'Content-Type: application/json' --data-binary @-
```

返回 `data:{mailbox,previousUserId,transferred,revokedShares}`。保留邮箱 ID、地址、显示名、原创建时间及全部历史收发邮件、回收站和附件；新主人取得完整邮箱权限，原主人失去普通所属权限。**旧共享全部撤销**，过户后不自动恢复；新收到的邮件使用新主人的个人通知/转发配置。以前收件的通知快照和任务保持原归属，不重新推送历史邮件。

所有权变更、共享撤销和 `mailbox.transfer` 管理审计在同一事务内提交。主人已改变时返回 409 `conflict`，需重新读取并确认新状态，不能自动改 expectedOwnerId 强行覆盖。超时后的相同请求若目标已经是主人，返回 `transferred:false,revokedShares:0`，不重复记审计，也不清除新主人后来建立的共享。不存在邮箱/用户返回 404；禁用用户返回 400，不能把过户成功解读为替目标启用账号或修改密码。

删除用户 **不删邮件**，邮箱变为未认领、历史可能由下一位 owner 继承。用户要求账户及邮件一起删除时，先核对并按授权清理该用户各邮箱历史（释放时 `deleteHistory=1`），再删账户；不能把单个 deleteUser 的成功报告成历史已全部消除。外发大附件独立保留链接的边界见附件参考。

邮件审阅不是另一个 admin/messages 路径：

```bash
# 只读查看目标用户名下邮件，不包含该用户获共享的其他邮箱
hpc '/messages' --get --data-urlencode 'scope=user' \
  --data-urlencode "userId=$HPC_TARGET_USER_ID" --data-urlencode 'limit=30'
# 查看所有未认领地址邮件
hpc '/messages' --get --data-urlencode 'scope=unclaimed' --data-urlencode 'direction=inbound'
```

详情/线程/raw 同样带 scope 与 userId，管理员审阅其他用户为只读，所有邮件状态变更（含星标）仅支持 `mine/unclaimed`。未认领邮件修改需显式 `scope=unclaimed`；默认列表只自己的认领邮箱。要查看某个已认领邮箱自己的收件或发件，用 `scope=user&userId=<归属人>&address=<完整地址>`，再以 `direction=inbound|outbound` 区分。全站地址管理用 `GET /mailboxes?all=1`，编辑/释放对应 `/mailboxes/:id`；管理员共享管理可处理**全站任意已认领邮箱**，成员可为启用中的普通用户或管理员。域名与共享完整契约见 [邮箱、多域名参考](mailboxes-and-domains.md)。

## 邀请码

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/invites` | 邀请码数组，含使用者溯源 |
| `POST /admin/invites` | `{count?,maxUses?,expiresAt?,note?}`，201 返回新生成的邀请码数组 |
| `DELETE /admin/invites/:id` | 撤销该邀请码；`{success:true}`，不删除已经注册用户 |

count 1–50 默认 1；maxUses 1–1000 默认 1；expiresAt 可选 ISO 8601 时间；note 最多 128 字符默认空。返回 `id,code,maxUses,usedCount,expiresAt,note,createdAt,status,usedBy`；status 为 `usable|exhausted|expired|revoked`。注册模式为 invite 时用 `/api/auth/register` 的 inviteCode；生成邀请码不自动改注册模式，也不自动发送给第三方。

## 系统设置与域名

`GET /admin/settings` 返回下面配置，`PUT /admin/settings` 至少提供一个完整配置块或 register_mode；仅修改给出的项。不要把整个旧快照提交回去覆盖并发改动。

| 配置字段 | 结构与边界 |
|---|---|
| `register_mode` | `closed\|invite\|open`；决定注册开放性，不影响已有账户 |
| `code_extract` | `{enabled,aiEnabled}`；两布尔，控制验证码提取；aiEnabled 用 `ai_model` 兜底，未配置模型时只走正则；不能因此证明提取码绝对正确 |
| `site` | `{title}`，1–64 字符 |
| `api` | `{enabled}`；控制 `/v1` 开放 API，不关闭 JWT 网页管理 |
| `security` | `{require2fa}`；强制尚未绑定的 JWT 用户完成 2FA 后使用业务接口 |
| `domains` | `{list:[{domain,public,perUserLimit,random?}],revision?}`；`random:false` 的域不参与随机后缀；更新必须顶层 `expectedDomainsRevision`，见域名参考 |
| `mailbox_policy` | `{perUserLimit,reservedLocalParts}`；总认领上限 0–10000，0 不限；保留前缀最多 200 项，每项 ≤64 字符；普通用户生效，admin 豁免 |
| `claim_random` | `{paidSuspendedLimit,pendingDays,suspendedPercent,dailyLimit}`；Claude 0 封号随机后缀规则。任意历史封号记录都排除，不受账号数或付费状态影响；paidSuspendedLimit（0–1000，默认 2）和 suspendedPercent（0–100，默认 50）已弃用，仅兼容解析与存储，设为 0 也不能放行封号域名；pendingDays（0–90，默认 7，0 不计）天内认领、还没收到 Claude 来信的邮箱计入后缀负载；近 24 小时新增达到 dailyLimit（0–1000，默认 3，0 不限）的后缀当天不再分配。更新时提交完整对象，缺省字段按默认值处理 |
| `quota` | `{dailyOutbound,dailyRecipients,relayDaily,relayPerUserDaily}`；普通用户每日外发邮件数 0–100000、唯一收件地址数 0–1000000，跨 Key/JWT 共用，admin 豁免（用户可用 `/v1/me` 查看自己的用量）；`relayDaily`/`relayPerUserDaily`（0–100000，默认 300/50）是邮箱转发经 `no-reply@收件域名` 中转重发的全站与每位归属人每日上限，含管理员，原生转发不计入，超限的转发记为跳过。0 均为不限 |
| `retention` | `{unclaimedDays,allMessagesDays}`；0–3650 天，0 关闭该项定时清理 |
| `ai_model` | `{baseUrl,apiKey,model}`；全站唯一的 AI 模型（OpenAI 兼容 Chat Completions），翻译与验证码 AI 兜底共用；三项都非空才算已配置。baseUrl 为 https 根地址，不含 `/chat/completions`；apiKey 只写，回显为 `******`，提交 `******` 保留原值、空串清除；沿用已存 Key 时 baseUrl 的 origin 与路径必须与已保存的一致（协议、主机、端口或路径变化都算换了接口，末尾斜杠视为相同），否则仍提交 `******` 返回 400 `validation_failed`，需要重新填写 apiKey，防止已存的 Key 被发往新地址；清空 baseUrl 可沿用已存 Key |
| `translation` | `{enabled,dailyCharsPerUser}`；AI 翻译开关与额度。enabled=true 要求 `ai_model` 已配置，同一请求同时提交两者时按合并后的结果校验（翻译开着时不能单独清空模型）；dailyCharsPerUser 0–10000000，每用户每 UTC 日发送给模型的字符数，0 不限，admin 不豁免 |
| `hosted_domains` | `{enabled,maxPerUser,maxPendingPerUser,maxPendingTotal,pendingDays,autoClaimLimit}`；用户托管域名开关与额度（Worker 还需配置 Cloudflare 凭据，`/api/config` 的 `hostedDomainsEnabled` 反映两者）。maxPerUser 0–1000（0 不限）为普通用户最多拥有的域名数；maxPendingPerUser 1–100 与 maxPendingTotal 1–1000 限制同时等待 NS 生效的数量，保护站长 Cloudflare 账户的添加额度；pendingDays 1–28 天未改 NS 自动删除；autoClaimLimit 0–100000（默认 0 不限）为每个托管域名自动认领的地址上限，设为正数时域内地址达到后未认领新地址的来信拒收，手动认领始终不受限。管理员不受个人上限，受全站等待数限制。全站托管域名、暂停/恢复与凭据健康检查见 `/api/admin/hosted-domains…`，详情、成员、过户、删除复用 `/api/hosted-domains/:id…`（管理员有全部权限），见[邮箱参考](mailboxes-and-domains.md#用户托管域名) |
| `delivery_events` | `{enabled}`，默认 true；外发投递回执的事件订阅开关。关闭只停止新建订阅，已有订阅的事件仍会回写，见[投递回执与抑制名单](#投递回执与抑制名单) |

外发 dailyRecipients 以每次请求去重后的收件地址计数，不是跨全天同一收件人只计一次；站内/外收件均计入。系统当前策略必须先读取，不把 schema 默认值当线上设置。

retention.unclaimedDays 对当时未认领地址的旧 inbound 生效；allMessagesDays 对所有旧邮件生效，包括已认领及已发送。设置清理期限可能在下一次定时任务永久删除已有历史，按用户授权范围修改；0 不清理会继续增长，不能自动替用户开启破坏性策略。回收站 7 天清理和草稿附件 24 小时清理是独立机制，不受这两个 0 禁用。DNS 接入检测 `GET /admin/settings/domain-status` 及多域并发控制见域名参考。

AI 模型默认未配置，翻译默认关闭；本站不再使用 Cloudflare Workers AI。配置 `ai_model`（例如 DeepSeek：`baseUrl=https://api.deepseek.com`、`model=deepseek-flash`）后，邮件内容会在两种情况下发送到该第三方服务：① 翻译启用后，用户在网页邮件详情点「翻译」时，主题与正文中的文字片段；只有能在该邮件中找到的片段才会发送，验证码、纯数字、URL、邮箱等无字母片段不发送，译文缓存在本站并随邮件永久删除一并删除；② `code_extract.aiEnabled` 开启时，正则没提到码、且主题或正文（不含 URL）出现验证码相关词（验证码、code、OTP、passcode、PIN、verification、one-time 等）的入站邮件，其主题和正文前 6000 字符，每域每日最多 500 封，10 秒超时；只让点链接的邮件不发送，模型返回的码必须在原文中出现才采用。是否把邮件内容交给第三方处理属于隐私决定，按用户授权和所在组织的数据政策决定是否配置，不要替用户开启。`GET /api/config` 的 `translationEnabled` 只公开是否可用，不公开服务地址或 Key。翻译另有每用户每分钟 30 次模型调用上限；超额返回 429，翻译服务失败返回 500 并退还字符额度。翻译接口 `POST /api/messages/:id/translate` 仅 JWT，见邮件参考。

`POST /admin/settings/ai-model-test` 用固定英文示例按翻译格式真实调用一次 AI 模型，返回 `{ok:true,latencyMs,sample}`；body 可省略，`{baseUrl,apiKey,model}` 中未提交或为空的字段、以及 apiKey 为 `******` 时用已保存的 `ai_model`，不要求任何功能已启用，便于保存前验证。沿用已存 apiKey（未填、空串或 `******`）时 baseUrl 的 origin 与路径必须与已保存的一致（末尾斜杠视为相同），否则返回 400 `validation_failed`，要测试新地址需同时填写 apiKey。三项解析后仍缺失返回 400；服务失败返回 500，message 说明 HTTP 状态码、超时或返回格式无效，不回显 Key。测试会产生一次真实外部调用，不计用户额度。

通知/转发已为个人偏好，不在上述系统设置中；通过 `/api/me/notify-prefs` 修改当前管理员的个人通道，不能 PUT 旧全局 `feishu/notify_webhook/gmail_forward` 字段。

## 投递回执与抑制名单

外发投递回执来自 Cloudflare Email Sending 的事件订阅：送达、退信、失败、拒绝、投诉事件按发信域名投递到 Queue `hpc-mail-email-events`，本站据此回写发件的逐收件人结果（见[投递回执](mail.md#投递回执)），退信与投诉的收件人进入抑制名单（见[抑制名单](mail.md#抑制名单)）。设置 `delivery_events.enabled` 开启（默认）且 Worker 有 Cloudflare 凭据时，定时任务每 5 分钟为还没有订阅的系统域名补建订阅、每日核对一次，托管域名开通发信时立即订阅。关闭后不再新建订阅，已有订阅的事件仍会回写。

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/delivery-events` | `{enabled,credentials,queue,subscriptions:[{domain,kind,zoneId,subscriptionId,status,lastError,checkedAt}]}`；`kind` 为 `system\|hosted`，`status` 为 `active`（已订阅）或 `error`（建立失败，见 `lastError`，定时任务约 6 小时后重试）。只列定时任务处理过的域名 |
| `GET /admin/suppressions?q=…&cursor=…&limit=30` | 有效（未过期）的抑制条目，按 id 倒序分页；`q` 按收件地址或发信域名包含匹配，不区分大小写；limit 1–100，默认 30 |
| `DELETE /admin/suppressions/:id` | 解除一条，`{success:true}`；不存在返回 404 `not_found`；记管理审计 `suppression.delete`（target 为收件地址，detail 为「发信域名 <域名>」） |

抑制条目为 `{id,address,reason,sendingDomain,since,expiresAt,detail,updatedAt}`：`reason` 为 `hard_bounce`（永久退信）、`soft_bounce`（临时失败且重试耗尽）或 `complaint`（被标为垃圾邮件）；`expiresAt` 为 null 表示长期有效，只能由管理员解除；`detail` 是收件服务器的退信说明或投诉类型。条目只拦从 `sendingDomain` 发给该地址的信。解除前先确认对方地址已恢复（例如用户确认邮箱可用），解除后下一次发信才会重新尝试；投诉条目按用户授权处理，不要为了让发信通过而批量解除。解除只删本站条目，Cloudflare 侧的抑制需要在 Cloudflare 控制台另行解除，否则发送仍会被它拒绝。

`credentials:false` 时不会自动建立订阅；没有订阅的域名收不到回执，结果停在 `sent`。建立订阅需要 Worker 的 Cloudflare Token（部署时的 `CF_HOSTED_DOMAINS_TOKEN`）具有 Account → Queues:Edit 权限，系统域名还要求它能读取域名所在的 zone，缺权限时 `lastError` 会给出提示。Token 读不到的系统域名可由站长在 Cloudflare 侧为该域名手动建立同一 Queue 的 email.sending 订阅，下一次重试或每日核对会识别并标为 `active`。

## Key 与管理审计

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/api-keys` | 全站 Key 元数据数组，含 ownerUsername 与已吊销记录，无明文 key |
| `GET /admin/api-keys/:id` | 目标有效/禁用 Key 元数据；已吊销可能 404 |
| `GET /admin/api-keys/:id/logs?cursor=…&limit=30` | 目标 Key 调用审计分页 |
| `DELETE /admin/api-keys/:id` | 吊销目标 Key，`{success:true}` |
| `GET /admin/audit-logs?cursor=…&limit=30` | 管理操作审计分页 |

管理员全站 Key 接口没有 PUT；自己 Key 的创建/更新仍用 `/api/api-keys`，不能把 admin metadata 查询当明文找回。审计默认页大小 30、最大 100，倒序读到 nextCursor=null；管理日志含 `id,actorName,action,target,detail,ip,createdAt`；`settings.update` 的 target 只列实际变化的设置键（不含 `expectedDomainsRevision`），detail 为变更摘要，如域名新增/移除、公开性与每人上限变化、`mailbox_policy.perUserLimit: 50→20`；`ai_model.apiKey` 只记「已更新/已清除」，不记录值，Key 日志字段见鉴权参考，保留约 90 天。只根据已看到的审计区间报告结果，不声称此接口是全部应用运行日志或队列监控。生产部署、Cloudflare DNS/Routing、数据库/R2 运维不是这些管理接口提供的能力。
