#!/usr/bin/env bash

ZEROKUN_MIN_CODEX_VERSION="0.149.0"
ZEROKUN_MIN_HERDR_VERSION="0.8.2"

zerokun_codex_version() {
  local repo_dir="$1"
  bun --config=/dev/null --no-env-file \
    "$repo_dir/zerokun/standalone-codex.ts" version 2>/dev/null
}

zerokun_version_at_least() {
  local actual="$1" minimum="$2" component actual_part minimum_part
  for component in 1 2 3; do
    actual_part="$(printf '%s' "$actual" | cut -d. -f"$component")"
    minimum_part="$(printf '%s' "$minimum" | cut -d. -f"$component")"
    case "$actual_part" in ''|*[!0-9]*) return 1 ;; esac
    case "$minimum_part" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$actual_part" -gt "$minimum_part" ]; then return 0; fi
    if [ "$actual_part" -lt "$minimum_part" ]; then return 1; fi
  done
  return 0
}

zerokun_herdr_version() {
  local binary="${1:-herdr}"
  zerokun_herdr_probe "$binary" --version 2>/dev/null \
    | /usr/bin/sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
    | /usr/bin/head -n 1
}

zerokun_herdr_probe() {
  /usr/bin/perl -e '
    $seconds = shift @ARGV;
    $SIG{ALRM} = sub { exit 124 };
    alarm $seconds;
    exec @ARGV;
    exit 127;
  ' 5 "$@"
}

zerokun_resolve_herdr_binary() {
  local binary
  if [ -n "${HERDR_BIN_PATH:-}" ]; then
    binary="$HERDR_BIN_PATH"
    case "$binary" in /*) ;; *) return 1 ;; esac
    [ -f "$binary" ] && [ -x "$binary" ] || return 1
  else
    binary="$(command -v herdr 2>/dev/null)" || return 1
    case "$binary" in /*) ;; *) return 1 ;; esac
    [ -f "$binary" ] && [ -x "$binary" ] || return 1
  fi
  printf '%s\n' "$binary"
}

zerokun_herdr_capabilities_ready() {
  local binary="${1:-herdr}" help
  help="$(zerokun_herdr_probe "$binary" pane current --help 2>&1)" || return 1
  case "$help" in *'--current'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" tab create --help 2>&1)" || return 1
  case "$help" in
    *'--workspace'*'--cwd'*'--label'*'--no-focus'*) ;;
    *) return 1 ;;
  esac
  help="$(zerokun_herdr_probe "$binary" workspace list --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr workspace list'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" tab list --help 2>&1)" || return 1
  case "$help" in *'--workspace'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" pane list --help 2>&1)" || return 1
  case "$help" in *'--workspace'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" pane run --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr pane run'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" pane wait-output --help 2>&1)" || return 1
  case "$help" in
    *'--match'*'--source'*'--lines'*'--timeout'*) ;;
    *) return 1 ;;
  esac
  help="$(zerokun_herdr_probe "$binary" pane process-info --help 2>&1)" || return 1
  case "$help" in *'--pane'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" tab close --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr tab close'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" agent list --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr agent list'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" agent get --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr agent get'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" agent read --help 2>&1)" || return 1
  case "$help" in *'--source'*'--lines'*) ;; *) return 1 ;; esac
  help="$(zerokun_herdr_probe "$binary" agent prompt --help 2>&1)" || return 1
  case "$help" in *'--wait'*'--until'*'--timeout'*) ;; *) return 1 ;; esac
}

zerokun_require_herdr_version() {
  local binary actual
  binary="$(zerokun_resolve_herdr_binary)" || {
    echo "❌ Herdr ${ZEROKUN_MIN_HERDR_VERSION} 以上が必要です（検出: 未導入）。" >&2
    echo "   このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  }
  actual="$(zerokun_herdr_version "$binary")"
  if [ -z "$actual" ] || ! zerokun_version_at_least "$actual" "$ZEROKUN_MIN_HERDR_VERSION"; then
    echo "❌ Herdr ${ZEROKUN_MIN_HERDR_VERSION} 以上が必要です（検出: ${actual:-不明}）。" >&2
    echo "   このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  fi
  if ! zerokun_herdr_capabilities_ready "$binary"; then
    echo "❌ Herdr ${actual} にZeroちゃんが必要とするtab/pane APIがありません。" >&2
    echo "   このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  fi
}

zerokun_require_codex_version() {
  local repo_dir="${1:-}"
  if [[ -n "${ZEROKUN_CODEX_BIN+x}" ]]; then
    echo "❌ ZEROKUN_CODEX_BIN はSlack runtimeでは利用できません。" >&2
    echo "   .envから削除し、このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  fi
  [[ -n "$repo_dir" ]] && [[ -f "$repo_dir/zerokun/standalone-codex.ts" ]] || {
    echo "❌ Codex runtime verifierを解決できません。" >&2
    return 1
  }
  local actual
  actual="$(zerokun_codex_version "$repo_dir")"
  if [ -z "$actual" ] || ! zerokun_version_at_least "$actual" "$ZEROKUN_MIN_CODEX_VERSION"; then
    echo "❌ Codex CLI ${ZEROKUN_MIN_CODEX_VERSION} 以上が必要です（検出: ${actual:-不明}）。" >&2
    echo "   このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  fi
}
