#!/usr/bin/env bash
# 两份 OpenAPI（/api/openapi.json 与 /v1/openapi.json）导出后按仓库根 .spectral.yaml 检查，CI 与部署流水线共用：
#   bash scripts/check-openapi.sh [输出目录]（缺省用临时目录）
# Spectral 是 npx 现装的第三方包：固定版本、不跑安装脚本；env -i 只给 PATH/HOME，
# 流水线前面写进环境（GITHUB_ENV）的账户、D1、KV 标识不进入它的环境。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$(mktemp -d)}

node "$root/apps/worker/scripts/export-openapi.mjs" "$out"
env -i PATH="$PATH" HOME="$HOME" npm_config_ignore_scripts=true \
  npx --yes @stoplight/spectral-cli@6.17.1 lint "$out/api.json" "$out/v1.json" \
  --ruleset "$root/.spectral.yaml" --fail-severity=error
