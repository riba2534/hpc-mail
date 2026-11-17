#!/usr/bin/env bash
# 部署后探针：验证 fetch 以外的两个入口确实跑在新版本上
#   canary     经 POST /api/internal/canary 真实外发一封金丝雀信（send_email → MX → Email Routing → email handler），
#              轮询 GET /api/internal/canary/:nonce，直到 received 且由本次 build 处理
#   heartbeat  轮询 GET /api/internal/health，直到 scheduled 写的 cron 心跳来自本次 build
# 用法:
#   BASE_URL=https://your-domain.example CANARY_TOKEN=xx BUILD_SHA=<commit> ./scripts/deploy-probe.sh canary|heartbeat
# CANARY_TOKEN = hex(HMAC-SHA256(JWT_SECRET, "hpc-canary-v1"))，令牌错误时端点一律 404：
#   printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}'
# 可选：
#   DEPLOY_CANARY=off                    跳过金丝雀（如 Workers Free 计划 send_email 只能发往已验证地址）
#   SYSTEM_DOMAIN_COUNT=0                没有系统域名时跳过金丝雀（全新部署的合法状态）
#   CANARY_FROM_DOMAIN/CANARY_TO_DOMAIN  指定收发域名，须在系统域名列表内；默认由服务端按字母序取前两个
#   CANARY_TIMEOUT（默认 180 秒）、HEARTBEAT_TIMEOUT（默认 420 秒）、PROBE_POLL_INTERVAL（默认 10 秒）
set -euo pipefail

: "${BASE_URL:?需要 BASE_URL}"
: "${CANARY_TOKEN:?需要 CANARY_TOKEN}"
: "${BUILD_SHA:?需要 BUILD_SHA}"
CANARY_TIMEOUT=${CANARY_TIMEOUT:-180}
HEARTBEAT_TIMEOUT=${HEARTBEAT_TIMEOUT:-420}
POLL_INTERVAL=${PROBE_POLL_INTERVAL:-10}

fail() { echo "::error::$1"; exit 1; }
summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; }

# 带令牌请求内部端点：internal <路径> [curl 参数...]；结果写入 HTTP_STATUS / HTTP_BODY，
# 网络错误记为状态 000，由调用方决定是否重试
internal() {
  local path=$1 response
  shift
  response=$(curl -sS --max-time 30 -w '\n%{http_code}' -H "X-Canary-Token: $CANARY_TOKEN" "$@" "$BASE_URL$path" 2>/dev/null) || response=$'\n000'
  HTTP_STATUS=$(tail -n 1 <<< "$response")
  HTTP_BODY=$(sed '$d' <<< "$response")
}

# 只信 JSON 字段；响应不是 JSON（如边缘错误页）时返回空串
field() { jq -r "$1 // empty" <<< "$HTTP_BODY" 2>/dev/null || true; }

send_canary() {
  local body
  body=$(jq -nc '{fromDomain: (env.CANARY_FROM_DOMAIN // ""), toDomain: (env.CANARY_TO_DOMAIN // "")} | with_entries(select(.value != ""))')
  internal /api/internal/canary -X POST -H 'Content-Type: application/json' --data-binary "$body"
  case "$HTTP_STATUS" in
    2??) ;;
    404) fail "金丝雀端点返回 404：令牌与线上 jwt_secret 不符，或线上版本还没有该端点" ;;
    *) fail "金丝雀外发失败: HTTP $HTTP_STATUS $HTTP_BODY" ;;
  esac
  nonce=$(field '.data.nonce')
  [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || fail "金丝雀响应缺少 nonce: $HTTP_BODY"
  echo "已外发金丝雀 $(field '.data.from') → $(field '.data.to')（nonce $nonce，外发 build $(field '.data.build')）"
}

probe_canary() {
  if [ "${DEPLOY_CANARY:-on}" = "off" ]; then
    echo '::notice::DEPLOY_CANARY=off，跳过收件金丝雀'
    summary '- 收件金丝雀：已按 DEPLOY_CANARY=off 跳过'
    return 0
  fi
  if [ "${SYSTEM_DOMAIN_COUNT:-}" = "0" ]; then
    echo '::notice::尚未配置系统域名，跳过收件金丝雀（在管理后台添加域名后的下一次部署开始验证）'
    summary '- 收件金丝雀：尚未配置系统域名，已跳过'
    return 0
  fi
  local started=$SECONDS deadline=$((SECONDS + CANARY_TIMEOUT)) sends=0 received build
  send_canary
  sends=1
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
      # 发布切换期间收件可能落在旧版本上；全站每分钟限 2 封，只补发一次
      if [ "$sends" -ge 2 ] || [ "$SECONDS" -ge "$deadline" ]; then
        fail "金丝雀由旧版本 build ${build:-未知} 收件，新版本 email handler 未得到验证"
      fi
      echo "::warning::金丝雀由旧版本 build ${build:-未知} 收件（发布切换中），补发一次"
      send_canary
      sends=$((sends + 1))
      continue
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "${CANARY_TIMEOUT}s 内未收到金丝雀（nonce $nonce，最后一次查询 HTTP $HTTP_STATUS）：检查 send_email、收件域名的 Email Routing catch-all 与 email handler 日志"
    echo "等待金丝雀到达…（${HTTP_STATUS}，已等 $((SECONDS - started))s）"
  done
}

probe_heartbeat() {
  local started=$SECONDS deadline=$((SECONDS + HEARTBEAT_TIMEOUT)) cron_build
  while :; do
    internal /api/internal/health
    [ "$HTTP_STATUS" != "404" ] || fail "健康端点返回 404：令牌与线上 jwt_secret 不符，或线上版本还没有该端点"
    cron_build=$(field '.data.cron.build')
    if [ "$cron_build" = "$BUILD_SHA" ]; then
      echo "cron 心跳来自新版本（$(field '.data.cron.at')，cron $(field '.data.cron.cron')，用时 $((SECONDS - started))s）"
      summary "- cron 心跳：新版本已运行（$(field '.data.cron.at')，cron \`$(field '.data.cron.cron')\`）"
      if [ "$(field '.data.cron.ok')" != "true" ]; then
        # 失败步骤多为外部依赖（如 Cloudflare API）抖动，不判定发布失败，只提示人工跟进
        echo "::warning::新版本 cron 有失败步骤：$(jq -r '.data.cron.failedSteps // [] | join(", ")' <<< "$HTTP_BODY")"
        summary "  - 失败步骤：$(jq -r '.data.cron.failedSteps // [] | join(", ")' <<< "$HTTP_BODY")"
      fi
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "${HEARTBEAT_TIMEOUT}s 内没有等到新版本的 cron 心跳（最近一次 build ${cron_build:-无}，时间 $(field '.data.cron.at')）"
    echo "等待新版本 cron 心跳…（当前 ${cron_build:-无}，已等 $((SECONDS - started))s）"
    sleep "$POLL_INTERVAL"
  done
}

case "${1:-}" in
  canary) probe_canary ;;
  heartbeat) probe_heartbeat ;;
  *) echo "用法: $0 canary|heartbeat" >&2; exit 2 ;;
esac
