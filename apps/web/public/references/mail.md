# 邮件、验证码与发送

## 目录

- [读取与搜索](#读取与搜索)：列表参数、摘要与详情字段、翻译、管理员 scope
- [增量同步](#增量同步)：`afterId` 拉新邮件，避免重复读取详情；复查详情用 `If-None-Match`（304）
- [等待本次验证码](#等待本次验证码)：`/v1/messages/wait` 的过滤、多地址、`include=body` 与游标、Python 示例
- [维护状态与回收站](#维护状态与回收站)：已读、全部已读、星标、删除、恢复、永久删除
- [发送](#发送)：请求字段，[发件身份](#发件身份)、[收件人与显示名](#收件人与显示名)、[自定义邮件头](#自定义邮件头)、[结果与状态](#结果与状态)、[幂等与重试](#幂等与重试)、[回复和转发](#回复和转发)（含回复站外邮件）、[部分失败补发](#部分失败补发)

shell 示例复用 [入口指南](../skill.md) 的 `hpc()`、`BASE`、`UA`、`API`、`AUTH`。邮件读/维护路径在 `/api` 与 `/v1` 相同；JWT 无 Key scope，Key 需下面的 scope。唯有发送是 `/api/messages/send` 对应 `/v1/messages`，长轮询仅 `/v1`。

## 读取与搜索

| 方法与相对路径 | Key scope | 结果 |
|---|---|---|
| `GET /messages` | `mail.read` | 邮件摘要分页 |
| `GET /messages/:id` | `mail.read` | 邮件详情；读取本身不自动标记已读 |
| `GET /messages/:id/thread` | `mail.read` | `{items:[摘要...]}`；有界线程视图，优先按线程头关联；无法关联时仅对带 `Re:/Fwd:/Fw:/回复:/转发:` 前缀、且双方都没有验证码的同地址同主题邮件（30 天内）回退归并，不是独立分页或完整历史承诺 |
| `GET /messages/:id/raw` | `mail.read` | 原始 `.eml` 二进制；仅有原始存档的邮件可下载，404 不代表正文不存在 |
| `POST /messages/:id/translate` | 仅 JWT（`/api`） | `{translations,cached,skipped}`；把该邮件的文字片段译成简体中文，见下文 |
| `GET /messages/contacts` | `mail.read` | `{contacts:[邮箱...]}`，自己的近期联系人，不是完整通讯录 |
| `GET /messages/unread-count` | `mail.read` | `{unread:number}`；未读数只统计你认领的地址，共享邮件的已读状态属于所有者、不计入；不是全站统计。`/api` 最多数到 1000（界面角标用），`/v1` 返回精确值。`/v1` 可带 `scope=mine`，其他 scope 值返回 400 `validation_failed`，管理员也不能借此统计未认领地址 |
| `GET /messages/sync` | 仅 JWT（`/api`） | `{unread,head}`；网页轮询用：参数同列表（忽略 `cursor`、`afterId`），`unread` 同 `/api/messages/unread-count`，`head` 与同筛选列表首页的 `head` 相同即首页没有变化。Agent 等新邮件用 `/v1/messages/wait` |
| `GET /v1/messages/wait` | `mail.read` | `{message:摘要\|详情\|null,scannedThroughId}`，带 `include=body` 时命中返回详情结构，见下文 |

列表支持 `direction=inbound|outbound`、`address`（完整地址）、`domain`、`q`（最长 256 字符，主题/发件地址/发件名/文本正文/收件人子串）、`unread=1`（只匹配你认领的地址，共享邮件不出现在未读筛选里）、`starred=1`、`trash=1`、`afterId`（非负安全整数，0 是合法空基线）、`cursor`、`limit`（1–100）。布尔查询接受 `1/true/0/false`；`unread=0` 与 `starred=0` 表示不筛选，不是“只看已读/未星标”。`trash=1` 只看软删除，未传看非回收站。

```bash
hpc '/messages' --get --data-urlencode 'direction=inbound' \
  --data-urlencode "address=$HPC_MAIL_ADDRESS" --data-urlencode 'limit=30'
hpc '/messages' --get --data-urlencode 'q=验证码' --data-urlencode 'unread=1'
```

`/api` 列表首页（不带 `cursor`、`afterId`）另带 `head`，是该页内容的不透明指纹，只用于和 `/api/messages/sync` 比较是否相等；`/v1` 列表没有该字段。后续页带 `cursor=<data.nextCursor>`，保留过滤条件。`cursor` 只用服务器返回的值：伪造或截断后无法解码时返回 400 `validation_failed`，不会静默从首页重来（API Key 调用日志、管理员审计日志的分页同样如此）。

摘要包含 `id,direction,address,domain,fromAddress,fromName,subject,preview,verificationCode,verificationLink,status,errorDetail,isRead,isStarred,hasAttachments,size,createdAt`，发件还可含 `recipientsTo,recipientOutcomes`；`trash=1` 列表的每项另有 `deletedAt`（进入回收站时间，7 天后永久删除）。`verificationLink` 是收件时识别出的 http/https 验证、登录、激活或重置密码链接，识别不到、发件、关闭自动提取或功能上线前收到的邮件为空串，见[等待本次验证码](#等待本次验证码)的安全要求。详情增加 `recipients:{to,cc,bcc}`、`replyTo` 数组（都是纯地址字符串）、`bodyText,bodyHtml,attachments,hasRaw`；附件项的 `inline:true` 表示正文已用 `cid:` 引用并就地显示它（内联图片），不必再当附件列出，`hasAttachments` 也不计这类内联图。BCC 不在收件副本中披露。`status=degraded` 表示收件解析/附件降级，应说明 `errorDetail`、核对 `hasRaw`，不能承诺内容完整。

翻译 `POST /api/messages/:id/translate` 只接受 JWT，`/v1` 没有对应接口；管理员未启用翻译或未配置 AI 模型（`/api/config` 的 `translationEnabled=false`）时返回 403。body `{segments:[...]}`：1–60 段，单段 ≤2000 字符，合计 ≤6000 字符，长邮件分多次请求；scope/userId 与详情相同。返回 `translations` 与 segments 一一对应。只有能在该邮件主题或完整正文中找到的片段（比对只看字母和数字，忽略 HTML 标签、实体、标点、空白和大小写）才会发送给管理员配置的第三方模型，找不到的原样返回并计入 `skipped`；去掉 URL、邮箱后没有字母的片段（验证码、数字、标点）原样返回且不计费；相同片段只发一次。同一邮件同一组片段命中缓存时 `cached=true`，不消耗额度。每用户每日字符额度由管理员设置（admin 也计入），另有每分钟 30 次模型调用上限，超额 429；服务失败 500 并退还额度。译文是机器翻译，验证码、链接等以原文为准。

管理员读列表/详情/线程/原始档时可带 `scope=mine|unclaimed|user`，`scope=user` 需正整数 `userId`；普通用户不能使用管理员 scope。共享只加入个人可见的非删除 inbound；`direction=outbound`、`trash=1`、审阅他人 scope 都不会扩大到共享内容。

## 增量同步

列表按 ID 倒序。增量拉取带 `afterId=N`（上次处理完的最大 ID，首次为 0），结果仍倒序分页：先按 `nextCursor` 翻完这一批的所有页，处理完后再把其中最大的 ID 设为新基线。只读首页就推进基线会漏掉突发的邮件；中途出错不推进，下一轮按 ID 去重即可。完整 shell 示例见入口指南的配方 ⑥。

- 摘要已带 `preview`、`verificationCode`、`verificationLink`、`hasAttachments`。只有需要正文、收件人分组或附件时才读详情，每封读一次并按 ID 缓存；不要定时重拉同一批详情。
- 确实要复查某封邮件是否变化（已读、星标、补码、删除、发送状态）时用条件请求：详情响应带弱 `ETag`，下次请求带 `If-None-Match: <上次的 ETag>`，没有变化返回 304、没有正文，复用缓存即可；变化了返回 200 和新的 `ETag`。带附件的邮件 `ETag` 会随附件签名 URL 的有效期变化（`/v1` 约每分钟一次），304 时缓存里的签名 `url` 仍至少有 4 分钟可用；下载附件优先用 `GET /messages/:id/attachments/:attId`。成功的读取请求（含 304）在 API Key 调用日志里按分钟合并成一行。
- 实时性要求高时用 `/v1/messages/wait` 长轮询：不带过滤时返回 `afterId` 之后最早的一封来信，处理后以 `scannedThroughId` 为下一轮的 `afterId`。没有 wait 的 JWT 调用方按 3–5 秒以上的间隔轮询列表。
- 需要按已读状态分流时用 `unread=1` 或摘要的 `isRead`；处理完调用 `POST /messages/read` 标记，未读数用 `GET /messages/unread-count`。

## 等待本次验证码

若已有目标验证码邮件，直接读取详情并检查来源与时间，不先清空收件箱。若等待新验证码：先确认自己拥有或获共享的目标地址，在发起外部验证前读 `direction=inbound&address=…&limit=1` 并保存最新 ID（没有邮件时 0），然后触发用户授权的验证请求。基线不能来自带 `q/unread/starred` 的过滤列表。

`/v1/messages/wait` 参数：`afterId` 非负整数，默认 0；`timeout` 1–50 秒，默认 25；也支持管理员 `scope/userId`。范围与返回形式：

| 参数 | 语义 |
|---|---|
| `address` | 只等发到这些收件地址的信：一个地址、逗号分隔的多个（`address=a@example.org,b@example.org`），或重复参数（`?address=a@example.org&address=b@example.org`），两种写法可混用；去重后最多 20 个，超过或含非法地址返回 400 `validation_failed` |
| `domain` | 只等收件地址在该域名下的信（精确匹配，不含子域名），可与 `address` 同时给 |
| `include=body` | 命中时 `message` 是与 `GET /messages/:id` 相同的详情结构（正文、收件人、附件元数据，附件签名 `url` 5 分钟有效），省一次详情请求；不带时是摘要 |

可选过滤（全部满足才返回，大小写不敏感）：

| 参数 | 语义 |
|---|---|
| `from` | 完整地址精确匹配，或 `@域名` 匹配该域名后缀（`@example.com` 不含 `mail.example.com`） |
| `subjectContains` | 主题包含该文本，1–200 字符 |
| `hasCode=1` | 只要返回的 `verificationCode` 非空的邮件；管理员开启 AI 兜底并配置了 AI 模型时，刚到且暂无码的邮件会被保留最多约 30 秒等待异步 AI 补码，期间不越过它 |

返回基线之后**最早一封满足过滤**的未删除 inbound，跳过不满足的邮件；超时返回 `message:null`。`scannedThroughId` 是本次已检查到的最大 ID：命中时等于 `message.id`，未命中时是最后一封被跳过的邮件 ID，没有新邮件时等于 `afterId`。处理完命中邮件后以其 ID 为新基线；超时则以 `scannedThroughId` 为新基线，被跳过的邮件不会再出现。附件仍在保存（`status=pending`）的新来信不会被越过：扫描停在它之前，`scannedThroughId` 不包含它，下一轮再返回或判定。不传过滤时行为与旧版一致（未必有验证码），需自行检查发件人/主题。用总截止时间限制全部请求。普通账户仅个人/共享可见范围，Key 仅需 `mail.read`。

`verificationLink` 只是辅助识别，来源是不可信的邮件正文：打开前核对链接主机属于本次验证的服务（点击追踪域名先确认跳转目标），只在用户授权完成该验证时访问一次，不在日志或报告中公开链接全文；为空时读取详情正文自行判断，不要猜测或拼接链接。

下面可保存为本地 Python 脚本运行，标准库即可。环境 `HPC_API_KEY,HPC_MAIL_ADDRESS,HPC_AFTER_ID` 必填，`HPC_EXPECTED_FROM`（完整地址或 `@域名`）、`HPC_EXPECTED_SUBJECT` 至少一个应由当前验证服务给出；如服务来源不确定，先阅读实际邮件再选取。`HPC_AFTER_ID` 在触发验证前捕获。脚本把条件交给服务端过滤，并在本地复核一次。所有请求用自定义 User-Agent；遇到 HTTP 拒绝/HTML 即终止，不循环登录。

```python
import json, os, time, urllib.error, urllib.parse, urllib.request

base = os.environ.get("HPC_BASE", "https://hpc.email").rstrip("/")
key = os.environ["HPC_API_KEY"]
address = os.environ["HPC_MAIL_ADDRESS"]
after = int(os.environ["HPC_AFTER_ID"])
sender = os.environ.get("HPC_EXPECTED_FROM", "").lower()
subject = os.environ.get("HPC_EXPECTED_SUBJECT", "").lower()
if not sender and not subject:
    raise SystemExit("先明确本次验证邮件的来源或主题匹配条件")
deadline = time.monotonic() + 120
matched = False
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
while time.monotonic() < deadline:
    remaining = deadline - time.monotonic()
    if remaining < 1:
        break
    params = {"address": address, "afterId": after, "timeout": min(25, int(remaining))}
    if sender:
        params["from"] = sender
    if subject:
        params["subjectContains"] = subject
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(base + "/v1/messages/wait?" + query,
        headers={"Authorization": "Bearer " + key, "User-Agent": "HPC-Mail-Agent/1.0"})
    try:
        with opener.open(request, timeout=min(35, remaining)) as response:
            if "application/json" not in response.headers.get("Content-Type", ""):
                raise SystemExit("响应不是业务 JSON，请检查边缘拦截")
            data = json.load(response)["data"]
            message = data["message"]
    except urllib.error.HTTPError as error:
        with error:
            info = {"status": error.code, "code": "http_error", "message": "HTTP 请求被拒绝",
                    "requestId": error.headers.get("X-Request-ID", "")}
            if "application/json" not in error.headers.get("Content-Type", ""):
                info["message"] = "非 JSON 拒绝，请检查边缘规则"
            else:
                raw = error.read(8193)  # 错误诊断最多 8 KiB，不回显任意大响应
                try:
                    document = json.loads(raw) if len(raw) <= 8192 else {}
                    if isinstance(document, dict):
                        details = document.get("error", {})
                        if isinstance(details, dict):
                            for field in ("code", "message"):
                                if isinstance(details.get(field), str):
                                    info[field] = details[field][:1000]
                        if isinstance(document.get("requestId"), str) and document["requestId"]:
                            info["requestId"] = document["requestId"][:200]
                except ValueError:
                    info["message"] = "错误响应不是有效 JSON"
            raise SystemExit(json.dumps(info, ensure_ascii=False))
    if time.monotonic() >= deadline:
        raise SystemExit("等待超过总截止时间，不使用迟到的返回结果")
    after = data["scannedThroughId"]  # 服务端已检查并跳过的邮件不再重复等待
    if not message:
        continue
    after = message["id"]
    actual = message["fromAddress"].lower()
    if sender and (not actual.endswith(sender) if sender.startswith("@") else actual != sender):
        continue
    if subject and subject not in message["subject"].lower():
        continue
    print(json.dumps({"id": after, "verificationCode": message["verificationCode"],
                      "hasVerificationLink": bool(message.get("verificationLink"))},
                     ensure_ascii=False))
    matched = True
    break
if not matched:
    raise SystemExit("等待超过总截止时间，尚未找到匹配邮件")
```

匹配邮件的 `verificationCode` 为空时，先看 `verificationLink`（按上文核对域名），仍为空再用其 ID 读取详情、从正文识别；自动提取关闭或未匹配格式也会为空。示例只报告是否识别出链接，不打印链接全文。该字段是辅助提取，不能单独证明邮件真实性。上述示例只等待一次验证码，未自动标记已读、删除或使用验证码。Python socket timeout 约束的是网络不活动时间，不是严格的进程总耗时；需硬截止时保存脚本为 `wait-code.py`，用 `timeout 120s python3 wait-code.py` 包裹，退出码 124 表示到期而不是获得验证码。JWT 没有 wait 接口：每 3–5 秒 `GET /api/messages?direction=inbound&address=…&afterId=N`，分页取全、按 ID 升序在本地按发件人/主题检查，再推进基线，仍设 120 秒等总期限；N=0 为合法基线。

## 维护状态与回收站

| `POST` 相对路径 | JSON | 结果与语义 |
|---|---|---|
| `/messages/read` | `{ids:[1,2],isRead:true}`；false 标未读 | `{changed}`；只改自己认领地址的邮件（管理员 `scope=unclaimed` 为未认领地址）；共享收件不报错但计 0，已读状态归邮箱所有者 |
| `/messages/read-all` | `{}` 或 `{domain?,address?,q?}` | `{changed}`；当前 scope 的未删除未读 inbound，可按域名、完整地址、搜索词收窄（`q` 与列表搜索同一语义）；只处理自己认领的地址（管理员 `scope=unclaimed` 为未认领），共享邮件一律不动；不受分页影响 |
| `/messages/star` | `{ids:[1],starred:true}`；false 取消 | `{changed}`；每用户个人星标，包括有效共享收件 |
| `/messages/delete` | `{ids:[1]}` | `{deleted}`；仅移入回收站，7 天后定时永久删除；不能删除共享邮件 |
| `/messages/restore` | `{ids:[1]}` | `{changed,restored}`；仅恢复仍存在且尚未进入永久清理的回收站邮件 |
| `/messages/purge` | `{ids:[1]}` | `{changed,purged}`；仅永久删除回收站邮件与其资源引用，不可恢复 |

这些接口 Key 需 `mail.write`；`ids` 1–500 个正整数。要“把当前筛选结果全部标已读”时，把列表使用的 `domain/address/q` 原样传给 read-all，不要逐页收集 ID；`unread/starred/direction/trash` 不是 read-all 的条件。变更 scope 仅 `mine/unclaimed`，`scope=user` 对所有变更（含星标）均为 400。管理员需显式提供 `scope=unclaimed`，未传只能修改自己的范围；普通用户不能使用 unclaimed。scope 支持 query 或 body，二者冲突会 400。批量范围外 ID 不会被改动，核对返回计数而不是输入长度。全读、删除、清理不能默认附加在“查邮件/查码”的任务中。

## 发送

请求字段（`/api/messages/send` 与 `/v1/messages` 相同）：

| 字段 | 约束 |
|---|---|
| `from` | 四种写法之一：`{mailboxId,displayName?}`、`{localPart,domain,displayName?}`、`"Name <a@b>"` 或 `"a@b"`、`{address,name?}`。后两种解析成 `localPart+domain`，规则相同；同一对象里不能混用 `mailboxId` 与 `localPart/domain`。显示名最多 64 字符，缺省用邮箱的显示名，再缺省用前缀。见[发件身份](#发件身份) |
| `to` | 必填数组，可为空；To+Cc+Bcc 至少 1 个、合计最多 100 个，同一地址只投递一次。写法见[收件人与显示名](#收件人与显示名) |
| `cc,bcc` | 可选数组，默认 `[]`；仅 Bcc 发信也需显式 `to:[]`。Bcc 不会出现在其他收件人看到的信头里 |
| `replyTo` | 可选数组，最多 10 个，写法同收件人；对方点「回复」时的目标（Reply-To 头），不填即回复发件人 |
| `subject` | 1–998 字符，去首尾空白，不能含换行 |
| `text,html` | 至少一种非空，UTF-8 字节合计最多 1 MiB；不是附件 base64 字节数 |
| `headers` | 可选对象 `{名称:取值}`，只允许 `X-*` 与白名单头，见[自定义邮件头](#自定义邮件头) |
| `replyToMessageId` | 可选站内邮件 ID，服务器据此写 In-Reply-To/References；不自动填收件人/主题/正文。不能与 `headers` 的 `In-Reply-To`/`References` 同时给（400） |
| `forwardAttachmentsFrom` | 可选站内来源 ID，复制其全部附件（含内嵌图）；不自动填正文、主题或目标 |
| `attachments` | 可选 base64 附件数组 `{filename,contentType,content,contentId?,disposition?}`，合计解码后最多 10 MiB；带 `contentId` 即内联图片，见[附件参考](attachments.md#内联图片) |
| `attachmentTokens` | 可选已完成上传的 token 数组：字符串，或 `{token,contentId?,disposition?}` |

附件三路（base64、token、`forwardAttachmentsFrom`）合计最多 10 个、50 MiB。整个请求体超过 16 MiB 时在解析前返回 413 `payload_too_large`。例子是请求结构，地址、正文必须替换为用户确认的值并用 JSON 序列化器生成：

```json
{"from":"Alice <alice@example.org>","to":["Bob <bob@example.net>",{"address":"li@example.net","name":"李雷"}],
 "cc":[],"bcc":[],"replyTo":["support@example.org"],"subject":"确认信息","text":"这是用户确认的正文。",
 "headers":{"X-Request-Ref":"ticket-1024"}}
```

### 发件身份

先读发件身份（Key 需要 `mail.send` 或 `mailbox.read` 之一；JWT 用 `GET /api/identities`），从 `canSend=true` 的项里选 `mailboxId` 或 `address` 作为 `from`：

```bash
hpc '/identities' | jq '.data.identities[] | select(.canSend) | {mailboxId,address,displayName}'
```

- 普通用户只能用自己认领的邮箱：`mailboxId` 属于自己，或地址是自己认领的。用本站别人的地址返回 403 `forbidden`（`fix` 指向 `/v1/identities`，`docs` 指向[错误说明](errors.md#forbidden-sender)）；域名不属于本站返回 400 `validation_failed`。`kind=shared` 的共享邮箱恒为 `canSend:false`、`reason:"shared_readonly"`，不能发信。
- 托管域名上的地址（无论谁发）都要求该域发信已开通，否则 400 `validation_failed`。identities 里对应 `reason` 为 `hosted_sending_not_ready`（发信尚未就绪）或 `hosted_domain_unavailable`（域名暂停、NS 已移走或删除中）。系统域名不受此限；`/mailboxes` 每项的 `canSend` 同样只反映域名状态。
- 管理员可用任何已认领邮箱的 `mailboxId`（这些邮箱不列在 identities 里）；用地址写法时，域名须是系统域名（identities 的 `domains` 列出，`anyLocalPart:true`）、仍有存量邮箱的旧域名或托管域名，不检查该地址是否被认领。不能推断任意外部域名可用。
- 发件邮箱 `mailboxId` 不存在是 404 `not_found`。

### 收件人与显示名

`to`、`cc`、`bcc`、`replyTo` 的每一项可写成：

- `"bob@example.net"`；
- `"Bob <bob@example.net>"`，名字与 `<` 之间的空格可省，名字可含逗号（`"Doe, John <john@example.net>"`）；名字也可以用双引号包起来，其中的引号写成 `\"`（在 JSON 里还要再转义一次）；
- `{"address":"bob@example.net","name":"Bob"}`。

地址统一转小写并严格校验：本地部分为 dot-atom（字母、数字与 RFC 5322 允许的符号，点不在首尾、不连续），最长 64；域名每段 1–63 个字母、数字或连字符，顶级域为字母或 `xn--` 开头的 punycode；总长不超过 254。带引号的本地部分、IP 字面量、空白，以及 `alice<a@b.com` 这类缺少括号的写法返回 400 `validation_failed`，message 指出是哪一项。显示名最多 64 字符，不能含控制字符或尖括号，非 ASCII 名字由服务器编码。站内收件副本的 `recipients` 只记地址。

### 自定义邮件头

`headers` 是 `{名称:取值}` 对象，名称不区分大小写，按规范写法写出：

- 允许：`X-` 开头的头（名称只含字母、数字、`_`、`-`），以及 `In-Reply-To`、`References`、`List-Unsubscribe`、`List-Unsubscribe-Post`、`List-Id`、`List-Archive`、`List-Help`、`List-Owner`、`List-Post`、`List-Subscribe`、`Precedence`、`Auto-Submitted`、`Importance`、`Priority`、`Sensitivity`、`Organization`、`Keywords`、`Comments`、`Content-Language`、`Thread-Index`、`Thread-Topic`、`Require-Recipient-Valid-Since`、`Expires`、`Reply-By`、`Archived-At`、`OTP-Token`。
- 不允许：`From`、`To`、`Cc`、`Bcc`、`Subject`、`Reply-To`（用对应请求字段）；`Message-ID`、`Date`、`MIME-Version`、`Content-Type`、`Content-Transfer-Encoding`、`DKIM-Signature`、`Received`、`Return-Path`、`ARC-*` 等平台生成的头；其他不在白名单的头。只要出现一个，整个请求返回 400 `header_not_allowed`，`error.details.headers` 按请求里的写法列出全部被拒的名称。
- 取值：非空、单行（不能有 CR/LF 或其他控制字符），每个最多 2048 字节（UTF-8），同名头只出现一次（多个值用逗号合并）；非 `X-` 头最多 20 个；全部头的名称加取值合计最多 16 KiB。结构化头只收可打印 ASCII，`X-*`、`Comments`、`Keywords`、`Organization`、`Thread-Topic` 可写中文等 UTF-8（发出时按 RFC 2047 编码）；结构化头里超过 997 字节且不含空白的片段无法折行，也会拒绝。这些取值问题返回 400 `validation_failed`，同样带 `details.headers`。

| 头 | 取值格式 |
|---|---|
| `In-Reply-To` | 单个 `<message-id>` |
| `References` | 空格分隔的 `<message-id>` 列表 |
| `List-Unsubscribe` | 尖括号包裹的 `https:` 或 `mailto:` URI，多个用逗号分隔（不接受 http） |
| `List-Unsubscribe-Post` | 固定为 `List-Unsubscribe=One-Click`，并且要同时提供含 https URI 的 `List-Unsubscribe` |
| `Precedence`、`Importance`、`Priority`、`Sensitivity` | 依次为 `bulk/list/junk`、`high/normal/low`、`normal/non-urgent/urgent`、`personal/private/company-confidential` 之一 |

```json
{"headers":{"X-Campaign":"spring-2026","List-Unsubscribe":"<https://example.org/u/1>, <mailto:unsubscribe@example.org>",
  "List-Unsubscribe-Post":"List-Unsubscribe=One-Click","Auto-Submitted":"auto-generated"}}
```

`In-Reply-To`/`References` 只用于回复站外邮件，见[回复和转发](#回复和转发)；回复站内邮件用 `replyToMessageId`，两者同时给返回 400 `validation_failed`。

### 结果与状态

发件摘要的 `status`：

| `status` | 含义 | 在哪里出现 |
|---|---|---|
| `sent` | 至少一个外部收件人被发信服务商接受；不代表已进对方收件箱 | 201 响应、列表、详情 |
| `delivered` | 收件人都在本站，副本已落库 | 201 响应、列表、详情 |
| `pending` | 仍在投递，逐收件人结果边投递边回填 | 列表、详情；同 Key 重试返回 409 `send_in_progress` |
| `unknown` | 创建超过 1 小时仍是 `pending`（投递中断），已回填的结果保留，其余收件人记为 `unknown` | 列表、详情；同 Key 重试返回 201 与这个状态 |
| `failed` | 全部收件人失败 | 列表、详情；发信接口不以 201 返回它，而是 422 `delivery_failed` |

`recipientOutcomes` 每个去重后的收件人一项：`delivered`（站内已投递）、`sent`（外部已接受）、`failed`（`error` 为原因）、`unknown`（`error` 为「投递中断，结果未确认」，可能已经送达）。外部收件人最多 4 路并发投递，每完成一个就回填，所以 `pending` 的邮件可能已有部分结果。

- **201**：至少一个收件人成功。`errorDetail` 为空即全部成功；部分失败时为「部分收件人失败: 地址: 原因; …」，按[部分失败补发](#部分失败补发)处理。
- **422 `delivery_failed`**：每个收件人都尝试过且都被拒收，什么也没发出。message 为「全部收件人投递失败: …」，`error.details` 为 `{messageId,recipientOutcomes}`，`messageId` 是已记录的发件行（`direction=outbound` 列表里可见）。这次不占当日外发配额。同 Key 重试返回同一个 422；修正收件人后用新 Key 重发。
- **500 `internal`**：服务端在部分收件人还没尝试时出错（例如附件保存失败）。用同一 Key、同一请求体重试取回结果：可能继续发送并返回 201，也可能是 422 `delivery_failed`，此时其中的收件人可能从未发出过。

### 幂等与重试

将最终 JSON 保存到私有文件并设 `HPC_SEND_FILE`。下例在发送前创建包含 payload SHA-256 和 Key 的 sidecar，重复运行会保持原 Key；内容改变会终止，避免把编辑后的文件当结果查询。每次新的、已经授权的逻辑发送使用新文件，不能为超时重试改文件名/凭证。

```bash
umask 077
SEND_FILE="$HPC_SEND_FILE"
if [ "$API" = "$BASE/api" ]; then
  # 验证当前用户 ID，允许同用户重新登录后恢复；不是从未验证 JWT 中猜 ID
  SEND_USER=$(hpc '/auth/me' | jq -er '.data.id | select(type == "number") | tostring') || exit 1
  SEND_ACTOR="$API:user:$SEND_USER"
else
  # 幂等按 API Key ID 隔离，/v1/me 返回它
  SEND_KEY_ID=$(hpc '/me' | jq -er '.data.key.id | tostring') || exit 1
  SEND_ACTOR="$API:key:$SEND_KEY_ID"
fi
SEND_KEY=$(HPC_SEND_ACTOR="$SEND_ACTOR" python3 - "$SEND_FILE" <<'PY'
import hashlib, json, os, pathlib, sys, time, uuid
payload = pathlib.Path(sys.argv[1])
digest = hashlib.sha256(payload.read_bytes()).hexdigest()
actor = hashlib.sha256(os.environ["HPC_SEND_ACTOR"].encode()).hexdigest()
state = pathlib.Path(str(payload) + ".send-state.json")
if state.exists():
    record = json.loads(state.read_text())
    if record["payloadHash"] != digest:
        raise SystemExit("内容已改动，请先核对原发信结果，再创建独立发送任务")
    if record["actorHash"] != actor:
        raise SystemExit("凭证或 API 路径已改动，请先核对原发信结果")
    if time.time() - record["createdAt"] >= 48 * 3600:
        raise SystemExit("已超出已完成记录的幂等保留期限，先核对已发送邮件，不自动重投")
else:
    record = {"payloadHash": digest, "actorHash": actor, "key": str(uuid.uuid4()), "createdAt": time.time()}
    with state.open("x") as output:
        json.dump(record, output)
print(record["key"])
PY
) || exit 1
SEND_PATH='/messages'
if [ "$API" = "$BASE/api" ]; then SEND_PATH='/messages/send'; fi
hpc "$SEND_PATH" -X POST -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $SEND_KEY" --data-binary "@$SEND_FILE"
```

幂等 Key 1–128 位可见 ASCII，按 **JWT 用户 ID** 或 **API Key ID** 隔离；换 Key/用户、切换 `/api` 与 `/v1` 不能恢复原操作的幂等上下文。相同 Key 的重试是在查原结果，不是强制重新投递。同一 Key 的结果：

| 情况 | 返回 | 处理 |
|---|---|---|
| 原发送已结束，至少一个收件人成功 | 201 与原摘要（重放） | 按原摘要检查结果；旧附件 Tokens 可以已消费，但请求 JSON 必须不变 |
| 原发送全部收件人失败 | 422 `delivery_failed`（重放，内容同首次） | 修正收件人后换新 Key |
| 原发送投递中断，已标为 `unknown` | 201，`status:"unknown"` | 按[部分失败补发](#部分失败补发)核对 `unknown` 的收件人 |
| 原发送在外发前失败（网络、5xx），没有生成发件记录 | 继续发送 | 同 Key、同内容重试即可 |
| 原请求仍在处理，或发件记录仍是 `pending` | 409 `send_in_progress` | 不换 Key 重发；查 `direction=outbound` 列表和详情核对，仍需确认时稍后用同 Key 重试 |
| 同一 Key 用于不同内容 | 409 `idempotency_mismatch` | 先核对原发送；新内容换新 Key |
| 外发前的业务错误（400、403、404、413、429 等） | 原错误码 | 没有发出，幂等记录已释放；按 `error.fix` 修正后可继续用该 Key |

首次网络失败或 5xx 不代表没有投递，先用同 Key 重试查结果。待确认时查 `direction=outbound`、详情并核对原发送，保留 sidecar；不要直接换 Key“修复”。完成的记录约两天后清理，不要隔很久凭旧 Key 重新 POST。

### 回复和转发

没有 `/messages/:id/reply` 之类的端点，`POST /messages/:id` 返回 404；回复和转发都是带额外字段的普通发送。

回复先读详情，收件人优先 `replyTo` 非空数组，否则用 `fromAddress`，并检查它是否为本人地址、可疑来源或用户意图。选自己有权发件的身份，填 `replyToMessageId`、`Re:` 主题与用户确认正文。简单回复不会自动带回原 CC/BCC；回复全部需重新计算 To/CC、排除自己的地址，不能把原 BCC 泄露出去。共享给你的来信可以作为回复来源，但发件身份仍须是自己认领的地址，不能借共享邮箱的地址回复。

```bash
# 已读取详情到私有 message.json，HPC_FROM 为自己的发件地址（可带显示名），HPC_REPLY_TEXT 为回复正文
# 只生成请求；实际发送使用上面的持久化 Key 流程，不能漏 Idempotency-Key
jq -n --slurpfile original message.json --arg from "$HPC_FROM" \
  --arg text "$HPC_REPLY_TEXT" '
  $original[0].data as $m |
  {from:$from,to:(if ($m.replyTo // [] | length) > 0 then $m.replyTo else [$m.fromAddress] end),
   subject:(if ($m.subject | test("^Re:";"i")) then $m.subject else "Re: " + $m.subject end),
   text:$text,replyToMessageId:$m.id}'
```

**回复站外邮件**：原信不在本站（例如只从别的系统拿到了对方的 Message-ID），不写 `replyToMessageId`，改在 `headers` 里写线程头。`In-Reply-To` 是对方那封信的 Message-ID，`References` 是原信的 References 加上它（不知道就只写它）。服务器把这两个头写进外发邮件，也记到发件行与站内副本，后续来信能连成线程。与 `replyToMessageId` 同时给返回 400。

```json
{"from":"alice@example.org","to":["partner@example.net"],"subject":"Re: 合同条款","text":"已确认。",
 "headers":{"In-Reply-To":"<CAB12345@mail.example.net>","References":"<root-1@mail.example.net> <CAB12345@mail.example.net>"}}
```

转发用新目标/主题/正文，若需原附件填 `forwardAttachmentsFrom`；保留原 HTML 时也带原正文，并让服务器还原本站来源内嵌 CID。

`replyToMessageId` 与 `forwardAttachmentsFrom` 的来源邮件必须对发件人可见：自己认领地址上的邮件，或共享给自己的未删除来信；管理员另可引用未认领地址上的邮件，但不能借此外发其他用户的私有邮件。来源不存在或不可见返回 404 `source_unavailable`（message 为「回复的原邮件不存在或不可见」或「转发的原邮件不存在或不可见」），转发时原附件已丢失也返回它（「附件「文件名」已丢失，无法完整转发」）；去掉 `replyToMessageId`/`forwardAttachmentsFrom` 即可作为新邮件发送，丢失的附件需自行重新附上。用 Key 调用时，带这两个字段还需要 `mail.read`，只有 `mail.send` 返回 403。

### 部分失败补发

获取完整原详情，以 `recipientOutcomes.status=failed` 筛原 `recipients.to/cc/bcc` 各数组，新的请求只保留失败地址，`to` 可为空，保持原分组；原 HTML/text 与 `replyToMessageId` 上下文按需要保留，附件通过 `forwardAttachmentsFrom=原 outbound ID` 复制，不引用已消费的旧 Tokens。这是新的发送，使用新持久化 Key。原邮件的附件曾被转成下载链接时，沿用原正文即可：服务器会先去掉正文里本站注入的「附件下载」区块，再按本次大小决定是否重新生成，不会出现两段。

- `status=unknown` 或某个收件人为 `unknown`：投递中断，结果未确认，对方可能已经收到。先向用户或收件人确认，确认没收到的再按上面的方法补发，不要把 `unknown` 当成 `failed` 直接重发。
- 仍是 `pending`、没有逐收件人结果时先等待并核实，不全体重发。
