#!/usr/bin/env bash
# Zeroちゃん: standalone Slack gateway + persistent SQLite worker.
set -euo pipefail

INVOKED_AS="$(basename -- "$0")"
SOURCE_PATH="${BASH_SOURCE[0]}"
while [ -L "$SOURCE_PATH" ]; do
  SOURCE_DIR="$(CDPATH='' cd -P "$(dirname "$SOURCE_PATH")" >/dev/null 2>&1 && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  case "$SOURCE_PATH" in /*) ;; *) SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH" ;; esac
done
REPO_DIR="$(CDPATH='' cd -P "$(dirname "$SOURCE_PATH")" >/dev/null 2>&1 && pwd)"
. "$REPO_DIR/zerokun/state-dir.sh"

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Remove untrusted child-process transport and test overrides before the first
# Bun helper, including project selection.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
  http_proxy https_proxy all_proxy no_proxy \
  NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED \
  SSL_CERT_FILE SSL_CERT_DIR CURL_CA_BUNDLE AWS_CA_BUNDLE \
  GLOBAL_AGENT_HTTP_PROXY npm_config_proxy npm_config_https_proxy
unset BUN_OPTIONS BUN_CONFIG_PRELOAD NODE_OPTIONS
unset ZEROKUN_UPDATE_TESTING ZEROKUN_SLACK_IDENTITY_TEST_APP_ID \
  ZEROKUN_SETUP_TEST_STOP_PROBE
command -v bun >/dev/null 2>&1 || { echo "❌ bun が見つかりません。" >&2; exit 1; }
STATE_DIR="$(zerokun_resolve_state_dir)"
# The updater may hand this value to the launcher through an internal
# trampoline. Capture it as a non-exported shell value before the first Bun
# helper so Slack, advisor, runner, and gateway children never inherit it.
REPLACE_TOKEN_VALUE="${ZEROKUN_REPLACE_TOKEN:-}"
unset ZEROKUN_REPLACE_TOKEN
LAUNCH_MODE="start"
CHANNEL_ID=""

case "$INVOKED_AS" in
  zerochan)
    if [ "$#" -eq 0 ]; then
      PROJECT="$(pwd -P)"
    elif [ "$#" -eq 1 ] && [ "$1" = "--restart" ]; then
      LAUNCH_MODE="restart"
      PROJECT="$(bun --config=/dev/null --no-env-file \
        "$REPO_DIR/zerokun/project-selection.ts" read-last "$STATE_DIR")" || {
        echo "❌ 前回接続したprojectを確認できません。対象projectへ cd して zerochan を実行してください。" >&2
        exit 1
      }
    elif [ "$#" -eq 3 ] && [ "$1" = "set" ] && [ "$2" = "slack-channel" ]; then
      LAUNCH_MODE="set-channel"
      CHANNEL_ID="$3"
      PROJECT="$(pwd -P)"
    elif [ "$#" -eq 2 ] && [ "$1" = "unset" ] && [ "$2" = "slack-channel" ]; then
      LAUNCH_MODE="unset-channel"
      PROJECT="$(pwd -P)"
    elif [ "$#" -eq 1 ] && [ "$1" = "status" ]; then
      LAUNCH_MODE="status"
      PROJECT="$(pwd -P)"
    else
      echo "使い方: zerochan | zerochan --restart | zerochan set slack-channel <channel-id> | zerochan unset slack-channel | zerochan status" >&2
      exit 2
    fi
    ;;
  zerokun)
    [ "$#" -eq 0 ] || { echo "使い方: zerokun" >&2; exit 2; }
    PROJECT="${ZEROKUN_PROJECT_DIR:-$(pwd -P)}"
    ;;
  *)
    [ "$#" -le 1 ] || { echo "使い方: codex-channel [project-directory]" >&2; exit 2; }
    PROJECT="${1:-${ZEROKUN_PROJECT_DIR:-}}"
    if [ -z "$PROJECT" ]; then
      PROJECT="$(bun --config=/dev/null --no-env-file \
        "$REPO_DIR/zerokun/project-selection.ts" read-last "$STATE_DIR")" || {
        echo "❌ 作業projectが未指定です。対象projectへ cd して zerochan を実行してください。" >&2
        exit 1
      }
    fi
    ;;
esac

# Resolve and validate the selected project before consuming a restart token,
# recovering an update journal, checking Slack credentials, or signalling any
# live process. A stale shell export must never redirect `zerochan` away from
# the physical directory where the user invoked it.
PROJECT="$(bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/project-selection.ts" validate-launch \
  "$PROJECT" "$REPO_DIR" "$STATE_DIR" "$HOME")" || {
  echo "❌ 対象projectを選択できません。Git repository、または複数repositoryを直下に含むprojectへ cd して zerochan を実行してください。" >&2
  exit 1
}
echo "📁 Zeroちゃんの対象project: $PROJECT" >&2

JOB_DB="$(zerokun_resolve_job_db "$STATE_DIR")"
LOCK_FILE="$STATE_DIR/plugin.lock"
REPLACE_TOKEN_FILE="${ZEROKUN_REPLACE_TOKEN_FILE:-$STATE_DIR/replace-token}"
JOB_RUNNER="$REPO_DIR/zerokun/job-runner.ts"
RUNNER_LAUNCHER="$REPO_DIR/zerokun/runner-launcher.ts"
CHANNEL_CONFIG="$REPO_DIR/zerokun/project-channel-config.ts"
READY_FILE="$STATE_DIR/gateway-ready.json"
JOB_RUNNER_PID="$STATE_DIR/job-runner.lock/pid"
JOB_RUNNER_RUNTIME="$STATE_DIR/job-runner.lock/runtime"
JOB_RUNNER_LOG="$STATE_DIR/job-runner.log"
JOB_RUNNER_STARTER_LOCK="$STATE_DIR/job-runner-starter.lock"
EXPECTED_RUNNER_RUNTIME="zerokun-codex-runner-v1"

export ZEROKUN_STATE_DIR="$STATE_DIR"
export ZEROKUN_JOB_DB="$JOB_DB"
export ZEROKUN_PROJECT_DIR="$PROJECT"

RUNNER_RUNTIME_ID="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/slack-app-identity.ts" runtime-id-file "$STATE_DIR/.env")" \
  || { echo "❌ Slack token pair identityを確定できませんでした。既存processは停止しません。" >&2; exit 1; }
SLACK_APP_ID="${RUNNER_RUNTIME_ID%%:*}"
case "$SLACK_APP_ID" in
  A*[!A-Z0-9]*|A) echo "❌ Slack App identityが不正です。" >&2; exit 1 ;;
  A*) ;;
  *) echo "❌ Slack App identityが不正です。" >&2; exit 1 ;;
esac

process_command_is() {
  local pid="$1" pattern="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && ps -o command= -p "$pid" 2>/dev/null | grep -Eq "$pattern"
}

lock_process_is() {
  local lock_file="$1" pid="$2" pattern="$3"
  process_command_is "$pid" "$pattern" || return 1
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-identity-check.ts" "$lock_file" "$pid" "$pattern"
}

require_route_capable_gateway_if_running() {
  local gateway_pid=""
  [ -f "$LOCK_FILE" ] || return 0
  gateway_pid="$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null || true)"
  process_command_is "$gateway_pid" 'server\.ts' || return 0
  lock_process_is "$LOCK_FILE" "$gateway_pid" 'server\.ts' || {
    echo "❌ 稼働中gatewayのlock identityを検証できません。設定は変更しません。" >&2
    return 1
  }
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/readiness.ts" \
    can-share "$READY_FILE" "$gateway_pid" "$SLACK_APP_ID" || {
    echo "❌ 稼働中のZeroちゃんはSlackチャンネル紐付けに未対応です。設定は変更しません。" >&2
    echo "   zerochan --restart でZeroちゃんを更新してから、もう一度実行してください。" >&2
    return 1
  }
}

case "$LAUNCH_MODE" in
  set-channel)
    require_route_capable_gateway_if_running || exit 1
    exec bun --config=/dev/null --no-env-file "$CHANNEL_CONFIG" \
      set "$PROJECT" "$STATE_DIR" "$SLACK_APP_ID" "$CHANNEL_ID"
    ;;
  unset-channel)
    require_route_capable_gateway_if_running || exit 1
    exec bun --config=/dev/null --no-env-file "$CHANNEL_CONFIG" \
      unset "$PROJECT" "$STATE_DIR" "$SLACK_APP_ID"
    ;;
  status)
    exec bun --config=/dev/null --no-env-file "$CHANNEL_CONFIG" \
      status "$PROJECT" "$STATE_DIR" "$SLACK_APP_ID"
    ;;
esac

AUTHORIZED_UPDATE_RESTART=0
if [ "${ZEROKUN_UPDATE_RESTART:-0}" = "1" ] \
   && [ -s "$REPLACE_TOKEN_FILE" ] \
   && [ -n "$REPLACE_TOKEN_VALUE" ] \
   && [ "$REPLACE_TOKEN_VALUE" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
  AUTHORIZED_UPDATE_RESTART=1
  rm -f "$REPLACE_TOKEN_FILE"
  echo "   自己更新restartのワンタイムトークンを確認しました。" >&2
fi

# Validate the selected state's complete credential pair before recovery or
# replacement can stop any live gateway/runner. This also protects direct
# launcher use that did not pass through bootstrap's interactive Slack setup.
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/slack-app-identity.ts" verify-file "$STATE_DIR/.env" \
  || { echo "❌ Slack Bot/App token identityを検証できませんでした。既存processは停止しません。" >&2; exit 1; }
EXPECTED_RUNNER_RUNTIME="zerokun-codex-runner-v1:$RUNNER_RUNTIME_ID"

if [ -f "$STATE_DIR/update-transaction.json" ] && [ "$AUTHORIZED_UPDATE_RESTART" != "1" ]; then
  echo "⚠️  未完了の自己更新を検出しました。旧版へ復旧します。" >&2
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/update.ts" --recover-only
fi

# candidateへfast-forwardした直後にcrashした場合でも、候補版の最小Codex versionや
# system config検査よりjournal recoveryを必ず先に行う。rollback後の実体をここから検査する。
. "$REPO_DIR/zerokun/codex-version.sh"
zerokun_require_codex_version "$REPO_DIR" || exit 1
zerokun_require_herdr_version || exit 1
# External advisor login can expire while the service is running. Each round
# records a safely-contained unavailable Claude/Grok slot and continues; Zero
# never performs authentication on the user's behalf.
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/codex-executor.ts" verify-system-config || exit 1
HERDR_RUNTIME_ID="$(bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/herdr-runtime.ts" runtime-id)" || {
  echo "❌ ZeroちゃんはHerdr内の専用paneから起動してください。" >&2
  exit 1
}
case "$HERDR_RUNTIME_ID" in
  ''|*[!0-9a-f]*) echo "❌ Herdr runtime identityが不正です。" >&2; exit 1 ;;
esac
[ "${#HERDR_RUNTIME_ID}" -eq 64 ] \
  || { echo "❌ Herdr runtime identityの長さが不正です。" >&2; exit 1; }
EXPECTED_RUNNER_RUNTIME="$EXPECTED_RUNNER_RUNTIME:$HERDR_RUNTIME_ID"
[ -d "$PROJECT" ] || { echo "❌ 作業ディレクトリがありません: $PROJECT" >&2; exit 1; }
[ -f "$REPO_DIR/server.ts" ] || { echo "❌ server.ts がありません: $REPO_DIR" >&2; exit 1; }

if [ "${ZEROKUN_DRY_RUN:-0}" != "1" ] && [ "$AUTHORIZED_UPDATE_RESTART" != "1" ]; then
  bun --config=/dev/null --no-env-file "$CHANNEL_CONFIG" \
    sync "$PROJECT" "$STATE_DIR" "$SLACK_APP_ID" || exit 1
fi

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
  existing_runner_pid=""
  if [ -f "$JOB_RUNNER_PID" ]; then
    existing_runner_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID" 2>/dev/null || true)"
  fi
  existing_runner_runtime="$(tr -d '[:space:]' < "$JOB_RUNNER_RUNTIME" 2>/dev/null || true)"
  shared_runner_runtime=0
  case "$existing_runner_runtime" in
    "zerokun-codex-runner-v1:$RUNNER_RUNTIME_ID:"*) shared_runner_runtime=1 ;;
  esac
  if [ "$LAUNCH_MODE" = "start" ] && [ "$INVOKED_AS" = "zerochan" ] \
     && bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/readiness.ts" \
       can-share "$READY_FILE" "$existing_bridge_pid" "$SLACK_APP_ID" \
     && bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/herdr-runtime.ts" \
       verify-control-plane "$STATE_DIR" >/dev/null \
     && lock_process_is "$JOB_RUNNER_PID" "$existing_runner_pid" 'job-runner\.ts[[:space:]]+daemon' \
     && [ "$shared_runner_runtime" = "1" ]; then
    # Re-check the exact generations after the config transaction. If either
    # daemon changed, continue through the ordinary safe replacement path.
    joined_bridge_pid="$(tr -d '[:space:]' < "$LOCK_FILE" 2>/dev/null || true)"
    joined_runner_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID" 2>/dev/null || true)"
    if [ "$joined_bridge_pid" = "$existing_bridge_pid" ] \
       && [ "$joined_runner_pid" = "$existing_runner_pid" ] \
       && [ "$(tr -d '[:space:]' < "$JOB_RUNNER_RUNTIME" 2>/dev/null)" = "$existing_runner_runtime" ] \
       && lock_process_is "$LOCK_FILE" "$joined_bridge_pid" 'server\.ts' \
       && lock_process_is "$JOB_RUNNER_PID" "$joined_runner_pid" 'job-runner\.ts[[:space:]]+daemon' \
       && bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/readiness.ts" \
         can-share "$READY_FILE" "$joined_bridge_pid" "$SLACK_APP_ID"; then
      echo "✅ 既存のZeroちゃんを共用します。" >&2
      echo "   project: $PROJECT" >&2
      echo "   gateway: PID $joined_bridge_pid / runner: PID $joined_runner_pid" >&2
      exit 0
    fi
  fi
  echo "⚠️  ZeroちゃんのSlack gatewayは既に起動中です (PID $existing_bridge_pid)。" >&2
  do_replace=0
  if [ "$AUTHORIZED_UPDATE_RESTART" = "1" ]; then
    do_replace=1
  elif [ "${ZEROKUN_REPLACE:-0}" = "1" ] && [ -s "$REPLACE_TOKEN_FILE" ] \
     && [ -n "$REPLACE_TOKEN_VALUE" ] \
     && [ "$REPLACE_TOKEN_VALUE" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
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
    echo "   → 起動を中止しました。既存のZeroちゃんは無傷です。" >&2
    exit 1
  fi
  if [ "${ZEROKUN_DRY_RUN:-0}" = "1" ]; then
    echo "   (dry-run: 実際には停止・起動しません)" >&2
    exit 0
  fi
  if kill -0 "$existing_bridge_pid" 2>/dev/null; then
    lock_process_is "$LOCK_FILE" "$existing_bridge_pid" 'server\.ts' || {
      echo "❌ gateway identityが確認待ちの間に変化したためsignalしません。" >&2
      exit 1
    }
    kill "$existing_bridge_pid" \
      || { kill -0 "$existing_bridge_pid" 2>/dev/null \
        && { echo "❌ 既存gatewayへsignalできません。" >&2; exit 1; }; }
  fi
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
  local startup_attempts
  startup_attempts="${ZEROKUN_RUNNER_STARTUP_ATTEMPTS:-300}"
  case "$startup_attempts" in
    ''|*[!0-9]*) echo "❌ ZEROKUN_RUNNER_STARTUP_ATTEMPTSが不正です。" >&2; exit 1 ;;
  esac
  [ "$startup_attempts" -ge 1 ] && [ "$startup_attempts" -le 600 ] \
    || { echo "❌ ZEROKUN_RUNNER_STARTUP_ATTEMPTSは1〜600で指定してください。" >&2; exit 1; }
  if job_runner_is_alive; then
    echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
    return
  fi
  if [ -f "$JOB_RUNNER_PID" ]; then
    local existing_pid
    existing_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID" 2>/dev/null || true)"
    if process_command_is "$existing_pid" 'job-runner\.ts[[:space:]]+daemon'; then
      lock_process_is "$JOB_RUNNER_PID" "$existing_pid" 'job-runner\.ts[[:space:]]+daemon' || {
        echo "❌ 既存job runnerのgenerationを検証できません。自動停止しません。" >&2
        exit 1
      }
      echo "   Herdr/Slack runtimeが変わったため、既存job runnerを安全に入れ替えます。" >&2
      bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
        stop-owner-force "$JOB_RUNNER_PID" "$existing_pid" \
        'job-runner\.ts\s+daemon' 10000 >/dev/null 2>&1 || {
          echo "❌ 既存job runnerを同一generationのまま停止できません。" >&2
          exit 1
        }
    fi
    if process_command_is "$existing_pid" 'job-runner\.ts[[:space:]]+daemon'; then
      echo "❌ 旧版または不明なjob runnerが稼働中です (PID $existing_pid)。" >&2
      echo "   bash zerokun/setup.sh で安全にcutoverしてください。" >&2
      exit 1
    fi
  fi
  if [ -f "$JOB_RUNNER_STARTER_LOCK" ]; then
    local existing_starter_pid
    existing_starter_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_STARTER_LOCK" 2>/dev/null || true)"
    if process_command_is "$existing_starter_pid" 'runner-launcher\.ts'; then
      lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" 'runner-launcher\.ts' || {
        echo "❌ 既存runner launcherのgenerationを検証できません。自動停止しません。" >&2
        exit 1
      }
      # A concurrent launcher may still be between its starter lease and the
      # daemon lock. Give it the same bounded startup window before classifying
      # it as an orphan. The exact starter lease is rechecked on every pass.
      for ((attempt = 0; attempt < startup_attempts; attempt += 1)); do
        if job_runner_is_alive; then
          echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
          return
        fi
        lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" \
          'runner-launcher\.ts' || break
        sleep 0.1
      done
      if job_runner_is_alive; then
        echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
        return
      fi
      if lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" \
        'runner-launcher\.ts'; then
        echo "   終了済みrunnerを待ち続けているlauncherを安全に回収します。" >&2
        bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
          stop-owner-force "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" \
          'runner-launcher\.ts' 5000 >/dev/null 2>&1 || {
            echo "❌ 既存runner launcherを同一generationのまま停止できません。" >&2
            exit 1
          }
      fi
      for _ in {1..50}; do
        lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" \
          'runner-launcher\.ts' || break
        sleep 0.1
      done
      if lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$existing_starter_pid" \
        'runner-launcher\.ts'; then
        echo "❌ 既存runner launcherの停止を確認できません。次の起動は行いません。" >&2
        exit 1
      fi
    fi
  fi
  # The old launcher may have published its daemon after the first check but
  # before it was stopped. Re-run the exact daemon replacement guard so a
  # mismatched or retained generation cannot overlap the new FIFO worker.
  if job_runner_is_alive; then
    echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
    return
  fi
  if [ -f "$JOB_RUNNER_PID" ]; then
    local late_runner_pid
    late_runner_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID" 2>/dev/null || true)"
    if process_command_is "$late_runner_pid" 'job-runner\.ts[[:space:]]+daemon'; then
      lock_process_is "$JOB_RUNNER_PID" "$late_runner_pid" \
        'job-runner\.ts[[:space:]]+daemon' || {
          echo "❌ 遅れて起動したjob runnerのgenerationを検証できません。自動停止しません。" >&2
          exit 1
        }
      bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
        stop-owner-force "$JOB_RUNNER_PID" "$late_runner_pid" \
        'job-runner\.ts\s+daemon' 10000 >/dev/null 2>&1 || {
          echo "❌ 遅れて起動したjob runnerを同一generationのまま停止できません。" >&2
          exit 1
        }
    fi
  fi
  [ -f "$JOB_RUNNER" ] || {
    echo "❌ Codex job runnerが未導入です。bash zerokun/setup.sh を再実行してください。" >&2
    exit 1
  }
  mkdir -p "$STATE_DIR"
  [ -f "$RUNNER_LAUNCHER" ] || {
    echo "❌ runner launcherが未導入です。bash zerokun/setup.sh を再実行してください。" >&2
    exit 1
  }
  local starter_pid
  bun --config=/dev/null --no-env-file \
    "$RUNNER_LAUNCHER" "$JOB_RUNNER" "$STATE_DIR" "$JOB_RUNNER_LOG" \
    "$JOB_RUNNER_STARTER_LOCK" \
    >/dev/null &
  starter_pid=$!
  for ((attempt = 0; attempt < startup_attempts; attempt += 1)); do
    if job_runner_is_alive; then
      echo "   job-runner: started (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO=1)"
      return
    fi
    kill -0 "$starter_pid" 2>/dev/null || break
    sleep 0.1
  done
  if lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$starter_pid" 'runner-launcher\.ts'; then
    bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
      stop-owner-force "$JOB_RUNNER_STARTER_LOCK" "$starter_pid" \
      'runner-launcher\.ts' 5000 >/dev/null 2>&1 || {
        echo "❌ 起動失敗後のrunner launcherを安全に停止できません。次の起動は行いません。" >&2
        exit 1
      }
  fi
  for _ in {1..50}; do
    lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$starter_pid" 'runner-launcher\.ts' || break
    sleep 0.1
  done
  if lock_process_is "$JOB_RUNNER_STARTER_LOCK" "$starter_pid" 'runner-launcher\.ts' \
     || job_runner_is_alive; then
    echo "❌ 起動失敗generationの停止を確認できません。次の起動は行いません。" >&2
    exit 1
  fi
  echo "❌ Codex job runnerの起動に失敗しました: $JOB_RUNNER_LOG" >&2
  exit 1
}

if [ -n "$REPLACE_TOKEN_VALUE" ] && [ -s "$REPLACE_TOKEN_FILE" ] \
   && [ "$REPLACE_TOKEN_VALUE" = "$(cat "$REPLACE_TOKEN_FILE" 2>/dev/null)" ]; then
  rm -f "$REPLACE_TOKEN_FILE"
fi
REPLACE_TOKEN_VALUE=''
start_job_runner
cd "$PROJECT"
echo "▶ Zeroちゃん"
echo "   gateway : $REPO_DIR/server.ts"
echo "   project : $PROJECT"
echo "   state   : $STATE_DIR"
echo "   runtime : verified Herdr pane + job単位のCodex"
echo "   trust   : read/writeともrepository sandbox / advisorは固定broker"
echo "   caffeinate: ON (Ctrl-Cでgatewayを停止)"

exec caffeinate -dimsu bun --config=/dev/null --no-env-file "$REPO_DIR/server.ts"
