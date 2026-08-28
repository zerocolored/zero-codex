#!/usr/bin/env bash
# launchdからbridge/job-runnerを監視し、状態遷移だけをSlack DMへ通知する。
set -u

PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

# The selected state's token is authoritative. Ignore stale shell/launchd
# tokens that could reconnect this machine to another Zeroちゃん Slack App.
WATCHDOG_BOT_TOKEN=""
WATCHDOG_APP_TOKEN=""
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
export -n WATCHDOG_BOT_TOKEN WATCHDOG_APP_TOKEN 2>/dev/null || true
# Notifications carry a bearer token. Ignore inherited proxy/custom-CA and
# curl configuration channels so local shell state cannot redirect or trace it.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR

SCRIPT_PATH="${BASH_SOURCE[0]}"
CURL_BIN=/usr/bin/curl

watchdog_lexical_path() {
  local input="$1" current rest component
  case "$input" in /*) current="/" ;; *) current="$PWD" ;; esac
  rest="$input"
  while :; do
    case "$rest" in
      */*) component="${rest%%/*}"; rest="${rest#*/}" ;;
      *) component="$rest"; rest="" ;;
    esac
    case "$component" in
      ''|.) ;;
      ..) current="${current%/*}"; [ -n "$current" ] || current="/" ;;
      *) if [ "$current" = "/" ]; then current="/$component"; else current="$current/$component"; fi ;;
    esac
    [ -n "$rest" ] || break
  done
  printf '%s\n' "$current"
}

watchdog_normalize_path() {
  local input="$1" normalized ancestor suffix component physical
  if [ -d "$input" ]; then
    physical="$(CDPATH='' cd -P -- "$input" 2>/dev/null && pwd -P)" || physical=""
    if [ -n "$physical" ]; then printf '%s\n' "$physical"; return; fi
  fi
  normalized="$(watchdog_lexical_path "$input")"
  ancestor="$normalized"
  suffix=""
  while [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ] && [ "$ancestor" != "/" ]; do
    component="${ancestor##*/}"
    suffix="/$component$suffix"
    ancestor="${ancestor%/*}"
    [ -n "$ancestor" ] || ancestor="/"
  done
  if [ -d "$ancestor" ]; then
    physical="$(CDPATH='' cd -P -- "$ancestor" 2>/dev/null && pwd -P)" || physical=""
    if [ -n "$physical" ]; then
      [ "$physical" != "/" ] || physical=""
      printf '%s%s\n' "$physical" "$suffix"
      return
    fi
  fi
  printf '%s\n' "$normalized"
}

watchdog_path_selects_legacy() {
  local logical physical legacy_physical
  logical="$(watchdog_lexical_path "$1")"
  case "$logical" in */.claude/channels/slack) return 0 ;; esac
  physical="$(watchdog_normalize_path "$1")"
  legacy_physical="$(watchdog_normalize_path "$HOME/.claude/channels/slack")"
  [ "$physical" != "$legacy_physical" ] || return 0
  case "$physical" in */.claude/channels/slack) return 0 ;; esac
  return 1
}

watchdog_owned_regular_file() {
  local file="$1" metadata
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l' "$file" 2>/dev/null || true)"
  [ "$metadata" = "$(/usr/bin/id -u):1" ]
}

watchdog_valid_cutover_marker_only() {
  local state="$1" marker physical first second third lines
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  marker="$state/.codex-legacy-cutover"
  watchdog_owned_regular_file "$marker" || return 1
  first="$(/usr/bin/sed -n '1p' "$marker" 2>/dev/null)" || return 1
  second="$(/usr/bin/sed -n '2p' "$marker" 2>/dev/null)" || return 1
  third="$(/usr/bin/sed -n '3p' "$marker" 2>/dev/null)" || return 1
  lines="$(/usr/bin/wc -l < "$marker" 2>/dev/null | /usr/bin/tr -d '[:space:]')" || return 1
  [ "$first" = 'zerokun-codex-legacy-cutover-v1' ] \
    && [ "$second" = "$physical" ] && [ -z "$third" ] && [ "$lines" = "2" ]
}

watchdog_valid_cutover_state() {
  local state="$1" env_file physical legacy_physical owner
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  owner="$(/usr/bin/stat -f '%u' "$state" 2>/dev/null || true)"
  [ "$owner" = "$(/usr/bin/id -u)" ] || return 1
  env_file="$state/.env"
  watchdog_owned_regular_file "$env_file" && [ -s "$env_file" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' "$env_file" || true)" = "1" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_APP_TOKEN=' "$env_file" || true)" = "1" ] \
    && /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' "$env_file" \
    && /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$' "$env_file" \
    || return 1
  physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  watchdog_valid_cutover_marker_only "$state" && return 0
  [ -d "$HOME/.claude/channels/slack" ] || return 1
  legacy_physical="$(CDPATH='' cd -P -- "$HOME/.claude/channels/slack" 2>/dev/null && pwd -P)" \
    || return 1
  [ "$physical" = "$legacy_physical" ]
}

resolve_state_dir() {
  local selected
  case "${ZEROKUN_LEGACY_CUTOVER:-0}" in
    0) ;;
    1)
      selected="${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}"
      if ! watchdog_valid_cutover_state "$selected"; then
        printf 'zerokun watchdog: legacy cutover state is missing or invalid: %s\n' "$selected" >&2
        return 1
      fi
      printf '%s\n' "$selected"
      return
      ;;
    *)
      printf 'zerokun watchdog: ZEROKUN_LEGACY_CUTOVER must be 0 or 1\n' >&2
      return 1
      ;;
  esac
  if [ -n "${ZEROKUN_STATE_DIR:-}" ]; then
    if watchdog_valid_cutover_marker_only "$ZEROKUN_STATE_DIR" \
      || watchdog_path_selects_legacy "$ZEROKUN_STATE_DIR"; then
      printf '%s\n' "$HOME/.codex/zerokun"
    else
      printf '%s\n' "$ZEROKUN_STATE_DIR"
    fi
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
  local line bot_assignments app_assignments
  [ -f "$STATE_DIR/.env" ] || return 0
  private_regular_file "$STATE_DIR/.env" || {
    printf 'zerokun watchdog: unsafe .env; refusing to read it\n' >&2
    return 1
  }
  bot_assignments="$(/usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' "$STATE_DIR/.env" || true)"
  app_assignments="$(/usr/bin/grep -Ec '^SLACK_APP_TOKEN=' "$STATE_DIR/.env" || true)"
  if [ "$bot_assignments" != "1" ] || [ "$app_assignments" != "1" ]; then
    printf 'zerokun watchdog: .env must contain exactly one Slack Bot/App token pair\n' >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      SLACK_BOT_TOKEN=*)
        WATCHDOG_BOT_TOKEN="${line#SLACK_BOT_TOKEN=}"
        ;;
      SLACK_APP_TOKEN=*)
        WATCHDOG_APP_TOKEN="${line#SLACK_APP_TOKEN=}"
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

load_slack_tokens() {
  if [ -z "$WATCHDOG_BOT_TOKEN" ] || [ -z "$WATCHDOG_APP_TOKEN" ]; then
    load_state_env || return 1
  fi
  export -n WATCHDOG_BOT_TOKEN WATCHDOG_APP_TOKEN 2>/dev/null || true
  case "$WATCHDOG_BOT_TOKEN" in
    ''|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  case "$WATCHDOG_APP_TOKEN" in
    ''|*$'\n'*|*$'\r'*) return 1 ;;
  esac
  printf '%s\n' "$WATCHDOG_BOT_TOKEN" \
    | /usr/bin/grep -Eq '^xoxb-[A-Za-z0-9._-]{10,}$' \
    && printf '%s\n' "$WATCHDOG_APP_TOKEN" \
      | /usr/bin/grep -Eq '^xapp-([0-9]+-)?A[A-Z0-9]+-[A-Za-z0-9._-]{10,}$'
}

verify_slack_app_identity() {
  local expected_app_id auth_response identity bot_app_id bot_id bots_response
  if [[ ! "$WATCHDOG_APP_TOKEN" =~ ^xapp-([0-9]+-)?(A[A-Z0-9]+)-[A-Za-z0-9._-]{10,}$ ]]; then
    printf 'zerokun watchdog: SLACK_APP_TOKEN does not contain a valid Slack App ID\n' >&2
    return 1
  fi
  expected_app_id="${BASH_REMATCH[2]}"
  auth_response="$(printf 'Authorization: Bearer %s\n' "$WATCHDOG_BOT_TOKEN" \
    | "$CURL_BIN" -q -sS --proxy '' --noproxy '*' --max-time 10 \
      -X POST 'https://slack.com/api/auth.test' -H @- 2>/dev/null)" || return 1
  identity="$(printf '%s' "$auth_response" | /usr/bin/python3 -c \
    'import json,sys; d=json.load(sys.stdin); print("%s|%s" % (d.get("app_id",""), d.get("bot_id","")) if d.get("ok") else "|", end="")' \
    2>/dev/null)" || return 1
  IFS='|' read -r bot_app_id bot_id <<< "$identity"
  if [ -z "$bot_app_id" ] && [ -n "$bot_id" ]; then
    bots_response="$(printf 'Authorization: Bearer %s\n' "$WATCHDOG_BOT_TOKEN" \
      | "$CURL_BIN" -q -sS --proxy '' --noproxy '*' --max-time 10 \
        -X POST 'https://slack.com/api/bots.info' -H @- \
        --data-urlencode "bot=$bot_id" 2>/dev/null)" || return 1
    bot_app_id="$(printf '%s' "$bots_response" | /usr/bin/python3 -c \
      'import json,sys; d=json.load(sys.stdin); print(d.get("bot",{}).get("app_id","") if d.get("ok") else "", end="")' \
      2>/dev/null)" || return 1
  fi
  if [ -z "$bot_app_id" ] || [ "$bot_app_id" != "$expected_app_id" ]; then
    printf 'zerokun watchdog: Slack Bot/App token identity mismatch; notification suppressed\n' >&2
    return 1
  fi
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
  load_slack_tokens || { printf 'zerokun watchdog: Slack Bot/App tokens are unavailable\n' >&2; return 1; }
  verify_slack_app_identity || return 1
  notify_user="$(notification_user)"
  [ -n "$notify_user" ] || { printf 'zerokun watchdog: notification user is unavailable\n' >&2; return 1; }

  open_response="$(printf 'Authorization: Bearer %s\n' "$WATCHDOG_BOT_TOKEN" \
    | "$CURL_BIN" -q -sS --proxy '' --noproxy '*' --max-time 10 \
    -X POST 'https://slack.com/api/conversations.open' \
    -H @- \
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
  post_response="$(printf 'Authorization: Bearer %s\n' "$WATCHDOG_BOT_TOKEN" \
    | "$CURL_BIN" -q -sS --proxy '' --noproxy '*' --max-time 10 \
    -X POST 'https://slack.com/api/chat.postMessage' \
    -H @- \
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
        alert = "✅ Zeroちゃんが復旧しました。"
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
        since = dt.datetime.fromtimestamp(down_since).strftime("%H:%M")
        alert = (
            f"🚨 Zeroちゃんが停止しています。{since}から応答できていません。"
            "復旧するには、Macの端末で zerochan --restart を実行してください。"
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
  STATE_DIR="$(resolve_state_dir)" || return 1
  STATE_FILE="$STATE_DIR/watchdog-state.json"
  prepare_state_dir || return 1
  if [ -e "$STATE_FILE" ] && ! private_regular_file "$STATE_FILE"; then
    printf 'zerokun watchdog: unsafe state file; refusing to read it\n' >&2
    return 1
  fi
  load_state_env || return 1
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

selftest_environment() {
  local name
  load_slack_tokens || selftest_fail 'token unavailable' || return 1
  if /usr/bin/env | /usr/bin/grep -Eq '^WATCHDOG_(BOT|APP)_TOKEN='; then
    selftest_fail 'token inherited by child environment'
    return 1
  fi
  for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
    http_proxy https_proxy all_proxy no_proxy CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR; do
    if /usr/bin/env | /usr/bin/grep -q "^${name}="; then
      selftest_fail "network override inherited by child environment: ${name}"
      return 1
    fi
  done
  printf 'watchdog environment selftest: PASS state=%s\n' "$STATE_DIR"
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

  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'healthy alert' || return 1
  printf 'ok: healthy sends nothing\n'

  rm -f "$test_dir/plugin.lock"
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'first down alert' || return 1
  printf '%s\n' "$server_pid" > "$test_dir/plugin.lock"
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'transient recovery alert' || return 1
  printf 'ok: transient down sends nothing\n'

  rm -f "$test_dir/plugin.lock"
  ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH" >/dev/null
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'🚨 Zeroちゃんが停止しています'* ]] || selftest_fail 'second down did not alert' || return 1
  printf 'ok: second down sends alert\n'

  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
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
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'🚨 Zeroちゃんが停止しています'* ]] || selftest_fail 'late reminder missing' || return 1
  printf 'ok: reminder is sent after interval\n'

  printf '%s\n' "$server_pid" > "$test_dir/plugin.lock"
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" == *'✅ Zeroちゃんが復旧しました。'* ]] || selftest_fail 'recovery missing' || return 1
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'duplicate recovery' || return 1
  printf 'ok: recovery sends once\n'

  touch "$test_dir/watchdog-off"
  rm -f "$test_dir/plugin.lock"
  output="$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  output="$output$(ZEROKUN_STATE_DIR="$test_dir" DRY_RUN=1 /bin/bash "$SCRIPT_PATH")"
  [[ "$output" != *'DRY_RUN notification:'* ]] || selftest_fail 'mute alert' || return 1
  printf 'ok: watchdog-off mutes notifications\n'
  printf 'watchdog selftest: PASS\n'
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

if [ "${1:-}" = "--selftest-environment" ]; then
  STATE_DIR="$(resolve_state_dir)" || exit 1
  prepare_state_dir || exit 1
  selftest_environment
  exit $?
fi

if [ "${1:-}" = "--test-notification" ]; then
  STATE_DIR="$(resolve_state_dir)" || exit 1
  prepare_state_dir || exit 1
  load_state_env
  if send_notification '🧪 Zeroちゃんwatchdog通知テスト（実装確認のための1通です）'; then
    printf 'zerokun watchdog: test notification sent\n'
    exit 0
  fi
  exit 1
fi

if [ "${1:-}" = "--selftest-notification" ]; then
  STATE_DIR="$(resolve_state_dir)" || exit 1
  prepare_state_dir || exit 1
  CURL_BIN="${ZEROKUN_WATCHDOG_TEST_CURL:-}"
  if ! private_regular_file "$CURL_BIN" || [ ! -x "$CURL_BIN" ]; then
    printf 'zerokun watchdog: invalid selftest curl helper\n' >&2
    exit 1
  fi
  load_state_env || exit 1
  send_notification 'watchdog identity selftest'
  exit $?
fi

run_watchdog
exit $?
