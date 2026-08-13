#!/usr/bin/env bash
# 端到端回归：playwright headless 浏览器跑全部页面 + 关键交互。
# 用法：
#   scripts/e2e.sh                          # 默认 http://localhost:8099，token=t
#   E2E_URL=http://localhost:8080 E2E_TOKEN=xxx scripts/e2e.sh
# 需要：npm ci 后执行 npx playwright install chromium。
set -euo pipefail
cd "$(dirname "$0")/.."

export E2E_URL="${E2E_URL:-http://127.0.0.1:8099}"
export E2E_TOKEN="${E2E_TOKEN:-t}"
export E2E_VIEWPORT="${E2E_VIEWPORT:-1440x900}"
if [ ! -x node_modules/.bin/playwright ]; then
  echo "错误：缺少 Playwright，请先执行 npm ci。" >&2
  exit 1
fi

node scripts/e2e.js
