#!/usr/bin/env bash
# 部署回滚用：记录与恢复 Worker 的 cron 触发器（Cloudflare API .../workers/scripts/<名称>/schedules）
#   save <文件>     读出当前 schedules，以 [{"cron": "..."}] 写入文件；Worker 还不存在（首次部署）时写 []。
#                   读取失败以 1 退出：回滚时无法恢复触发器，部署应当中止
#   restore <文件>  把 schedules 恢复为文件里的值；失败只输出 ::warning:: 并以 0 退出，不改变回滚结论
# wrangler rollback 只换回代码版本、不恢复触发器：新版本加的 cron 会留在线上，被旧代码当成常规任务执行。
# 需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；可选 WORKER_NAME（默认 hpc-cloud-mail）、
# CF_API_BASE（默认 Cloudflare API，自测时指向桩）、SCHEDULES_CURL_TIMEOUT（默认 30 秒）。
# 日志与 Job Summary 只写 cron 表达式、HTTP 状态与 Cloudflare 错误码，不写账户 id 与请求 URL。
set -euo pipefail

mode=${1:?用法: worker-schedules.sh save|restore <文件>}
file=${2:?用法: worker-schedules.sh save|restore <文件>}
: "${CLOUDFLARE_API_TOKEN:?需要 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?需要 CLOUDFLARE_ACCOUNT_ID}"
WORKER_NAME=${WORKER_NAME:-hpc-cloud-mail}
API=${CF_API_BASE:-https://api.cloudflare.com/client/v4}
CURL_TIMEOUT=${SCHEDULES_CURL_TIMEOUT:-30}
url="$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/schedules"

summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; }

# request <方法> [curl 参数...]：结果写入 HTTP_STATUS / HTTP_BODY，网络错误记为 000。
# curl 自己的报错不输出（会带上含账户 id 的 URL）
request() {
  local method=$1 response
  shift
  response=$(curl -sS --max-time "$CURL_TIMEOUT" -X "$method" -w '\n%{http_code}' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@" "$url" 2>/dev/null) || response=$'\n000'
  HTTP_STATUS=$(tail -n 1 <<< "$response")
  HTTP_BODY=$(sed '$d' <<< "$response")
}
error_codes() { jq -r '[.errors[]?.code | tostring] | join(",")' <<< "$HTTP_BODY" 2>/dev/null || true; }
list_crons() { jq -r 'if length == 0 then "无" else map("`" + .cron + "`") | join("、") end' "$1"; }

case "$mode" in
  save)
    request GET
    if [ "$HTTP_STATUS" = 200 ] && jq -e '.success == true and (.result.schedules | type == "array")' <<< "$HTTP_BODY" >/dev/null 2>&1; then
      jq '[.result.schedules[] | {cron}]' <<< "$HTTP_BODY" > "$file"
      crons=$(list_crons "$file")
      echo "部署前的 cron 触发器：$crons"
      summary "- 部署前的 cron 触发器：$crons"
      exit 0
    fi
    # Worker 还不存在（首次部署）：没有可回滚的版本，也就没有要恢复的触发器
    if [ "$HTTP_STATUS" = 404 ] || grep -qE '(^|,)10007(,|$)' <<< "$(error_codes)"; then
      echo '[]' > "$file"
      echo '::notice::Worker 尚未部署过，没有需要记录的 cron 触发器'
      summary '- 部署前的 cron 触发器：无（首次部署）'
      exit 0
    fi
    echo "::error::读取部署前的 cron 触发器失败（HTTP $HTTP_STATUS，错误码 $(error_codes)），失败时无法恢复触发器，终止部署"
    exit 1
    ;;
  restore)
    if ! jq -e 'type == "array"' "$file" >/dev/null 2>&1; then
      echo '::warning::没有记录到部署前的 cron 触发器，跳过恢复；请到 Cloudflare 控制台核对 Triggers'
      summary '- cron 触发器：没有基线，未恢复，请人工核对'
      exit 0
    fi
    crons=$(list_crons "$file")
    request PUT -H 'Content-Type: application/json' --data-binary "@$file"
    if [ "$HTTP_STATUS" = 200 ] && jq -e '.success == true' <<< "$HTTP_BODY" >/dev/null 2>&1; then
      echo "已把 cron 触发器恢复为部署前的值：$crons"
      summary "- cron 触发器已恢复为部署前的值：$crons"
      exit 0
    fi
    echo "::warning::恢复 cron 触发器失败（HTTP $HTTP_STATUS，错误码 $(error_codes)），请手动恢复为：$crons（见 docs/ROLLBACK.md）"
    summary "- **cron 触发器恢复失败**（HTTP $HTTP_STATUS），请手动恢复为：$crons（见 docs/ROLLBACK.md）"
    exit 0
    ;;
  *)
    echo "未知模式：$mode（只支持 save、restore）" >&2
    exit 2
    ;;
esac
