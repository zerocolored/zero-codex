#!/usr/bin/env bash

zerokun_lexical_path() {
  local input="$1" current rest component
  case "$input" in
    /*) current="/" ;;
    *) current="$PWD" ;;
  esac
  rest="$input"
  while :; do
    case "$rest" in
      */*) component="${rest%%/*}"; rest="${rest#*/}" ;;
      *) component="$rest"; rest="" ;;
    esac
    case "$component" in
      ''|.) ;;
      ..)
        current="${current%/*}"
        [ -n "$current" ] || current="/"
        ;;
      *)
        if [ "$current" = "/" ]; then current="/$component"; else current="$current/$component"; fi
        ;;
    esac
    [ -n "$rest" ] || break
  done
  printf '%s\n' "$current"
}

zerokun_normalize_path() {
  local input="$1" normalized ancestor suffix component physical
  if [ -d "$input" ]; then
    physical="$(CDPATH='' cd -P -- "$input" 2>/dev/null && pwd -P)" || physical=""
    if [ -n "$physical" ]; then printf '%s\n' "$physical"; return; fi
  fi
  normalized="$(zerokun_lexical_path "$input")"
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

zerokun_path_selects_legacy() {
  local logical normalized legacy_normalized
  logical="$(zerokun_lexical_path "$1")"
  case "$logical" in
    */.claude/channels/slack) return 0 ;;
  esac
  normalized="$(zerokun_normalize_path "$1")"
  legacy_normalized="$(zerokun_normalize_path "$HOME/.claude/channels/slack")"
  [ "$normalized" != "$legacy_normalized" ] || return 0
  case "$normalized" in
    */.claude/channels/slack) return 0 ;;
    *) return 1 ;;
  esac
}

zerokun_owned_regular_file() {
  local file="$1" metadata
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l' "$file" 2>/dev/null || true)"
  [ "$metadata" = "$(/usr/bin/id -u):1" ]
}

zerokun_valid_slack_environment() {
  local env_file="$1/.env"
  zerokun_owned_regular_file "$env_file" && [ -s "$env_file" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' "$env_file" || true)" = "1" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_APP_TOKEN=' "$env_file" || true)" = "1" ] \
    && /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' "$env_file" \
    && /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$' "$env_file"
}

zerokun_valid_cutover_marker() {
  local state="$1" marker physical first second third lines
  marker="$state/.codex-legacy-cutover"
  zerokun_owned_regular_file "$marker" || return 1
  physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  first="$(/usr/bin/sed -n '1p' "$marker" 2>/dev/null)" || return 1
  second="$(/usr/bin/sed -n '2p' "$marker" 2>/dev/null)" || return 1
  third="$(/usr/bin/sed -n '3p' "$marker" 2>/dev/null)" || return 1
  lines="$(/usr/bin/wc -l < "$marker" 2>/dev/null | /usr/bin/tr -d '[:space:]')" || return 1
  [ "$first" = 'zerokun-codex-legacy-cutover-v1' ] \
    && [ "$second" = "$physical" ] && [ -z "$third" ] && [ "$lines" = "2" ]
}

zerokun_valid_legacy_cutover_state() {
  local state="$1" selected_physical legacy_physical owner
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  owner="$(/usr/bin/stat -f '%u' "$state" 2>/dev/null || true)"
  [ "$owner" = "$(/usr/bin/id -u)" ] || return 1
  zerokun_valid_slack_environment "$state" || return 1
  zerokun_valid_cutover_marker "$state" && return 0
  [ -d "$HOME/.claude/channels/slack" ] || return 1
  selected_physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  legacy_physical="$(CDPATH='' cd -P -- "$HOME/.claude/channels/slack" 2>/dev/null && pwd -P)" \
    || return 1
  [ "$selected_physical" = "$legacy_physical" ]
}

zerokun_resolve_state_dir() {
  case "${ZEROKUN_LEGACY_CUTOVER:-0}" in
    0) ;;
    1)
      local selected="${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}"
      if ! zerokun_valid_legacy_cutover_state "$selected"; then
        printf 'zerokun: legacy cutover state is missing or invalid: %s\n' "$selected" >&2
        return 1
      fi
      printf '%s\n' "$selected"
      return
      ;;
    *)
      printf 'zerokun: ZEROKUN_LEGACY_CUTOVER must be 0 or 1\n' >&2
      return 1
      ;;
  esac
  if [ -n "${ZEROKUN_STATE_DIR:-}" ]; then
    if zerokun_valid_cutover_marker "$ZEROKUN_STATE_DIR" \
      || zerokun_path_selects_legacy "$ZEROKUN_STATE_DIR"; then
      printf '%s\n' "$HOME/.codex/zerokun"
    else
      printf '%s\n' "$ZEROKUN_STATE_DIR"
    fi
  else
    printf '%s\n' "$HOME/.codex/zerokun"
  fi
}

zerokun_resolve_job_db() {
  local state="$1" configured state_physical candidate_logical candidate_parent candidate_name
  local candidate_parent_physical candidate_physical expected sidecar
  state_physical="$(zerokun_normalize_path "$state")" || return 1
  configured="${ZEROKUN_JOB_DB:-$state/jobs.sqlite3}"
  candidate_logical="$(zerokun_lexical_path "$configured")" || return 1
  candidate_parent="${candidate_logical%/*}"
  candidate_name="${candidate_logical##*/}"
  [ -n "$candidate_name" ] || {
    printf 'zerokun: ZEROKUN_JOB_DB must name a file inside selected state: %s\n' "$state" >&2
    return 1
  }
  [ -n "$candidate_parent" ] || candidate_parent="/"
  candidate_parent_physical="$(zerokun_normalize_path "$candidate_parent")" || return 1
  if [ "$candidate_parent_physical" = "/" ]; then
    candidate_physical="/$candidate_name"
  else
    candidate_physical="$candidate_parent_physical/$candidate_name"
  fi
  expected="$state_physical/jobs.sqlite3"
  if [ "$candidate_physical" != "$expected" ]; then
    printf "zerokun: ZEROKUN_JOB_DB must be the selected state's jobs.sqlite3: %s\n" "$state" >&2
    return 1
  fi
  for sidecar in "$candidate_physical" "$candidate_physical-wal" "$candidate_physical-shm"; do
    if [ -e "$sidecar" ] || [ -L "$sidecar" ]; then
      zerokun_owned_regular_file "$sidecar" || {
        printf 'zerokun: unsafe SQLite file: %s\n' "$sidecar" >&2
        return 1
      }
    fi
  done
  printf '%s\n' "$candidate_physical"
}
