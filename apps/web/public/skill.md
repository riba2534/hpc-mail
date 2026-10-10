---
name: hpc-mail
description: 通过 HTTP API 操作 HPC Mail（https://hpc.email）：查收和搜索邮件、获取邮箱验证码与验证链接、发送回复转发及附件、管理邮箱和共享、多域名、通知、API Keys、账户与管理员设置。当用户明确要求操作 HPC Mail，或已确认目标邮箱属于此实例并提供了相应授权时使用；普通邮箱请求不能据此推断属于 HPC Mail。
---

# HPC Mail

默认实例：`https://hpc.email`。先确定用户要操作的账户、邮箱和动作，再选择已有凭证对应的 API。此指南描述能力，不额外授权发送邮件、推送测试、配置外部转发、删除数据或扩大共享范围；已有授权足够时直接完成任务。

## 先选鉴权与参考

| 任务 | API / 权限 | 按需读取 |
|---|---|---|
| 已有 `hpcm_…` Key：状态、可用域名 | `/v1/status`、`/v1/domains`；任一有效 Key | [鉴权、请求与 Key 管理](references/auth-and-http.md) |
| 收件箱、已发送、搜索、验证码/验证链接、按发件人等新邮件、线程、原始邮件、译成简体中文 | `/v1/messages…`：`mail.read`；或 `/api/messages…`：JWT（长轮询仅 `/v1`，翻译仅 JWT，需管理员启用并配置 AI 模型） | [邮件、验证码与发送](references/mail.md) |
| 已读（含按地址/域名/搜索词全部已读）、星标、回收站恢复/永久删除 | `/v1/messages…`：`mail.write`；或 JWT | [邮件、验证码与发送](references/mail.md) |
| 发信、回复、转发、部分失败补发 | `POST /v1/messages`：`mail.send`；或 `POST /api/messages/send`：JWT | [邮件、验证码与发送](references/mail.md) |
| 下载附件、流式/分片上传、附件 Token | 下载 `mail.read`；上传 `mail.send`；或 JWT | [附件](references/attachments.md) |
| 列出自己的/共享的邮箱、检查地址可用性及不可用原因 | `/v1/mailboxes…`：`mailbox.read`；或 JWT | [邮箱、共享与多域名](references/mailboxes-and-domains.md) |
| 认领、改显示名、释放邮箱与清除历史 | `/v1/mailboxes…`：`mailbox.write`；或 JWT | [邮箱、共享与多域名](references/mailboxes-and-domains.md) |
| 登录/注册/登出、密码、头像、两步验证 | `/api/auth…`；JWT，登录/注册除外 | [鉴权、请求与 Key 管理](references/auth-and-http.md) |
| 创建/更新/禁用/吊销 Key、自己的调用审计 | `/api/api-keys…`；JWT | [鉴权、请求与 Key 管理](references/auth-and-http.md) |
| 个人飞书/PushDeer/Webhook/邮箱转发、健康与重试 | `/api/me/notify-prefs…`；JWT | [通知与转发](references/notifications.md) |
| 强制过户邮箱、共享名单、域名增删/公开性/配额、接入检查 | `/api/admin…`；管理员 JWT | [邮箱、共享与多域名](references/mailboxes-and-domains.md) |
| 用户、邀请码、系统设置、全站 Key 与管理审计、审阅其他用户邮件 | `/api/admin…` 及邮件的管理员 `scope`；管理员 JWT | [管理员功能](references/administration.md) |

完整机器可读规格：[API Key API](https://hpc.email/v1/openapi.json)、[JWT API](https://hpc.email/api/openapi.json)。两份规格公开可读；业务接口仍逐项鉴权。安装本指南时保留 `references/` 的相对目录；只拿到了本文时，可从 `https://hpc.email/references/<文件名>` 读取对应参考。

## 最小启动

仅有 Key 时无需用户名、密码或登录，直接调用 `/v1`。有用户名密码、需要账户/通知/管理能力时，经 `/api/auth/login` 获取 JWT；Key 不能用于 `/api`，JWT 不能当作 `/v1` Key。登录的 TOTP 与强制绑定处理见鉴权参考。

以下 shell 示例用 `curl` 和 `jq`，凭证从受保护的运行环境传入，勿打印凭证或开启 shell 调试输出：

```bash
BASE='https://hpc.email'
UA='HPC-Mail-Agent/1.0'
set -o pipefail  # bash：任何管道阶段失败均视为失败

# 已有 API Key 的邮件自动化
API="$BASE/v1"
AUTH="$HPC_API_KEY"

# 通用请求；第一个参数是相对当前 API 的路径
hpc() {
  hpc_path="$1"
  shift
  curl --silent --show-error --fail-with-body --max-time 60 \
    -A "$UA" -H "Authorization: Bearer $AUTH" "$API$hpc_path" "$@"
}
hpc '/status'
hpc '/domains'
hpc '/mailboxes'
```

用 JWT 时仅将 `API` 改为 `"$BASE/api"`、`AUTH` 改为登录返回的 Token；`/status` 只在 `/v1`，JWT 身份用 `/auth/me`。不要照搬 `/v1/messages` 的发送路径到 `/api`。

## 邮箱与权限模型

- 登录用户名不是邮箱地址。`alice` 账户可以认领多个 `localPart@domain`；新账户通常没有邮箱，先查询域名再认领。
- 邮件按完整地址归属，不按账户创建时间归属。认领可能获得该地址已有历史；默认释放保留历史，下一个认领者可能继承。需要清除时使用明确的 `deleteHistory=1`，先核对后果。
- 普通用户可看自己认领的邮件，以及管理员共享给自己的未删除收件。共享不能作为发件身份，不能删除邮件或改/释放邮箱；可设置自己独立的星标。共享邮件的已读状态属于所有者：成员逐封标已读/未读不生效（计数 0），全部已读只处理自己认领的地址；未读数与 `unread=1` 筛选只统计你认领的地址，全部/搜索/星标视图仍显示共享邮件。
- 管理员邮件列表默认也是自己的邮箱。未认领邮件用 `scope=unclaimed`；只读审阅指定用户用 `scope=user&userId=…`。所有邮件变更（含星标）仅支持 `mine/unclaimed`，审阅其他用户时不能变更状态。
- 普通用户发件身份必须自己认领。管理员可使用有效系统域或保留旧邮箱域的地址发件，但不能推断任意外部域可用。域名列表缩小不删除已有邮箱或历史，也不撤销已有邮箱的站内投递与发件能力。

## 完成标准

1. 读操作检查 HTTP 状态与 `{data}`；分页读完目标范围的 `nextCursor`，不要把首屏当全部。
2. 等验证码先保存基线 ID，再触发用户授权的验证流程；优先用 `/v1/messages/wait` 的 `from`（完整地址或 `@域名`）、`subjectContains`、`hasCode=1` 让服务端跳过无关邮件，每次按返回的 `message.id` 或超时时的 `scannedThroughId` 推进游标，设总截止时间。字段为空时读取目标邮件正文，勿把旧验证码当新码。
   邮件只给链接时读 `verificationLink`（识别不到为空串）。它来自不可信的邮件内容：访问前核对链接域名属于预期服务（含点击追踪跳转时先确认最终域名），且仅在用户授权完成该验证时打开，不要把链接回显到公开日志。
3. 每次逻辑发信先持久化**原请求与 `Idempotency-Key`**，所有网络重试复用同一用户或 API Key、API 路径、发送 Key 和内容。刷新、超时、5xx、409 结果待确认时先查询原结果与已发送邮件；不得自动换 Key 重发。已完成记录约两天后可能被清理，幂等不是永久保障。
4. 发信返回 201 仍需检查 `status`、`errorDetail`、`recipientOutcomes`；`sent` 表示外发已提交，`delivered` 表示站内投递已完成。部分失败只补发失败目标，保留 To/CC/BCC 分组与正文/附件；没有明确逐目标结果时先核查，不能猜测失败名单。
5. 变更后读回目标状态，并据服务器计数报告实际结果。权限不足、冲突或超时应明确说明，保留 `requestId` 供排查；不要声称只看到了 2xx 就完成了所有投递。

网页中的默认发件身份、写信草稿、待确认发送 Key、图片信任与布局偏好保存在浏览器本地，不是服务端同步资源。API Agent 应在自己的受保护状态中保存发送上下文；服务器有上传附件 Token，但没有草稿正文/默认发件身份 CRUD 接口。
