#!/usr/bin/env bash

ZEROKUN_MIN_CODEX_VERSION="0.149.0"

zerokun_codex_version() {
  local codex_bin="${ZEROKUN_CODEX_BIN:-codex}"
  "$codex_bin" --version 2>/dev/null \
    | sed -nE 's/^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' \
    | head -n 1
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
  local codex_bin="${ZEROKUN_CODEX_BIN:-codex}"
  command -v "$codex_bin" >/dev/null 2>&1 || {
    echo "❌ Codex CLI が見つかりません。" >&2
    return 1
  }
  local actual
  actual="$(zerokun_codex_version)"
  if [ -z "$actual" ] || ! zerokun_version_at_least "$actual" "$ZEROKUN_MIN_CODEX_VERSION"; then
    echo "❌ Codex CLI ${ZEROKUN_MIN_CODEX_VERSION} 以上が必要です（検出: ${actual:-不明}）。" >&2
    echo "   このrepositoryで bash zerokun/bootstrap-macos.sh --skip-slack を実行してください。" >&2
    return 1
  fi
}
