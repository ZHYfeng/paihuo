#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode="build"
if [ "${1:-}" = "--check" ]; then
  mode="check"
elif [ "$#" -gt 0 ]; then
  echo "用法：$0 [--check]" >&2
  exit 2
fi

if [ ! -x node_modules/.bin/vite ]; then
  echo "错误：缺少前端依赖，请先执行 npm ci。" >&2
  exit 1
fi

normalize_output() {
  find "$1" -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.json' \) \
    -exec sed -i 's/[[:blank:]]\+$//' {} +
}

if [ "$mode" = "build" ]; then
  node_modules/.bin/vite build
  normalize_output internal/web/dist
  echo "React 前端构建完成 ✓"
  exit 0
fi

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
node_modules/.bin/vite build --outDir "$build_dir/dist" >/dev/null
normalize_output "$build_dir/dist"
if ! diff -qr internal/web/dist "$build_dir/dist" >/dev/null; then
  echo "错误：内嵌前端产物不是当前源码的构建结果，请运行 npm run build:frontend。" >&2
  diff -qr internal/web/dist "$build_dir/dist" >&2 || true
  exit 1
fi
echo "React 前端产物已同步 ✓"
