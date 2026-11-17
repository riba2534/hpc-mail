#!/usr/bin/env bash
# 部署后探针：验证 fetch 以外的两个入口确实跑在新版本上
#   canary     经 POST /api/internal/canary 真实外发一封金丝雀信（send_email → MX → Email Routing → email handler），
#              轮询 GET /api/internal/canary/:nonce，直到 received 且由本次 build 处理
#   heartbeat  轮询 GET /api/internal/health，直到 scheduled 写的 cron 心跳来自本次 build
#              （只比对 build：心跳在 build 不变时不刷新 at，同一提交重跑部署时看到的是上次的心跳，属于接受的取舍）
# 用法:
#   BASE_URL=https://your-domain.example CANARY_TOKEN=xx BUILD_SHA=<commit> ./scripts/deploy-probe.sh canary|heartbeat
# CANARY_TOKEN = hex(HMAC-SHA256(JWT_SECRET, "hpc-canary-v1"))，令牌错误时端点一律 404：
#   printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}'
# 金丝雀须显式启用（会真实外发邮件，Workers Free 计划的 send_email 只能发往已验证地址）：
#   CANARY_FROM_DOMAIN 与 CANARY_TO_DOMAIN 都设置时启用，收发域名须在系统域名列表内；
#   或 DEPLOY_CANARY=on，由服务端按字母序取系统域名的前两个；DEPLOY_CANARY=off 一律跳过。
# 可选：
#   CANARY_TIMEOUT（默认 180 秒）、HEARTBEAT_TIMEOUT（默认 600 秒）、PROBE_POLL_INTERVAL（默认 10 秒）、
#   PROBE_CURL_TIMEOUT（单个请求超时，默认 30 秒）
set -euo pipefail

: "${BASE_URL:?需要 BASE_URL}"
: "${CANARY_TOKEN:?需要 CANARY_TOKEN}"
: "${BUILD_SHA:?需要 BUILD_SHA}"
CANARY_TIMEOUT=${CANARY_TIMEOUT:-180}
HEARTBEAT_TIMEOUT=${HEARTBEAT_TIMEOUT:-600}
POLL_INTERVAL=${PROBE_POLL_INTERVAL:-10}
CURL_TIMEOUT=${PROBE_CURL_TIMEOUT:-30}

fail() { echo "::error::$1"; exit 1; }
summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; }

# 带令牌请求内部端点：internal <路径> [curl 参数...]；结果写入 HTTP_STATUS / HTTP_BODY，
# 网络错误记为状态 000，由调用方决定是否重试
internal() {
  local path=$1 response
  shift
  response=$(curl -sS --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' -H "X-Canary-Token: $CANARY_TOKEN" "$@" "$BASE_URL$path" 2>/dev/null) || response=$'\n000'
  HTTP_STATUS=$(tail -n 1 <<< "$response")
  HTTP_BODY=$(sed '$d' <<< "$response")
}

# 只信 JSON 字段；响应不是 JSON（如边缘错误页）时返回空串
field() { jq -r "$1 // empty" <<< "$HTTP_BODY" 2>/dev/null || true; }

# 已发起的外发请求数：服务端全站每分钟限 2 次（校验通过即计数，外发失败也算），补发与重试共用这个额度
POSTS=0

send_canary() {
  local body
  body=$(jq -nc '{fromDomain: (env.CANARY_FROM_DOMAIN // ""), toDomain: (env.CANARY_TO_DOMAIN // "")} | with_entries(select(.value != ""))')
  while :; do
    internal /api/internal/canary -X POST -H 'Content-Type: application/json' --data-binary "$body"
    POSTS=$((POSTS + 1))
    # 网络错误或 5xx 重试一次；结果不明的那次可能已经发出，所以只重试一次
    [[ "$HTTP_STATUS" == 000 || "$HTTP_STATUS" == 5?? ]] && [ "$POSTS" -lt 2 ] || break
    echo "::warning::金丝雀外发返回 HTTP $HTTP_STATUS，${POLL_INTERVAL}s 后重试一次"
    sleep "$POLL_INTERVAL"
  done
  case "$HTTP_STATUS" in
    2??) ;;
    404) fail "金丝雀端点返回 404：令牌与线上 jwt_secret 不符，或线上版本还没有该端点" ;;
    *) fail "金丝雀外发失败: HTTP $HTTP_STATUS $HTTP_BODY" ;;
  esac
  nonce=$(field '.data.nonce')
  [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || fail "金丝雀响应缺少 nonce: $HTTP_BODY"
  echo "已外发金丝雀 $(field '.data.from') → $(field '.data.to')（nonce $nonce，外发 build $(field '.data.build')）"
}

canary_enabled() {
  case "${DEPLOY_CANARY:-}" in
    off) return 1 ;;
    on) return 0 ;;
  esac
  [ -n "${CANARY_FROM_DOMAIN:-}" ] && [ -n "${CANARY_TO_DOMAIN:-}" ]
}

probe_canary() {
  if ! canary_enabled; then
    echo '::notice::收件金丝雀未启用：设置 Variable CANARY_FROM_DOMAIN 与 CANARY_TO_DOMAIN（或 DEPLOY_CANARY=on）后启用'
    summary '- 收件金丝雀：未启用，已跳过'
    return 0
  fi
  local started=$SECONDS deadline=$((SECONDS + CANARY_TIMEOUT)) received build
  send_canary
  while :; do
    sleep "$POLL_INTERVAL"
    internal "/api/internal/canary/$nonce"
    received=$(field '.data.received')
    build=$(field '.data.build')
    if [ "$received" = "true" ] && [ "$build" = "$BUILD_SHA" ]; then
      echo "金丝雀已由新版本收件（$(field '.data.receivedAt')，用时 $((SECONDS - started))s）"
      summary "- 收件金丝雀：新版本已收到（用时 $((SECONDS - started))s，nonce \`$nonce\`）"
      return 0
    fi
    if [ "$received" = "true" ]; then
      # 发布切换期间收件可能落在旧版本上；全站每分钟限 2 封，额度没被重试用掉时补发一次
      if [ "$POSTS" -ge 2 ] || [ "$SECONDS" -ge "$deadline" ]; then
        fail "金丝雀由旧版本 build ${build:-未知} 收件，新版本 email handler 未得到验证"
      fi
      echo "::warning::金丝雀由旧版本 build ${build:-未知} 收件（发布切换中），补发一次"
      send_canary
      continue
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "${CANARY_TIMEOUT}s 内未收到金丝雀（nonce $nonce，最后一次查询 HTTP $HTTP_STATUS）：检查 send_email、收件域名的 Email Routing catch-all 与 email handler 日志"
    echo "等待金丝雀到达…（${HTTP_STATUS}，已等 $((SECONDS - started))s）"
  done
}

probe_heartbeat() {
  local started=$SECONDS deadline=$((SECONDS + HEARTBEAT_TIMEOUT)) cron_build failed_steps
  while :; do
    internal /api/internal/health
    [ "$HTTP_STATUS" != "404" ] || fail "健康端点返回 404：令牌与线上 jwt_secret 不符，或线上版本还没有该端点"
    cron_build=$(field '.data.cron.build')
    if [ "$cron_build" = "$BUILD_SHA" ]; then
      echo "cron 心跳来自新版本（$(field '.data.cron.at')，cron $(field '.data.cron.cron')，用时 $((SECONDS - started))s）"
      summary "- cron 心跳：新版本已运行（$(field '.data.cron.at')，cron \`$(field '.data.cron.cron')\`）"
      if [ "$(field '.data.cron.ok')" != "true" ]; then
        # 失败步骤多为外部依赖（如 Cloudflare API）抖动，不判定发布失败，只提示人工跟进
        failed_steps=$(field '(.data.cron.failedSteps // []) | join(", ")')
        echo "::warning::新版本 cron 有失败步骤：$failed_steps"
        summary "  - 失败步骤：$failed_steps"
      fi
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "${HEARTBEAT_TIMEOUT}s 内没有等到新版本的 cron 心跳（最近一次 build ${cron_build:-无}，时间 $(field '.data.cron.at')）"
    echo "等待新版本 cron 心跳…（当前 build ${cron_build:-无}，时间 $(field '.data.cron.at')，已等 $((SECONDS - started))s）"
    sleep "$POLL_INTERVAL"
  done
}

case "${1:-}" in
  canary) probe_canary ;;
  heartbeat) probe_heartbeat ;;
  *) echo "用法: $0 canary|heartbeat" >&2; exit 2 ;;
esac
