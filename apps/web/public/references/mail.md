# 邮件、验证码与发送

按任务定位：[读取与搜索](#读取与搜索)、[等待本次验证码](#等待本次验证码)、[维护状态与回收站](#维护状态与回收站)、[发送、回复和转发](#发送回复和转发)。

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
| `GET /messages/unread-count` | `mail.read` | `{unread:number}`；未读数只统计你认领的地址，共享邮件的已读状态属于所有者、不计入；不是全站统计 |
| `GET /v1/messages/wait` | `mail.read` | `{message:摘要\|null,scannedThroughId}`，见下文 |

列表支持 `direction=inbound|outbound`、`address`（完整地址）、`domain`、`q`（最长 256 字符，主题/发件地址/发件名/文本正文/收件人子串）、`unread=1`（只匹配你认领的地址，共享邮件不出现在未读筛选里）、`starred=1`、`trash=1`、`afterId`（非负安全整数，0 是合法空基线）、`cursor`、`limit`（1–100）。布尔查询接受 `1/true/0/false`；`unread=0` 与 `starred=0` 表示不筛选，不是“只看已读/未星标”。`trash=1` 只看软删除，未传看非回收站。

```bash
hpc '/messages' --get --data-urlencode 'direction=inbound' \
  --data-urlencode "address=$HPC_MAIL_ADDRESS" --data-urlencode 'limit=30'
hpc '/messages' --get --data-urlencode 'q=验证码' --data-urlencode 'unread=1'
```

后续页带 `cursor=<data.nextCursor>`，保留过滤条件。增量查询 `afterId=N` 仍倒序；若一页没读完，先翻完这批所有页，再把已处理的最大 ID 设为新基线。不要只读首屏就推进最大 ID，否则突发邮件会被跳过。

摘要包含 `id,direction,address,domain,fromAddress,fromName,subject,preview,verificationCode,verificationLink,status,errorDetail,isRead,isStarred,hasAttachments,size,createdAt`，发件还可含 `recipientsTo,recipientOutcomes`；`trash=1` 列表的每项另有 `deletedAt`（进入回收站时间，7 天后永久删除）。`verificationLink` 是收件时识别出的 http/https 验证、登录、激活或重置密码链接，识别不到、发件、关闭自动提取或功能上线前收到的邮件为空串，见[等待本次验证码](#等待本次验证码)的安全要求。详情增加 `recipients:{to,cc,bcc}`、`replyTo` 数组、`bodyText,bodyHtml,attachments,hasRaw`。BCC 不在收件副本中披露。`status=degraded` 表示收件解析/附件降级，应说明 `errorDetail`、核对 `hasRaw`，不能承诺内容完整。

翻译 `POST /api/messages/:id/translate` 只接受 JWT，`/v1` 没有对应接口；管理员未启用翻译或未配置 AI 模型（`/api/config` 的 `translationEnabled=false`）时返回 403。body `{segments:[...]}`：1–60 段，单段 ≤2000 字符，合计 ≤6000 字符，长邮件分多次请求；scope/userId 与详情相同。返回 `translations` 与 segments 一一对应。只有能在该邮件主题或完整正文中找到的片段（比对只看字母和数字，忽略 HTML 标签、实体、标点、空白和大小写）才会发送给管理员配置的第三方模型，找不到的原样返回并计入 `skipped`；去掉 URL、邮箱后没有字母的片段（验证码、数字、标点）原样返回且不计费；相同片段只发一次。同一邮件同一组片段命中缓存时 `cached=true`，不消耗额度。每用户每日字符额度由管理员设置（admin 也计入），另有每分钟 30 次模型调用上限，超额 429；服务失败 500 并退还额度。译文是机器翻译，验证码、链接等以原文为准。

管理员读列表/详情/线程/原始档时可带 `scope=mine|unclaimed|user`，`scope=user` 需正整数 `userId`；普通用户不能使用管理员 scope。共享只加入个人可见的非删除 inbound；`direction=outbound`、`trash=1`、审阅他人 scope 都不会扩大到共享内容。

## 等待本次验证码

若已有目标验证码邮件，直接读取详情并检查来源与时间，不先清空收件箱。若等待新验证码：先确认自己拥有或获共享的目标地址，在发起外部验证前读 `direction=inbound&address=…&limit=1` 并保存最新 ID（没有邮件时 0），然后触发用户授权的验证请求。基线不能来自带 `q/unread/starred` 的过滤列表。

`/v1/messages/wait` 参数：`afterId` 非负整数，默认 0；`address` 可选；`timeout` 1–50 秒，默认 25；也支持管理员 `scope/userId`。可选过滤（全部满足才返回，大小写不敏感）：

| 参数 | 语义 |
|---|---|
| `from` | 完整地址精确匹配，或 `@域名` 匹配该域名后缀（`@example.com` 不含 `mail.example.com`） |
| `subjectContains` | 主题包含该文本，1–200 字符 |
| `hasCode=1` | 只要返回的 `verificationCode` 非空的邮件；管理员开启 AI 兜底并配置了 AI 模型时，刚到且暂无码的邮件会被保留最多约 30 秒等待异步 AI 补码，期间不越过它 |

返回基线之后**最早一封满足过滤**的未删除 inbound，跳过不满足的邮件；超时返回 `message:null`。`scannedThroughId` 是本次已检查到的最大 ID：命中时等于 `message.id`，未命中时是最后一封被跳过的邮件 ID，没有新邮件时等于 `afterId`。处理完命中邮件后以其 ID 为新基线；超时则以 `scannedThroughId` 为新基线，被跳过的邮件不会再出现。不传过滤时行为与旧版一致（未必有验证码），需自行检查发件人/主题。用总截止时间限制全部请求。普通账户仅个人/共享可见范围，Key 仅需 `mail.read`。

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

## 发送、回复和转发

请求字段（两种 API 相同）：

| 字段 | 约束 |
|---|---|
| `from` | `{mailboxId:正整数,displayName?}` 或 `{localPart,domain,displayName?}` 二选一，不能混用；建议选已核实的邮箱 ID |
| `to` | 必填数组，可为空；To+CC+BCC 至少 1 个、合计最多 100 个 |
| `cc,bcc` | 可选数组，默认 `[]`；仅 BCC 发信也需显式 `to:[]` |
| `subject` | 1–998 字符，去首尾空白 |
| `text,html` | 至少一种非空，UTF-8 字节合计最多 1 MiB；不是附件 base64 字节数 |
| `replyToMessageId` | 可选站内邮件 ID，服务器注入 In-Reply-To/References；不自动填收件人/主题/正文 |
| `forwardAttachmentsFrom` | 可选站内来源 ID，复制其附件；不自动填正文、主题或目标 |
| `attachments` | 可选 base64 内联附件数组，详见附件参考 |
| `attachmentTokens` | 可选已完成上传 Token 数组，详见附件参考 |

例子是请求结构，ID/地址/正文必须替换为用户确认的值并安全序列化：

```json
{"from":{"mailboxId":42},"to":["recipient@example.net"],"cc":[],"bcc":[],"subject":"确认信息","text":"这是用户确认的正文。"}
```

将最终 JSON 保存到私有文件并设 `HPC_SEND_FILE`。下例在发送前创建包含 payload SHA-256 和 Key 的 sidecar，重复运行会保持原 Key；内容改变会终止，避免把编辑后的文件当结果查询。每次新的、已经授权的逻辑发送使用新文件，不能为超时重试改文件名/凭证。

```bash
umask 077
SEND_FILE="$HPC_SEND_FILE"
if [ "$API" = "$BASE/api" ]; then
  # 验证当前用户 ID，允许同用户重新登录后恢复；不是从未验证 JWT 中猜 ID
  SEND_USER=$(hpc '/auth/me' | jq -er '.data.id | select(type == "number") | tostring') || exit 1
  SEND_ACTOR="$API:user:$SEND_USER"
else
  # API Key 不返回 key ID，保守按完整 key 识别；仅 SHA-256 写入 sidecar
  SEND_ACTOR="$API:key:$AUTH"
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

幂等 Key 1–128 位可见 ASCII，按 **JWT 用户 ID** 或 **API Key ID** 隔离；换 Key/用户、切换 `/api` 与 `/v1` 不能恢复原操作的幂等上下文。服务端同一 Key 不同内容 409，处理中/结果不明 409；明确终结结果可重放原摘要，首次网络/5xx 失败不代表没有投递。相同 Key 的重放是在查原结果，不是强制重新投递。请求成功重放时旧附件 Tokens 可以已消费，但必须保持原 JSON 不变。记录 completed 后约两天会清理，不要多年后凭旧 Key 重新 POST。

先检查 `recipientOutcomes`，再结合 `status/errorDetail`；`sent` 只表示外发被接受，无外部最终到达承诺。部分失败可返回 201 与 `sent/delivered`，`errorDetail` 非空；全失败首次通常为 500，查询原请求可能返回 `status:"failed"` 的终结摘要。待确认时查 `direction=outbound`、详情并核对原发送，保留 sidecar；不要直接换 Key“修复”。确认结束后可归档/清理待确认状态，保留足够记录以免误当新发送。

回复先读详情，收件人优先 `replyTo` 非空数组，否则用 `fromAddress`，并检查它是否为本人地址、可疑来源或用户意图。选自己有权发件的身份，填 `replyToMessageId`、`Re:` 主题与用户确认正文。简单回复不会自动带回原 CC/BCC；回复全部需重新计算 To/CC、排除自己的地址，不能把原 BCC 泄露出去。普通用户的共享只读邮件不能作为 `replyToMessageId` 或 `forwardAttachmentsFrom` 来源；不能假定可借共享身份回复。

```bash
# 已读取详情到私有 message.json，MAILBOX_ID 为自己的发件邮箱，HPC_REPLY_TEXT 为回复正文
# 只生成请求；实际发送使用上面的持久化 Key 流程，不能漏 Idempotency-Key
jq -n --slurpfile original message.json --argjson mailbox "$MAILBOX_ID" \
  --arg text "$HPC_REPLY_TEXT" '
  $original[0].data as $m |
  {from:{mailboxId:$mailbox},to:(if ($m.replyTo // [] | length) > 0 then $m.replyTo else [$m.fromAddress] end),
   subject:(if ($m.subject | test("^Re:";"i")) then $m.subject else "Re: " + $m.subject end),
   text:$text,replyToMessageId:$m.id}'
```

转发用新目标/主题/正文，若需原附件填 `forwardAttachmentsFrom`；保留原 HTML 时也带原正文，并让服务器还原本站来源内嵌 CID。普通用户需拥有原邮件地址，管理员仍应按任务范围操作。

部分失败补发：获取完整原详情，以 `recipientOutcomes.status=failed` 筛原 `recipients.to/cc/bcc` 各数组，新的请求只保留失败地址，`to` 可为空，保持原分组；原 HTML/text 与 `replyToMessageId` 上下文按需要保留，附件通过 `forwardAttachmentsFrom=原 outbound ID` 复制，不引用已消费的旧 Tokens。这是新的发送，使用新持久化 Key。没有逐目标结果或仍是 pending 时先核实，不全体重发。
