#!/usr/bin/env bash
# 前端打包：src/ ES 模块 → 单文件 app.bundle.js（嵌入 Go 二进制，单文件离线分发）。
# 用法：scripts/build-frontend.sh [--minify] [--check]
set -euo pipefail
cd "$(dirname "$0")/.."

MINIFY=false
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --minify) MINIFY=true ;;
    --check) CHECK=true ;;
    *)
      echo "用法：$0 [--minify] [--check]" >&2
      exit 2
      ;;
  esac
done

# 优先使用锁定在 package-lock.json 中的本地版本；保留全局回退，兼容已有
# 开发环境和单文件部署仓库的轻量使用方式。
if [ -n "${ESBUILD_BIN:-}" ]; then
  esbuild_bin="$ESBUILD_BIN"
elif [ -x "node_modules/.bin/esbuild" ]; then
  esbuild_bin="node_modules/.bin/esbuild"
elif command -v esbuild >/dev/null 2>&1; then
  esbuild_bin="$(command -v esbuild)"
else
  echo "错误：未找到 esbuild。请先执行 npm ci（推荐）或安装全局 esbuild。" >&2
  exit 1
fi

ARGS=(--bundle --format=iife --target=es2020 --log-level=warning)
if [ "$MINIFY" = true ]; then
  ARGS+=(--minify)
fi

python3 scripts/gen-globals.py

"$esbuild_bin" internal/web/static/src/main.js "${ARGS[@]}" --outfile=internal/web/static/app.bundle.js

if [ "$CHECK" = true ] && ! git diff --quiet -- internal/web/static/src/main.js internal/web/static/app.bundle.js; then
  echo "错误：前端源码生成的文件未提交。请运行 scripts/build-frontend.sh 并提交变更。" >&2
  git diff --stat -- internal/web/static/src/main.js internal/web/static/app.bundle.js >&2
  exit 1
fi

echo "前端打包完成 ✓"
