#!/usr/bin/env bash
# launchdからbridge/job-runnerを監視し、状態遷移だけをSlack DMへ通知する。
set -u

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

SCRIPT_PATH="${BASH_SOURCE[0]}"

resolve_state_dir() {
  if [ -n "${ZEROKUN_STATE_DIR:-}" ]; then
    printf '%s\n' "$ZEROKUN_STATE_DIR"
  elif [ -n "${SLACK_STATE_DIR:-}" ]; then
    printf '%s\n' "$SLACK_STATE_DIR"
  elif [ -f "$HOME/.claude/channels/slack/jobs.sqlite3" ] \
    || [ -f "$HOME/.claude/channels/slack/.env" ] \
    || [ -f "$HOME/.claude/channels/slack/access.json" ]; then
    printf '%s\n' "$HOME/.claude/channels/slack"
  else
    printf '%s\n' "$HOME/.codex/zerokun"
  fi
}

process_matches() {
  local pid_file="$1"
  local expected="$2"
  local pid command
  private_regular_file "$pid_file" || return 1
  pid="$(tr -d '[:space:]' < "$pid_file" 2>/dev/null)"
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$pid" -gt 0 ] 2>/dev/null || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(/bin/ps -o command= -p "$pid" 2>/dev/null)"
  [[ "$command" =~ $expected ]]
}

prepare_state_dir() {
  if [ -L "$STATE_DIR" ]; then
    printf 'zerokun watchdog: unsafe state directory symlink: %s\n' "$STATE_DIR" >&2
    return 1
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null || return 1
  local owner
  [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || return 1
  owner="$(/usr/bin/stat -f '%u' "$STATE_DIR" 2>/dev/null)" || return 1
  [ "$owner" = "$(/usr/bin/id -u)" ] || return 1
  chmod 700 "$STATE_DIR" || return 1
}

private_regular_file() {
  local file="$1" owner links
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  owner="$(/usr/bin/stat -f '%u' "$file" 2>/dev/null)" || return 1
  links="$(/usr/bin/stat -f '%l' "$file" 2>/dev/null)" || return 1
  [ "$owner" = "$(/usr/bin/id -u)" ] && [ "$links" = "1" ]
}

load_state_env() {
  local line
  [ -f "$STATE_DIR/.env" ] || return 0
  private_regular_file "$STATE_DIR/.env" || {
    printf 'zerokun watchdog: unsafe .env; refusing to read it\n' >&2
    return 1
  }
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      SLACK_BOT_TOKEN=*)
        [ -n "${SLACK_BOT_TOKEN:-}" ] || SLACK_BOT_TOKEN="${line#SLACK_BOT_TOKEN=}"
        export SLACK_BOT_TOKEN
        ;;
      ZEROKUN_WATCHDOG_NOTIFY=*)
        [ -n "${ZEROKUN_WATCHDOG_NOTIFY:-}" ] || ZEROKUN_WATCHDOG_NOTIFY="${line#ZEROKUN_WATCHDOG_NOTIFY=}"
        export ZEROKUN_WATCHDOG_NOTIFY
        ;;
      ZEROKUN_WATCHDOG_REALERT_MIN=*)
        [ -n "${ZEROKUN_WATCHDOG_REALERT_MIN:-}" ] || ZEROKUN_WATCHDOG_REALERT_MIN="${line#ZEROKUN_WATCHDOG_REALERT_MIN=}"
        export ZEROKUN_WATCHDOG_REALERT_MIN
        ;;
    esac
  done < "$STATE_DIR/.env"
}

load_bot_token() {
  [ -n "${SLACK_BOT_TOKEN:-}" ] && return 0
  load_state_env
  [ -n "${SLACK_BOT_TOKEN:-}" ] || return 1
  return 0
}

notification_user() {
  if [ -n "${ZEROKUN_WATCHDOG_NOTIFY:-}" ]; then
    printf '%s' "$ZEROKUN_WATCHDOG_NOTIFY"
    return 0
  fi
  private_regular_file "$STATE_DIR/access.json" || return 1
  /usr/bin/python3 - "$STATE_DIR/access.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        users = json.load(handle).get("allowFrom", [])
    if users and isinstance(users[0], str):
        print(users[0], end="")
except Exception:
    pass
PY
}

send_notification() {
  local body="$1"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    printf 'DRY_RUN notification: %s\n' "$body"
    return 0
  fi

  local notify_user open_response dm_channel payload post_response api_error
  load_bot_token || { printf 'zerokun watchdog: SLACK_BOT_TOKEN is unavailable\n' >&2; return 1; }
  notify_user="$(notification_user)"
  [ -n "$notify_user" ] || { printf 'zerokun watchdog: notification user is unavailable\n' >&2; return 1; }

  open_response="$(/usr/bin/curl -sS --max-time 10 -X POST 'https://slack.com/api/conversations.open' \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    --data-urlencode "users=$notify_user" 2>/dev/null)" || return 1
  dm_channel="$(printf '%s' "$open_response" | /usr/bin/python3 -c \
    'import json,sys; data=json.load(sys.stdin); print(data.get("channel",{}).get("id","") if data.get("ok") else "", end="")' \
    2>/dev/null)"
  if [ -z "$dm_channel" ]; then
    api_error="$(printf '%s' "$open_response" | /usr/bin/python3 -c \
      'import json,sys; print(json.load(sys.stdin).get("error","unknown_error"), end="")' 2>/dev/null)"
    printf 'zerokun watchdog: conversations.open failed: %s\n' "${api_error:-invalid_response}" >&2
    return 1
  fi

  payload="$(WATCHDOG_CHANNEL="$dm_channel" WATCHDOG_BODY="$body" /usr/bin/python3 -c \
    'import json,os; print(json.dumps({"channel":os.environ["WATCHDOG_CHANNEL"],"text":os.environ["WATCHDOG_BODY"]},ensure_ascii=False), end="")')"
  post_response="$(/usr/bin/curl -sS --max-time 10 -X POST 'https://slack.com/api/chat.postMessage' \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data "$payload" 2>/dev/null)" || return 1
  if ! printf '%s' "$post_response" | /usr/bin/python3 -c \
    'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null; then
    api_error="$(printf '%s' "$post_response" | /usr/bin/python3 -c \
      'import json,sys; print(json.load(sys.stdin).get("error","unknown_error"), end="")' 2>/dev/null)"
    printf 'zerokun watchdog: chat.postMessage failed: %s\n' "${api_error:-invalid_response}" >&2
    return 1
  fi
  return 0
}

prepare_state_transition() {
  /usr/bin/python3 - \
    "$STATE_FILE" "$NEXT_STATE_FILE" "$ALERT_FILE" \
    "$bridge_up" "$runner_up" "$now_epoch" "$REALERT_MIN" <<'PY'
import datetime as dt
import json
import os
import sys

state_path, next_path, alert_path = sys.argv[1:4]
bridge_up = sys.argv[4] == "1"
runner_up = sys.argv[5] == "1"
now = int(sys.argv[6])
realert_seconds = int(sys.argv[7]) * 60
default = {"status": "up", "downSince": None, "lastAlertAt": None, "consecutiveDownChecks": 0}
try:
    with open(state_path, encoding="utf-8") as handle:
        state = {**default, **json.load(handle)}
except Exception:
    state = default.copy()

alert = None
if bridge_up and runner_up:
    if state.get("status") == "down":
        alert = "✅ ゼロくん復旧（bridge: up / job-runner: up）"
    next_state = default.copy()
else:
    consecutive = int(state.get("consecutiveDownChecks") or 0) + 1
    down_since = int(state.get("downSince") or now)
    status = state.get("status") if state.get("status") in ("up", "down") else "up"
    last_alert = state.get("lastAlertAt")
    should_alert = False
    if status == "up" and consecutive >= 2:
        status = "down"
        should_alert = True
    elif status == "down" and (not last_alert or now - int(last_alert) >= realert_seconds):
        should_alert = True
    if should_alert:
        bridge = "up" if bridge_up else "down"
        runner = "up" if runner_up else "down"
        since = dt.datetime.fromtimestamp(down_since).strftime("%H:%M")
        alert = (
            f"🚨 ゼロくん停止中（bridge: {bridge} / job-runner: {runner}）"
            f"{since}から。復旧: 端末で zerokun-restart"
        )
        last_alert = now
    next_state = {
        "status": status,
        "downSince": down_since,
        "lastAlertAt": last_alert,
        "consecutiveDownChecks": consecutive,
    }

with open(next_path, "w", encoding="utf-8") as handle:
    json.dump(next_state, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
os.chmod(next_path, 0o600)
if alert:
    with open(alert_path, "w", encoding="utf-8") as handle:
        handle.write(alert)
    os.chmod(alert_path, 0o600)
PY
}

run_watchdog() {
  STATE_DIR="$(resolve_state_dir)"
  STATE_FILE="$STATE_DIR/watchdog-state.json"
  prepare_state_dir || return 1
  if [ -e "$STATE_FILE" ] && ! private_regular_file "$STATE_FILE"; then
    printf 'zerokun watchdog: unsafe state file; refusing to read it\n' >&2
    return 1
  fi
  load_state_env
  REALERT_MIN="${ZEROKUN_WATCHDOG_REALERT_MIN:-60}"
  case "$REALERT_MIN" in
    ''|*[!0-9]*) REALERT_MIN=60 ;;
  esac
  [ "$REALERT_MIN" -ge 1 ] 2>/dev/null || REALERT_MIN=60
  if [ -e "$STATE_DIR/watchdog-off" ]; then
    printf '%s zerokun watchdog: muted\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    return 0
  fi
  NEXT_STATE_FILE="$(mktemp "$STATE_DIR/.watchdog-state.next.XXXXXX")" || return 1
  ALERT_FILE="$(mktemp "$STATE_DIR/.watchdog-state.alert.XXXXXX")" || {
    rm -f "$NEXT_STATE_FILE"
    return 1
  }

  bridge_up=0
  runner_up=0
  process_matches "$STATE_DIR/plugin.lock" 'server\.ts' && bridge_up=1
  process_matches "$STATE_DIR/job-runner.lock/pid" 'job-runner\.ts[[:space:]]+daemon([[:space:]]|$)' && runner_up=1
  now_epoch="$(date +%s)"
  export STATE_DIR STATE_FILE NEXT_STATE_FILE ALERT_FILE REALERT_MIN
  export bridge_up runner_up now_epoch

  if ! prepare_state_transition; then
    printf 'zerokun watchdog: state transition failed\n' >&2
    rm -f "$NEXT_STATE_FILE" "$ALERT_FILE"
    return 0
  fi

  if [ -s "$ALERT_FILE" ]; then
    local alert
    alert="$(cat "$ALERT_FILE")"
    if send_notification "$alert"; then
      mv -f "$NEXT_STATE_FILE" "$STATE_FILE"
    else
      rm -f "$NEXT_STATE_FILE"
    fi
    rm -f "$ALERT_FILE"
  else
    mv -f "$NEXT_STATE_FILE" "$STATE_FILE"
  fi
  rm -f "$ALERT_FILE"

  printf '%s zerokun watchdog: bridge=%s runner=%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
    "$([ "$bridge_up" = "1" ] && printf up || printf down)" \
    "$([ "$runner_up" = "1" ] && printf up || printf down)"
  return 0
}

selftest_fail() {
  printf 'watchdog selftest: FAIL: %s\n' "$1" >&2
  return 1
}

selftest() {
  local test_dir fake_server fake_runner server_pid runner_pid output
  test_dir="$(mktemp -d "${TMPDIR:-/tmp}/zerokun-watchdog.XXXXXX")" || return 1
  fake_server="$test_dir/server.ts"
  fake_runner="$test_dir/job-runner.ts"
  printf '#!/bin/bash\nexec -a "$0" sleep 30\n' > "$fake_server"
  printf '#!/bin/bash\nexec -a "$0 $1" sleep 30\n' > "$fake_runner"
  /bin/bash "$fake_server" & server_pid=$!
  /bin/bash "$fake_runner" daemon & runner_pid=$!
  trap "kill $server_pid $runner_pid 2>/dev/null || true; wait $server_pid $runner_pid 2>/dev/null || true; rm -rf '$test_dir'" EXIT
  sleep 0.05
  mkdir -p "$test_dir/job-runner.lock"
  printf '%s\n' "$server_pid" > "$test_dir/plugin.lock"
  printf '%s\n' "$runner_pid" > "$test_dir/job-runner.lock/pid"

  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'healthy alert' || return 1
  printf 'ok: healthy sends nothing\n'

  rm -f "$test_dir/plugin.lock"
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'first down alert' || return 1
  printf '%s\n' "$server_pid" > "$test_dir/plugin.lock"
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'transient recovery alert' || return 1
  printf 'ok: transient down sends nothing\n'

  rm -f "$test_dir/plugin.lock"
  SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH" >/dev/null
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'🚨 ゼロくん停止中'* ]] || selftest_fail 'second down did not alert' || return 1
  printf 'ok: second down sends alert\n'

  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'early reminder' || return 1
  printf 'ok: down reminder is suppressed\n'

  /usr/bin/python3 - "$test_dir/watchdog-state.json" <<'PY'
import json, sys, time
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    state = json.load(handle)
state["lastAlertAt"] = int(time.time()) - 3601
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle)
PY
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'🚨 ゼロくん停止中'* ]] || selftest_fail 'late reminder missing' || return 1
  printf 'ok: reminder is sent after interval\n'

  printf '%s\n' "$server_pid" > "$test_dir/plugin.lock"
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'✅ ゼロくん復旧'* ]] || selftest_fail 'recovery missing' || return 1
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'duplicate recovery' || return 1
  printf 'ok: recovery sends once\n'

  touch "$test_dir/watchdog-off"
  rm -f "$test_dir/plugin.lock"
  output="$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  output="$output$(SLACK_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'mute alert' || return 1
  printf 'ok: watchdog-off mutes notifications\n'
  printf 'watchdog selftest: PASS\n'
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

if [ "${1:-}" = "--test-notification" ]; then
  STATE_DIR="$(resolve_state_dir)"
  prepare_state_dir || exit 1
  load_state_env
  if send_notification '🧪 ゼロくんwatchdog通知テスト（実装確認のための1通です）'; then
    printf 'zerokun watchdog: test notification sent\n'
    exit 0
  fi
  exit 1
fi

run_watchdog
exit $?
