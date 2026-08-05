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

esbuild internal/web/static/src/main.js "${ARGS[@]}" --outfile=internal/web/static/app.bundle.js

# 校验：模板 onclick 引用的全局函数必须由 main.js 挂到 window
python3 - <<'PYEOF'
import os, re, sys
KEYWORDS = {"if", "for", "while", "return", "new", "typeof", "delete", "void"}
root = os.getcwd()
needed = set()
for f in os.listdir("internal/web/templates"):
    if not f.endswith(".html"):
        continue
    t = open(os.path.join("internal/web/templates", f), encoding="utf-8").read()
    for m in re.finditer(r'on[a-z]+\s*=\s*"([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(', t):
        if m.group(1) not in KEYWORDS:
            needed.add(m.group(1))
main = open("internal/web/static/src/main.js", encoding="utf-8").read()
exported = set(re.findall(r"^window\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=", main, re.M))
missing = sorted(needed - exported)
if missing:
    print("错误：模板引用的全局函数未导出:", ", ".join(missing))
    sys.exit(1)
print(f"前端打包完成 ✓ 模板全局函数 {len(exported)} 个，全部就位")
PYEOF
