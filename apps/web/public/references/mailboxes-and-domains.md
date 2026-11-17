# 邮箱、共享与多域名

## 目录

- [发现域名与邮箱](#发现域名与邮箱)：域名、邮箱列表、可用性、认领与释放的端点对照
- [发件身份](#发件身份)：`/identities` 与 `canSend`，哪些地址能发信
- [批量认领](#批量认领)：随机后缀方案、批量可用性、批量认领
- [释放、历史与共享边界](#释放历史与共享边界)：释放与清除历史、共享的权限范围与管理接口
- [域名新增、关闭公开和删除](#域名新增关闭公开和删除)：管理员维护系统域名
- [用户托管域名](#用户托管域名)：把自己的域名接入本站，[用 API Key 接入](#用-api-key-接入)，以及[托管域名的 DNS 解析](#托管域名的-dns-解析)

shell 示例复用 [入口指南](../skill.md) 的 `hpc()`。邮箱 CRUD、发件身份与批量认领在 JWT `/api` 与 Key `/v1` 均可用；共享管理只用 JWT `/api`；用户托管域名的查看、添加、检测与 DNS 解析两者均可用（Key 需 `domain.read`/`domain.write`），删除、成员上限、成员与过户只用 JWT `/api`；强制过户、全站共享和系统域名管理只用管理员 JWT `/api`，Key scopes 不提供管理权。

## 发现域名与邮箱

| 路径 | JWT `/api` | Key `/v1` |
|---|---|---|
| `GET /domains` | `data` 为域名字符串数组；系统域名之后附上已生效的托管域名：普通用户为自己拥有或被共享的，管理员为全部 | `data:{domains:[...]}`，任一有效 Key，范围同左 |
| `GET /identities` | 发件身份 `{identities,domains}`，见[发件身份](#发件身份) | 同左，`mail.send` 或 `mailbox.read` 之一 |
| `GET /mailboxes` | 自己认领的数组 | 同左，`mailbox.read` |
| `GET /mailboxes?all=1` | 管理员全站数组；普通用户不能请求全站范围 | 同左，`mailbox.read` 加管理员角色 |
| `GET /mailboxes/shared` | 分享给自己的只读邮箱数组 | 同左，`mailbox.read` |
| `GET /mailboxes/availability?localPart=…&domain=…&strategy=claude` | `{address,available,reason?}` | 同左，`mailbox.read` |
| `POST /mailboxes/availability/batch` | `{items:[{localPart,domain,strategy?}...]}`（1–999 个）→ 按请求顺序的 availability 数组 | 同左，`mailbox.read` |
| `GET /mailboxes/random-plan?count=…&strategy=uniform\|claude` | 只分配随机后缀、不认领：`{strategy,items:[{domain,suspended}],pool,shortfall,reason}`，见[批量认领](#批量认领) | 同左，`mailbox.read` |
| `POST /mailboxes` | `{localPart,domain,strategy?}` → 201 邮箱 | 同左，`mailbox.write` |
| `POST /mailboxes/batch` | `{items:[{localPart,domain,strategy?}...]}`（1–999 个）→ `{claimed,taken,notAttempted,stoppedBy}`，见[批量认领](#批量认领) | 同左，`mailbox.write` |
| `PUT /mailboxes/:id` | `{displayName}` → 邮箱 | 同左，`mailbox.write` |
| `DELETE /mailboxes/:id` | `{success:true,deletedMessages}` | 同左，`mailbox.write` |

邮箱字段 `id,address,domain,userId,displayName,messageCount,createdAt,canSend`；管理员全站列表还有 `ownerUsername`。`canSend` 只反映该邮箱的域名当前能否发信（系统域名恒为 true，托管域名要求域名可用且发信已开通），不代表调用者有权用它发信。共享视图字段为 `mailboxId,address,domain,displayName,ownerUsername`，其 mailboxId 不是自己的发件权限。`messageCount` 包括地址下历史与软删除记录，不应作为是否删除历史的唯一依据。

`strategy` 为可选的 `uniform|claude`，单项认领请求体、单项可用性 query 和两种批量请求的每个 item 均接受。缺省或 `uniform` 保持普通认领；`claude` 是「Claude 0 封号」：域名只要存在任意历史封号事实就拒绝，包括管理员与托管域名，且不受旧付费/比例阈值影响。实际写入会在 INSERT/批量事务内复核，规划或检查之后新出现的封号也会拒绝，错误为 `forbidden`，message 为“该域名有 Claude 封号记录，不能在 Claude 0 封号模式下认领”。手动改后缀、单个重新随机及最终提交都须保留 `strategy=claude`。

可认领域名必须来自当前身份的 `/domains`，而不是公开 `/api/config` 或猜测 `@hpc.email`。普通用户默认只可认领公开域；管理员配置了用户专属权限时，仅可认领专属名单中的系统域名（可包含非公开域名），总数和单域名额度也使用专属配置。管理员可认领所有配置域。完整地址全局唯一，两个域名中的相同 localPart 是不同邮箱。域名/前缀归一化为小写；前缀 1–64 字符、小写字母或数字首尾，中间可含 `. _ + -`；域名须为合法 DNS 标签的 ASCII 形式，顶级域当前只接受至少两个字母。国际化中间标签可转 punycode 后校验，但 punycode 顶级域目前不支持，不能承诺任意 IDN 可配置。

```bash
hpc '/mailboxes/availability' --get --data-urlencode "localPart=$HPC_LOCAL_PART" \
  --data-urlencode "domain=$HPC_DOMAIN"
jq -n --arg local "$HPC_LOCAL_PART" --arg domain "$HPC_DOMAIN" \
  '{localPart:$local,domain:$domain}' |
  hpc '/mailboxes' -X POST -H 'Content-Type: application/json' --data-binary @-
```

availability 与认领使用同一套规则、同一判定顺序，是瞬时提示而非预订。`available:false` 时带 `reason`：

| reason | 含义 | 对应认领错误 |
|---|---|---|
| `domain_unavailable` | 域名不在系统配置中，或不在当前用户公共/专属权限允许范围 | 400 / 403 |
| `claude_suspended` | Claude 模式下域名存在任意历史封号记录 | 403 `forbidden` |
| `reserved` | 系统保留前缀（仅普通用户） | 403 |
| `quota` | 当前用户已达总认领上限 | 403 |
| `domain_limit` | 当前用户已达该域名的每人上限 | 403 |
| `taken` | 地址已被认领 | 409 `address_taken` |

按 `reason` 决定换前缀、换域名或告知用户额度已满，不要对 quota/domain_quota/daily_limit/domain_limit 反复换前缀重试。检查与认领之间状态仍可能变化，认领可能 403、409 `address_taken` 或域名/用户权限配置冲突。普通用户受系统保留前缀、公共或专属配置中的用户总认领上限和每域认领上限；管理员豁免，0 表示该限额不限。并发冲突刷新域名/邮箱状态后按任务要求重试，不能忽略错误声称认领成功。

显示名最多 64 字符，允许空串清除；不是改地址。普通用户仅可改/释放自己的邮箱，管理员可处理全站邮箱；不能凭“共享给我”修改它。

## 发件身份

`GET /identities`（Key 需要 `mail.send` 或 `mailbox.read` 之一，两者都没有返回 403 并在 `fix` 里说明；JWT 无 scope 要求）告诉调用者能用哪些地址发信：

```bash
hpc '/identities' | jq '.data'
# {"identities":[{"kind":"owned","mailboxId":42,"address":"alice@example.org","domain":"example.org","displayName":"Alice","canSend":true,"reason":null},
#   {"kind":"shared","mailboxId":57,"address":"team@example.org","domain":"example.org","displayName":"","canSend":false,"reason":"shared_readonly"}],
#  "domains":[]}
```

- `identities` 先列自己认领的邮箱（`kind=owned`），再列共享给自己的邮箱（`kind=shared`），各按地址排序。
- `canSend=true` 的项可以作为发信的 `from`：写 `{mailboxId}`、地址字符串（可加显示名 `"Alice <alice@example.org>"`）或 `{address,name}`，见[邮件参考](mail.md#发件身份)。
- `canSend=false` 时 `reason` 说明原因：`hosted_sending_not_ready`（托管域名的发信尚未开通，等域名进度里 `steps.sending` 变成 ready）、`hosted_domain_unavailable`（托管域名被暂停、NS 已移走或删除中）、`shared_readonly`（共享邮箱只读，永远不能发信）。用这些地址发信分别返回 400 和 403。
- `domains` 只对管理员有内容：全部系统域名（`kind:"system"`、`anyLocalPart:true`），管理员可以在这些域名上用任意前缀发信。普通用户为空数组。
- 管理员凭 `mailboxId` 使用他人邮箱发信的能力不变，但这些邮箱不在 `identities` 里。仍有存量邮箱的旧域名、托管域名上的地址写法也只对管理员开放，不能推断任意外部域名可用。

## 批量认领

一次要多个地址时，三个接口在 JWT 与 Key 下同形（Key 的 scope 见上表）：先用 `random-plan` 分配域名、自己生成前缀，再用 `availability/batch` 检查，最后 `POST /mailboxes/batch` 认领。

```bash
PLAN=$(hpc '/mailboxes/random-plan' --get --data-urlencode 'count=3' --data-urlencode 'strategy=uniform')
ITEMS=$(jq -c --arg p "tmp-$(date +%s)" '{items:[.data.items | to_entries[] | {localPart:"\($p)-\(.key)", domain:.value.domain}]}' <<<"$PLAN")   # 前缀自己生成
hpc '/mailboxes/availability/batch' -X POST -H 'Content-Type: application/json' --data-binary "$ITEMS" | jq '.data'
hpc '/mailboxes/batch' -X POST -H 'Content-Type: application/json' --data-binary "$ITEMS" | jq '.data | {claimed:[.claimed[].address],taken,stoppedBy}'
```

批量认领按请求顺序逐个执行，规则与单个认领相同：已被占用的地址进 `taken` 并继续下一个；其他错误（额度用尽、域名或权限配置变化等）立即停止，已认领的保留在 `claimed`，触发停止的那一项及其后各项进 `notAttempted`，`stoppedBy` 给出 `{code,message}`。HTTP 200 不代表全部认领成功，要以 `claimed` 为准。批量可用性按请求顺序返回每一项的 availability，含义同单个检查。

`random-plan` 的 `count` 必须为 1–999 的整数。它只分配后缀，前缀由调用方生成，然后携带相同策略做可用性检查与认领。候选是当前用户可认领且 `domains.list[].random` 不为 false 的域名，按每域与总认领额度裁剪；`pool` 是仍有额度且符合当前策略的候选，供单个地址重新随机。`strategy=uniform` 在候选中等概率选；`strategy=claude` 从 `items` 和 `pool` 一律剔除有任何封号记录的域名，仅在零封号域中把「已有 Claude 账号 + 近 `pendingDays` 天认领还没收到 Claude 来信的邮箱 + 本批已分配」负载拉平。近 24 小时新增（新注册的 Claude 账号 + 新认领的未注册邮箱 + 本批已分配）达到 `dailyLimit` 时停止向该域分配；每日上限或每域额度用完均不会溢出到有封号的域名。`items[].suspended` 是历史封号地址数，Claude 模式下恒为 0。分不满时 `shortfall` 大于 0，`reason` 为 `quota`（用户总额度不足）、`domain_quota`（零封号候选每域额度用完）、`daily_limit`（零封号候选近 24 小时新增都已达上限）或 `no_candidates`（没有符合策略的候选）。零封号指历史已观测记录，不保证未来不会封号；统计依据官方来信的发件人和主题，未校验 DKIM。删除邮件不会清除历史封号事实。

## 释放、历史与共享边界

管理员要把现有邮箱直接分配给指定用户时，使用 `POST /api/admin/mailboxes/:id/transfer`，不要先释放再替目标用户认领。请求、并发校验、历史和共享处理见 [管理员强制过户](administration.md#强制过户邮箱)。

默认 `DELETE /mailboxes/:id` **仅释放地址并撤销相关共享**，历史收发邮件保留，按地址回到未认领范围；原 owner 失去访问，下一个认领者可以继承该地址已有历史。因此账户与邮箱不是永久私有映射，用户明确要求清理时使用 `?deleteHistory=1`（也接受 true）。该选项永久清除地址下所有历史，包括回收站与 outgoing；不要将界面/响应中的 `messageCount=0` 当作可以隐瞒的历史风险。

选择动作时复用已有用户意图：只要释放可用默认行为；要求删邮箱及历史时带 deleteHistory。缺失且会影响隐私/保留正确性的关键选择才需要澄清，不能把接口的二选一说明变成每次重复批准流程。结果 `deletedMessages` 是被清除的记录数量；释放不停止域名 catch-all，后来到该地址的新邮件仍可能入库。

所有者可以共享自己认领的邮箱，管理员可以共享全站任意已认领邮箱。共享公开邮箱的**全部现有及未来未删除收件**，不是自共享时刻起的新信，不包括发件或回收站。grantee 可以是启用中的普通用户或管理员，最多 100 人；邮箱所有者已经有访问权，无需加入名单。共享不能当发件身份，不能删除、恢复、purge、重命名或释放邮箱；允许查看详情/线程/附件/raw、设置自己独立的星标，共享来信也可以作为回复（`replyToMessageId`）或附件转发（`forwardAttachmentsFrom`）的来源，发件身份仍须是自己认领的地址。共享邮件的已读状态属于所有者：成员逐封标记计 0、全部已读不包含共享邮件；成员的未读数和 `unread=1` 筛选只统计自己认领的地址。仅被分享人的通知偏好不会因共享自动收到推送，通知按收信时实际 owner 结算。

共享管理 JWT 接口（`/admin` 路径需要管理员）：

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /mailboxes/shares` | 当前用户自有邮箱与共享名单，包含尚未共享邮箱；JWT 专用 |
| `PUT /mailboxes/shares` | `{mailboxId,userIds:[...],expectedOwnerId?}` 整体替换自己邮箱的名单；管理员通过此入口也只能修改自己邮箱 |
| `POST /mailboxes/shares/batch` | `{mailboxIds:[...],userIds:[...]}`（各 1–100 个）把自己的多只邮箱一次**追加**共享给同一批用户：已在名单的保留原授权时间，不移除任何人，重复调用幂等；每只邮箱追加后最多 100 人。出错时整单不写入任何邮箱：任一邮箱不归自己（管理员也一样）返回 403；用户含自己、不存在或已禁用，或追加后某只邮箱会超过 100 人，返回 400；校验通过后、写入前状态被并发改变返回 409，例如邮箱被过户或释放、被分享人被禁用或删除、并发写入使某只邮箱超过 100 人。并发的追加或替换共享本身不报错，按先后合并（已在名单的按主键跳过）。返回各邮箱本次写入后的完整名单，按去重后的 `mailboxIds` 顺序，重复 id 只返回一次 |
| `DELETE /mailboxes/shares/:mailboxId/grantees/:userId` | 所有者撤销一个成员；`{success:true}` |
| `GET /mailboxes/share-users?q=...&excludeUserId=...&limit=20` | JWT 专用；搜索启用用户，仅返回 `{items:[{id,username,role}],hasMore}`，不含账户隐私或邮箱列表 |
| `GET /admin/mailbox-shares` | 管理员查看全站已认领邮箱与 `grantees:[{userId,username,status,grantedAt}]`，包含尚未共享邮箱；`?mailboxId=` 只返回该邮箱（0 或 1 项） |
| `PUT /admin/mailbox-shares` | `{mailboxId,userIds:[...],expectedOwnerId?}` **整体替换任意已认领邮箱**的名单，`[]` 撤销全部；返回更新后的共享邮箱 |
| `DELETE /admin/mailbox-shares/:mailboxId/grantees/:userId` | 只撤销一人；`{success:true}` |

共享管理视图还包含 `ownerUserId,ownerUsername`。保存时建议带 `expectedOwnerId=ownerUserId`，所有者已变化返回 409；写入时再次校验归属，防止并发过户覆盖新共享。

更新前读回完整名单，保留仍需授权的人，避免把新增一个人当整体替换。已禁用的成员不能重新出现在 PUT 名单中，应移除失效成员；DELETE 单人撤销可处理失效成员。共享 owner 被禁用时共享立即不可见；角色升降级保留共享；释放邮箱/过户/删除用户时相关共享撤销，重新认领不会恢复旧名单。

## 域名新增、关闭公开和删除

管理员 JWT `GET /api/admin/settings` 的 `domains` 是 `{list:[{domain,public,perUserLimit,random?}],revision?}`。最多 64 域，不重复；`public` 默认 false；`perUserLimit` 0–10000，仅普通用户生效；`random` 缺省视为 true，false 时该域不参与认领弹窗的随机后缀（均匀随机与 Claude 0 封号两种模式），只能手动选择。管理员可用 `GET /api/admin/settings/domain-claude-stats` 按域名列表顺序查看每域 `accounts,suspended,paid,paidSuspended,pending,recent,risk`（`recent` 是近 24 小时新增；`risk` 在有任何历史封号时为 `suspended`，否则为 null；旧枚举仅为兼容保留，有封号域均被 Claude 0 封号模式排除），统计约每 5 分钟刷新，邮件删除后仍保留。没有单独域名 DELETE/POST，增删/改公开性都通过**替换 domains.list** 完成：

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

- 新增域名只是业务配置；不会自动写 DNS、开通 Cloudflare Email Routing、把 catch-all 接到 Worker 或配置外发服务。已被用户托管的域名不能加为系统域名，返回 409 `conflict`；反之系统域名也不能被托管。
- `public:false` 关闭使用公共配置的普通用户的新认领与域名公开列表；专属配置仍可单独授权该域名；已认领邮箱继续存在、可收可发，已有共享不因此撤销。
- 从 list 删除停止在该域新认领，保留旧邮箱/历史；只要还有该域存量邮箱，它仍被视为站内路由域，既有邮箱可发件。它不等于注销域名或停收邮件，也不会移除 Cloudflare 的 DNS/路由。
- 配置为空且无存量邮箱时没有可用发件/认领域；需管理员先完成实际域名接入。不应承诺外部投递由“保存域名”即可成功。

接入检查 `GET /api/admin/settings/domain-status?domain=…` 返回 `domain,inList,mxReady,spfReady,mxRecords,resolved`。`resolved:false` 是查询失败，不是证明没接入；MX 指向 `*.mx.cloudflare.net`、SPF 包含 `_spf.mx.cloudflare.net` 只验证 DNS，不能证明 catch-all 指向本 Worker、外发授权或真实投递成功。完整接入需用户授权范围内的 DNS/Cloudflare 配置与真实收发验证，这些操作并非本邮箱管理 API 的能力。

## 用户托管域名

`GET /api/config` 的 `hostedDomainsEnabled` 为 true 时，任何登录用户都能把自己的域名托管到本站，用 JWT `/api` 或带 `domain.read`/`domain.write` 的 Key `/v1`（Key 可用的范围见[用 API Key 接入](#用-api-key-接入)）。站点在站长的 Cloudflare 账户建 zone，用户在注册商把 NS 改成返回的两条。原 DNS 服务商的记录不会自动迁移，网站、域名验证等常用记录用下文的 [DNS 解析](#托管域名的-dns-解析) 接口补建，最好在改 NS 之前补好。

| 路径（JWT `/api`；Key `/v1` 的范围见[下节](#用-api-key-接入)） | 说明 |
|---|---|
| `GET /hosted-domains` | 自己拥有（`role:"owner"`）与被共享（`role:"member"`）的域名；管理员全站用 `GET /admin/hosted-domains?status=&q=` |
| `POST /hosted-domains` | `{domain}`，填已注册的根域名 → 201，`status:"pending"`、`nameServers` 两条、`originalNameServers`、`warnings`（如需先关闭 DNSSEC）、`expiresAt`（到期未改 NS 自动删除） |
| `GET /hosted-domains/:id` | 进度：`status` 与 `steps:{nameServers,routing,catchAll,sending}`（各为 waiting/ready/error）、`lastError`、`checkedAt` |
| `POST /hosted-domains/:id/check` | 所有者或管理员：请 Cloudflare 立即复查 NS 并推进开通，15 秒内重复调用直接返回当前状态；每人每分钟最多 10 次（被节流、无权限的也计），超出或全站 Cloudflare 额度用完返回 429；真正触发复查时计 4 次全站额度，托管功能关闭或站点缺少 Cloudflare 凭据时不计 |
| `PUT /hosted-domains/:id` | `{memberLimit}`：每位成员在该域最多认领数，0 不限 |
| `GET` / `PUT /hosted-domains/:id/members` | 成员名单；PUT `{userIds,expectedOwnerId}` 整体替换（已禁用的现有成员可保留，新增的须为启用中的用户），选人用 `GET /mailboxes/share-users` |
| `DELETE /hosted-domains/:id/members/:userId` | 移除成员；成员传自己的 id 即退出共享。已认领的地址保留 |
| `POST /hosted-domains/:id/transfer` | `{userId,expectedOwnerId,includeMailboxes}`；`includeMailboxes:true` 连同原所有者在该域的地址与全部历史一起过户。调用者过户后失去权限时返回 `domain:null` |
| `DELETE /hosted-domains/:id` | 不可逆：立即拒收，随后永久删除该域全部邮件、释放全部地址并删除 zone。先在注册商把 NS 改回 `originalNameServers` |
| `/hosted-domains/:id/dns-records…` | 所有者或管理员管理 DNS 解析，见 [托管域名的 DNS 解析](#托管域名的-dns-解析) |

状态：`pending` 等待改 NS → NS 生效后系统自动开通收件与发信（`provisioning`）→ `active`。`error` 为开通或巡检未通过（自动重试），`moved` 为 NS 已不再指向本站，`suspended` 为管理员暂停（拒收、禁止发信与新认领），`deleting` 为删除中。定时任务约每 5 分钟推进一次。

- 权限：所有者与管理员可查看进度、管理成员、过户、删除；管理员还能在任何人的托管域名下认领地址，并像其他邮箱一样用 `/admin/mailboxes/:id/transfer`、`/admin/mailbox-shares` 过户或共享其中的地址（含自动认领给所有者的地址）；成员只能在该域认领地址（受 `memberLimit` 与系统保留前缀约束），看不到域名设置，也看不到他人地址的邮件；其他用户看到 404。管理员额外可用 `POST /admin/hosted-domains/:id/suspend|resume`。
- 收件：已生效域名上**未认领地址的来信自动认领给域名所有者**，直接出现在所有者收件箱并按其个人偏好通知；自动认领默认不限数量（`hosted_domains.autoClaimLimit` 为 0），管理员设了正数上限时，域内地址达到上限后未认领新地址的来信拒收；暂停或删除中的域名拒收。释放托管域名下的地址且保留历史时，下一封来信会把该地址连同历史邮件自动认领给域名所有者；不想留给所有者就用 `deleteHistory=1` 释放。
- 认领与发信：托管域名的地址不占全站每人认领上限；所有者不受保留前缀限制。从托管域名发信要求 `steps.sending` 为 ready，否则返回 400。
- 添加限制：普通用户受 `hosted_domains.maxPerUser` 与同时等待生效数限制；系统域名、本站已有历史地址或邮件的域名、站长 Cloudflare 账户里已存在的 zone 一律 409；子域名或未注册域名 400。添加每人每分钟最多 5 次（包括被 Cloudflare 拒绝的，管理员也计）；全站 Cloudflare 调用额度见下文 DNS 解析的限流说明：添加时占位计 2 次（额度不足直接 429），开通前的后台预配置再计 5 次；删除计 2 次，只计数不会因额度被拒。超出任一限制或 Cloudflare 限流都返回 429 `rate_limited`，稍后重试，不要循环提交。

### 用 API Key 接入

Key `/v1` 开放托管域名的查看、添加、立即检测与 DNS 解析，路径、请求与响应和 JWT `/api` 相同，调用同一套服务：权限、添加额度、每人与全站限流、全站 Cloudflare 调用额度、`pending` 期间的规则、功能开关与凭据检查、DNS 冲突规则都与本节和下节一致。接入流程见[入口指南](../skill.md)的配方⑦。

| 方法与 `/v1` 路径 | Key scope |
|---|---|
| `GET /hosted-domains`、`GET /hosted-domains/:id` | `domain.read` |
| `GET /hosted-domains/:id/dns-records` | `domain.read` |
| `POST /hosted-domains`、`POST /hosted-domains/:id/check` | `domain.write` |
| `POST /hosted-domains/:id/dns-records`、`PUT /hosted-domains/:id/dns-records/:recordId`、`DELETE /hosted-domains/:id/dns-records/:recordId` | `domain.write` |

- 缺 scope 返回 403 `forbidden`，`fix` 写明缺哪个；scope 在解析请求体和任何计数之前检查，不占用限流与 Cloudflare 额度。已有的 Key 不会自动获得这两个 scope，由用户在网页 API Key 页面勾选（或用 JWT `PUT /api/api-keys/:id` 修改 `scopes`）。
- 每人限流按用户计数，网页与该用户的所有 Key 合计：添加每分钟 5 次、检测 10 次、DNS 解析 30 次；全站每分钟 150 次 Cloudflare 调用同样共用。
- 功能未开启或站点缺少 Cloudflare 凭据时，添加与检测返回 403，可先读公开的 `GET /api/config` 的 `hostedDomainsEnabled`；DNS 解析只要求凭据。
- 只用 JWT：`DELETE /hosted-domains/:id`（永久删除该域全部邮件）、`PUT /hosted-domains/:id`（`memberLimit`）、成员名单、过户，以及管理员的 `/admin/hosted-domains…`；`/v1` 没有这些路径，返回 404。
- 管理员的 Key 与管理员 JWT 同权，可以查看和操作任何人的托管域名；但 `GET /v1/hosted-domains` 也只列自己拥有或被共享的，全站列表只在 JWT `GET /api/admin/hosted-domains`。
- 添加域名与 DNS 记录的增改删写入管理审计，操作人记为「用户名（API Key #id）」，与网页操作区分。

### 托管域名的 DNS 解析

所有者与管理员直接读写该域名在站长 Cloudflare 账户中的 zone（JWT `/api`，或带 `domain.read`/`domain.write` 的 Key `/v1`，路径相同）。只做 DNS 解析，A/AAAA/CNAME 一律以 `proxied:false` 写入，不开启 Cloudflare 代理。

| 路径（`/api` 与 `/v1` 相同） | 说明 |
|---|---|
| `GET /hosted-domains/:id/dns-records` | 全部记录（含邮箱与只读记录），按 `name`（`@` 在最前）、`type`、`content` 排序 |
| `POST /hosted-domains/:id/dns-records` | 新增 → 201，返回该记录 |
| `PUT /hosted-domains/:id/dns-records/:recordId` | 修改，`type` 必须与原记录相同；`recordId` 为列表里的 32 位十六进制 `id` |
| `DELETE /hosted-domains/:id/dns-records/:recordId` | 删除 → `{success:true}` |

记录字段：`id,type,name,fqdn,content,ttl,priority,srv,caa,proxied,comment,kind,lockedReason,modifiedAt`。`name` 为相对名称（根域为 `@`）；`content` 是 Cloudflare 原值，TXT 可能带引号，SRV 为 `weight port target`，CAA 为 `flags tag "value"`；`ttl` 为 1 表示自动；`priority` 只有 MX 有值。

`kind` 决定能否修改，不能修改时 `lockedReason` 给出原因：

- `user`：可在本站修改、删除。在 Cloudflare 控制台建的根域 CNAME 等与邮箱冲突的现存记录也属于此类：可以删除，修改保存时返回 400 并说明冲突原因。
- `mail`：邮箱收发占用，只读。包括根域 MX 与 SPF、`_dmarc`、`_domainkey` 下的 DKIM、`cf-bounce` 子域，以及 Cloudflare 邮件服务自动维护的记录。
- `readonly`：本站不编辑的类型（如 NS）、不在支持范围内的 CAA（`flags` 不是 0/128 或 `tag` 不是 `issue|issuewild|iodef`）、已开启 Cloudflare 代理的记录，以及 Cloudflare 其他服务（如 Worker 自定义域名）自动维护的记录，只读。

请求体按 `type` 区分，新增与修改相同：

- `name`：相对名称（`@`、`www`、`_acme-challenge`、`*.dev`）或以本域名结尾的完整域名；通配符 `*` 只能在最前面。
- `ttl`：1（自动）或 60–86400 秒；`comment` 可选，最多 100 字符，修改时传空串即清除。
- A/AAAA/CNAME/TXT 用 `content`；MX 用 `content` 与 `priority`；SRV 用 `srv:{priority,weight,port,target}`，`name` 写成 `_服务._协议[.子域]`；CAA 用 `caa:{flags,tag,value}`，`flags` 为 0 或 128，`tag` 为 `issue|issuewild|iodef`。

```bash
# JWT：API="$BASE/api"；Key（domain.read/domain.write）：API="$BASE/v1"。AUTH 属于所有者或管理员；HPC_HOSTED_ID 来自 GET /hosted-domains
hpc "/hosted-domains/$HPC_HOSTED_ID/dns-records" | jq '.data[] | {id,type,name,content,kind}'
for HPC_DNS_RECORD in \
  '{"type":"A","name":"www","ttl":1,"content":"203.0.113.10"}' \
  '{"type":"TXT","name":"@","ttl":1,"content":"google-site-verification=abc"}' \
  '{"type":"MX","name":"mail","ttl":3600,"content":"mx.example.net","priority":10}' \
  '{"type":"SRV","name":"_minecraft._tcp.mc","ttl":1,"srv":{"priority":0,"weight":5,"port":25565,"target":"mc.example.net"}}'
do
  printf '%s' "$HPC_DNS_RECORD" |
    hpc "/hosted-domains/$HPC_HOSTED_ID/dns-records" -X POST -H 'Content-Type: application/json' --data-binary @-
done
```

- 受保护的记录：根域 MX、根域 SPF（`v=spf1` 开头的 TXT）、`_dmarc`、`_domainkey` 及其子域、`cf-bounce` 及其子域上的任何记录，以及根域 CNAME（与收件需要的 MX、TXT 不能共存，改用 A/AAAA）。新增或改成这些都会在写入 Cloudflare 之前返回 400；其他名称上的 SPF、MX（如 `mail` 子域）不受限制。
- 权限与状态：所有者与管理员可用，成员 403，其他用户 404。等待改 NS（`pending`）时也能读写，便于先补好网站记录；`suspended` 时所有者只读，管理员仍可修改；`deleting` 或 zone 还在创建中返回 409。只要求本站配置了 Cloudflare 凭据，不受管理员托管开关影响；未配置时 403。
- 上限与限流：每个域名最多 100 条非邮箱记录（只读记录也计入），达到后新增返回 403；四个接口共用每人每分钟 30 次（管理员同样计数）。所有域名共用站长的 Cloudflare Token，用户操作全站合计每分钟最多 150 次 Cloudflare 调用，由 DNS 解析与托管域名的添加（占位 2 次、后台预配置 5 次）、立即检测（4 次）、删除（2 次，只计数不拒绝）共用：解析列表计 1 次，新增、修改、删除各计 2 次，只计能真正调用 Cloudflare 的请求（超出个人限额、无权访问、删除中或创建中的不计）。任一超出返回 429，稍后重试。
- 常见错误：请求体不合法、修改类型、与邮箱冲突、Cloudflare 拒绝记录值返回 400，message 为具体原因；修改或删除 `mail`/`readonly` 记录返回 403，message 为 `lockedReason`；记录不存在或 `recordId` 格式不对返回 404；同名下已有相同或不能共存的记录返回 409；Cloudflare 中的 zone 已不可用返回 409，需联系管理员；Cloudflare 繁忙返回 429；超时、5xx 或响应读不出来返回 500「Cloudflare 没有返回明确结果，请刷新列表确认是否已生效」，写操作可能已经生效，先重新列出记录再决定是否重试。

