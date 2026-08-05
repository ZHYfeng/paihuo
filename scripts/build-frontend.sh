#!/usr/bin/env bash
# 前端打包：src/ ES 模块 → 单文件 app.bundle.js（嵌入 Go 二进制，单文件离线分发）。
# 用法：scripts/build-frontend.sh [--minify]
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v esbuild >/dev/null 2>&1; then
  echo "错误：需要 esbuild（npm i -g esbuild）" >&2
  exit 1
fi

ARGS=(--bundle --format=iife --target=es2020 --log-level=warning)
if [ "${1:-}" = "--minify" ]; then
  ARGS+=(--minify)
fi

python3 scripts/gen-globals.py

esbuild internal/web/static/src/main.js "${ARGS[@]}" --outfile=internal/web/static/app.bundle.js
echo "前端打包完成 ✓"
