#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
  echo "用法：$0" >&2
  exit 2
fi

if [ ! -x node_modules/.bin/vite ]; then
  echo "错误：缺少前端依赖，请先执行 npm ci。" >&2
  exit 1
fi

node_modules/.bin/vite build
touch internal/web/dist/.gitkeep
echo "React 前端构建完成 ✓"
