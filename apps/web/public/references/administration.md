# 管理员功能

## 目录

- [用户与邮件审阅](#用户与邮件审阅)：用户管理、审阅他人邮件
- [用户专属邮箱权限](#用户专属邮箱权限)：按用户限定可认领域名与额度
- [强制过户邮箱](#强制过户邮箱)：把邮箱连同历史转给另一个用户
- [批量邮箱操作](#批量邮箱操作)：批量认领、释放、过户、共享与取消共享
- [管理员 Key 运维接口](#管理员-key-运维接口)：用管理员 API Key 批量建邮箱、共享、过户、释放，查用户、托管域名与 Claude 状态
- [邀请码](#邀请码)
- [系统设置与域名](#系统设置与域名)：设置项、外发与中转配额、系统域名
- [投递回执与抑制名单](#投递回执与抑制名单)：回执订阅状态、抑制名单的查看与解除
- [系统域名一键接入](#系统域名一键接入)：把站长 Cloudflare 账户里的域名一键配好收发并加入系统域名
- [Key 与管理审计](#key-与管理审计)

所有 `/api/admin/*` 必须有效 **管理员 JWT**，API Key 的 scopes 不提供这些权限；运维脚本常用的邮箱、用户与托管域名操作另有管理员 Key 可调的 `/v1/admin/*`，见[管理员 Key 运维接口](#管理员-key-运维接口)。调用先 `GET /api/auth/me` 核对当前角色；没有管理员权限时报告限制，不换身份或猜测他人 ID。shell 示例复用 [入口指南](../skill.md)，设 `API="$BASE/api"`、`AUTH` 为管理员 JWT。

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

恢复公共配置提交 `{"mailboxPolicy":null,"expectedMailboxPolicyRevision":当前版本}`。保存和角色变更都会增加 `mailboxPolicyRevision`；409 时重新读取并核对当前配置，不能仅换版本强行覆盖陈旧草稿。普通用户不能修改自己的权限，API Key 也不能修改邮箱权限（管理员 Key 可用 `GET /v1/admin/users` 读取）。认领与过户在写入时复核目标权限版本、域名版本和数量，避免并发突破限制。

权限收紧、删除域名授权或恢复公共配置不会释放已有邮箱、删除邮件或撤销已有邮箱的收发能力；所有名下邮箱继续计入总额度，超额时不能新增。只读共享邮箱不计入认领额度。专属权限只作用于邮箱认领与新增过户，不替代每日外发、翻译、注册、2FA 等系统规则。用户应从自己的 `/api/domains` 或 `/v1/domains` 查询可认领域名，公开 `/api/config` 不包含个人权限。

## 强制过户邮箱

管理员 JWT 可 `POST /api/admin/mailboxes/:id/transfer`，将任意现有已认领邮箱直接转给指定的启用中用户（普通用户或管理员）。自己或别人认领的均可；此操作不经过未认领状态。目标普通用户有专属邮箱权限时，域名范围、系统保留前缀、总数和单域名数量必须符合其权限，超出时先调整配置。目标用户使用公共配置或为管理员时，保留原有强制过户豁免。它不创建尚未存在的邮箱。

先读 `GET /api/mailboxes?all=1&q=<地址片段>&limit=50`（已知邮箱 ID 时用 `GET /api/admin/mailboxes/:id`，不存在返回 404）核对邮箱 `id,address,userId`，再用 `GET /api/admin/users/search?q=用户名&excludeUserId=当前主人ID` 查找目标用户。q 为 1–32 字符的用户名片段，完全匹配优先，其次前缀和其他包含匹配；hasMore=true 时继续补充用户名缩小范围。body 为 `{userId:目标用户ID,expectedOwnerId:列表中的当前主人ID}`，两者必须是正整数。

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

详情/线程/raw 同样带 scope 与 userId，管理员审阅其他用户为只读，所有邮件状态变更（含星标）仅支持 `mine/unclaimed`。未认领邮件修改需显式 `scope=unclaimed`；默认列表只自己的认领邮箱。要查看某个已认领邮箱自己的收件或发件，用 `scope=user&userId=<归属人>&address=<完整地址>`，再以 `direction=inbound|outbound` 区分。全站地址管理用 `GET /mailboxes?all=1`（带 `limit`/`cursor` 分页、`q`/`domain` 筛选，见[邮箱列表](mailboxes-and-domains.md#发现域名与邮箱)），编辑/释放对应 `/mailboxes/:id`；管理员共享管理可处理**全站任意已认领邮箱**，成员可为启用中的普通用户或管理员。域名与共享完整契约见 [邮箱、多域名参考](mailboxes-and-domains.md)。

## 批量邮箱操作

运维批量处理邮箱用下面的接口，不要直写数据库。这里的 `/api` 路径**只接受管理员 JWT**（API Key 返回 401）；管理员 Key 用 `/v1/admin/mailboxes/batch/*` 的同名接口，见[管理员 Key 运维接口](#管理员-key-运维接口)。每次最多 100 项，items 里的地址不能重复（按小写比较），否则整批 400。

| 方法与 `/api` 路径 | body | 作用 |
|---|---|---|
| `POST /admin/mailboxes/batch/claim` | `{userId,items:[{localPart,domain,strategy?}]}` | 为该用户认领，按**该用户自己**的认领规则（域名授权、保留前缀、额度；托管域名须已生效且他是所有者或成员）。返回同 `POST /mailboxes/batch`：`{claimed,taken,notAttempted,stoppedBy}` |
| `POST /admin/mailboxes/batch/release` | `{items:[{address,expectedOwnerId?}],deleteHistory?}` | 释放并撤销共享；`deleteHistory:true` 同时永久删除这些地址的全部历史邮件（整批一个事务，地址历史很多时减小每批数量） |
| `POST /admin/mailboxes/batch/transfer` | `{userId,items:[{address,expectedOwnerId}]}` | 过户给同一用户，规则同[强制过户](#强制过户邮箱)：保留历史、撤销旧共享；目标为专属配置的普通用户时按其额度逐项累计 |
| `POST /admin/mailboxes/batch/share` | `{userIds,items:[{address,expectedOwnerId?}]}` | 把这批用户追加进每个邮箱的名单，不移除已有成员，不加入所有者，每只邮箱最多 100 人 |
| `POST /admin/mailboxes/batch/unshare` | 同 share | 从每个邮箱的名单里移除这批用户 |

除 claim 外返回 `{results,done,unchanged,failed}`，results 与 items 同序，每项 `{address,status,mailboxId,ownerId,error}`，另按操作带 `deletedMessages`、`revokedShares`（释放与过户撤销的共享数，取消共享移除的人数）或 `addedShares`。status 为 `done`、`unchanged`（已归目标用户，或成员都已在/都不在名单里）或 `failed`；failed 时 `error:{code,message}`：`not_found` 邮箱不存在，`conflict` 当前所有者与 expectedOwnerId 不符，`forbidden`/`validation_failed` 不符合目标用户的权限或名单已满。

**事务语义是逐项结果**：读取后逐项校验，失败项不影响其他项；其余项在同一个事务里一起提交，提交时复核读取时的所有者、目标用户与被分享人状态、额度，有任何变化则**整批不做**并返回 409 `conflict`，重新执行即可。超时后重试同一请求时，上次已完成的项会报 `unchanged`（过户、共享、取消共享）或 `not_found`（释放）。认领例外，沿用批量认领语义：按顺序认领，被占用的跳过，首个业务错误停止，之前认领的保留。整批错误：400 参数、被分享人不存在或已禁用、目标用户已禁用；404 目标用户不存在；409 提交前状态已变。

```bash
# 释放并删除历史，只处理仍归 $HPC_OWNER_ID 的地址
jq -n --argjson owner "$HPC_OWNER_ID" \
  '{deleteHistory:true,items:[{address:"a@example.com",expectedOwnerId:$owner},{address:"b@example.com",expectedOwnerId:$owner}]}' |
  hpc '/admin/mailboxes/batch/release' -X POST -H 'Content-Type: application/json' --data-binary @-
```

每项写一行管理审计，action 与单个操作相同：`mailbox.claim`、`mailbox.release`、`mailbox.transfer`、`mailbox.share`、`mailbox.unshare`；target 为地址，detail 末尾带 `批量请求 <请求 id>`（即响应头 `X-Request-ID`），可据此找出同一批的全部记录。

## 管理员 Key 运维接口

运维脚本（批量建邮箱、共享、过户、释放，查归属、托管域名与 Claude 状态）用管理员 Key 调 `/v1/admin/*`，不要直连 D1 写 SQL：这些接口与 `/api/admin/*` 一样逐项校验、在事务里提交并写管理审计。

**管理员 Key** 是管理员账户创建、勾选 `admin` scope（网页「管理员能力」）的 API Key，IP 白名单与有效期可选。`GET /v1/me` 的 `key.effectiveRole` 为 `admin`、且没有设置 `allowedMailboxIds` 与 `allowedDomains`（不限范围）才能调用；普通用户的 Key、没带 `admin` 的管理员 Key、限定了邮箱或域名的管理员 Key 一律 403 `forbidden`，`fix` 写明怎么处理。除 `admin` 外，每个接口还要下表 scope 列里的读写 scope：写入要 `mailbox.write`，查邮箱、用户与托管域名要 `mailbox.read`，Claude 查询要 `mail.read`，缺少时 403，message 写明缺哪个。只带 `mailbox.read`、`mail.read` 与 `admin` 的 Key 是只读的管理员 Key。限流同其他 `/v1` 请求。写操作每项一行管理审计，操作人是 Key 所属管理员的用户名，detail 末尾为 `批量请求 <请求 id>（API Key #id）`。shell 示例复用[入口指南](../skill.md)，设 `API="$BASE/v1"`、`AUTH` 为管理员 Key。

### 写入

| 方法与路径 | scope | body | 作用 |
|---|---|---|---|
| `POST /v1/admin/mailboxes/batch/claim` | `admin` + `mailbox.write` | `{userId,items:[{localPart,domain,strategy?}],shareUserIds?}` | 为该用户认领，规则同[批量邮箱操作](#批量邮箱操作)，返回 `{claimed,taken,notAttempted,stoppedBy,shares}`。`shareUserIds` 非空时把本次 `claimed` 的邮箱共享给这些用户，`shares` 为逐项结果；不给或为 `[]` 时 `shares:null` |
| `POST /v1/admin/mailboxes/batch/release` | `admin` + `mailbox.write` | `{items:[{address,expectedOwnerId?}],deleteHistory?}` | 释放并撤销共享；`deleteHistory:true` 同时永久删除这些地址的全部历史邮件 |
| `POST /v1/admin/mailboxes/batch/transfer` | `admin` + `mailbox.write` | `{userId,items:[{address,expectedOwnerId}]}` | 过户给同一用户，保留历史、撤销旧共享 |
| `POST /v1/admin/mailboxes/batch/share` | `admin` + `mailbox.write` | `{userIds,items:[{address,expectedOwnerId?}]}` | 把这批用户追加进每个邮箱的共享名单，不加入所有者 |
| `POST /v1/admin/mailboxes/batch/unshare` | `admin` + `mailbox.write` | 同 share | 从每个邮箱的名单移除这批用户 |
| `PUT /v1/admin/mailboxes/shares` | `admin` + `mailbox.write` | `{userIds,items:[{address,expectedOwnerId?}]}` | 把每个邮箱的共享名单**精确替换**为 `userIds`，`[]` 清空；每项同时带 `addedShares` 与 `revokedShares` |

每次 1–100 项，地址不能重复；`userIds`、`shareUserIds` 最多 100 个。除认领外返回 `{results,done,unchanged,failed}`，results 与 items 同序，每项 `status` 为 `done`、`unchanged`（已是目标状态；超时重试时上次已完成的项也报它）或 `failed`（`error:{code,message}`：`not_found` 邮箱不存在，`conflict` 所有者与 `expectedOwnerId` 不符；替换名单时 `userIds` 含该邮箱所有者为 `validation_failed`）。事务语义和整批 400/404/409 同[批量邮箱操作](#批量邮箱操作)，409 时重新读取再执行。

认领带 `shareUserIds` 时：先校验这些用户，有不存在、已禁用或系统保留的用户时整批 400，什么都不认领；共享只作用于本次 `claimed`（落进 `taken` 的已被别人认领，不共享），名单含 `userId` 本人时不加入所有者。认领提交后共享这一步整体失败（如并发修改导致 409）时认领保留，每个新认领的地址在 `shares.results` 记为 `failed` 并带错误码，对这些地址重试 `batch/share` 即可。

### 查询

列表参数逗号分隔（也可重复参数），每项先规整（转小写、去空白）再去重，去重后 1–200 项，超出或格式错误返回 400 `validation_failed`。`data` 直接是数组，查询不写审计。

| 方法与路径 | scope | 参数 | 返回 `data` |
|---|---|---|---|
| `GET /v1/admin/mailboxes` | `admin` + `mailbox.read` | `addresses` 或 `domain`，二选一 | 已认领邮箱 `[{id,address,domain,ownerId,ownerUsername,grantees:[{userId,username}],createdAt}]`，按 address 排序；未认领或不存在的地址不出现；`domain` 返回该域全部已认领邮箱，不分页 |
| `GET /v1/admin/users` | `admin` + `mailbox.read` | `usernames` | `[{id,username,role,status,mailboxPolicy,mailboxPolicyRevision,createdAt}]`，按 username 排序；不存在的用户名不出现；`mailboxPolicy:null` 表示使用公共配置 |
| `GET /v1/admin/hosted-domains` | `admin` + `mailbox.read` | `domains`、`owner`（用户名），都可选 | `[{id,domain,ownerId,ownerUsername,status,zoneStatus,routingStatus,sendingStatus,catchAllReady,ready,createdAt}]`，按 id 排序；都不给返回全站，同时给取交集，`owner` 不存在返回 `[]`；`ready:true` 表示收发都已就绪 |
| `GET /v1/admin/claude/domains` | `admin` + `mail.read` | `domains` | 每个后缀一项、与请求同序：`{domain,addresses,paid,suspended,suspendedAddresses:[{address,suspendedAt}]}`，即有 Claude 账号事实或收据的地址数、付费数、封号数与封号地址，`paid` 与地址视图同一口径；没有记录的后缀计数为 0 |
| `GET /v1/admin/claude/addresses` | `admin` + `mail.read` | `addresses` | 每个地址一项、与请求同序：`{address,domain,known,firstSeenAt,paid,suspended,suspendedAt,anthropicMails,lastAnthropicMailAt,loginLinkMails,receipts,tier}`；没有 Anthropic 来信的地址 `known:false` |

Claude 状态的口径：

- `paid`、`suspended` 与收据只认 Anthropic 官方发件域（`email.claude.com`、`mail.anthropic.com`、`research.anthropic.com`、`anthropic-safeguards.intercom-mail.com`）、DKIM 对齐且收件地址在 To 头里的来信。主题以 `Your account has been suspended` 开头记封号，以 `Your receipt from Anthropic` 开头或含 `subscription is confirmed` 记付费；有收据的地址也算付费，后缀汇总的 `paid` 与地址视图同一口径（事实表标了付费或有收据）。2026-11-17T16:00Z 之前收到、没有认证结果的历史收据按发件域与主题计入。两个标志只会由否变是。
- `receipts` 按收到时间升序，每张 `{messageId,receivedAt,subject,amountCents,currency,tier,cardLast4}`：金额以分计，`cardLast4` 是扣款卡尾号，解析不到的字段为 null；原邮件永久删除后 `messageId` 为 null，收据保留。顶层 `tier` 取最近一张能识别金额的收据：$100 为 `5x`，$200 为 `20x`，其他金额为 null。
- `anthropicMails`、`lastAnthropicMailAt` 统计发件域为 `anthropic.com`、`claude.com` 及其子域的来信（含回收站，不含已永久删除的），`anthropicMails > 0` 即收到过 Anthropic 来信（注册、登录链接等）；`loginLinkMails` 是其中登录链接邮件（主题以 `Secure link to log in to Claude` 或 `Your secure link to Claude` 开头）的数量。
- 账号事实（`claude_address_facts`）与收据（`claude_receipts`）是只给管理员看的运维事实：邮件永久删除前先归纳留存，永久删除邮件、释放并清空历史、保留期清理都不会清掉它们。这是有意的设计，删信后后缀统计、档位与卡尾号仍可查。
- 历史邮件由定时任务每 5 分钟分批回填，回填完成前历史收据与标志会陆续出现，不能据空结果断定没有收据。

### 运维配方

```bash
# API="$BASE/v1"，AUTH 为管理员 Key；ADDRS 为逗号分隔的完整地址
hpc '/me' | jq -e '.data.key.effectiveRole == "admin"' >/dev/null || { echo '不是管理员 Key'; exit 1; }
uid() { hpc '/admin/users' --get --data-urlencode "usernames=$1" | jq -er '.data[0].id'; }   # 用户名 → id，不存在时失败
```

① 在托管域名上新建邮箱，归域名主人并共享给开号人：

```bash
HD=$(hpc '/admin/hosted-domains' --get --data-urlencode "domains=$DOMAIN" | jq -ec '.data[0] | select(.ready)') || exit 1   # 收发未就绪不认领
OPENER_ID=$(uid "$OPENER") || exit 1
jq -n --argjson hd "$HD" --argjson opener "$OPENER_ID" --arg d "$DOMAIN" \
  '{userId:$hd.ownerId, shareUserIds:[$opener], items:[{localPart:"a1",domain:$d},{localPart:"a2",domain:$d}]}' |
  hpc '/admin/mailboxes/batch/claim' -X POST -H 'Content-Type: application/json' --data-binary @- |
  jq '.data | {claimed:[.claimed[].address], taken:[.taken[] | "\(.localPart)@\(.domain)"], stoppedBy, shares:(.shares | {done,failed})}'
```

② 转交开号人：把这批邮箱的共享名单换成新开号人（旧成员一并移除）：

```bash
NEW_ID=$(uid "$NEW_OPENER") || exit 1
hpc '/admin/mailboxes' --get --data-urlencode "addresses=$ADDRS" |   # 结果里缺的地址是未认领的，先报告
  jq --argjson u "$NEW_ID" '{userIds:[$u], items:[.data[] | {address,expectedOwnerId:.ownerId}]}' |
  hpc '/admin/mailboxes/shares' -X PUT -H 'Content-Type: application/json' --data-binary @- | jq '.data | {done,unchanged,failed}'
```

③ 过户给买家（旧共享全部撤销，还要共享时过户后再调 `batch/share`）：

```bash
BUYER_ID=$(uid "$BUYER") || exit 1
hpc '/admin/mailboxes' --get --data-urlencode "addresses=$ADDRS" |
  jq --argjson u "$BUYER_ID" '{userId:$u, items:[.data[] | {address,expectedOwnerId:.ownerId}]}' |
  hpc '/admin/mailboxes/batch/transfer' -X POST -H 'Content-Type: application/json' --data-binary @- | jq '.data | {done,unchanged,failed}'
```

④ 释放收到过 Anthropic 来信的邮箱。默认保留历史给下一个认领者，用户明确要求清除时才加 `deleteHistory:true`；Claude 状态不随删信丢失：

```bash
USED=$(hpc '/admin/claude/addresses' --get --data-urlencode "addresses=$ADDRS" |
  jq -r '[.data[] | select(.anthropicMails > 0) | .address] | join(",")')
[ -n "$USED" ] && hpc '/admin/mailboxes' --get --data-urlencode "addresses=$USED" |
  jq '{items:[.data[] | {address,expectedOwnerId:.ownerId}]}' |
  hpc '/admin/mailboxes/batch/release' -X POST -H 'Content-Type: application/json' --data-binary @- | jq '.data | {done,failed}'
```

⑤ 按后缀查封号：

```bash
hpc '/admin/claude/domains' --get --data-urlencode 'domains=a.example,b.example' |
  jq -r '.data[] | "\(.domain) 付费 \(.paid) 封号 \(.suspended) \([.suspendedAddresses[].address] | join(" "))"'
```

⑥ 按地址查档位与卡尾号（`tier` 为 null 时看 `receipts`：没有收据或金额不是 $100/$200 时如实报告，不推断档位）：

```bash
hpc '/admin/claude/addresses' --get --data-urlencode "addresses=$ADDRS" |
  jq '.data[] | {address, tier, paid, suspended, receipts:[.receipts[] | {receivedAt,amountCents,tier,cardLast4}]}'
```

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
| `quota` | `{dailyOutbound,dailyRecipients,relayDaily,relayPerUserDaily,relayUnclaimedDaily}`；普通用户每日外发邮件数 0–100000、唯一收件地址数 0–1000000，跨 Key/JWT 共用，admin 豁免（用户可用 `/v1/me` 查看自己的用量）；`relayDaily`/`relayPerUserDaily`（0–100000，默认 300/50）是邮箱隐私转发经本站发信身份中转重发的全站与每位归属人每日上限，含管理员；`relayUnclaimedDaily`（默认 50）是未认领地址（归管理员）来信中转的全站合计上限，不按管理员人数叠加，免得外部灌信耗尽全站中转额度。所有自动转发计入，超限的转发记为跳过，因额度跳过的不占域名与目标计数。0 均为不限 |
| `retention` | `{unclaimedDays,allMessagesDays}`；0–3650 天，0 关闭该项定时清理 |
| `ai_model` | `{baseUrl,apiKey,model}`；全站唯一的 AI 模型（OpenAI 兼容 Chat Completions），翻译与验证码 AI 兜底共用；三项都非空才算已配置。baseUrl 为 https 根地址，不含 `/chat/completions`；apiKey 只写，回显为 `******`，提交 `******` 保留原值、空串清除；沿用已存 Key 时 baseUrl 的 origin 与路径必须与已保存的一致（协议、主机、端口或路径变化都算换了接口，末尾斜杠视为相同），否则仍提交 `******` 返回 400 `validation_failed`，需要重新填写 apiKey，防止已存的 Key 被发往新地址；清空 baseUrl 可沿用已存 Key |
| `translation` | `{enabled,dailyCharsPerUser}`；AI 翻译开关与额度。enabled=true 要求 `ai_model` 已配置，同一请求同时提交两者时按合并后的结果校验（翻译开着时不能单独清空模型）；dailyCharsPerUser 0–10000000，每用户每 UTC 日发送给模型的字符数，0 不限，admin 不豁免 |
| `hosted_domains` | `{enabled,maxPerUser,maxPendingPerUser,maxPendingTotal,pendingDays,autoClaimLimit}`；用户托管域名开关与额度（Worker 还需配置 Cloudflare 凭据，`/api/config` 的 `hostedDomainsEnabled` 反映两者）。maxPerUser 0–1000（0 不限）为普通用户最多拥有的域名数；maxPendingPerUser 1–100 与 maxPendingTotal 1–1000 限制同时等待 NS 生效的数量，保护站长 Cloudflare 账户的添加额度；pendingDays 1–28 天未改 NS 自动删除；autoClaimLimit 0–100000（默认 0 不限）为每个托管域名自动认领的地址上限，设为正数时域内地址达到后未认领新地址的来信拒收，手动认领始终不受限。管理员不受个人上限，受全站等待数限制。全站托管域名、暂停/恢复与凭据健康检查见 `/api/admin/hosted-domains…`，详情、成员、过户、删除复用 `/api/hosted-domains/:id…`（管理员有全部权限），见[邮箱参考](mailboxes-and-domains.md#用户托管域名) |
| `delivery_events` | `{enabled}`，默认 true；外发投递回执的事件订阅开关。关闭只停止新建订阅，已有订阅的事件仍会回写，见[投递回执与抑制名单](#投递回执与抑制名单) |

外发 dailyRecipients 以每次请求去重后的收件地址计数，不是跨全天同一收件人只计一次；站内/外收件均计入。系统当前策略必须先读取，不把 schema 默认值当线上设置。

retention.unclaimedDays 对当时未认领地址的旧 inbound 生效；allMessagesDays 对所有旧邮件生效，包括已认领及已发送。设置清理期限可能在下一次定时任务永久删除已有历史，按用户授权范围修改；0 不清理会继续增长，不能自动替用户开启破坏性策略。回收站 7 天清理和未发送上传附件的 24 小时清理是独立机制，不受这两个 0 禁用。DNS 接入检测 `GET /admin/settings/domain-status` 及多域并发控制见域名参考。

AI 模型默认未配置，翻译与自动 AI 提码默认关闭；翻译与验证码 AI 兜底只用这里配置的模型。配置 `ai_model`（例如 DeepSeek：`baseUrl=https://api.deepseek.com`、`model=deepseek-flash`）后，邮件内容会在两种情况下发送到该第三方服务：① 翻译启用后，用户在网页邮件详情点「翻译」时，主题与正文中的文字片段；只有能在该邮件中找到的片段才会发送，模型请求中的 URL、邮箱和验证码形态字段用占位符替代后发送，处理完成后恢复，译文缓存在本站并随邮件永久删除一并删除；② `code_extract.aiEnabled` 开启时，正则没提到码、且主题或正文（不含 URL）出现验证码相关词（验证码、code、OTP、passcode、PIN、verification、one-time 等）的入站邮件，其主题和正文前 6000 字符（发送前遮盖敏感字段），每域每日最多 500 封，10 秒超时；只让点链接的邮件不发送，模型返回的码必须在原文中出现才采用。是否把邮件内容交给第三方处理属于隐私决定，按用户授权和所在组织的数据政策决定是否配置，不要替用户开启。`GET /api/config` 的 `translationEnabled` 只公开是否可用，不公开服务地址或 Key。翻译接口 `POST /api/messages/:id/translate`（仅 JWT）的请求、限额与错误见[邮件参考](mail.md#读取与搜索)。

`POST /admin/settings/ai-model-test` 用固定英文示例按翻译格式真实调用一次 AI 模型，返回 `{ok:true,latencyMs,sample}`；body 可省略，`{baseUrl,apiKey,model}` 中未提交或为空的字段、以及 apiKey 为 `******` 时用已保存的 `ai_model`，不要求任何功能已启用，便于保存前验证。沿用已存 apiKey（未填、空串或 `******`）时 baseUrl 的 origin 与路径必须与已保存的一致（末尾斜杠视为相同），否则返回 400 `validation_failed`，要测试新地址需同时填写 apiKey。三项解析后仍缺失返回 400；服务失败返回 500，message 说明 HTTP 状态码、超时或返回格式无效，不回显 Key。测试会产生一次真实外部调用，不计用户额度。

通知/转发已为个人偏好，不在上述系统设置中；通过 `/api/me/notify-prefs` 修改当前管理员的个人通道，不能 PUT 旧全局 `feishu/notify_webhook/gmail_forward` 字段。

## 投递回执与抑制名单

外发投递回执来自 Cloudflare Email Sending 的事件订阅：送达、退信、失败、拒绝、投诉事件按发信域名投递到部署时配置的 Queue，本站据此回写发件的逐收件人结果（见[投递回执](mail.md#投递回执)），退信与投诉的收件人进入抑制名单（见[抑制名单](mail.md#抑制名单)）。这个功能需要站长在部署时显式启用（GitHub Variable `DELIVERY_EVENTS_QUEUE`）；没启用时 `GET /admin/delivery-events` 的 `queue` 为 null，不建订阅、发信也不查抑制名单。启用后，设置 `delivery_events.enabled` 开启（默认）且 Worker 有 Cloudflare 凭据时，定时任务每 5 分钟为还没有订阅的系统域名补建订阅、每日核对一次，托管域名开通发信时立即订阅。关闭后不再新建订阅，已有订阅的事件仍会回写。

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/delivery-events` | `{enabled,credentials,queue,subscriptions:[{domain,kind,zoneId,subscriptionId,status,lastError,checkedAt}]}`；`queue` 为部署配置的队列名，null 表示部署未启用；`kind` 为 `system\|hosted`，`status` 为 `active`（已订阅）或 `error`（建立失败，见 `lastError`，定时任务约 6 小时后重试）。只列定时任务处理过的域名 |
| `GET /admin/suppressions?q=…&cursor=…&limit=30` | 有效（未过期）的抑制条目，按 id 倒序分页；`q` 按收件地址或发信域名包含匹配，不区分大小写；limit 1–100，默认 30 |
| `DELETE /admin/suppressions/:id` | 解除一条，`{success:true}`；不存在返回 404 `not_found`；记管理审计 `suppression.delete`（target 为收件地址，detail 为「发信域名 <域名>」） |

抑制条目为 `{id,address,reason,sendingDomain,since,expiresAt,detail,updatedAt}`：`reason` 为 `hard_bounce`（永久退信）、`soft_bounce`（临时失败且重试耗尽）或 `complaint`（被标为垃圾邮件）；`expiresAt` 为 null 表示长期有效，只能由管理员解除；`detail` 是收件服务器的退信说明或投诉类型。条目只拦从 `sendingDomain` 发给该地址的信。解除前先确认对方地址已恢复（例如用户确认邮箱可用），解除后下一次发信才会重新尝试；投诉条目按用户授权处理，不要为了让发信通过而批量解除。解除只删本站条目，Cloudflare 侧的抑制需要在 Cloudflare 控制台另行解除，否则发送仍会被它拒绝。

`credentials:false` 时不会自动建立订阅；没有订阅的域名收不到回执，结果停在 `sent`。建立订阅需要 Worker 的 Cloudflare Token（部署时的 `CF_HOSTED_DOMAINS_TOKEN`）具有 Account → Queues:Edit 权限，系统域名还要求它能读取域名所在的 zone，缺权限时 `lastError` 会给出提示。Token 读不到的系统域名可由站长在 Cloudflare 侧为该域名手动建立同一 Queue 的 email.sending 订阅，下一次重试或每日核对会识别并标为 `active`。

## 系统域名一键接入

只用管理员 JWT（`/api`），API Key 与 `/v1` 都没有这些接口。Worker 配有 Cloudflare 凭据即可用，不受 `hosted_domains.enabled` 开关控制。它替管理员在站长 Cloudflare 账户里开启 Email Routing、把 catch-all 指向本站 Worker、接入 Email Sending，收发都就绪后把域名追加到 `settings.domains.list`（`{public:false,perUserLimit:0,random:true}`，之后照常用 `PUT /admin/settings` 调整）。

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/system-domains/zones?hidden=0\|1&refresh=0\|1` | 账户 zone 分类：`zones` 是可接入（available）与接入中（onboarding，行上带任务摘要），`others` 是已是系统域名、用户托管（管理员名下的会标出）与记录不一致；每次最多预检 10 个可接入 zone 给出 `readiness.verdict`（ready/confirm/blocked/pending），其余 `unchecked`；无凭据时 `configured:false` |
| `GET /admin/system-domains/precheck?mode=existing_zone&zoneId=…` 或 `?mode=new_zone&domain=…` | 只读预检：`checks`（severity none/info/confirm/blocker）、计划 `steps`、`requiredAcks`、`fingerprint`、RDAP 注册商；业务冲突不报错 |
| `POST /admin/system-domains/onboardings` | 一键接入，体 `{mode,zoneId\|domain,fingerprint?,accept?}`；201 新建，同域名同方式进行中任务重放 200；需确认或有阻断时 409，`error.details.precheck` 带最新预检 |
| `GET /admin/system-domains/onboardings?active=0\|1` | 任务列表（倒序） |
| `GET /admin/system-domains/onboardings/:id` | 任务详情：分项 `steps`、最近预检、已确认项、变更台账 `changes`（含原值） |
| `POST /admin/system-domains/onboardings/:id/check` | 立即检测或重试；15 秒内重复或正在处理时直接返回当前状态 |
| `POST /admin/system-domains/onboardings/:id/confirm` | 只用于 `needs_confirmation`（远端在确认后又变了）：带 `fingerprint` 与 `accept`；指纹过期 409 并附新预检 |
| `POST /admin/system-domains/onboardings/:id/cancel` | 取消，体 `{deleteCreatedZone?}`；只有本任务创建且从未激活的 zone 才能删（`canDeleteZone`），否则 400 |
| `PUT /admin/system-domains/hidden-zones` | `{domain,hidden,expectedRevision}` 隐藏或恢复可接入列表中的 zone，revision 过期 409 |

流程：读 zones → 选一个 available zone → `verdict=ready` 直接 POST；`confirm` 先 GET precheck，把要确认的变更逐条告诉用户、取得授权后带 `fingerprint` 与 `accept`（即 `requiredAcks`）POST；`blocked` 按 `checks` 里的说明处理后再检测。任务状态 `creating_zone → awaiting_ns → configuring → finalizing → completed`，`needs_confirmation`、`blocked` 等人处理（blocked 每 30 分钟自动复检），每 5 分钟由定时任务推进；轮询详情即可。

```bash
# API="$BASE/api"，AUTH 为管理员 JWT；HPC_ZONE_ID 来自 zones，用户已确认 requiredAcks 中的每一项
PRECHECK=$(hpc "/admin/system-domains/precheck?mode=existing_zone&zoneId=$HPC_ZONE_ID")
jq --arg zone "$HPC_ZONE_ID" '{mode:"existing_zone",zoneId:$zone,fingerprint:.data.fingerprint,accept:.data.requiredAcks}' <<< "$PRECHECK" |
  hpc '/admin/system-domains/onboardings' -X POST -H 'Content-Type: application/json' --data-binary @-
```

需确认项（`ack`）的含义，每一项都要先征得用户同意：

- `mx.delete`（危险）：根域有第三方 MX 或 null MX。确认后系统删除这些记录并紧接着开启 Email Routing，该域名**不再经原服务商收信**；原记录写进台账，可手动恢复。删除后 Routing 没开起来时任务 `blocked`、`errorCode=mx_removed_routing_pending`，按最短间隔重试。
- `catchAll.replace`：catch-all 正指向其他 Worker、转发或丢弃，替换后原目标收不到这个域名的信。由其他 Worker 的 wrangler `addresses` 管理的 catch-all 是阻断项，不能替换。
- `spf.merge`：把 `include:_spf.mx.cloudflare.net` 合并进唯一的一条 SPF；多条 SPF、含宏、超过 10 次查询为阻断项。
- `rules.bypass`：启用中的专用地址规则优先于 catch-all，这些地址的来信不进本站（不修改规则）。
- `dmarc.create`：没有 `_dmarc` 且域名另有邮件服务，接入发信时 Cloudflare 会写入 `p=reject`。
- `ns.change`：`new_zone` 要把 NS 改到 Cloudflare，影响整个域名的 DNS；原记录不会自动迁移。

规则与边界：

- 任意读取失败都是阻断项，不会当作「不存在」去写入；不自动回滚，不关闭 Routing、不删除发信子域，只有取消时可删除本任务新建且从未激活的 zone。
- 系统域名、用户托管域名与进行中的接入任务三方同名互斥；`new_zone` 新建的待激活 zone 与托管域名一起计入 `hosted_domains.maxPendingTotal`。
- 接入完成前到达的来信按「未认领」收下。之后从系统域名列表移除不会停止 Cloudflare 的收件路由。
- Cloudflare 调用另有额度：每 5 分钟 120 次；超出或 Cloudflare 返回 429 后的退避期内，这些接口返回 429 `rate_limited`。
- 审计 action：`system_domain.create`、`.confirm`、`.cancel`、`.complete`、`.zone_delete`、`.fail`、`.hide`、`.unhide`。

## Key 与管理审计

| 方法与 `/api` 路径 | 契约 |
|---|---|
| `GET /admin/api-keys` | 全站 Key 元数据数组，含 ownerUsername 与已吊销记录，无明文 key |
| `GET /admin/api-keys/:id` | 目标有效/禁用 Key 元数据；已吊销可能 404 |
| `GET /admin/api-keys/:id/logs?cursor=…&limit=30` | 目标 Key 调用审计分页 |
| `DELETE /admin/api-keys/:id` | 吊销目标 Key，`{success:true}` |
| `GET /admin/audit-logs?cursor=…&limit=30` | 管理操作审计分页 |

管理员全站 Key 接口没有 PUT；自己 Key 的创建/更新仍用 `/api/api-keys`，不能把 admin metadata 查询当明文找回。审计默认页大小 30、最大 100，倒序读到 nextCursor=null；管理日志含 `id,actorName,action,target,detail,ip,createdAt`；`settings.update` 的 target 只列实际变化的设置键（不含 `expectedDomainsRevision`），detail 为变更摘要，如域名新增/移除、公开性与每人上限变化、`mailbox_policy.perUserLimit: 50→20`；`ai_model.apiKey` 只记「已更新/已清除」，不记录值，Key 日志字段见鉴权参考，保留约 90 天。

管理员对他人邮箱与邮件的操作也会留痕：释放他人邮箱记 `mailbox.release`（原所有者、保留或永久删除历史及条数），改他人邮箱发件名记 `mailbox.update`（前后值），`scope=unclaimed` 的永久删除记 `mail.purge_unclaimed`（条数与请求的 id），`scope=user` 读取他人邮件（列表、同步、详情、线程、原始邮件、附件等）记 `mail.read_user`，target 为 `user#目标用户ID`，每个管理员对每个用户每 UTC 日只记一条。经 `/v1` 的操作以 Key 所属用户为操作者，detail 末尾标注 `（API Key #id）`。只根据已看到的审计区间报告结果，不声称此接口是全部应用运行日志或队列监控。生产部署、Cloudflare DNS/Routing、数据库/R2 运维不是这些管理接口提供的能力。
