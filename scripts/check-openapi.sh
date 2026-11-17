#!/usr/bin/env bash
# 两份 OpenAPI（/api/openapi.json 与 /v1/openapi.json）导出后按仓库根 .spectral.yaml 检查，只在 PR CI（ci.yml）运行：
#   bash scripts/check-openapi.sh [输出目录]（缺省用临时目录）
# Spectral 是 npx 现装的第三方包：顶层版本固定、不跑安装脚本，但约 200 个传递依赖没有锁定。env -i 只隔离环境变量，
# 挡不住恶意包改写工作区文件，所以不能放进持有生产密钥、部署工作区产物的部署 job（scripts/check-deploy-scripts.mjs 校验）。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$(mktemp -d)}

node "$root/apps/worker/scripts/export-openapi.mjs" "$out"
env -i PATH="$PATH" HOME="$HOME" npm_config_ignore_scripts=true \
  npx --yes @stoplight/spectral-cli@6.17.1 lint "$out/api.json" "$out/v1.json" \
  --ruleset "$root/.spectral.yaml" --fail-severity=error
