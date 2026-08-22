#!/usr/bin/env bash
# ゼロくん新マシンセットアップ
# 使い方: リポを clone した直後に `bash zerokun/setup.sh` を1回実行するだけ。
# 既存の設定ファイル(.env / access.json 等)があるマシンでは上書きしない(再実行しても安全)。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$REPO_DIR/zerokun/state-dir.sh"
CH="$(zerokun_resolve_state_dir)"
TPL="$REPO_DIR/zerokun/templates"
PROJECT_DIR="${ZEROKUN_PROJECT_DIR:-$(dirname "$REPO_DIR")/zerokun-workspace}"
LAUNCHCTL_BIN="${ZEROKUN_LAUNCHCTL_BIN:-/bin/launchctl}"
. "$REPO_DIR/zerokun/codex-version.sh"

echo "== ゼロくんセットアップ開始 (repo: $REPO_DIR)"

# 0. 依存確認
command -v bun >/dev/null 2>&1 || { echo "❌ bun がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }
zerokun_require_codex_version || exit 1
bun "$REPO_DIR/zerokun/codex-executor.ts" verify-system-config || exit 1
command -v git >/dev/null 2>&1 || { echo "❌ git がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "❌ tmux がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }
(cd "$REPO_DIR" && bun install --frozen-lockfile --silent)
mkdir -p "$PROJECT_DIR"
[ "$(cd "$PROJECT_DIR" && pwd -P)" != "$(cd "$REPO_DIR" && pwd -P)" ] \
  || { echo "❌ Slack作業projectはZero-kun本体と別directoryにしてください" >&2; exit 1; }
if [ ! -e "$PROJECT_DIR/.git" ]; then
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null init --initial-branch=main "$PROJECT_DIR" >/dev/null
fi

# 1. 設定ディレクトリ。既存rootはowner/symlinkを検査してから0700へ直す。
mkdir -p "$CH"
bun "$REPO_DIR/zerokun/managed-path.ts" prepare-root "$CH" >/dev/null
bun "$REPO_DIR/zerokun/managed-path.ts" prepare-directories \
  "$CH" "$CH/inbox" "$CH/approved" "$CH/update.lock" "$CH/job-runner.lock"

# Claude版daemonが新しいCodex jobをclaimしないよう、cutover中はclaimを止める。
# 実行中の旧jobだけをdrainしてから旧runner/gatewayを終了する。待機jobは
# SQLite migrationでsessionを破棄し、Codex jobとして引き継ぐ。
SETUP_LOCK="$CH/update.lock"
SETUP_OWNS_LOCK=0
WATCHDOG_PLIST_TMP=""
ZSHRC_TMP=""
cleanup_setup_lock() {
  [ -z "$WATCHDOG_PLIST_TMP" ] || rm -f -- "$WATCHDOG_PLIST_TMP"
  [ -z "$ZSHRC_TMP" ] || rm -f -- "$ZSHRC_TMP"
  if [ "$SETUP_OWNS_LOCK" = "1" ]; then
    bun "$REPO_DIR/zerokun/process-lock.ts" release "$SETUP_LOCK/pid" "$$" || true
  fi
}
trap cleanup_setup_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
LOCK_OWNER=""
if LOCK_OWNER="$(bun "$REPO_DIR/zerokun/process-lock.ts" acquire "$SETUP_LOCK/pid" "$$")"; then
  SETUP_OWNS_LOCK=1
else
  if [ "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" != "1" ]; then
    echo "❌ zerokun-updateが実行中です (PID ${LOCK_OWNER:-不明})。完了後にsetupを再実行してください。" >&2
    exit 1
  fi
fi

process_matches() {
  local pid="$1" pattern="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && ps -o command= -p "$pid" 2>/dev/null | grep -Eq "$pattern"
}

lock_process_matches() {
  local lock_file="$1" pid="$2" pattern="$3"
  process_matches "$pid" "$pattern" || return 1
  bun "$REPO_DIR/zerokun/process-identity-check.ts" "$lock_file" "$pid" "$pattern"
}

pid_is_alive() {
  local pid="$1" state
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

read_lock_pid() {
  tr -d '[:space:]' < "$1" 2>/dev/null || true
}

# The legacy launcher execs Claude with this development-channel marker. Stop
# only that exact Zero-kun parent so it cannot respawn the old Slack gateway.
while IFS= read -r legacy_parent; do
  [ -n "$legacy_parent" ] || continue
  [ "$legacy_parent" != "$$" ] || continue
  if process_matches "$legacy_parent" 'claude.*dangerously-load-development-channels[[:space:]]+server:slack-channel'; then
    kill "$legacy_parent"
    for _ in {1..150}; do
      pid_is_alive "$legacy_parent" || break
      sleep 0.2
    done
    pid_is_alive "$legacy_parent" && {
      echo "❌ 旧Claude Zero-kun親process PID $legacy_parent が正常終了しません。" >&2
      exit 1
    }
    echo "   旧Claude Zero-kun親processを停止しました"
  fi
done < <(pgrep -f 'claude.*dangerously-load-development-channels.*server:slack-channel' 2>/dev/null || true)

legacy_running_count() {
  local db="$CH/jobs.sqlite3"
  [ -f "$db" ] || { printf '0\n'; return; }
  ZEROKUN_CUTOVER_DB="$db" bun -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.ZEROKUN_CUTOVER_DB!, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS count FROM jobs WHERE status = ?").get("running") as { count: number };
      console.log(row.count);
    } finally { db.close(); }
  '
}

GATEWAY_PID="$(read_lock_pid "$CH/plugin.lock")"
if process_matches "$GATEWAY_PID" 'server\.ts'; then
  if ! lock_process_matches "$CH/plugin.lock" "$GATEWAY_PID" 'server\.ts'; then
    bun "$REPO_DIR/zerokun/adopt-legacy-lock.ts" \
      "$CH/plugin.lock" "$GATEWAY_PID" "$CH/server.ts" \
      || { echo "❌ gateway lock identityを検証できないため自動停止しません。" >&2; exit 1; }
    lock_process_matches "$CH/plugin.lock" "$GATEWAY_PID" 'server\.ts' \
      || { echo "❌ gateway lock identityの移行に失敗しました。" >&2; exit 1; }
  fi
  kill "$GATEWAY_PID"
  for _ in {1..150}; do
    pid_is_alive "$GATEWAY_PID" || break
    sleep 0.2
  done
  pid_is_alive "$GATEWAY_PID" && {
    echo "❌ 旧gateway PID $GATEWAY_PID が正常終了しません。" >&2
    exit 1
  }
  echo "   旧Slack gatewayを停止しました"
fi

RUNNER_PID="$(read_lock_pid "$CH/job-runner.lock/pid")"
if process_matches "$RUNNER_PID" 'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)'; then
  if ! lock_process_matches "$CH/job-runner.lock/pid" "$RUNNER_PID" \
    'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)'; then
    bun "$REPO_DIR/zerokun/adopt-legacy-lock.ts" \
      "$CH/job-runner.lock/pid" "$RUNNER_PID" "$CH/job-runner.ts" daemon \
      || { echo "❌ job runner lock identityを検証できないため自動停止しません。" >&2; exit 1; }
    lock_process_matches "$CH/job-runner.lock/pid" "$RUNNER_PID" \
      'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)' \
      || { echo "❌ job runner lock identityの移行に失敗しました。" >&2; exit 1; }
  fi
  drain_deadline=$(( $(date +%s) + ${ZEROKUN_SETUP_DRAIN_SECONDS:-21600} ))
  while [ "$(legacy_running_count)" -gt 0 ]; do
    [ "$(date +%s)" -lt "$drain_deadline" ] || {
      echo "❌ 実行中jobのdrain待ちがtimeoutしました。旧runnerは停止していません。" >&2
      exit 1
    }
    echo "   旧runnerの実行中job完了を待っています..."
    sleep 2
  done
  kill "$RUNNER_PID"
  for _ in {1..150}; do
    pid_is_alive "$RUNNER_PID" || break
    sleep 0.2
  done
  pid_is_alive "$RUNNER_PID" && {
    echo "❌ 旧runner PID $RUNNER_PID が正常終了しません。" >&2
    exit 1
  }
  echo "   旧job runnerを安全に停止しました"
fi

# Legacy rows are handled only after both legacy processes are gone. Queued rows
# move to Codex; uncertain running rows fail closed and require an explicit resend.
# Opening JobStore for status/server startup is deliberately non-destructive.
ZEROKUN_STATE_DIR="$CH" bun "$REPO_DIR/zerokun/job-runner.ts" prepare-storage
ZEROKUN_STATE_DIR="$CH" bun "$REPO_DIR/zerokun/job-runner.ts" migrate-legacy

# 2. 設定ファイル(既存があれば触らない)
bun "$REPO_DIR/zerokun/safe-file.ts" validate-existing "$CH/access.json" "$CH/.env"
[ -f "$CH/access.json" ] || cp "$TPL/access.json.example" "$CH/access.json"
[ ! -f "$CH/access.json" ] || chmod 600 "$CH/access.json"
[ -f "$CH/.env" ] || { cp "$TPL/env.example" "$CH/.env"; chmod 600 "$CH/.env"; }

# 3. SQLite直列job runner・Codex executor・watchdog・管理CLI
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/zerokun/job-runner.ts" "$CH/job-runner.ts"
ln -sfn "$REPO_DIR/zerokun/codex-executor.ts" "$CH/codex-executor.ts"
install -m 0700 "$REPO_DIR/zerokun/update-request.ts" "$CH/update-request.ts"
install -m 0600 "$REPO_DIR/zerokun/child-environment.ts" "$CH/child-environment.ts"
install -m 0600 "$REPO_DIR/zerokun/safe-file.ts" "$CH/safe-file.ts"
install -m 0600 "$REPO_DIR/zerokun/managed-path.ts" "$CH/managed-path.ts"
install -m 0600 "$REPO_DIR/zerokun/state-dir.ts" "$CH/state-dir.ts"
install -m 0700 "$REPO_DIR/zerokun/watchdog.sh" "$CH/watchdog.sh"
mkdir -p "$HOME/Library/LaunchAgents"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/com.zerokun.watchdog.plist"
if [ -e "$WATCHDOG_PLIST" ] || [ -L "$WATCHDOG_PLIST" ]; then
  bun "$REPO_DIR/zerokun/safe-file.ts" validate-owned-regular "$WATCHDOG_PLIST"
fi
WATCHDOG_PLIST_TMP="$(mktemp "$HOME/Library/LaunchAgents/.com.zerokun.watchdog.plist.XXXXXX")"
sed "s|__STATE_DIR__|$CH|g" \
  "$TPL/com.zerokun.watchdog.plist.template" > "$WATCHDOG_PLIST_TMP"
chmod 600 "$WATCHDOG_PLIST_TMP"
mv -f -- "$WATCHDOG_PLIST_TMP" "$WATCHDOG_PLIST"
WATCHDOG_PLIST_TMP=""
if [ "${ZEROKUN_SKIP_WATCHDOG_LAUNCHD:-0}" = "1" ]; then
  echo "   watchdog のlaunchd登録をスキップしました"
else
  "$LAUNCHCTL_BIN" bootout "gui/$(id -u)/com.zerokun.watchdog" 2>/dev/null || true
  if "$LAUNCHCTL_BIN" bootstrap "gui/$(id -u)" "$WATCHDOG_PLIST"; then
    echo "   watchdog をlaunchdへ登録しました(60秒間隔・自動再起動なし)"
  else
    echo "⚠️ watchdog のlaunchd登録に失敗しました。CLIとaliasの設置は続行します。" >&2
  fi
fi
ln -sfn "$REPO_DIR/zerokun/job-runner.ts" "$HOME/.local/bin/zerokun-jobs"
ln -sfn "$REPO_DIR/zerokun/access.ts" "$HOME/.local/bin/zerokun-access"
ln -sfn "$REPO_DIR/zerokun/update.ts" "$HOME/.local/bin/zerokun-update"
ln -sfn "$REPO_DIR/codex-channel.sh" "$HOME/.local/bin/codex-channel"
# Remove only dangling Claude-era links that this same Zero-kun checkout owned.
remove_owned_legacy_link() {
  local legacy_path="$1" legacy_target="$2"
  if [ -L "$legacy_path" ] && [ "$(readlink "$legacy_path")" = "$legacy_target" ]; then
    rm -f "$legacy_path"
  fi
}
remove_owned_legacy_link "$HOME/.local/bin/claude-channel" "$REPO_DIR/claude-channel.sh"
remove_owned_legacy_link "$HOME/.claude/skills/threads" "$REPO_DIR/skills/threads"
remove_owned_legacy_link "$HOME/.claude/skills/zerokun-update" "$REPO_DIR/skills/zerokun-update"
echo "   SQLite job runner を設置しました(永続FIFO / 同時実行数1)"
echo "   Slack更新リクエストworkerを設置しました"
echo "   安全更新コマンドを設置しました: zerokun-update"

# 4. zsh エイリアス。既存の管理ブロックだけをatomicに置換する。
# symlink/hardlinkや不均衡markerではユーザー設定を変更せず停止する。
ZSHRC="$HOME/.zshrc"
ZSHRC_TMP="$(mktemp "$HOME/.zshrc.zerokun-tmp.XXXXXX")"
if [ -e "$ZSHRC" ] || [ -L "$ZSHRC" ]; then
  bun "$REPO_DIR/zerokun/safe-file.ts" validate-owned-regular "$ZSHRC"
  ZSHRC_MODE="$(stat -f '%Lp' "$ZSHRC")"
  bun "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$ZSHRC" | awk '
    $0 == "# >>> zerokun setup >>>" { if (skip) exit 2; skip=1; next }
    $0 == "# <<< zerokun setup <<<" { if (!skip) exit 2; skip=0; next }
    !skip { print }
    END { if (skip) exit 2 }
  ' > "$ZSHRC_TMP"
  chmod "$ZSHRC_MODE" "$ZSHRC_TMP"
else
  chmod 600 "$ZSHRC_TMP"
fi
  {
    cat <<'EOF'

# >>> zerokun setup >>>
# Slack からCodexを動かすボット — zerokun/setup.sh が管理
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
EOF
    printf 'export ZEROKUN_PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf 'export ZEROKUN_STATE_DIR=%q\n' "$CH"
    cat <<'EOF'
alias zerokun='codex-channel "$ZEROKUN_PROJECT_DIR"'
# 稼働中を止めて入れ替えるかは端末の y/N プロンプトで都度確認する。
# ZEROKUN_REPLACE=1 は自己更新のワンタイムトークン無しでは停止権限にならない。
alias zerokun-restart='codex-channel "$ZEROKUN_PROJECT_DIR"'
alias zerokun-status='pid=$(cat "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/plugin.lock" 2>/dev/null); [ -n "$pid" ] && ps -p "$pid" -o pid=,command= || echo "ゼロくんは停止中"'
# <<< zerokun setup <<<
EOF
  } >> "$ZSHRC_TMP"
mv -f -- "$ZSHRC_TMP" "$ZSHRC"
ZSHRC_TMP=""
echo "   .zshrc のゼロくん管理ブロックを更新しました(新しいターミナルで有効)"

echo ""
if [ "${ZEROKUN_BOOTSTRAP:-0}" = "1" ]; then
  echo "✅ 配線完了。bootstrapのSlack設定へ続きます。"
else
  echo "✅ 配線完了。残りの手動ステップ:"
  echo "  1. Slack アプリをこのマシン用に新規作成し(1台=1アプリ=1ボット名)、"
  echo "     トークン2つを $CH/.env に貼る (xoxb- / xapp-。作成手順はリポ直下 README.md)"
  echo "  2. $CH/access.json に許可する Slack ユーザーID/チャンネルIDを入れる"
  echo "  3. codex login status でログイン済みか確認"
  echo "  4. 必要なら --project-dir でSlack DMの既定作業リポを指定"
  echo "  5. 新しいターミナルで: zerokun"
  echo "     queue確認: zerokun-jobs status"
  echo "     Codex版更新: zerokun-update"
  echo "     書込み許可: zerokun-access write allow <SlackユーザーID>"
fi
