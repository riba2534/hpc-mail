#!/usr/bin/env bash
# 部署后线上冒烟：真实登录 + 关键端点 + 鉴权边界
# 用法: BASE_URL=https://your-domain.example ADMIN_USERNAME=xx ADMIN_PASSWORD=xx ./scripts/smoke.sh
set -euo pipefail

: "${BASE_URL:?需要 BASE_URL}"
: "${ADMIN_USERNAME:?需要 ADMIN_USERNAME}"
: "${ADMIN_PASSWORD:?需要 ADMIN_PASSWORD}"

PASS=0
step() { PASS=$((PASS + 1)); echo "[$PASS] $1"; }
fail() { echo "::error::冒烟失败: $1"; exit 1; }

TOKEN=""
cleanup() {
  if [ -n "$TOKEN" ]; then
    curl -sS -o /dev/null -X POST "$BASE_URL/api/auth/logout" -H "Authorization: Bearer $TOKEN" || true
  fi
}
trap cleanup EXIT

step "首页可访问"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/")
[ "$code" = "200" ] || fail "GET / 返回 $code"

step "静态资源边缘直出且缺失哈希资源仍为 404"
asset=$(curl -fsS "$BASE_URL/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
[ -n "$asset" ] || fail "首页未引用 /assets/*.js"
asset_meta=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL$asset")
echo "$asset_meta" | grep -qE '^200 (text|application)/javascript' || fail "现存静态资源响应异常: $asset $asset_meta"
curl -sS -D - -o /dev/null "$BASE_URL$asset" | tr -d '\r' | grep -qi '^cache-control:.*immutable' || fail "现存静态资源缺少长缓存: $asset"
missing_asset=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "$BASE_URL/assets/missing-smoke-00000000.js")
[ "$missing_asset" = "404 text/plain; charset=utf-8" ] || fail "缺失哈希资源未返回 404: $missing_asset"

step "公开配置合法"
timing=$(curl -sS -D - -o /dev/null "$BASE_URL/api/config" | tr -d '\r' | grep -i '^server-timing:' || true)
echo "$timing" | grep -q 'app;dur=' || fail "API 响应缺少 Server-Timing"
config=$(curl -sS "$BASE_URL/api/config")
mode=$(echo "$config" | jq -r '.data.registrationMode')
echo "$mode" | grep -qE '^(closed|invite|open)$' || fail "registrationMode 非法: $config"
# 域名由管理端维护，全新部署初始可为空（合法状态）；仅校验是数组
echo "$config" | jq -e '.data.domains | type == "array"' >/dev/null || fail "domains 非数组: $config"

step "管理员真实登录"
login=$(curl -sS -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$login" | jq -r '.data.token // empty')
[ -n "$TOKEN" ] || fail "登录未返回 token: $login"

step "当前用户为 admin 且无密码字段泄漏"
me=$(curl -sS "$BASE_URL/api/auth/me" -H "Authorization: Bearer $TOKEN")
[ "$(echo "$me" | jq -r '.data.role')" = "admin" ] || fail "role != admin: $me"
[ "$(echo "$me" | jq -r '.data.username')" = "$ADMIN_USERNAME" ] || fail "username 不符: $me"
echo "$me" | grep -qi 'password' && fail "me 响应疑似泄漏密码字段" || true

step "邮件列表与域名过滤"
list=$(curl -sS "$BASE_URL/api/messages?limit=5" -H "Authorization: Bearer $TOKEN")
echo "$list" | jq -e '.data.items | type == "array"' >/dev/null || fail "items 非数组: $list"
# 域名取自 /api/domains（按角色返回，管理员=全部系统域名）；config.domains 仅含公开子集，可能为空
domains=$(curl -sS "$BASE_URL/api/domains" -H "Authorization: Bearer $TOKEN")
echo "$domains" | jq -e '.data | type == "array"' >/dev/null || fail "域名列表非数组: $domains"
first_domain=$(echo "$domains" | jq -r '.data[0] // empty')
if [ -n "$first_domain" ]; then
  dlist=$(curl -sS "$BASE_URL/api/messages?limit=5&domain=$first_domain" -H "Authorization: Bearer $TOKEN")
  echo "$dlist" | jq -e '.data.items | type == "array"' >/dev/null || fail "域名过滤失败: $dlist"
fi

step "admin 设置可读且密文脱敏"
settings=$(curl -sS "$BASE_URL/api/admin/settings" -H "Authorization: Bearer $TOKEN")
echo "$settings" | jq -e '.data.register_mode' >/dev/null || fail "settings 结构异常: $settings"

step "邮箱与共享邮箱列表可读"
for endpoint in mailboxes mailboxes/shared admin/mailbox-shares; do
  curl -fsS "$BASE_URL/api/$endpoint" -H "Authorization: Bearer $TOKEN" | jq -e '.data | type == "array"' >/dev/null || fail "$endpoint 结构异常"
done

step "通知状态和转发配额可读"
curl -fsS "$BASE_URL/api/me/notify-prefs/health" -H "Authorization: Bearer $TOKEN" | jq -e '.data | (.channels | type == "array") and (.forward.targets | type == "array")' >/dev/null || fail "通知状态结构异常"

step "最近邮件详情与线程可读"
message_id=$(echo "$list" | jq -r '.data.items[0].id // empty')
if [ -n "$message_id" ]; then
  curl -fsS "$BASE_URL/api/messages/$message_id" -H "Authorization: Bearer $TOKEN" | jq -e '.data | (.bodyText | type == "string") and (.attachments | type == "array") and (.replyTo | type == "array")' >/dev/null || fail "邮件详情结构异常"
  curl -fsS "$BASE_URL/api/messages/$message_id/thread" -H "Authorization: Bearer $TOKEN" | jq -e '.data.items | type == "array"' >/dev/null || fail "邮件线程结构异常"
fi

step "OpenAPI 可读"
curl -fsS "$BASE_URL/v1/openapi.json" | jq -e '.openapi == "3.1.0"' >/dev/null || fail "OpenAPI 结构异常"

step "Agent 技能与会话 API 可发现"
curl -fsS "$BASE_URL/api/openapi.json" | jq -e '.openapi == "3.1.0" and (.paths["/auth/login"].post.requestBody != null) and (.paths["/admin/settings"].put != null)' >/dev/null || fail "会话 OpenAPI 缺少认证或管理员能力"
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

step "未知 API 返回结构化错误"
unknown=$(curl -sS -w '\n%{http_code}' "$BASE_URL/v1/missing-smoke-endpoint")
[ "$(echo "$unknown" | tail -1)" = "404" ] || fail "未知 API 未返回 404"
echo "$unknown" | head -1 | jq -e '.error.code == "not_found" and (.requestId | type == "string")' >/dev/null || fail "未知 API 错误不可解析"

step "管理员用户搜索和邮箱过户契约"
curl -fsS "$BASE_URL/api/openapi.json" | jq -e '
  .paths["/admin/mailboxes/{id}/transfer"].post["x-required-role"] == "admin" and
  .paths["/admin/users/search"].get["x-required-role"] == "admin" and
  (.components.schemas.TransferMailboxRequest.required | sort) == ["expectedOwnerId", "userId"]
' >/dev/null || fail "邮箱过户机器契约缺失"
admin_id=$(echo "$me" | jq -r '.data.id')
curl -fsS --get "$BASE_URL/api/admin/users/search" --data-urlencode "q=$ADMIN_USERNAME" \
  -H "Authorization: Bearer $TOKEN" | jq --argjson userId "$admin_id" -e '
    .data.items[0].id == $userId and (.data.items | length) <= 20 and
    (.data.hasMore | type) == "boolean" and (.data.items[0] | keys | sort) == ["id", "role", "username"]
  ' >/dev/null || fail "管理员用户搜索结构或精确匹配异常"
transfer_input=$(jq -n --argjson ownerId "$admin_id" '{userId:0,expectedOwnerId:$ownerId}')
invalid_transfer=$(curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/api/admin/mailboxes/0/transfer" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "$transfer_input")
[ "$(echo "$invalid_transfer" | tail -1)" = "400" ] || fail "非法目标用户 ID 未被过户接口拒绝"
echo "$invalid_transfer" | head -1 | jq -e '.error.code == "validation_failed"' >/dev/null || fail "非法过户请求错误不可解析"

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

step "登出后旧 token 失效"
curl -sS -o /dev/null -X POST "$BASE_URL/api/auth/logout" -H "Authorization: Bearer $TOKEN"
mcode=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/me" -H "Authorization: Bearer $TOKEN")
TOKEN=""
[ "$mcode" = "401" ] || fail "登出后 me 返回 $mcode（期望 401）"

echo "冒烟全部通过（$PASS 项）"
