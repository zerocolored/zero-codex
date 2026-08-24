#!/usr/bin/env bash

ZEROKUN_MIN_CODEX_VERSION="0.149.0"

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
