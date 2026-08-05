#!/usr/bin/env bash
# 端到端回归：playwright headless 浏览器跑全部页面 + 关键交互。
# 用法：
#   scripts/e2e.sh                          # 默认 http://localhost:8099，token=t
#   E2E_URL=http://localhost:8080 E2E_TOKEN=xxx scripts/e2e.sh
# 需要：playwright-core（npm i -g playwright-core）+ 本机 chromium（~/.cache/ms-playwright 或 $CHROME_PATH）
set -euo pipefail
cd "$(dirname "$0")/.."

export E2E_URL="${E2E_URL:-http://127.0.0.1:8099}"
export E2E_TOKEN="${E2E_TOKEN:-t}"
export E2E_VIEWPORT="${E2E_VIEWPORT:-1440x900}"
export NODE_PATH="${NODE_PATH:-$(npm root -g)}"  # playwright-core 为全局安装

node scripts/e2e.js
