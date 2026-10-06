# 邮箱、共享与多域名

shell 示例复用 [入口指南](../skill.md) 的 `hpc()`。邮箱 CRUD 在 JWT `/api` 与 Key `/v1` 均可用；强制过户、域名/共享管理只用管理员 JWT `/api`，Key scopes 不提供管理权。

## 发现域名与邮箱

| 路径 | JWT `/api` | Key `/v1` |
|---|---|---|
| `GET /domains` | `data` 为域名字符串数组 | `data:{domains:[...]}`，任一有效 Key |
| `GET /mailboxes` | 自己认领的数组 | 同左，`mailbox.read` |
| `GET /mailboxes?all=1` | 管理员全站数组；普通用户不能请求全站范围 | 同左，`mailbox.read` 加管理员角色 |
| `GET /mailboxes/shared` | 分享给自己的只读管理员邮箱数组 | 同左，`mailbox.read` |
| `GET /mailboxes/availability?localPart=…&domain=…` | `{address,available}` | 同左，`mailbox.read` |
| `POST /mailboxes` | `{localPart,domain}` → 201 邮箱 | 同左，`mailbox.write` |
| `PUT /mailboxes/:id` | `{displayName}` → 邮箱 | 同左，`mailbox.write` |
| `DELETE /mailboxes/:id` | `{success:true,deletedMessages}` | 同左，`mailbox.write` |

邮箱字段 `id,address,domain,userId,displayName,messageCount,createdAt`；管理员全站列表还有 `ownerUsername`。共享视图字段为 `mailboxId,address,domain,displayName,ownerUsername`，其 mailboxId 不是自己的发件权限。`messageCount` 包括地址下历史与软删除记录，不应作为是否删除历史的唯一依据。

可认领域名必须来自当前身份的 `/domains`，而不是公开 `/api/config` 或猜测 `@hpc.email`。普通用户只可认领公开域；管理员可认领所有配置域。完整地址全局唯一，两个域名中的相同 localPart 是不同邮箱。域名/前缀归一化为小写；前缀 1–64 字符、小写字母或数字首尾，中间可含 `. _ + -`；域名须为合法 DNS 标签的 ASCII 形式，顶级域当前只接受至少两个字母。国际化中间标签可转 punycode 后校验，但 punycode 顶级域目前不支持，不能承诺任意 IDN 可配置。

```bash
hpc '/mailboxes/availability' --get --data-urlencode "localPart=$HPC_LOCAL_PART" \
  --data-urlencode "domain=$HPC_DOMAIN"
jq -n --arg local "$HPC_LOCAL_PART" --arg domain "$HPC_DOMAIN" \
  '{localPart:$local,domain:$domain}' |
  hpc '/mailboxes' -X POST -H 'Content-Type: application/json' --data-binary @-
```

availability 是瞬时占用提示，不预订、不保证通过保留前缀/全局/每域限额；认领最终可能 403、409 `address_taken` 或域配置冲突。普通用户受系统保留前缀、用户总认领上限和每域认领上限；管理员豁免，0 表示该限额不限。并发冲突刷新域名/邮箱状态后按任务要求重试，不能忽略错误声称认领成功。

显示名最多 64 字符，允许空串清除；不是改地址。普通用户仅可改/释放自己的邮箱，管理员可处理全站邮箱；不能凭“共享给我”修改它。普通用户发件可用自己的 `mailboxId` 或已认领 `localPart+domain`；管理员任意发件仍限服务器认可的系统/保留域。

## 释放、历史与共享边界

管理员要把现有邮箱直接分配给指定用户时，使用 `POST /api/admin/mailboxes/:id/transfer`，不要先释放再替目标用户认领。请求、并发校验、历史和共享处理见 [管理员强制过户](administration.md#强制过户邮箱)。

默认 `DELETE /mailboxes/:id` **仅释放地址并撤销相关共享**，历史收发邮件保留，按地址回到未认领范围；原 owner 失去访问，下一个认领者可以继承该地址已有历史。因此账户与邮箱不是永久私有映射，用户明确要求清理时使用 `?deleteHistory=1`（也接受 true）。该选项永久清除地址下所有历史，包括回收站与 outgoing；不要将界面/响应中的 `messageCount=0` 当作可以隐瞒的历史风险。

选择动作时复用已有用户意图：只要释放可用默认行为；要求删邮箱及历史时带 deleteHistory。缺失且会影响隐私/保留正确性的关键选择才需要澄清，不能把接口的二选一说明变成每次重复批准流程。结果 `deletedMessages` 是被清除的记录数量；释放不停止域名 catch-all，后来到该地址的新邮件仍可能入库。

共享只公开管理员自己认领邮箱的**全部现有及未来未删除收件**，不是自共享时刻起的新信，不包括发件或回收站。grantee 必须是启用中的普通用户，最多 100 人。共享不能当发件身份/回复引用/附件转发来源，不能删除、恢复、purge、重命名或释放邮箱；允许查看详情/线程/附件/raw、修改邮件已读状态、设置自己独立的星标。仅被分享人的通知偏好不会因共享自动收到推送，通知按收信时实际 owner 结算。

管理员 JWT 接口：

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/mailbox-shares` | 当前管理员自有邮箱与 `grantees:[{userId,username,grantedAt}]`，包含尚未共享邮箱 |
| `PUT /admin/mailbox-shares` | `{mailboxId,userIds:[...]}` **整体替换**名单，`[]` 撤销全部；返回更新后的共享邮箱 |
| `DELETE /admin/mailbox-shares/:mailboxId/grantees/:userId` | 只撤销一人；`{success:true}` |

更新前读回完整名单，保留仍需授权的人，避免把新增一个人当整体替换。已禁用或升级为管理员的成员不能重新出现在 PUT 名单中，应移除失效成员；DELETE 单人撤销可处理失效成员。共享 owner 被禁用时共享立即不可见；降级为普通用户/释放邮箱/删除用户时相关共享撤销，重新认领不会恢复旧名单。

## 域名新增、关闭公开和删除

管理员 JWT `GET /api/admin/settings` 的 `domains` 是 `{list:[{domain,public,perUserLimit}],revision?}`。最多 64 域，不重复；`public` 默认 false；`perUserLimit` 0–10000，仅普通用户生效。没有单独域名 DELETE/POST，增删/改公开性都通过**替换 domains.list** 完成：

```bash
# API="$BASE/api"、AUTH 为管理员 JWT；HPC_NEW_DOMAIN 已按任务确认
CURRENT_SETTINGS=$(hpc '/admin/settings')
jq --arg domain "$HPC_NEW_DOMAIN" '
  {expectedDomainsRevision:(.data.domains.revision // 0),
   domains:{list:(.data.domains.list + [{domain:$domain,public:false,perUserLimit:0}])}}' \
  <<< "$CURRENT_SETTINGS" |
  hpc '/admin/settings' -X PUT -H 'Content-Type: application/json' --data-binary @-
```

先读现值，合并**本次已授权的变更**，带顶层 `expectedDomainsRevision`（读取默认 0），不要把整份陈旧 settings PUT 回去。服务端自动增加 revision。409 时重新 GET 并检查他人变更，再基于新版本合并；不能只改 revision 强行覆盖旧 list。设置请求其他字段可独立更新，不附带 domains 就不会覆盖域名列表。

- 新增域名只是业务配置；不会自动写 DNS、开通 Cloudflare Email Routing、把 catch-all 接到 Worker 或配置外发服务。
- `public:false` 关闭普通用户的新认领与域名公开列表；已认领邮箱继续存在、可收可发，已有共享不因此撤销。
- 从 list 删除停止在该域新认领，保留旧邮箱/历史；只要还有该域存量邮箱，它仍被视为站内路由域，既有邮箱可发件。它不等于注销域名或停收邮件，也不会移除 Cloudflare 的 DNS/路由。
- 配置为空且无存量邮箱时没有可用发件/认领域；需管理员先完成实际域名接入。不应承诺外部投递由“保存域名”即可成功。

接入检查 `GET /api/admin/settings/domain-status?domain=…` 返回 `domain,inList,mxReady,spfReady,mxRecords,resolved`。`resolved:false` 是查询失败，不是证明没接入；MX 指向 `*.mx.cloudflare.net`、SPF 包含 `_spf.mx.cloudflare.net` 只验证 DNS，不能证明 catch-all 指向本 Worker、外发授权或真实投递成功。完整接入需用户授权范围内的 DNS/Cloudflare 配置与真实收发验证，这些操作并非本邮箱管理 API 的能力。
