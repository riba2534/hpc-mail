# 管理员功能

所有 `/api/admin/*` 必须有效 **管理员 JWT**，API Key 的五个 scopes 不提供这些权限。调用先 `GET /api/auth/me` 核对当前角色；没有管理员权限时报告限制，不换身份、猜测他人 ID 或通过 `/v1` 规避。shell 示例复用 [入口指南](../skill.md)，设 `API="$BASE/api"`、`AUTH` 为管理员 JWT。

## 用户与邮件审阅

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/users` | 全部用户数组 |
| `POST /admin/users` | `{username,password,role?}`，role 默认 user，可 admin；201 新用户，不自动认领邮箱 |
| `PUT /admin/users/:id` | 至少一个 `status:active\|disabled`、`role:user\|admin`、`password`（重置密码）；返回更新后的用户 |
| `DELETE /admin/users/:id` | `{success:true}`，不可恢复；账户与其邮箱/共享/Key/星标关联撤销，邮件历史仍按地址保留 |

用户含 `id,username,role,status,mailboxCount,mailboxes,apiKeyCount,createdAt,lastLoginAt,avatarUrl`。建户/重置密码约束见鉴权参考。不能禁用或删除自己；不能移除最后一个启用中的管理员。禁用/重置密码撤销旧会话，禁用期间 Key 也被拒绝；重置密码本身不吊销 Key。降级管理员撤销其名下共享，存量邮箱仍存在，新认领/发件按当前角色校验。

## 强制过户邮箱

管理员 JWT 可 `POST /api/admin/mailboxes/:id/transfer`，将任意现有已认领邮箱直接转给指定的启用中用户（普通用户或管理员）。自己或别人认领的均可；此操作不经过未认领状态，不受普通认领配额、保留前缀、域名公开性或当前新认领域名列表限制。它不创建尚未存在的邮箱。

先读 `GET /api/mailboxes?all=1` 核对邮箱 `id,address,userId`，再读 `GET /api/admin/users` 核对目标 `id,username,status`。body 为 `{userId:目标用户ID,expectedOwnerId:列表中的当前主人ID}`，两者必须是正整数。

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

详情/线程/raw 同样带 scope 与 userId，管理员审阅其他用户为只读，所有邮件状态变更（含星标）仅支持 `mine/unclaimed`。未认领邮件修改需显式 `scope=unclaimed`；默认列表只自己的认领邮箱。全站地址管理用 `GET /mailboxes?all=1`，编辑/释放对应 `/mailboxes/:id`；共享管理只能管理**自己的**邮箱，不是任意 owner 的共享。域名与共享完整契约见 [邮箱、多域名参考](mailboxes-and-domains.md)。

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
| `code_extract` | `{enabled,aiEnabled}`；两布尔，控制验证码提取；不能因此证明提取码绝对正确 |
| `site` | `{title}`，1–64 字符 |
| `api` | `{enabled}`；控制 `/v1` 开放 API，不关闭 JWT 网页管理 |
| `security` | `{require2fa}`；强制尚未绑定的 JWT 用户完成 2FA 后使用业务接口 |
| `domains` | `{list:[{domain,public,perUserLimit}],revision?}`；更新必须顶层 `expectedDomainsRevision`，见域名参考 |
| `mailbox_policy` | `{perUserLimit,reservedLocalParts}`；总认领上限 0–10000，0 不限；保留前缀最多 200 项，每项 ≤64 字符；普通用户生效，admin 豁免 |
| `quota` | `{dailyOutbound,dailyRecipients}`；普通用户每日外发邮件数 0–100000、唯一收件地址数 0–1000000，跨 Key/JWT 共用；0 不限，admin 豁免 |
| `retention` | `{unclaimedDays,allMessagesDays}`；0–3650 天，0 关闭该项定时清理 |

外发 dailyRecipients 以每次请求去重后的收件地址计数，不是跨全天同一收件人只计一次；站内/外收件均计入。系统当前策略必须先读取，不把 schema 默认值当线上设置。

retention.unclaimedDays 对当时未认领地址的旧 inbound 生效；allMessagesDays 对所有旧邮件生效，包括已认领及已发送。设置清理期限可能在下一次定时任务永久删除已有历史，按用户授权范围修改；0 不清理会继续增长，不能自动替用户开启破坏性策略。回收站 7 天清理和草稿附件 24 小时清理是独立机制，不受这两个 0 禁用。DNS 接入检测 `GET /admin/settings/domain-status` 及多域并发控制见域名参考。

通知/转发已为个人偏好，不在上述系统设置中；通过 `/api/me/notify-prefs` 修改当前管理员的个人通道，不能 PUT 旧全局 `feishu/notify_webhook/gmail_forward` 字段。

## Key 与管理审计

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/api-keys` | 全站 Key 元数据数组，含 ownerUsername 与已吊销记录，无明文 key |
| `GET /admin/api-keys/:id` | 目标有效/禁用 Key 元数据；已吊销可能 404 |
| `GET /admin/api-keys/:id/logs?cursor=…&limit=30` | 目标 Key 调用审计分页 |
| `DELETE /admin/api-keys/:id` | 吊销目标 Key，`{success:true}` |
| `GET /admin/audit-logs?cursor=…&limit=30` | 管理操作审计分页 |

管理员全站 Key 接口没有 PUT；自己 Key 的创建/更新仍用 `/api/api-keys`，不能把 admin metadata 查询当明文找回。审计默认页大小 30、最大 100，倒序读到 nextCursor=null；管理日志含 `id,actorName,action,target,detail,ip,createdAt`，Key 日志字段见鉴权参考，保留约 90 天。只根据已看到的审计区间报告结果，不声称此接口是全部应用运行日志或队列监控。生产部署、Cloudflare DNS/Routing、数据库/R2 运维不是这些管理接口提供的能力。
