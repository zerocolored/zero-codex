#!/usr/bin/env bash
# Zero-kun for Codex: standalone Slack gateway + persistent SQLite worker.
set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [ -L "$SOURCE_PATH" ]; do
  SOURCE_DIR="$(CDPATH='' cd -P "$(dirname "$SOURCE_PATH")" >/dev/null 2>&1 && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  case "$SOURCE_PATH" in /*) ;; *) SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH" ;; esac
done
REPO_DIR="$(CDPATH='' cd -P "$(dirname "$SOURCE_PATH")" >/dev/null 2>&1 && pwd)"
. "$REPO_DIR/zerokun/state-dir.sh"
PROJECT="${1:-${ZEROKUN_PROJECT_DIR:-$REPO_DIR}}"
STATE_DIR="$(zerokun_resolve_state_dir)"
LOCK_FILE="$STATE_DIR/plugin.lock"
REPLACE_TOKEN_FILE="${ZEROKUN_REPLACE_TOKEN_FILE:-$STATE_DIR/replace-token}"
JOB_RUNNER="$REPO_DIR/zerokun/job-runner.ts"
JOB_RUNNER_PID="$STATE_DIR/job-runner.lock/pid"
JOB_RUNNER_RUNTIME="$STATE_DIR/job-runner.lock/runtime"
JOB_RUNNER_LOG="$STATE_DIR/job-runner.log"
EXPECTED_RUNNER_RUNTIME="zerokun-codex-runner-v1"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v bun >/dev/null 2>&1 || { echo "❌ bun が見つかりません。" >&2; exit 1; }
export ZEROKUN_STATE_DIR="$STATE_DIR"
export ZEROKUN_PROJECT_DIR="$PROJECT"

AUTHORIZED_UPDATE_RESTART=0
if [ "${ZEROKUN_UPDATE_RESTART:-0}" = "1" ] \
   && [ -s "$REPLACE_TOKEN_FILE" ] \
   && [ -n "${ZEROKUN_REPLACE_TOKEN:-}" ] \
   && [ "$ZEROKUN_REPLACE_TOKEN" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
  AUTHORIZED_UPDATE_RESTART=1
  rm -f "$REPLACE_TOKEN_FILE"
  echo "   自己更新restartのワンタイムトークンを確認しました。" >&2
fi

if [ -f "$STATE_DIR/update-transaction.json" ] && [ "$AUTHORIZED_UPDATE_RESTART" != "1" ]; then
  echo "⚠️  未完了の自己更新を検出しました。旧版へ復旧します。" >&2
  bun "$REPO_DIR/zerokun/update.ts" --recover-only
fi

# candidateへfast-forwardした直後にcrashした場合でも、候補版の最小Codex versionや
# system config検査よりjournal recoveryを必ず先に行う。rollback後の実体をここから検査する。
. "$REPO_DIR/zerokun/codex-version.sh"
zerokun_require_codex_version || exit 1
bun "$REPO_DIR/zerokun/codex-executor.ts" verify-system-config || exit 1
[ -d "$PROJECT" ] || { echo "❌ 作業ディレクトリがありません: $PROJECT" >&2; exit 1; }
[ -f "$REPO_DIR/server.ts" ] || { echo "❌ server.ts がありません: $REPO_DIR" >&2; exit 1; }

process_command_is() {
  local pid="$1" pattern="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && ps -o command= -p "$pid" 2>/dev/null | grep -Eq "$pattern"
}

lock_process_is() {
  local lock_file="$1" pid="$2" pattern="$3"
  process_command_is "$pid" "$pattern" || return 1
  bun "$REPO_DIR/zerokun/process-identity-check.ts" "$lock_file" "$pid" "$pattern"
}

existing_bridge_pid=""
if [ -f "$LOCK_FILE" ]; then
  existing_bridge_pid="$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null || true)"
  if process_command_is "$existing_bridge_pid" 'server\.ts'; then
    lock_process_is "$LOCK_FILE" "$existing_bridge_pid" 'server\.ts' || {
      echo "❌ 稼働中gatewayのlock identityを検証できません。自動停止せず終了します。" >&2
      exit 1
    }
  else
    existing_bridge_pid=""
  fi
fi

if [ -n "$existing_bridge_pid" ]; then
  echo "⚠️  ゼロくんのSlack gatewayは既に起動中です (PID $existing_bridge_pid)。" >&2
  do_replace=0
  if [ "$AUTHORIZED_UPDATE_RESTART" = "1" ]; then
    do_replace=1
  elif [ "${ZEROKUN_REPLACE:-0}" = "1" ] && [ -s "$REPLACE_TOKEN_FILE" ] \
     && [ -n "${ZEROKUN_REPLACE_TOKEN:-}" ] \
     && [ "$ZEROKUN_REPLACE_TOKEN" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
    do_replace=1
    rm -f "$REPLACE_TOKEN_FILE"
    echo "   自己更新のワンタイムトークンを確認しました。" >&2
  elif [ "${ZEROKUN_REPLACE:-0}" = "1" ]; then
    echo "   有効なワンタイムトークンがありません。稼働中プロセスは停止しません。" >&2
  elif [ -t 0 ]; then
    printf "   既存を止めて入れ替えますか? [y/N]: " >&2
    read -r answer || answer=""
    case "$answer" in [yY]|[yY][eE][sS]) do_replace=1 ;; esac
  fi
  if [ "$do_replace" != "1" ]; then
    echo "   → 起動を中止しました。既存のゼロくんは無傷です。" >&2
    exit 1
  fi
  if [ "${ZEROKUN_DRY_RUN:-0}" = "1" ]; then
    echo "   (dry-run: 実際には停止・起動しません)" >&2
    exit 0
  fi
  kill "$existing_bridge_pid"
  for _ in {1..50}; do
    kill -0 "$existing_bridge_pid" 2>/dev/null || break
    sleep 0.1
  done
fi

if [ "${ZEROKUN_DRY_RUN:-0}" = "1" ]; then
  echo "(dry-run: 起動条件を満たしています。実際には起動しません)" >&2
  exit 0
fi

job_runner_is_alive() {
  [ -f "$JOB_RUNNER_PID" ] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID")"
  lock_process_is "$JOB_RUNNER_PID" "$pid" 'job-runner\.ts[[:space:]]+daemon' \
    && [ "$(tr -d '[:space:]' < "$JOB_RUNNER_RUNTIME" 2>/dev/null)" = "$EXPECTED_RUNNER_RUNTIME" ]
}

start_job_runner() {
  if job_runner_is_alive; then
    echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
    return
  fi
  if [ -f "$JOB_RUNNER_PID" ]; then
    local existing_pid
    existing_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID" 2>/dev/null || true)"
    if process_command_is "$existing_pid" 'job-runner\.ts[[:space:]]+daemon'; then
      echo "❌ 旧版または不明なjob runnerが稼働中です (PID $existing_pid)。" >&2
      echo "   bash zerokun/setup.sh で安全にcutoverしてください。" >&2
      exit 1
    fi
  fi
  [ -f "$JOB_RUNNER" ] || {
    echo "❌ Codex job runnerが未導入です。bash zerokun/setup.sh を再実行してください。" >&2
    exit 1
  }
  mkdir -p "$STATE_DIR"
  nohup caffeinate -dimsu bun "$JOB_RUNNER" daemon 2>&1 </dev/null \
    | nohup bun "$REPO_DIR/zerokun/safe-log-sink.ts" "$STATE_DIR" "$JOB_RUNNER_LOG" \
      >/dev/null 2>&1 &
  local starter_pid=$!
  for _ in {1..50}; do
    if job_runner_is_alive; then
      echo "   job-runner: started (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
      return
    fi
    kill -0 "$starter_pid" 2>/dev/null || break
    sleep 0.1
  done
  echo "❌ Codex job runnerの起動に失敗しました: $JOB_RUNNER_LOG" >&2
  exit 1
}

start_job_runner
if [ -n "${ZEROKUN_REPLACE_TOKEN:-}" ] && [ -s "$REPLACE_TOKEN_FILE" ] \
   && [ "$ZEROKUN_REPLACE_TOKEN" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
  rm -f "$REPLACE_TOKEN_FILE"
fi
cd "$PROJECT"
echo "▶ Zero-kun for Codex"
echo "   gateway : $REPO_DIR/server.ts"
echo "   project : $PROJECT"
echo "   state   : $STATE_DIR"
echo "   sandbox : HOME/state deny + job専用permission profile（writeAllowFromのみrepo/.git write + network）"
echo "   caffeinate: ON (Ctrl-Cでgatewayを停止)"

exec caffeinate -dimsu bun "$REPO_DIR/server.ts"
