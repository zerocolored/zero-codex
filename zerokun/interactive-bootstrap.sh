#!/usr/bin/env bash
# Open the complete bootstrap in a user-visible Terminal without putting Slack
# tokens in Codex tool input, argv, environment variables, or ordinary logs.
set -euo pipefail

usage() {
  echo 'usage: bash zerokun/interactive-bootstrap.sh <bootstrap-macos.sh arguments...>'
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
[ "$#" -gt 0 ] || { usage >&2; exit 2; }
[ "$(uname -s)" = "Darwin" ] || { echo '❌ このlauncherはmacOS専用です。' >&2; exit 1; }

SCRIPT_DIR="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap-macos.sh"
[ -f "$BOOTSTRAP" ] && [ ! -L "$BOOTSTRAP" ] \
  || { echo '❌ bootstrap-macos.shを確認できません。' >&2; exit 1; }
[ "$(/usr/bin/stat -f '%u:%l' "$BOOTSTRAP" 2>/dev/null)" = "$(/usr/bin/id -u):1" ] \
  || { echo '❌ bootstrap-macos.shの所有状態が不正です。' >&2; exit 1; }

for argument in "$@"; do
  case "$argument" in
    *$'\n'*|*$'\r'*) echo '❌ bootstrap引数に改行は使えません。' >&2; exit 2 ;;
  esac
done

RUN_ROOT="$(/usr/bin/mktemp -d /tmp/zerochan-interactive-setup.XXXXXX)" \
  || { echo '❌ 対話セットアップ用directoryを作成できません。' >&2; exit 1; }
/bin/chmod 0700 "$RUN_ROOT"
RUNNER="$RUN_ROOT/run.sh"
ARGUMENTS="$RUN_ROOT/arguments"
APPLE_SCRIPT="$RUN_ROOT/open-terminal.applescript"
RECEIPT="$RUN_ROOT/result"
LAUNCHED=0
COMPLETED=0

cleanup() {
  if [ "$LAUNCHED" = "0" ] || [ "$COMPLETED" = "1" ]; then
    /bin/rm -rf -- "$RUN_ROOT"
  fi
}
trap cleanup EXIT

# NUL framing preserves spaces and shell metacharacters without evaluating
# them as code in the visible Terminal process.
{
  /usr/bin/printf '%s\0' "$BOOTSTRAP"
  /usr/bin/printf '%s\0' "$@"
} > "$ARGUMENTS"
/bin/chmod 0600 "$ARGUMENTS"

/bin/cat > "$RUNNER" <<'RUNNER'
#!/bin/bash
set +e
umask 077
run_root="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1
values=()
while IFS= read -r -d '' value; do values+=("$value"); done < "$run_root/arguments"
[ "${#values[@]}" -ge 2 ] || exit 2
bootstrap="${values[0]}"
/bin/bash "$bootstrap" "${values[@]:1}"
status=$?
temporary="$run_root/result.$$.tmp"
/usr/bin/printf '%s\n' "$status" > "$temporary"
/bin/chmod 0600 "$temporary"
/bin/mv -f -- "$temporary" "$run_root/result"
if [ "$status" -eq 0 ]; then
  /usr/bin/printf '\n✅ Zeroちゃんの対話セットアップが完了しました。このwindowは閉じて構いません。\n'
else
  /usr/bin/printf '\n❌ セットアップが終了コード %s で停止しました。上の案内に従い、必要な認証後にCodexへ再開を伝えてください。\n' "$status"
fi
exit "$status"
RUNNER
/bin/chmod 0700 "$RUNNER"

/bin/cat > "$APPLE_SCRIPT" <<'APPLESCRIPT'
on run argv
  set runnerPath to item 1 of argv
  tell application "Terminal"
    activate
    do script "/bin/bash " & quoted form of runnerPath
  end tell
end run
APPLESCRIPT
/bin/chmod 0600 "$APPLE_SCRIPT"

echo '🔐 対話入力用のTerminalを開きます。認証とtoken入力は、そのwindowで行ってください。'
if ! /usr/bin/osascript "$APPLE_SCRIPT" "$RUNNER" >/dev/null; then
  echo '❌ 対話入力用Terminalを開けませんでした。' >&2
  exit 1
fi
LAUNCHED=1

deadline=$((SECONDS + 21600))
while [ ! -f "$RECEIPT" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "❌ 対話セットアップが6時間以内に完了しませんでした。Terminalの処理は継続しています: $RUN_ROOT" >&2
    exit 1
  fi
  /bin/sleep 1
done

[ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] \
  && [ "$(/usr/bin/stat -f '%u:%l:%Lp' "$RECEIPT" 2>/dev/null)" = "$(/usr/bin/id -u):1:600" ] \
  || { echo '❌ 対話セットアップの完了receiptが不正です。' >&2; exit 1; }
status="$(/bin/cat "$RECEIPT")"
case "$status" in ''|*[!0-9]*) echo '❌ 対話セットアップの終了状態が不正です。' >&2; exit 1 ;; esac
[ "$status" -le 255 ] || { echo '❌ 対話セットアップの終了状態が不正です。' >&2; exit 1; }
COMPLETED=1
exit "$status"
