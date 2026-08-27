#!/usr/bin/env bash
# Zeroちゃん新マシンセットアップ
# 使い方: リポを clone した直後に `bash zerokun/setup.sh` を1回実行するだけ。
# 既存の設定ファイル(.env / access.json 等)があるマシンでは上書きしない(再実行しても安全)。
set -euo pipefail
unset BUN_OPTIONS BUN_CONFIG_PRELOAD NODE_OPTIONS

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$REPO_DIR/zerokun/state-dir.sh"
CH="$(zerokun_resolve_state_dir)"
CH="$(zerokun_normalize_path "$CH")"
ZEROKUN_JOB_DB="$(zerokun_resolve_job_db "$CH")"
export ZEROKUN_JOB_DB
LEGACY_STATE_DIR="$HOME/.claude/channels/slack"
TPL="$REPO_DIR/zerokun/templates"
PROJECT_DIR="${ZEROKUN_PROJECT_DIR:-$(dirname "$REPO_DIR")/zerokun-workspace}"
LAUNCHCTL_BIN="${ZEROKUN_LAUNCHCTL_BIN:-/bin/launchctl}"
. "$REPO_DIR/zerokun/codex-version.sh"

# Cutoverは既存legacy stateへの明示操作だけに限定する。検査より先にdirectoryを
# 作成すると、空の標準pathでもglobal Claude process停止へ進んでしまう。
LEGACY_CUTOVER=0
LEGACY_CUTOVER_INITIAL=0
CUTOVER_MARKER="$CH/.codex-legacy-cutover"
valid_cutover_marker() {
  local metadata first second third lines physical
  [ -f "$CUTOVER_MARKER" ] && [ ! -L "$CUTOVER_MARKER" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l' "$CUTOVER_MARKER" 2>/dev/null || true)"
  [ "$metadata" = "$(/usr/bin/id -u):1" ] || return 1
  physical="$(cd "$CH" 2>/dev/null && pwd -P)" || return 1
  first="$(/usr/bin/sed -n '1p' "$CUTOVER_MARKER" 2>/dev/null)" || return 1
  second="$(/usr/bin/sed -n '2p' "$CUTOVER_MARKER" 2>/dev/null)" || return 1
  third="$(/usr/bin/sed -n '3p' "$CUTOVER_MARKER" 2>/dev/null)" || return 1
  lines="$(/usr/bin/wc -l < "$CUTOVER_MARKER" 2>/dev/null | /usr/bin/tr -d '[:space:]')" \
    || return 1
  [ "$first" = "zerokun-codex-legacy-cutover-v1" ] \
    && [ "$second" = "$physical" ] && [ -z "$third" ] && [ "$lines" = "2" ]
}
case "${ZEROKUN_LEGACY_CUTOVER:-0}" in
  0) ;;
  1)
    if valid_cutover_marker; then
      LEGACY_CUTOVER=1
    else
      [ -d "$LEGACY_STATE_DIR" ] && [ -d "$CH" ] || {
        echo "❌ legacy cutover stateがありません: $LEGACY_STATE_DIR" >&2
        exit 1
      }
      LEGACY_STATE_REAL="$(cd "$LEGACY_STATE_DIR" && pwd -P)"
      SELECTED_STATE_REAL="$(cd "$CH" && pwd -P)"
      [ "$SELECTED_STATE_REAL" = "$LEGACY_STATE_REAL" ] || {
        echo "❌ ZEROKUN_LEGACY_CUTOVER=1にはlegacy stateを指定してください: $LEGACY_STATE_DIR" >&2
        exit 1
      }
      LEGACY_CUTOVER=1
      LEGACY_CUTOVER_INITIAL=1
    fi
    LEGACY_ENV="$CH/.env"
    LEGACY_ENV_METADATA="$(/usr/bin/stat -f '%u:%l' "$LEGACY_ENV" 2>/dev/null || true)"
    if [ ! -f "$LEGACY_ENV" ] || [ -L "$LEGACY_ENV" ] || [ ! -s "$LEGACY_ENV" ] \
      || [ "$LEGACY_ENV_METADATA" != "$(/usr/bin/id -u):1" ] \
      || [ "$(/usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' "$LEGACY_ENV" || true)" != "1" ] \
      || [ "$(/usr/bin/grep -Ec '^SLACK_APP_TOKEN=' "$LEGACY_ENV" || true)" != "1" ] \
      || ! /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' "$LEGACY_ENV" \
      || ! /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$' "$LEGACY_ENV"; then
      echo "❌ legacy cutover stateに有効なSlack App token設定がありません: $LEGACY_STATE_DIR" >&2
      exit 1
    fi
    ;;
  *) echo "❌ ZEROKUN_LEGACY_CUTOVERは0または1で指定してください" >&2; exit 1 ;;
esac

SETUP_DRAIN_SECONDS="${ZEROKUN_SETUP_DRAIN_SECONDS:-21600}"
if [ "$LEGACY_CUTOVER" = "1" ]; then
  case "$SETUP_DRAIN_SECONDS" in
    ''|*[!0-9]*) echo "❌ ZEROKUN_SETUP_DRAIN_SECONDSは0以上の整数で指定してください" >&2; exit 1 ;;
  esac
  [ "${#SETUP_DRAIN_SECONDS}" -le 6 ] \
    && [ "$SETUP_DRAIN_SECONDS" -le 604800 ] || {
      echo "❌ ZEROKUN_SETUP_DRAIN_SECONDSは604800以下で指定してください" >&2
      exit 1
    }
else
  SETUP_DRAIN_SECONDS=0
fi

# 0. 依存確認
command -v bun >/dev/null 2>&1 || { echo "❌ bun がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }

case "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" in
  0|1) ;;
  *) echo "❌ ZEROKUN_UPDATE_IN_PROGRESSは0または1で指定してください" >&2; exit 1 ;;
esac

# A human/bootstrap invocation first becomes a coordinator. The coordinator
# owns the primary update lock and starts this script again inside a gated,
# persisted process-group delegate before any setup mutation can begin.
if [ "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" = "0" ]; then
  exec bun --config=/dev/null --no-env-file \
    "$REPO_DIR/zerokun/update.ts" --setup-supervisor
fi

SETUP_LOCK="$CH/update.lock"
WATCHDOG_PLIST_TMP=""
ZSHRC_TMP=""
cleanup_setup_temporary_files() {
  [ -z "$WATCHDOG_PLIST_TMP" ] || rm -f -- "$WATCHDOG_PLIST_TMP"
  [ -z "$ZSHRC_TMP" ] || rm -f -- "$ZSHRC_TMP"
}
trap cleanup_setup_temporary_files EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A setup checked out by an updater must join that updater's existing lease
# before even preparing state directories. It must never reclaim a dead
# parent as a standalone primary: doing so would lose process-group coverage
# if the setup leader were killed while one of its children kept mutating.
if [ "${ZEROKUN_UPDATE_IN_PROGRESS:-0}" = "1" ]; then
  CH="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" \
    require-root "$CH")" || {
      echo "❌ 現在のzerokun-update lock pathをread-only検証できません。Codex版のoffline bootstrapを実行してください。変更は開始しません。" >&2
      exit 1
    }
  SETUP_LOCK="$CH/update.lock"
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" \
    require-directories "$CH" "$SETUP_LOCK" || {
      echo "❌ 現在のzerokun-update lock directoryが安全ではありません。Codex版のoffline bootstrapを実行してください。変更は開始しません。" >&2
      exit 1
    }
  if bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
    delegate-active "$SETUP_LOCK/pid" "$$"; then
    : # Current updater registered this gated setup before allowing mutation.
  else
    echo "❌ 現在のzerokun-updateは安全なlock委譲に対応していません。Codex版のoffline bootstrapを実行してください。変更は開始しません。" >&2
    exit 1
  fi
fi

# Updater-launched setup must prove the inherited state/lock/delegation first.
# Detect a helper upgrade here, but do not replace the executable while an old
# runner may still be using it for an owned Claude cleanup. The only helper
# writer runs after the old runner and gateway have stopped below.
FIFTH_ADVISOR_INSTALL_REQUIRED=0
if ! bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/install-fifth-advisor.ts" verify; then
  [ -f "$REPO_DIR/zerokun/install-fifth-advisor.ts" ] \
    || { echo "❌ fifth-advisor helper installerがありません。offline bootstrapを実行してください。" >&2; exit 1; }
  FIFTH_ADVISOR_INSTALL_REQUIRED=1
fi

if ! bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/advisor-prerequisites.ts" verify-grok; then
  [ -f "$REPO_DIR/zerokun/install-grok-reviewer.ts" ] \
    || { echo "❌ 専用Grok reviewer installerがありません。offline bootstrapを実行してください。" >&2; exit 1; }
  echo "   専用Grok reviewerをこのrelease用に導入します。" >&2
  bun --config=/dev/null --no-env-file \
    "$REPO_DIR/zerokun/install-grok-reviewer.ts" install \
    || { echo "❌ 専用Grok reviewerを導入できません。Codex版のoffline bootstrapを実行してください。" >&2; exit 1; }
fi
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/advisor-prerequisites.ts" verify-grok \
  || { echo "❌ 専用Grok reviewerを確認できません。Codex版のoffline bootstrapを実行してください。" >&2; exit 1; }

echo "== Zeroちゃんセットアップ開始 (repo: $REPO_DIR)"

# The update lock is the first mutation boundary. Every setup is already
# running inside the coordinator's persisted process-group delegate here.
CH="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" \
  prepare-root "$CH")" \
  || { echo "❌ state directoryを安全に準備できません" >&2; exit 1; }
SETUP_LOCK="$CH/update.lock"
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" prepare-directories \
  "$CH" "$SETUP_LOCK"

zerokun_require_codex_version "$REPO_DIR" || exit 1
ZEROKUN_STATE_DIR="$CH" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/codex-executor.ts" \
  verify-system-config --inherit-process-group || exit 1
command -v git >/dev/null 2>&1 || { echo "❌ git がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }
command -v tmux >/dev/null 2>&1 || { echo "❌ tmux がありません → bash zerokun/bootstrap-macos.sh"; exit 1; }
zerokun_require_herdr_version || exit 1
zerokun_resolve_claude_binary >/dev/null \
  || { echo "❌ Claude Codeがありません。先に公式Claude Codeを導入してください。" >&2; exit 1; }
zerokun_claude_subscription_ready \
  || { echo "❌ Claude Codeはsubscription login済みである必要があります。Herdrで先にloginしてください。Zeroちゃんは認証操作を行いません。" >&2; exit 1; }
BUN_BIN="$(command -v bun)"
INSTALL_ENV_ROOT="$(/usr/bin/mktemp -d /tmp/zerokun-bun-install.XXXXXX)" \
  || { echo "❌ dependency install用一時directoryを作成できません" >&2; exit 1; }
/bin/chmod 0700 "$INSTALL_ENV_ROOT"
/bin/mkdir "$INSTALL_ENV_ROOT/home" "$INSTALL_ENV_ROOT/curl" \
  "$INSTALL_ENV_ROOT/xdg-config" "$INSTALL_ENV_ROOT/xdg-cache" "$INSTALL_ENV_ROOT/bun-cache"
/bin/chmod 0700 "$INSTALL_ENV_ROOT/home" "$INSTALL_ENV_ROOT/curl" \
  "$INSTALL_ENV_ROOT/xdg-config" "$INSTALL_ENV_ROOT/xdg-cache" "$INSTALL_ENV_ROOT/bun-cache"
INSTALL_STATUS=0
(cd "$REPO_DIR" && /usr/bin/env -i \
  HOME="$INSTALL_ENV_ROOT/home" USER="$(/usr/bin/id -un)" LOGNAME="$(/usr/bin/id -un)" \
  SHELL="${SHELL:-/bin/zsh}" TERM="${TERM:-dumb}" \
  PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  TMPDIR=/tmp CURL_HOME="$INSTALL_ENV_ROOT/curl" \
  XDG_CONFIG_HOME="$INSTALL_ENV_ROOT/xdg-config" XDG_CACHE_HOME="$INSTALL_ENV_ROOT/xdg-cache" \
  BUN_INSTALL_CACHE_DIR="$INSTALL_ENV_ROOT/bun-cache" \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false \
  "$BUN_BIN" --config=/dev/null --no-env-file install --frozen-lockfile --silent) \
  || INSTALL_STATUS=$?
/bin/rm -rf "$INSTALL_ENV_ROOT"
[ "$INSTALL_STATUS" = "0" ] || { echo "❌ dependency installに失敗しました" >&2; exit "$INSTALL_STATUS"; }
unset INSTALL_ENV_ROOT INSTALL_STATUS

# Any configured state must prove that its Bot/App tokens belong to one Slack
# App before setup can reach a process-stop boundary. A newly generated
# placeholder file is the sole unconfigured exception.
VERIFY_SLACK_IDENTITY=0
if [ "$LEGACY_CUTOVER_INITIAL" = "1" ]; then
  VERIFY_SLACK_IDENTITY=1
elif [ -e "$CH/.env" ] || [ -L "$CH/.env" ]; then
  STATE_ENV_CONTENT="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$CH/.env")" \
    || { echo "❌ 既存Slack設定を安全に読み取れないためprocessは停止しません" >&2; exit 1; }
  BOT_ASSIGNMENTS=0
  APP_ASSIGNMENTS=0
  BOT_PLACEHOLDERS=0
  APP_PLACEHOLDERS=0
  while IFS= read -r state_env_line; do
    case "$state_env_line" in
      SLACK_BOT_TOKEN=*) BOT_ASSIGNMENTS=$((BOT_ASSIGNMENTS + 1)) ;;
    esac
    case "$state_env_line" in
      SLACK_APP_TOKEN=*) APP_ASSIGNMENTS=$((APP_ASSIGNMENTS + 1)) ;;
    esac
    [ "$state_env_line" != 'SLACK_BOT_TOKEN=xoxb-ここに貼る' ] \
      || BOT_PLACEHOLDERS=$((BOT_PLACEHOLDERS + 1))
    [ "$state_env_line" != 'SLACK_APP_TOKEN=xapp-ここに貼る' ] \
      || APP_PLACEHOLDERS=$((APP_PLACEHOLDERS + 1))
  done <<< "$STATE_ENV_CONTENT"
  unset STATE_ENV_CONTENT state_env_line
  if [ "$BOT_ASSIGNMENTS" != "1" ] || [ "$APP_ASSIGNMENTS" != "1" ] \
    || [ "$BOT_PLACEHOLDERS" != "1" ] || [ "$APP_PLACEHOLDERS" != "1" ]; then
    VERIFY_SLACK_IDENTITY=1
  fi
fi
if [ "$VERIFY_SLACK_IDENTITY" = "1" ]; then
  BUN_BIN="$(command -v bun)"
  IDENTITY_ENV=(/usr/bin/env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}")
  "${IDENTITY_ENV[@]}" "$BUN_BIN" --config=/dev/null --no-env-file "$REPO_DIR/zerokun/slack-app-identity.ts" \
    verify-file "$CH/.env" \
    || { echo "❌ setup前にSlack App token identityを検証できないためprocessは停止しません" >&2; exit 1; }
fi
mkdir -p "$PROJECT_DIR"
[ "$(cd "$PROJECT_DIR" && pwd -P)" != "$(cd "$REPO_DIR" && pwd -P)" ] \
  || { echo "❌ Slack作業projectはZeroちゃん本体と別directoryにしてください" >&2; exit 1; }
if [ ! -e "$PROJECT_DIR/.git" ]; then
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    git -c core.hooksPath=/dev/null init --initial-branch=main "$PROJECT_DIR" >/dev/null
fi

# 1. 残りの設定ディレクトリをlock保持中に準備する。
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" prepare-directories \
  "$CH" "$CH/inbox" "$CH/approved" "$CH/job-runner.lock"

# Claude版daemonが新しいCodex jobをclaimしないよう、cutover中はclaimを止める。
# 実行中の旧jobだけをdrainしてから旧runner/gatewayを終了する。待機jobは
# SQLite migrationでsessionを破棄し、Codex jobとして引き継ぐ。

process_matches() {
  local pid="$1" pattern="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && ps -o command= -p "$pid" 2>/dev/null | grep -Eq "$pattern"
}

lock_process_matches() {
  local lock_file="$1" pid="$2" pattern="$3"
  process_matches "$pid" "$pattern" || return 1
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-identity-check.ts" "$lock_file" "$pid" "$pattern"
}

pid_is_alive() {
  local pid="$1" state
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || return 0
  [ -z "$state" ] && return 0
  [ "${state#Z}" = "$state" ]
}

read_lock_pid() {
  { tr -d '[:space:]' < "$1"; } 2>/dev/null || true
}

# Validate the database and sidecars before the first process-stop boundary.
# Opening/migrating the database is intentionally deferred until services stop.
ZEROKUN_STATE_DIR="$CH" bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/job-runner.ts" validate-storage >/dev/null \
  || { echo "❌ SQLite stateが安全でないためprocessは停止しません。" >&2; exit 1; }

# Explicitly selecting the legacy state is the opt-in in-place cutover path.
# A normal Codex setup never scans for or stops Claude processes.
if [ "$LEGACY_CUTOVER_INITIAL" = "1" ]; then
  while IFS= read -r legacy_parent; do
    [ -n "$legacy_parent" ] || continue
    [ "$legacy_parent" != "$$" ] || continue
    if process_matches "$legacy_parent" 'claude.*dangerously-load-development-channels[[:space:]]+server:slack-channel'; then
      bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-generation.ts" \
        stop-matching "$legacy_parent" \
        'claude.*dangerously-load-development-channels\s+server:slack-channel' 30000 \
        || { echo "❌ 旧Claude版Zeroちゃん親processを世代検証付きで停止できません。" >&2; exit 1; }
      echo "   旧Claude版Zeroちゃん親processを停止しました"
    fi
  done < <(pgrep -f 'claude.*dangerously-load-development-channels.*server:slack-channel' 2>/dev/null || true)
fi

legacy_running_state() {
  local db="$CH/jobs.sqlite3"
  [ -f "$db" ] || return 0
  ZEROKUN_CUTOVER_DB="$db" bun --config=/dev/null --no-env-file -e '
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.ZEROKUN_CUTOVER_DB!, { readonly: true });
    let count = -1;
    try {
      const row = db.query("SELECT COUNT(*) AS count FROM jobs WHERE status = ?").get("running") as { count: number };
      count = row.count;
    } finally { db.close(); }
    if (!Number.isSafeInteger(count) || count < 0) process.exit(70);
    process.exit(count > 0 ? 10 : 0);
  '
}

GATEWAY_SCRIPT="$CH/server.ts"
RUNNER_SCRIPT="$CH/job-runner.ts"
if [ "$LEGACY_CUTOVER" = "1" ]; then
  # Existing legacy processes were launched from the user-facing HOME path,
  # which may differ from pwd -P on macOS (for example /var vs /private/var).
  GATEWAY_SCRIPT="$LEGACY_STATE_DIR/server.ts"
  RUNNER_SCRIPT="$LEGACY_STATE_DIR/job-runner.ts"
fi
RUNNER_PID="$(read_lock_pid "$CH/job-runner.lock/pid")"
if process_matches "$RUNNER_PID" 'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)'; then
  if ! lock_process_matches "$CH/job-runner.lock/pid" "$RUNNER_PID" \
    'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)'; then
    bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/adopt-legacy-lock.ts" \
      "$CH/job-runner.lock/pid" "$RUNNER_PID" "$RUNNER_SCRIPT" daemon \
      || { echo "❌ job runner lock identityを検証できないため自動停止しません。" >&2; exit 1; }
    lock_process_matches "$CH/job-runner.lock/pid" "$RUNNER_PID" \
      'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)' \
      || { echo "❌ job runner lock identityの移行に失敗しました。" >&2; exit 1; }
  fi
  drain_deadline=$(( $(date +%s) + SETUP_DRAIN_SECONDS ))
  while :; do
    if legacy_running_state; then
      break
    else
      running_state=$?
      [ "$running_state" -eq 10 ] || {
        echo "❌ 実行中job件数を安全に確認できません。旧runnerは停止していません。" >&2
        exit 1
      }
    fi
    [ "$(date +%s)" -lt "$drain_deadline" ] || {
      echo "❌ 実行中jobのdrain待ちがtimeoutしました。旧runnerは停止していません。" >&2
      exit 1
    }
    echo "   旧runnerの実行中job完了を待っています..."
    sleep 2
  done
  if pid_is_alive "$RUNNER_PID"; then
    bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
      stop-owner "$CH/job-runner.lock/pid" "$RUNNER_PID" \
      'job-runner\.ts\s+daemon(?:\s|$)' 30000 \
      || { echo "❌ 旧runnerを世代検証付きで停止できません。" >&2; exit 1; }
  fi
  echo "   旧job runnerを安全に停止しました"
fi

# Keep Slack intake available while an existing job drains. Once the runner
# is stopped no accepted event can start work, so the gateway can be stopped
# immediately before storage/setup mutation without leaving a partial outage
# on a drain timeout.
GATEWAY_PID="$(read_lock_pid "$CH/plugin.lock")"
if process_matches "$GATEWAY_PID" 'server\.ts'; then
  if ! lock_process_matches "$CH/plugin.lock" "$GATEWAY_PID" 'server\.ts'; then
    bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/adopt-legacy-lock.ts" \
      "$CH/plugin.lock" "$GATEWAY_PID" "$GATEWAY_SCRIPT" \
      || { echo "❌ gateway lock identityを検証できないため自動停止しません。" >&2; exit 1; }
    lock_process_matches "$CH/plugin.lock" "$GATEWAY_PID" 'server\.ts' \
      || { echo "❌ gateway lock identityの移行に失敗しました。" >&2; exit 1; }
  fi
  if pid_is_alive "$GATEWAY_PID"; then
    bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/process-lock.ts" \
      stop-owner "$CH/plugin.lock" "$GATEWAY_PID" 'server\.ts' 30000 \
      || { echo "❌ 旧gatewayを世代検証付きで停止できません。" >&2; exit 1; }
  fi
  echo "   旧Slack gatewayを停止しました"
fi

# No old process can be executing the previous helper beyond this point. A
# release upgrade may now atomically replace it, and every setup re-verifies
# the exact owner-only copy before starting storage migration or new services.
if [ "$FIFTH_ADVISOR_INSTALL_REQUIRED" = "1" ]; then
  echo "   fifth-advisor transport helperをこのrelease用に導入します。" >&2
  bun --config=/dev/null --no-env-file \
    "$REPO_DIR/zerokun/install-fifth-advisor.ts" install \
    || { echo "❌ fifth-advisor helperを導入できません。Codex版のoffline bootstrapを実行してください。" >&2; exit 1; }
fi
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/install-fifth-advisor.ts" verify \
  || { echo "❌ fifth-advisor helperを確認できません。Codex版のoffline bootstrapを実行してください。" >&2; exit 1; }

# Legacy rows are handled only after both legacy processes are gone. Queued rows
# move to Codex; uncertain running rows fail closed and require an explicit resend.
# Opening JobStore for status/server startup is deliberately non-destructive.
ZEROKUN_STATE_DIR="$CH" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/job-runner.ts" prepare-storage
if [ "$LEGACY_CUTOVER" = "1" ]; then
  ZEROKUN_STATE_DIR="$CH" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/job-runner.ts" migrate-legacy
fi
if [ "$LEGACY_CUTOVER_INITIAL" = "1" ]; then
  printf '%s\n%s\n' 'zerokun-codex-legacy-cutover-v1' "$CH" \
    | bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" atomic-write-private "$CUTOVER_MARKER"
fi

# 2. 設定ファイル(既存があれば触らない)
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" validate-existing "$CH/access.json" "$CH/.env"
[ -f "$CH/access.json" ] || cp "$TPL/access.json.example" "$CH/access.json"
[ ! -f "$CH/access.json" ] || chmod 600 "$CH/access.json"
[ -f "$CH/.env" ] || { cp "$TPL/env.example" "$CH/.env"; chmod 600 "$CH/.env"; }

# 3. SQLite直列job runner・Codex executor・watchdog・管理CLI
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/zerokun/job-runner.ts" "$CH/job-runner.ts"
ln -sfn "$REPO_DIR/zerokun/codex-executor.ts" "$CH/codex-executor.ts"
bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/update-runtime.ts" \
  install "$REPO_DIR/zerokun" "$CH" >/dev/null
install -m 0700 "$REPO_DIR/zerokun/watchdog.sh" "$CH/watchdog.sh"
mkdir -p "$HOME/Library/LaunchAgents"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/com.zerokun.watchdog.plist"
if [ -e "$WATCHDOG_PLIST" ] || [ -L "$WATCHDOG_PLIST" ]; then
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" validate-owned-regular "$WATCHDOG_PLIST"
fi
WATCHDOG_PLIST_TMP="$(mktemp "$HOME/Library/LaunchAgents/.com.zerokun.watchdog.plist.XXXXXX")"
sed -e "s|__STATE_DIR__|$CH|g" -e "s|__LEGACY_CUTOVER__|$LEGACY_CUTOVER|g" \
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
# Remove only dangling Claude-era links that this same Zeroちゃん checkout owned.
remove_owned_legacy_link() {
  local legacy_path="$1" legacy_target="$2"
  if [ -L "$legacy_path" ] && [ "$(readlink "$legacy_path")" = "$legacy_target" ]; then
    rm -f "$legacy_path"
  fi
}
if [ "$LEGACY_CUTOVER" = "1" ]; then
  remove_owned_legacy_link "$HOME/.local/bin/claude-channel" "$REPO_DIR/claude-channel.sh"
  remove_owned_legacy_link "$HOME/.claude/skills/threads" "$REPO_DIR/skills/threads"
  remove_owned_legacy_link "$HOME/.claude/skills/zerokun-update" "$REPO_DIR/skills/zerokun-update"
fi
echo "   SQLite job runner を設置しました(永続FIFO / 同時実行数1)"
echo "   Slack更新リクエストworkerを設置しました"
echo "   安全更新コマンドを設置しました: zerokun-update"

# 4. zsh エイリアス。既存の管理ブロックだけをatomicに置換する。
# symlink/hardlinkや不均衡markerではユーザー設定を変更せず停止する。
ZSHRC="$HOME/.zshrc"
ZSHRC_TMP="$(mktemp "$HOME/.zshrc.zerokun-tmp.XXXXXX")"
if [ -e "$ZSHRC" ] || [ -L "$ZSHRC" ]; then
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" validate-owned-regular "$ZSHRC"
  ZSHRC_MODE="$(stat -f '%Lp' "$ZSHRC")"
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$ZSHRC" | awk '
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
# SlackからZeroちゃんを動かすボット — zerokun/setup.sh が管理
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
EOF
    printf 'export ZEROKUN_PROJECT_DIR=%q\n' "$PROJECT_DIR"
    printf 'export ZEROKUN_STATE_DIR=%q\n' "$CH"
    printf 'export ZEROKUN_LEGACY_CUTOVER=%q\n' "$LEGACY_CUTOVER"
    cat <<'EOF'
alias zerokun='codex-channel "$ZEROKUN_PROJECT_DIR"'
# 稼働中を止めて入れ替えるかは端末の y/N プロンプトで都度確認する。
# ZEROKUN_REPLACE=1 は自己更新のワンタイムトークン無しでは停止権限にならない。
alias zerokun-restart='codex-channel "$ZEROKUN_PROJECT_DIR"'
alias zerokun-status='pid=$(cat "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/plugin.lock" 2>/dev/null); [ -n "$pid" ] && ps -p "$pid" -o pid=,command= || echo "Zeroちゃんは停止中"'
# <<< zerokun setup <<<
EOF
  } >> "$ZSHRC_TMP"
mv -f -- "$ZSHRC_TMP" "$ZSHRC"
ZSHRC_TMP=""
echo "   .zshrc のZeroちゃん管理ブロックを更新しました(新しいターミナルで有効)"

echo ""
if [ "${ZEROKUN_BOOTSTRAP:-0}" = "1" ]; then
  echo "✅ 配線完了。bootstrapのSlack設定へ続きます。"
else
  echo "✅ 配線完了。残りの手動ステップ:"
  echo "  1. Slack アプリをこのマシン用に新規作成し(1台=1アプリ=1ボット名)、"
  echo "     トークン2つを $CH/.env に貼る (xoxb- / xapp-。作成手順はリポ直下 README.md)"
  echo "  2. $CH/access.json に許可する Slack ユーザーID/チャンネルIDを入れる"
  echo "  3. codex login status が Logged in using ChatGPT と返すことを確認"
  echo "  4. 必要なら --project-dir でSlack DMの既定作業リポを指定"
  echo "  5. Herdrの専用paneで: zerokun"
  echo "     queue確認: zerokun-jobs status"
  echo "     Codex版更新: zerokun-update"
  echo "     書込み許可: zerokun-access write allow <SlackユーザーID>"
fi
