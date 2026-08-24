#!/usr/bin/env bash
# 构建并替换 /home/yu/paihuo 中已有的 systemd 部署。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -ne 0 ]; then
  echo "用法：VERSION=vYYYY.MM.DD-n scripts/deploy-local.sh" >&2
  exit 2
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "错误：仓库有未提交改动，拒绝部署不可追溯版本" >&2
  exit 1
fi

DEPLOY_DIR=/home/yu/paihuo
DB="$DEPLOY_DIR/paihuo.db"
SERVICE=paihuo.service
commit="$(git rev-parse --short HEAD)"
commit_date="$(git show -s --format=%cd --date=format:%Y.%m.%d HEAD)"
VERSION="${VERSION:-v${commit_date}-${commit}}"
backup="$DEPLOY_DIR/backups/pre-${VERSION}-$(date +%Y%m%d-%H%M%S)"

printf '构建 %s（%s）\n' "$VERSION" "$commit"
npm ci
make check
make test-race
make release VERSION="$VERSION"

stopped=0
installed=0
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    if [ "$stopped" -eq 1 ] && [ "$installed" -eq 0 ]; then
      systemctl --user start "$SERVICE" || true
      echo "部署失败，旧服务已重新启动。" >&2
    else
      echo "部署失败；恢复点：$backup" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

systemctl --user stop "$SERVICE"
stopped=1
active="$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM tasks WHERE status IN ('running','active');")"
if [ "$active" -ne 0 ] || tmux -L paihuo list-windows -a -F '#{window_name}' 2>/dev/null | grep -Eq '^task-[0-9]+$'; then
  echo "错误：仍有运行中的 Task/Session，已取消部署" >&2
  exit 1
fi

sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null
mkdir -m 0700 -p "$backup"
install -m 0755 "$DEPLOY_DIR/paihuo" "$backup/paihuo"
sqlite3 "$DB" ".backup '$backup/paihuo.db'"
cp -a "$DEPLOY_DIR/artifacts" "$backup/artifacts"
[ "$(sqlite3 -readonly "$backup/paihuo.db" 'PRAGMA integrity_check;')" = ok ]
[ -z "$(sqlite3 -readonly "$backup/paihuo.db" 'PRAGMA foreign_key_check;')" ]

install -m 0755 bin/paihuo "$DEPLOY_DIR/.paihuo.new"
mv -f "$DEPLOY_DIR/.paihuo.new" "$DEPLOY_DIR/paihuo"
installed=1
systemctl --user start "$SERVICE"
stopped=0

for _ in $(seq 1 60); do
  if systemctl --user is-active --quiet "$SERVICE" && curl -fsS -o /dev/null http://127.0.0.1:8080/login; then
    [ "$("$DEPLOY_DIR/paihuo" --version)" = "$VERSION" ]
    [ "$(sqlite3 -readonly "$DB" 'PRAGMA integrity_check;')" = ok ]
    [ -z "$(sqlite3 -readonly "$DB" 'PRAGMA foreign_key_check;')" ]
    printf '部署完成：%s\n恢复点：%s\n' "$VERSION" "$backup"
    exit 0
  fi
  sleep 0.5
done

systemctl --user status "$SERVICE" --no-pager >&2 || true
exit 1
