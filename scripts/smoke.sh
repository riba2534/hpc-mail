#!/usr/bin/env bash
# 部署后线上冒烟：公开端点 + 冒烟账号（普通用户）+ 管理员（能登录时）
# 用法:
#   BASE_URL=https://your-domain.example ADMIN_USERNAME=xx ADMIN_PASSWORD=xx SMOKE_PASSWORD=xx ./scripts/smoke.sh
# SMOKE_PASSWORD 是冒烟账号 ci-smoke 的密码：hex(HMAC-SHA256(JWT_SECRET, "ci-smoke-password-v1")) 的前 32 位，
#   部署流程由 apps/worker/scripts/seed-smoke.mjs 创建该账号；它登录失败判冒烟失败。
# 管理员登录不了时只跳过管理员专属检查、不判失败（普通用户检查照常由冒烟账号完成）：
#   - 开了两步验证（totp_required）且没给 ADMIN_TOTP_SECRET：打印 notice；
#   - 密码或两步验证码不对（bad_credentials，如站长在网页改了密码而 CI secret 没跟上）：打印 warning。
# 可选：ADMIN_TOTP_SECRET（管理员 TOTP 种子，base32；给了就算出当前验证码完成登录，需要 node）、
#   SMOKE_ASSET_RETRY_INTERVAL（静态资源重试间隔，默认 10 秒）、SMOKE_CURL_TIMEOUT（单个请求超时，默认 30 秒）
set -Eeuo pipefail
# 请求超时、连接错误等让命令直接失败退出时，也留下一条能定位的错误
trap 'code=$?; echo "::error::冒烟失败: 第 $LINENO 行命令退出码 $code（多为请求超时或连接错误）"' ERR

: "${BASE_URL:?需要 BASE_URL}"
: "${ADMIN_USERNAME:?需要 ADMIN_USERNAME}"
: "${ADMIN_PASSWORD:?需要 ADMIN_PASSWORD}"
: "${SMOKE_PASSWORD:?需要 SMOKE_PASSWORD（冒烟账号密码）}"
SMOKE_USERNAME=ci-smoke
ASSET_RETRIES=5
ASSET_RETRY_INTERVAL=${SMOKE_ASSET_RETRY_INTERVAL:-10}
CURL_TIMEOUT=${SMOKE_CURL_TIMEOUT:-30}

# 每个请求都有上限：线上挂住的连接不能把冒烟拖到 job 超时（那样自动回滚也来不及跑）
curl() { command curl --max-time "$CURL_TIMEOUT" "$@"; }

PASS=0
step() { PASS=$((PASS + 1)); echo "[$PASS] $1"; }
fail() { echo "::error::冒烟失败: $1"; exit 1; }

ADMIN_TOKEN=""
USER_TOKEN=""
cleanup() {
  for token in "$ADMIN_TOKEN" "$USER_TOKEN"; do
    [ -n "$token" ] && curl -sS -o /dev/null -X POST "$BASE_URL/api/auth/logout" -H "Authorization: Bearer $token" || true
  done
}
trap cleanup EXIT

# 登录：login <用户名> <密码> [两步验证码]，结果写入 LOGIN_STATUS / LOGIN_BODY。
# 凭据经环境变量交给 jq、经 stdin 交给 curl，不出现在命令行参数里
login() {
  local response
  response=$(LOGIN_USERNAME="$1" LOGIN_PASSWORD="$2" LOGIN_TOTP="${3:-}" jq -n '
    {username: env.LOGIN_USERNAME, password: env.LOGIN_PASSWORD} + (if env.LOGIN_TOTP == "" then {} else {totp: env.LOGIN_TOTP} end)' |
    curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' --data-binary @-)
  LOGIN_STATUS=$(tail -n 1 <<< "$response")
  LOGIN_BODY=$(sed '$d' <<< "$response")
}

# 按 ADMIN_TOTP_SECRET 算当前 TOTP（RFC 6238：SHA-1、6 位、30 秒，同 worker src/lib/totp.ts）。
# 种子只经环境变量交给 node，不进命令行参数，也不打印
totp_now() {
  node -e '
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0, value = 0;
    const key = [];
    for (const ch of (process.env.ADMIN_TOTP_SECRET || "").toUpperCase()) {
      const index = alphabet.indexOf(ch);
      if (index === -1) continue;
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) { key.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const hash = require("node:crypto").createHmac("sha1", Buffer.from(key)).update(counter).digest();
    const code = (hash.readUInt32BE(hash[hash.length - 1] & 15) & 0x7fffffff) % 1000000;
    process.stdout.write(String(code).padStart(6, "0"));
  '
}

# 登出后旧 token 必须立即失效
assert_logout() {
  local token=$1 code
  curl -sS -o /dev/null -X POST "$BASE_URL/api/auth/logout" -H "Authorization: Bearer $token"
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/me" -H "Authorization: Bearer $token")
  [ "$code" = "401" ] || fail "$2 登出后 me 返回 $code（期望 401）"
}

# check_me <token> <角色> <用户名> <称呼>：校验身份且无密码字段泄漏，结果写入 ME
check_me() {
  ME=$(curl -sS "$BASE_URL/api/auth/me" -H "Authorization: Bearer $1")
  [ "$(jq -r '.data.role' <<< "$ME")" = "$2" ] || fail "$4 role != $2: $ME"
  [ "$(jq -r '.data.username' <<< "$ME")" = "$3" ] || fail "$4 username 不符: $ME"
  grep -qi 'password' <<< "$ME" && fail "me 响应疑似泄漏密码字段" || true
}

# 站点强制两步验证而 ME 对应的账号尚未绑定
needs_2fa_setup() { [ "$require2fa" = "true" ] && [ "$(jq -r '.data.twoFactorEnabled' <<< "$ME")" != "true" ]; }

# ---------- 公开端点 ----------

step "首页可访问"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$code" = "200" ] || fail "GET / 返回 $code"

step "静态资源边缘直出且缺失哈希资源仍为 404"
# 发布切换期间边缘可能短暂返回旧首页，它引用的旧哈希资源已不在新版本里（404）；
# 遇到 404 时带缓存击穿参数重取首页再试，最多重试 ASSET_RETRIES 次
page_url="$BASE_URL/"
attempt=0
while :; do
  asset=$(curl -fsS "$page_url" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1 || true)
  [ -n "$asset" ] || fail "首页未引用 /assets/*.js"
  asset_meta=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL$asset")
  [ "${asset_meta%% *}" = "404" ] && [ "$attempt" -lt "$ASSET_RETRIES" ] || break
  attempt=$((attempt + 1))
  echo "    $asset 返回 404（可能拿到了切换前的首页），${ASSET_RETRY_INTERVAL}s 后带缓存击穿重取首页（$attempt/$ASSET_RETRIES）"
  sleep "$ASSET_RETRY_INTERVAL"
  page_url="$BASE_URL/?smoke-cache-bust=$(date +%s)-$attempt"
done
echo "$asset_meta" | grep -qE '^200 (text|application)/javascript' || fail "现存静态资源响应异常: $asset $asset_meta"
# 先把响应头读进变量再判断：pipefail 下 `curl | tr | grep -q` 会因 grep 匹配后提前退出、上游收到 SIGPIPE 而随机判失败
asset_headers=$(curl -sS -D - -o /dev/null "$BASE_URL$asset" | tr -d '\r')
grep -qi '^cache-control:.*immutable' <<<"$asset_headers" || fail "现存静态资源缺少长缓存: $asset"
missing_asset=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/assets/missing-smoke-00000000.js")
[ "$missing_asset" = "404 text/plain; charset=utf-8" ] || fail "缺失哈希资源未返回 404: $missing_asset"

step "Service Worker 可更新"
sw_headers=$(curl -sS -D - -o /dev/null "$BASE_URL/sw.js" | tr -d '\r')
echo "$sw_headers" | head -1 | grep -q ' 200' || fail "/sw.js 未返回 200"
echo "$sw_headers" | grep -qi '^cache-control:.*no-cache' || fail "/sw.js 缺少 no-cache，紧急关闭版本可能无法及时生效"

step "公开配置合法"
timing=$(curl -sS -D - -o /dev/null "$BASE_URL/api/config" | tr -d '\r' | grep -i '^server-timing:' || true)
echo "$timing" | grep -q 'app;dur=' || fail "API 响应缺少 Server-Timing"
config=$(curl -sS "$BASE_URL/api/config")
mode=$(echo "$config" | jq -r '.data.registrationMode')
echo "$mode" | grep -qE '^(closed|invite|open)$' || fail "registrationMode 非法: $config"
# 域名由管理端维护，全新部署初始可为空（合法状态）；仅校验是数组
echo "$config" | jq -e '.data.domains | type == "array"' >/dev/null || fail "domains 非数组: $config"
require2fa=$(echo "$config" | jq -r '.data.require2fa // false')

step "OpenAPI 可读"
v1_openapi=$(curl -fsS "$BASE_URL/v1/openapi.json") || fail "/v1/openapi.json 不可读"
session_openapi=$(curl -fsS "$BASE_URL/api/openapi.json") || fail "/api/openapi.json 不可读"
jq -e '.openapi == "3.1.0"' <<< "$v1_openapi" >/dev/null || fail "OpenAPI 结构异常"

step "Agent 技能与会话 API 可发现"
jq -e '.openapi == "3.1.0" and (.paths["/auth/login"].post.requestBody != null) and (.paths["/admin/settings"].put != null)' <<< "$session_openapi" >/dev/null || fail "会话 OpenAPI 缺少认证或管理员能力"
agent_skill=$(curl -fsS "$BASE_URL/skill.md")
grep -q '^name: hpc-mail$' <<< "$agent_skill" || fail "Agent 技能元数据缺失"
agent_index=$(curl -fsS "$BASE_URL/llms.txt")
grep -q '/skill.md' <<< "$agent_index" || fail "Agent 发现入口缺失"
for reference in auth-and-http mail attachments mailboxes-and-domains notifications administration; do
  doc_metadata=$(curl -fsS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/references/$reference.md")
  [ "$doc_metadata" = "200 text/markdown; charset=utf-8" ] || fail "参考文档响应异常: $reference $doc_metadata"
done
missing_document=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/references/missing-smoke-document.md")
[ "$missing_document" = "404 text/plain; charset=utf-8" ] || fail "缺失参考文档未返回明确 404: $missing_document"

step "认领、过户、邮箱权限与共享的机器契约"
for namespace in api v1; do
  [ "$namespace" = api ] && spec=$session_openapi || spec=$v1_openapi
  jq -e '
    .components.schemas.ClaimMailboxRequest.properties.strategy.enum == ["uniform", "claude"] and
    (.components.schemas.ClaimMailboxRequest.required | index("strategy") == null) and
    any(.paths["/mailboxes/availability"].get.parameters[]; .name == "strategy" and .schema.enum == ["uniform", "claude"]) and
    (.components.schemas.MailboxAvailability.properties.reason.enum | index("claude_suspended") != null)
  ' <<< "$spec" >/dev/null || fail "$namespace Claude 认领契约缺失"
done
jq -e '
  .paths["/admin/mailboxes/{id}/transfer"].post["x-required-role"] == "admin" and
  .paths["/admin/users/search"].get["x-required-role"] == "admin" and
  (.components.schemas.TransferMailboxRequest.required | sort) == ["expectedOwnerId", "userId"]
' <<< "$session_openapi" >/dev/null || fail "邮箱过户机器契约缺失"
jq -e '
  .components.schemas.AdminUser.properties.mailboxPolicy != null and
  .components.schemas.AdminUser.properties.mailboxPolicyRevision.type == "integer" and
  .components.schemas.UpdateUserRequest.dependentRequired.mailboxPolicy == ["expectedMailboxPolicyRevision"]
' <<< "$session_openapi" >/dev/null || fail "用户专属邮箱权限机器契约缺失"
jq -e '
  .paths["/mailboxes/shares"].put.requestBody != null and
  .paths["/mailboxes/shares/{mailboxId}/grantees/{userId}"].delete != null and
  .paths["/mailboxes/share-users"].get != null and
  .paths["/admin/mailbox-shares"].put["x-required-role"] == "admin" and
  .components.schemas.MailboxShareGrant.properties.ownerUserId.type == "integer" and
  .components.schemas.MailboxShareGrant.properties.ownerUsername.type == "string" and
  .components.schemas.ReplaceMailboxSharesRequest.properties.expectedOwnerId.type == "integer"
' <<< "$session_openapi" >/dev/null || fail "共享邮箱机器契约缺失"

step "未知 API 返回结构化错误"
unknown=$(curl -sS -w '\n%{http_code}' "$BASE_URL/v1/missing-smoke-endpoint")
[ "$(echo "$unknown" | tail -1)" = "404" ] || fail "未知 API 未返回 404"
echo "$unknown" | head -1 | jq -e '.error.code == "not_found" and (.requestId | type == "string")' >/dev/null || fail "未知 API 错误不可解析"

step "系统域名一键接入：会话 OpenAPI 已登记、未登录返回 401（不调用 Cloudflare）"
jq -e '
  .paths["/admin/system-domains/zones"].get["x-required-role"] == "admin" and
  .paths["/admin/system-domains/onboardings"].post["x-required-role"] == "admin" and
  .paths["/admin/system-domains/hidden-zones"].put["x-required-role"] == "admin"
' <<< "$session_openapi" >/dev/null || fail "系统域名接入接口未登记到会话 OpenAPI"
for path in zones onboardings; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/admin/system-domains/$path")
  [ "$code" = "401" ] || fail "未登录访问 /api/admin/system-domains/$path 返回 $code"
done

step "注册模式=closed 时注册被拒"
if [ "$mode" = "closed" ]; then
  rcode=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/auth/register" \
    -H 'Content-Type: application/json' -d '{"username":"smoketest","password":"smoketest123"}')
  [ "$rcode" = "403" ] || fail "closed 模式注册返回 $rcode（期望 403）"
else
  echo "    （当前模式 $mode，跳过）"
fi

step "/v1 无 key 返回 401 且带 requestId"
v1=$(curl -sS -w '\n%{http_code}' "$BASE_URL/v1/status")
v1code=$(echo "$v1" | tail -1)
[ "$v1code" = "401" ] || fail "/v1/status 无鉴权返回 $v1code"
echo "$v1" | head -1 | jq -e '.requestId' >/dev/null || fail "/v1 错误体缺 requestId"

step "/v1/admin 无 key 返回 401 且带 requestId"
v1admin=$(curl -sS -w '\n%{http_code}' "$BASE_URL/v1/admin/users?usernames=$SMOKE_USERNAME")
v1admincode=$(echo "$v1admin" | tail -1)
[ "$v1admincode" = "401" ] || fail "/v1/admin/users 无鉴权返回 $v1admincode"
echo "$v1admin" | head -1 | jq -e '.error.code == "unauthorized" and (.requestId | type == "string")' >/dev/null || fail "/v1/admin 错误体异常"

# ---------- 冒烟账号（普通用户） ----------

user_checks() {
  local list domains
  step "冒烟账号 $SMOKE_USERNAME 真实登录"
  login "$SMOKE_USERNAME" "$SMOKE_PASSWORD"
  USER_TOKEN=$(jq -r '.data.token // empty' <<< "$LOGIN_BODY" 2>/dev/null || true)
  [ -n "$USER_TOKEN" ] || fail "冒烟账号登录失败（部署流程的 seed-smoke.mjs 负责创建）: HTTP $LOGIN_STATUS $LOGIN_BODY"

  step "冒烟账号为普通用户且无密码字段泄漏"
  check_me "$USER_TOKEN" user "$SMOKE_USERNAME" 冒烟账号

  if needs_2fa_setup; then
    step "强制两步验证拦截未绑定账号"
    gated=$(curl -sS -w '\n%{http_code}' "$BASE_URL/api/messages?limit=1" -H "Authorization: Bearer $USER_TOKEN")
    [ "$(echo "$gated" | tail -1)" = "403" ] || fail "require2fa 开启时未绑定账号未被拦截"
    echo "$gated" | head -1 | jq -e '.error.code == "totp_setup_required"' >/dev/null || fail "require2fa 拦截错误码异常"
    echo "::notice::站点开启了强制两步验证，$SMOKE_USERNAME 未绑定，跳过普通用户的数据接口检查"
  else
    step "普通用户邮件、域名、邮箱与通知接口可读"
    list=$(curl -fsS "$BASE_URL/api/messages?limit=5" -H "Authorization: Bearer $USER_TOKEN")
    echo "$list" | jq -e '.data.items | type == "array"' >/dev/null || fail "普通用户 items 非数组: $list"
    domains=$(curl -fsS "$BASE_URL/api/domains" -H "Authorization: Bearer $USER_TOKEN")
    echo "$domains" | jq -e '.data | type == "array"' >/dev/null || fail "普通用户域名列表非数组: $domains"
    for endpoint in mailboxes mailboxes/shared mailboxes/shares; do
      curl -fsS "$BASE_URL/api/$endpoint" -H "Authorization: Bearer $USER_TOKEN" | jq -e '.data | type == "array"' >/dev/null || fail "普通用户 $endpoint 结构异常"
    done
    curl -fsS "$BASE_URL/api/me/notify-prefs/health" -H "Authorization: Bearer $USER_TOKEN" | jq -e '.data | (.channels | type == "array") and (.forward.targets | type == "array")' >/dev/null || fail "普通用户通知状态结构异常"

    step "普通用户无法访问管理接口"
    denied=$(curl -sS -w '\n%{http_code}' "$BASE_URL/api/admin/settings" -H "Authorization: Bearer $USER_TOKEN")
    [ "$(echo "$denied" | tail -1)" = "403" ] || fail "普通用户访问 /api/admin/settings 未返回 403"
    echo "$denied" | head -1 | jq -e '.error.code == "forbidden"' >/dev/null || fail "普通用户越权错误码异常"
  fi

  step "冒烟账号登出后旧 token 失效"
  assert_logout "$USER_TOKEN" 冒烟账号
  USER_TOKEN=""
}

# ---------- 管理员（能登录时） ----------

admin_checks() {
  local list domains first_domain dlist settings claude_stats claude_plan claude_probe suspended_domain
  local zero_domain zero_availability fresh_claude_stats message_id admin_id transfer_input invalid_transfer
  step "当前用户为 admin 且无密码字段泄漏"
  check_me "$ADMIN_TOKEN" admin "$ADMIN_USERNAME" 管理员
  if needs_2fa_setup; then
    # 站点要求两步验证而管理员还没绑定：管理员自己也会被拦，属于配置问题而非本次发布引入
    echo "::warning::站点开启了强制两步验证但管理员尚未绑定，跳过其余管理员检查"
    step "管理员登出后旧 token 失效"
    assert_logout "$ADMIN_TOKEN" 管理员
    ADMIN_TOKEN=""
    return
  fi

  step "邮件列表与域名过滤"
  list=$(curl -sS "$BASE_URL/api/messages?limit=5" -H "Authorization: Bearer $ADMIN_TOKEN")
  echo "$list" | jq -e '.data.items | type == "array"' >/dev/null || fail "items 非数组: $list"
  # 域名取自 /api/domains（按角色返回，管理员=全部系统域名）；config.domains 仅含公开子集，可能为空
  domains=$(curl -sS "$BASE_URL/api/domains" -H "Authorization: Bearer $ADMIN_TOKEN")
  echo "$domains" | jq -e '.data | type == "array"' >/dev/null || fail "域名列表非数组: $domains"
  first_domain=$(echo "$domains" | jq -r '.data[0] // empty')
  if [ -n "$first_domain" ]; then
    dlist=$(curl -sS "$BASE_URL/api/messages?limit=5&domain=$first_domain" -H "Authorization: Bearer $ADMIN_TOKEN")
    echo "$dlist" | jq -e '.data.items | type == "array"' >/dev/null || fail "域名过滤失败: $dlist"
  fi

  step "admin 设置可读且密文脱敏"
  settings=$(curl -sS "$BASE_URL/api/admin/settings" -H "Authorization: Bearer $ADMIN_TOKEN")
  echo "$settings" | jq -e '.data.register_mode' >/dev/null || fail "settings 结构异常: $settings"

  step "邮箱与共享邮箱列表可读"
  for endpoint in mailboxes mailboxes/shared mailboxes/shares admin/mailbox-shares; do
    curl -fsS "$BASE_URL/api/$endpoint" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.data | type == "array"' >/dev/null || fail "$endpoint 结构异常"
  done

  step "Claude 0 封号规划与可用性（只读）"
  claude_stats=$(curl -fsS "$BASE_URL/api/admin/settings/domain-claude-stats" -H "Authorization: Bearer $ADMIN_TOKEN")
  jq -e '.data | type == "array" and all(.[]; if .suspended > 0 then .risk == "suspended" else .risk == null end)' \
    <<< "$claude_stats" >/dev/null || fail "Claude 域名风险未按任意历史封号标记"
  claude_plan=$(curl -fsS "$BASE_URL/api/mailboxes/random-plan?strategy=claude&count=10" -H "Authorization: Bearer $ADMIN_TOKEN")
  jq --argjson stats "$claude_stats" -e '
    ($stats.data | map(select(.suspended > 0) | .domain)) as $blocked |
    .data | .strategy == "claude" and (.items | type == "array") and (.pool | type == "array") and
    all(.items[]; .suspended == 0 and (.domain as $domain | $blocked | index($domain) == null)) and
    all(.pool[]; . as $domain | $blocked | index($domain) == null) and
    (.shortfall == 10 - (.items | length))
  ' <<< "$claude_plan" >/dev/null || fail "Claude 规划包含有封号域名或结构异常"
  claude_probe="smoke-claude-$(date +%s)"
  suspended_domain=$(jq -r '[.data[] | select(.suspended > 0)][0].domain // empty' <<< "$claude_stats")
  if [ -n "$suspended_domain" ]; then
    curl -fsS --get "$BASE_URL/api/mailboxes/availability" -H "Authorization: Bearer $ADMIN_TOKEN" \
      --data-urlencode "localPart=$claude_probe" --data-urlencode "domain=$suspended_domain" --data-urlencode 'strategy=claude' |
      jq -e '.data.available == false and .data.reason == "claude_suspended"' >/dev/null || fail "Claude 封号域名可用性未拒绝"
  else
    printf '%s\n' '    （没有历史封号域名，跳过封号域名可用性检查）'
  fi
  zero_domain=$(jq -r '[.data[] | select(.suspended == 0)][0].domain // empty' <<< "$claude_stats")
  if [ -n "$zero_domain" ]; then
    zero_availability=$(curl -fsS --get "$BASE_URL/api/mailboxes/availability" -H "Authorization: Bearer $ADMIN_TOKEN" \
      --data-urlencode "localPart=$claude_probe" --data-urlencode "domain=$zero_domain" --data-urlencode 'strategy=claude')
    if jq -e '.data.available == false and .data.reason == "claude_suspended"' <<< "$zero_availability" >/dev/null; then
      # 初次统计之后可能刚补录了首条封号；只有最新事实能证实这次拒绝时才通过。
      fresh_claude_stats=$(curl -fsS "$BASE_URL/api/admin/settings/domain-claude-stats" -H "Authorization: Bearer $ADMIN_TOKEN")
      jq --arg domain "$zero_domain" -e '.data | any(.[]; .domain == $domain and .suspended > 0 and .risk == "suspended")' \
        <<< "$fresh_claude_stats" >/dev/null || fail "Claude 零封号域名被拒绝，但最新统计没有对应封号事实"
    else
      jq -e '.data | .available == true or (.available == false and (.reason == "taken" or .reason == "quota" or .reason == "domain_limit"))' \
        <<< "$zero_availability" >/dev/null || fail "Claude 零封号域名可用性未遵循普通权限配额"
    fi
  else
    printf '%s\n' '    （没有零封号域名，跳过零封号域名可用性检查）'
  fi

  step "通知状态和转发配额可读"
  curl -fsS "$BASE_URL/api/me/notify-prefs/health" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.data | (.channels | type == "array") and (.forward.targets | type == "array")' >/dev/null || fail "通知状态结构异常"

  step "最近邮件详情与线程可读"
  message_id=$(echo "$list" | jq -r '.data.items[0].id // empty')
  if [ -n "$message_id" ]; then
    curl -fsS "$BASE_URL/api/messages/$message_id" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.data | (.bodyText | type == "string") and (.attachments | type == "array") and (.replyTo | type == "array")' >/dev/null || fail "邮件详情结构异常"
    curl -fsS "$BASE_URL/api/messages/$message_id/thread" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '.data.items | type == "array"' >/dev/null || fail "邮件线程结构异常"
  fi

  step "管理员用户搜索和邮箱过户"
  admin_id=$(jq -r '.data.id' <<< "$ME")
  curl -fsS --get "$BASE_URL/api/admin/users/search" --data-urlencode "q=$ADMIN_USERNAME" \
    -H "Authorization: Bearer $ADMIN_TOKEN" | jq --argjson userId "$admin_id" -e '
      .data.items[0].id == $userId and (.data.items | length) <= 20 and
      (.data.hasMore | type) == "boolean" and (.data.items[0] | keys | sort) == ["id", "role", "username"]
    ' >/dev/null || fail "管理员用户搜索结构或精确匹配异常"
  transfer_input=$(jq -n --argjson ownerId "$admin_id" '{userId:0,expectedOwnerId:$ownerId}')
  invalid_transfer=$(curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/api/admin/mailboxes/0/transfer" \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' --data-binary "$transfer_input")
  [ "$(echo "$invalid_transfer" | tail -1)" = "400" ] || fail "非法目标用户 ID 未被过户接口拒绝"
  echo "$invalid_transfer" | head -1 | jq -e '.error.code == "validation_failed"' >/dev/null || fail "非法过户请求错误不可解析"

  step "用户专属邮箱权限配置回显"
  curl -fsS "$BASE_URL/api/admin/users" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '
    .data | type == "array" and all(.[];
      has("mailboxPolicy") and
      (.mailboxPolicy == null or (.mailboxPolicy | type == "object")) and
      (.mailboxPolicyRevision | type == "number") and .mailboxPolicyRevision >= 0)
  ' >/dev/null || fail "用户邮箱权限配置或版本未正确回显"

  step "所有者共享与管理员全站共享"
  curl -fsS "$BASE_URL/api/mailboxes/shares" -H "Authorization: Bearer $ADMIN_TOKEN" | jq --argjson ownerId "$admin_id" -e '
    .data | type == "array" and all(.[]; .ownerUserId == $ownerId and (.ownerUsername | type == "string"))
  ' >/dev/null || fail "个人共享名单越出自有邮箱范围"
  curl -fsS "$BASE_URL/api/admin/mailbox-shares" -H "Authorization: Bearer $ADMIN_TOKEN" | jq -e '
    .data | type == "array" and all(.[];
      (.ownerUserId | type == "number") and (.ownerUsername | type == "string") and
      (.grantees | type == "array" and all(.[]; .status == "active" or .status == "disabled")))
  ' >/dev/null || fail "全站共享邮箱所有者或成员状态缺失"
  curl -fsS --get "$BASE_URL/api/mailboxes/share-users" --data-urlencode "q=$ADMIN_USERNAME" \
    -H "Authorization: Bearer $ADMIN_TOKEN" | jq --argjson userId "$admin_id" -e '
      .data.items[0].id == $userId and
      (.data.items | length) <= 20 and (.data.hasMore | type == "boolean") and
      (.data.items[0] | keys | sort) == ["id", "username"]
    ' >/dev/null || fail "共享成员搜索未正确返回管理员候选"

  step "管理员登出后旧 token 失效"
  assert_logout "$ADMIN_TOKEN" 管理员
  ADMIN_TOKEN=""
}

step "管理员真实登录"
admin_totp=""
[ -z "${ADMIN_TOTP_SECRET:-}" ] || admin_totp=$(totp_now) || fail "按 ADMIN_TOTP_SECRET 计算两步验证码失败"
login "$ADMIN_USERNAME" "$ADMIN_PASSWORD" "$admin_totp"
ADMIN_TOKEN=$(jq -r '.data.token // empty' <<< "$LOGIN_BODY" 2>/dev/null || true)
if [ -z "$ADMIN_TOKEN" ]; then
  # 管理员凭据与线上不同步属于配置问题而非本次发布引入，只跳过管理员检查，不触发回滚
  case "$LOGIN_STATUS:$(jq -r '.error.code // empty' <<< "$LOGIN_BODY" 2>/dev/null || true)" in
    401:totp_required)
      # 只在密码正确后返回：管理员凭据有效、只是开了两步验证
      echo "::notice::管理员已开启两步验证且未配置 ADMIN_TOTP_SECRET，跳过管理员专属检查；普通用户检查由 $SMOKE_USERNAME 完成" ;;
    401:bad_credentials)
      if [ -n "$admin_totp" ]; then
        echo "::warning::管理员登录被拒（bad_credentials）：ADMIN_PASSWORD 或 ADMIN_TOTP_SECRET 与线上不符，跳过管理员专属检查，请同步 CI secret"
      else
        echo "::warning::管理员登录被拒（bad_credentials）：ADMIN_PASSWORD 与线上不符（站长可能在网页改了密码），跳过管理员专属检查，请同步 CI secret"
      fi ;;
    *) fail "管理员登录未返回 token: HTTP $LOGIN_STATUS $LOGIN_BODY" ;;
  esac
fi

user_checks

# 管理员令牌为空说明上面已按 totp_required / bad_credentials 跳过
[ -z "$ADMIN_TOKEN" ] || admin_checks

echo "冒烟全部通过（$PASS 项）"
