#!/usr/bin/env bash
# Fresh macOS -> Zeroちゃん bootstrap.
# This file can be copied to a new Mac and run before any project repository exists.
set -euo pipefail
unset BUN_OPTIONS BUN_CONFIG_PRELOAD NODE_OPTIONS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$HOME/Desktop/Project/zero-codex"
if [ -d "$SCRIPT_DIR/../.git" ] && [ -f "$SCRIPT_DIR/../server.ts" ]; then
  DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

REPO_DIR="${ZEROKUN_REPO_DIR:-$DEFAULT_REPO_DIR}"
PROJECT_DIR="${ZEROKUN_PROJECT_DIR:-$(dirname "$REPO_DIR")/zerokun-workspace}"

bootstrap_lexical_path() {
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

bootstrap_normalize_path() {
  local input="$1" normalized ancestor suffix component physical
  if [ -d "$input" ]; then
    physical="$(CDPATH='' cd -P -- "$input" 2>/dev/null && pwd -P)" || physical=""
    if [ -n "$physical" ]; then printf '%s\n' "$physical"; return; fi
  fi
  normalized="$(bootstrap_lexical_path "$input")"
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

bootstrap_path_selects_legacy() {
  local logical physical legacy_physical
  logical="$(bootstrap_lexical_path "$1")"
  case "$logical" in */.claude/channels/slack) return 0 ;; esac
  physical="$(bootstrap_normalize_path "$1")"
  legacy_physical="$(bootstrap_normalize_path "$HOME/.claude/channels/slack")"
  [ "$physical" != "$legacy_physical" ] || return 0
  case "$physical" in */.claude/channels/slack) return 0 ;; esac
  return 1
}

bootstrap_owned_regular_file() {
  local file="$1" metadata
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l' "$file" 2>/dev/null || true)"
  [ "$metadata" = "$(/usr/bin/id -u):1" ]
}

bootstrap_valid_cutover_marker_only() {
  local state="$1" marker physical first second third lines
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  marker="$state/.codex-legacy-cutover"
  bootstrap_owned_regular_file "$marker" || return 1
  first="$(/usr/bin/sed -n '1p' "$marker" 2>/dev/null)" || return 1
  second="$(/usr/bin/sed -n '2p' "$marker" 2>/dev/null)" || return 1
  third="$(/usr/bin/sed -n '3p' "$marker" 2>/dev/null)" || return 1
  lines="$(/usr/bin/wc -l < "$marker" 2>/dev/null | /usr/bin/tr -d '[:space:]')" || return 1
  [ "$first" = 'zerokun-codex-legacy-cutover-v1' ] \
    && [ "$second" = "$physical" ] && [ -z "$third" ] && [ "$lines" = "2" ]
}

bootstrap_valid_cutover_state() {
  local state="$1" env_file physical legacy_physical owner
  [ -d "$state" ] && [ ! -L "$state" ] || return 1
  owner="$(/usr/bin/stat -f '%u' "$state" 2>/dev/null || true)"
  [ "$owner" = "$(/usr/bin/id -u)" ] || return 1
  env_file="$state/.env"
  bootstrap_owned_regular_file "$env_file" && [ -s "$env_file" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' "$env_file" || true)" = "1" ] \
    && [ "$(/usr/bin/grep -Ec '^SLACK_APP_TOKEN=' "$env_file" || true)" = "1" ] \
    && /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' "$env_file" \
    && /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$' "$env_file" \
    || return 1
  physical="$(CDPATH='' cd -P -- "$state" 2>/dev/null && pwd -P)" || return 1
  bootstrap_valid_cutover_marker_only "$state" && return 0
  [ -d "$HOME/.claude/channels/slack" ] || return 1
  legacy_physical="$(CDPATH='' cd -P -- "$HOME/.claude/channels/slack" 2>/dev/null && pwd -P)" \
    || return 1
  [ "$physical" = "$legacy_physical" ]
}

bootstrap_resolve_state_dir() {
  local selected
  case "${ZEROKUN_LEGACY_CUTOVER:-0}" in
    0) ;;
    1)
      selected="${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}"
      bootstrap_valid_cutover_state "$selected" || {
        echo "❌ legacy cutover stateが存在しないか不正です: $selected" >&2
        return 1
      }
      printf '%s\n' "$selected"
      return
      ;;
    *) echo "❌ ZEROKUN_LEGACY_CUTOVERは0または1で指定してください" >&2; return 1 ;;
  esac
  if [ -n "${ZEROKUN_STATE_DIR:-}" ] \
    && ! bootstrap_valid_cutover_marker_only "$ZEROKUN_STATE_DIR" \
    && ! bootstrap_path_selects_legacy "$ZEROKUN_STATE_DIR"; then
    printf '%s\n' "$ZEROKUN_STATE_DIR"
  else
    printf '%s\n' "$HOME/.codex/zerokun"
  fi
}

STATE_DIR=""
MODE="install"
SKIP_SLACK=0
WITH_SLACK=0
SLACK_APP_NAME="${ZEROKUN_SLACK_APP_NAME:-}"
SLACK_BOT_USERNAME="${ZEROKUN_SLACK_BOT_USERNAME:-}"
SLACK_APP_CREATE_URL="https://api.slack.com/apps?new_app=1"
MIN_CODEX_VERSION="0.149.0"
MIN_HERDR_VERSION="0.8.2"

codex_version_number() {
  local binary="${1:-codex}"
  "$binary" --version 2>/dev/null | sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1
}

version_at_least() {
  local actual="$1" minimum="$2" index left right
  for index in 1 2 3; do
    left="$(printf '%s' "$actual" | cut -d. -f"$index")"
    right="$(printf '%s' "$minimum" | cut -d. -f"$index")"
    case "$left" in ''|*[!0-9]*) return 1 ;; esac
    case "$right" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$left" -gt "$right" ]; then return 0; fi
    if [ "$left" -lt "$right" ]; then return 1; fi
  done
  return 0
}

herdr_version_number() {
  local binary="${1:-herdr}"
  herdr_probe "$binary" --version 2>/dev/null \
    | /usr/bin/sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
    | /usr/bin/head -n 1
}

herdr_probe() {
  /usr/bin/perl -e '
    $seconds = shift @ARGV;
    $SIG{ALRM} = sub { exit 124 };
    alarm $seconds;
    exec @ARGV;
    exit 127;
  ' 5 "$@"
}

resolve_herdr_binary() {
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

resolve_claude_binary() {
  local binary resolved
  binary="$(command -v claude 2>/dev/null)" || return 1
  case "$binary" in /*) ;; *) return 1 ;; esac
  [ -f "$binary" ] && [ -x "$binary" ] || return 1
  resolved="$(/usr/bin/perl -MCwd=realpath -e 'print realpath($ARGV[0]) // q{}' "$binary" 2>/dev/null)" || return 1
  [ -f "$resolved" ] && [ -x "$resolved" ] || return 1
  [ "$(/usr/bin/stat -f '%u' "$resolved" 2>/dev/null)" = "$(/usr/bin/id -u)" ] || return 1
  printf '%s\n' "$binary"
}

claude_subscription_ready() {
  local binary binary_dir user_name
  binary="$(resolve_claude_binary)" || return 1
  binary_dir="$(dirname "$binary")"
  user_name="$(/usr/bin/id -un)" || return 1
  /usr/bin/env -i \
    HOME="$HOME" \
    USER="$user_name" \
    LOGNAME="$user_name" \
    SHELL="${SHELL:-/bin/zsh}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    PATH="$binary_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="${LANG:-en_US.UTF-8}" \
    LC_ALL="${LC_ALL:-${LANG:-en_US.UTF-8}}" \
    "$binary" auth status --json 2>/dev/null \
    | /usr/bin/python3 -c '
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
valid = (
    isinstance(value, dict)
    and value.get("loggedIn") is True
    and value.get("authMethod") == "claude.ai"
    and value.get("apiProvider") == "firstParty"
    and isinstance(value.get("subscriptionType"), str)
    and bool(value.get("subscriptionType"))
)
raise SystemExit(0 if valid else 1)
'
}

herdr_capabilities_ready() {
  local binary="${1:-herdr}" help
  help="$(herdr_probe "$binary" pane current --help 2>&1)" || return 1
  case "$help" in *'--current'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" tab create --help 2>&1)" || return 1
  case "$help" in
    *'--workspace'*'--cwd'*'--label'*'--no-focus'*) ;;
    *) return 1 ;;
  esac
  help="$(herdr_probe "$binary" workspace list --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr workspace list'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" workspace create --help 2>&1)" || return 1
  case "$help" in *'--cwd'*'--label'*'--no-focus'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" workspace get --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr workspace get'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" workspace close --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr workspace close'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" tab list --help 2>&1)" || return 1
  case "$help" in *'--workspace'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" pane list --help 2>&1)" || return 1
  case "$help" in *'--workspace'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" pane run --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr pane run'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" pane wait-output --help 2>&1)" || return 1
  case "$help" in
    *'--match'*'--source'*'--lines'*'--timeout'*) ;;
    *) return 1 ;;
  esac
  help="$(herdr_probe "$binary" pane process-info --help 2>&1)" || return 1
  case "$help" in *'--pane'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" pane get --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr pane get'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" tab close --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr tab close'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent list --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr agent list'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent get --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr agent get'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent read --help 2>&1)" || return 1
  case "$help" in *'--source'*'--lines'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent prompt --help 2>&1)" || return 1
  case "$help" in *'--wait'*'--until'*'--timeout'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent start --help 2>&1)" || return 1
  case "$help" in *'--kind'*'--pane'*'--timeout'*) ;; *) return 1 ;; esac
  help="$(herdr_probe "$binary" agent send-keys --help 2>&1)" || return 1
  case "$help" in *'Usage: herdr agent send-keys'*) ;; *) return 1 ;; esac
}

herdr_compatible() {
  local binary actual
  binary="$(resolve_herdr_binary)" || return 1
  actual="$(herdr_version_number "$binary")"
  [ -n "$actual" ] && version_at_least "$actual" "$MIN_HERDR_VERSION" \
    && herdr_capabilities_ready "$binary"
}

usage() {
  cat <<'EOF'
Usage: bootstrap-macos.sh [options]

新しいMacへZeroちゃん一式を導入します。Command Line Toolsはバージョンを固定せず、
そのmacOSにAppleが提供する適合版を `xcode-select --install` で導入します。

Options:
  --doctor              何も変更せず、必要ツールとバージョンだけ確認
  --skip-slack          Slack App作成とトークン入力の案内を省略
  --with-slack          基本セットアップ完了後、そのままSlack設定も行う
  --slack-only          導入済み環境でSlack設定だけを行う
  --slack-app-name NAME Slack上で表示するApp名（35文字以内）
  --slack-bot-name NAME bot username（英小文字・数字・-・_・.のみ）
  --repo-dir PATH       zeroリポの配置先
  --project-dir PATH    Slack DMで扱う既定repository
  -h, --help            このヘルプを表示

通常実行はCodexを使える状態まで完了して終了します。Slack設定は後から
`--slack-only`で行えます。ログインとmacOSの確認ダイアログだけは人の操作が必要です。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    # 後勝ちでモードを上書きすると、--doctor --slack-only が「何も変更しない」と
    # 言いながらHOMEへ書き込む。競合は受け付けずに使い方の誤りとして止める。
    --doctor)
      case "$MODE" in
        install|doctor) MODE="doctor" ;;
        *) echo "❌ --doctor と --slack-only は同時に指定できません" >&2; exit 2 ;;
      esac
      ;;
    --skip-slack) SKIP_SLACK=1; WITH_SLACK=0 ;;
    --with-slack) WITH_SLACK=1 ;;
    --slack-only)
      case "$MODE" in
        install|slack-only) MODE="slack-only"; WITH_SLACK=1 ;;
        *) echo "❌ --doctor と --slack-only は同時に指定できません" >&2; exit 2 ;;
      esac
      ;;
    --slack-app-name)
      [ "$#" -ge 2 ] || { echo "❌ --slack-app-nameには名前が必要です" >&2; exit 2; }
      SLACK_APP_NAME="$2"
      shift
      ;;
    --slack-bot-name)
      [ "$#" -ge 2 ] || { echo "❌ --slack-bot-nameには名前が必要です" >&2; exit 2; }
      SLACK_BOT_USERNAME="$2"
      shift
      ;;
    --repo-dir)
      [ "$#" -ge 2 ] || { echo "❌ --repo-dirにはパスが必要です" >&2; exit 2; }
      REPO_DIR="$2"
      shift
      ;;
    --project-dir)
      [ "$#" -ge 2 ] || { echo "❌ --project-dirにはパスが必要です" >&2; exit 2; }
      PROJECT_DIR="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ 不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "doctor" ]; then
  STATE_DIR="$HOME/.codex/zerokun"
else
  STATE_DIR="$(bootstrap_resolve_state_dir)"
fi

# 導入経路は、これから配置する場所を先にPATHへ足しておく必要がある。
# 診断(--doctor)は「呼び出し元の環境でそのまま使えるか」を答えるものなので、
# 渡されたPATHをそのまま評価する。ここで足し戻すと、PATHから届かないCLIまで
# 「導入済み」と報告してしまう。
if [ "$MODE" != "doctor" ]; then
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
fi

section() { printf '\n▶ %s\n' "$1"; }
ok() { printf '   ✅ %s\n' "$1"; }
warn() { printf '   ⚠️  %s\n' "$1" >&2; }
fail() { printf '❌ %s\n' "$1" >&2; exit 1; }

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || fail "このbootstrapはmacOS専用です"
  case "$(uname -m)" in
    arm64|x86_64) ;;
    *) fail "未対応のMacアーキテクチャです: $(uname -m)" ;;
  esac
}

clt_ready() {
  /usr/bin/xcode-select -p >/dev/null 2>&1 \
    && /usr/bin/xcrun --find clang >/dev/null 2>&1 \
    && /usr/bin/xcrun --find git >/dev/null 2>&1
}

clt_version() {
  local version
  version="$(/usr/sbin/pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null \
    | /usr/bin/awk '/^version:/ {print $2; exit}')"
  if [ -n "$version" ]; then
    printf '%s' "$version"
  else
    /usr/bin/xcode-select -p 2>/dev/null || printf 'unknown'
  fi
}

first_line() {
  "$@" 2>&1 | /usr/bin/head -n 1
}

# バージョンを聞くだけでもCLIはHOME配下を書き換えることがある。
# codexはversion確認だけでも`$CODEX_HOME`へ一時fileを作る。
# --doctor は「何も変更しない」と約束しているので、副作用は呼び出し側で止める。
DOCTOR_TMP=""
DOCTOR_TMP_UNAVAILABLE=0

cleanup_doctor_tmp() {
  [ -n "$DOCTOR_TMP" ] || return 0
  local path="$DOCTOR_TMP"
  # 先に手放してから消す。二重に呼ばれても同じ場所を二度消しにいかない。
  DOCTOR_TMP=""
  # 後始末の失敗で診断の終了値は書き換えないが、黙って残すこともしない。
  /bin/rm -rf "$path" 2>/dev/null \
    || warn "診断用の一時領域を削除できませんでした: $path"
  return 0
}

# 後始末はEXIT trapだけで足りる。bash 3.2では未捕捉のINT/TERM/HUPでもEXIT trapが走ることを
# 実測で確認している。INT/TERM/HUPを捕捉しても後始末の効果は増えない。
# 一方でbashは捕捉したシグナルのハンドラを同期実行中の子の終了まで遅らせるため、
# 子を直接前景で走らせる形にすると停止が遅くなる
# （実測: 子が10秒hangするとTERMでの停止も10秒待たされる。捕捉しなければ即時）。
# 現在のバージョン取得はコマンド置換の中で走るので、いまはどちらでも停止性は変わらない。
# 得るものが無く、書き方次第で損をするだけなので捕捉しない。
finish_doctor_tmp() {
  cleanup_doctor_tmp
  trap - EXIT
}

# 実パスを解決する。CDPATHがexportされていると cd は移動先も標準出力へ書くため、
# 相対パスのTMPDIRで戻り値が2行になる。サブシェルの中でCDPATHを外して捨てる。
resolve_dir() {
  ( CDPATH='' cd -- "$1" >/dev/null 2>&1 && pwd -P ) 2>/dev/null
}

# 退避先の親として信用できるのは次のどちらかだけ。
#   - 自分の持ち物で、他人が書けない（または他人が書けてもstickyで守られている）
#   - rootの持ち物で sticky（/private/tmp）
# 他人が書ける非stickyな場所や、他人が所有する場所は使わない。mktempが作った直後に
# エントリごと差し替えられる余地があり、stickyであっても親の所有者は他人のエントリを
# 動かせるため。判定は必ず物理解決したパスに対して行う（/tmpはsymlink）。
doctor_tmp_parent_is_trusted() {
  local dir="$1"
  local uid perm me shared
  uid="$(/usr/bin/stat -f '%u' "$dir" 2>/dev/null)" || return 1
  perm="$(/usr/bin/stat -f '%Sp' "$dir" 2>/dev/null)" || return 1
  me="$(/usr/bin/id -u 2>/dev/null)" || return 1
  [ "${#perm}" -ge 10 ] || return 1
  # drwxrwxrwt の 5 番目がグループのw、8 番目がその他のw。
  shared=0
  case "${perm:5:1}${perm:8:1}" in
    *w*) shared=1 ;;
  esac
  if [ "$uid" = "$me" ]; then
    [ "$shared" = "0" ] || [ -k "$dir" ] || return 1
    return 0
  fi
  if [ "$uid" = "0" ]; then
    [ -k "$dir" ] || return 1
    return 0
  fi
  return 1
}

# 退避先はHOMEの外にだけ作る。TMPDIRをそのまま信じると、TMPDIRがHOME配下のときに
# 診断がHOMEを書き換えてしまう。候補は順に試し、実際に作れたものを採用する。
ensure_doctor_tmp() {
  [ -z "$DOCTOR_TMP" ] || return 0
  local candidate resolved home_resolved created
  home_resolved=""
  if [ -n "${HOME:-}" ]; then
    home_resolved="$(resolve_dir "$HOME")" || home_resolved=""
    # HOMEが / なら「HOMEの外」はどこにも無い。退避先は作らない。
    if [ "$home_resolved" = "/" ]; then
      DOCTOR_TMP_UNAVAILABLE=1
      return 1
    fi
  fi
  for candidate in "${TMPDIR:-}" /tmp; do
    [ -n "$candidate" ] || continue
    [ -d "$candidate" ] && [ -w "$candidate" ] || continue
    resolved="$(resolve_dir "$candidate")" || continue
    [ -n "$resolved" ] || continue
    doctor_tmp_parent_is_trusted "$resolved" || continue
    if [ -n "$home_resolved" ]; then
      case "$resolved/" in
        "$home_resolved"/*) continue ;;
      esac
    fi
    # 判定を通っても、quota・inode枯渇・直前の権限変更で実際の作成は失敗しうる。
    # そのときは黙って諦めず、次の候補へ落とす。
    created="$(/usr/bin/mktemp -d "$resolved/zerokun-doctor.XXXXXX" 2>/dev/null)" || continue
    trap cleanup_doctor_tmp EXIT
    DOCTOR_TMP="$created"
    # 作った直後に別物へ差し替えられていないか確かめる。
    if [ -L "$DOCTOR_TMP" ] || [ ! -d "$DOCTOR_TMP" ] || [ ! -O "$DOCTOR_TMP" ]; then
      cleanup_doctor_tmp
      continue
    fi
    # CODEX_HOMEには実在するディレクトリを渡す。存在しないパスを渡すと
    # 「作れないが続行する」というcodex側の未仕様の寛容さに寄りかかることになり、
    # そこが厳格化された版では診断が落ちて自己更新が止まる。
    # -p は付けない。先にsymlinkを置かれていた場合、追わずに失敗させる。
    if /bin/mkdir "$DOCTOR_TMP/codex" "$DOCTOR_TMP/grok" 2>/dev/null; then
      return 0
    fi
    cleanup_doctor_tmp
  done
  DOCTOR_TMP_UNAVAILABLE=1
  return 1
}

doctor_item() {
  local label="$1"
  local command_name="$2"
  shift 2
  local version
  local status=0

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '   %-20s %s\n' "$label:" '未導入'
    return 1
  fi

  # 下の環境変数はバージョン取得のときだけ効かせる。認証状態を見る診断へ流用すると
  # 実環境ではなく退避先を診断してしまうので、コマンド名だけでなく引数でも限定する。
  local suppress='none'
  case "${1:-}" in
    --version|-V|-v|version)
      case "$command_name" in
        codex) suppress='codex' ;;
      esac
      ;;
  esac

  case "$suppress" in
    codex)
      if ! ensure_doctor_tmp; then
        printf '   %-20s %s\n' "$label:" '一時領域を確保できず未診断'
        return 1
      fi
      version="$(CODEX_HOME="$DOCTOR_TMP/codex" "$command_name" "$@" 2>/dev/null)" || status=$?
      ;;
    *)
      version="$("$command_name" "$@" 2>/dev/null)" || status=$?
      ;;
  esac

  # 以前はstderrを混ぜて先頭行を表示していたため、バージョン取得自体が失敗しても
  # 警告文をバージョンとして表示し、診断は成功扱いになっていた。
  if [ "$status" != "0" ]; then
    printf '   %-20s %s\n' "$label:" '実行失敗'
    return 1
  fi
  version="${version%%$'\n'*}"
  if [ -z "$version" ]; then
    printf '   %-20s %s\n' "$label:" 'バージョン不明'
    return 1
  fi
  printf '   %-20s %s\n' "$label:" "$version"
}

grok_build_executable() {
  [ -x /usr/bin/python3 ] || return 1
  /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin TMPDIR=/tmp \
    /usr/bin/python3 -I -B -c '
import os
import re
import stat
import subprocess
import sys

home = os.path.realpath(sys.argv[1])
uid = os.getuid()
logical = os.path.join(home, ".grok", "bin", "grok")

def same(left, right):
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    return all(getattr(left, field) == getattr(right, field) for field in fields)

def safe_dir(path):
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != uid or metadata.st_mode & 0o022:
        raise SystemExit(1)

def safe_file(path):
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or before.st_uid != uid or before.st_nlink != 1 or before.st_mode & 0o022 or not before.st_mode & 0o111 or not 0 < before.st_size <= 1024 * 1024 * 1024:
        raise SystemExit(1)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if not same(before, opened):
        raise SystemExit(1)

safe_dir(home)
safe_dir(os.path.join(home, ".grok"))
bin_dir = os.path.join(home, ".grok", "bin")
safe_dir(bin_dir)
before = os.lstat(logical)
if stat.S_ISREG(before.st_mode):
    target = logical
elif stat.S_ISLNK(before.st_mode) and before.st_uid == uid and before.st_nlink == 1 and 0 < before.st_size <= 255:
    raw = os.readlink(logical)
    after = os.lstat(logical)
    if not same(before, after):
        raise SystemExit(1)
    if re.fullmatch(r"grok-[0-9]+\.[0-9]+\.[0-9]+", raw):
        target = os.path.join(bin_dir, raw)
    else:
        machine = os.uname().machine
        if machine == "x86_64":
            try:
                translated = subprocess.run(["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"], check=False, capture_output=True, timeout=2)
                if translated.returncode == 0 and translated.stdout.strip() == b"1":
                    machine = "arm64"
            except (OSError, subprocess.SubprocessError):
                pass
        expected = "../downloads/grok-macos-aarch64" if machine == "arm64" else "../downloads/grok-macos-x86_64" if machine == "x86_64" else None
        if expected is None or raw != expected:
            raise SystemExit(1)
        downloads = os.path.join(home, ".grok", "downloads")
        safe_dir(downloads)
        target = os.path.join(downloads, os.path.basename(raw))
else:
    raise SystemExit(1)
safe_file(target)
print(target)
' "$HOME" 2>/dev/null
}

grok_auth_ready() {
  local auth="$HOME/.grok/auth.json" metadata uid links mode size type
  [ -f "$auth" ] && [ ! -L "$auth" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l:%Lp:%z:%HT' "$auth" 2>/dev/null)" || return 1
  IFS=: read -r uid links mode size type <<EOF
$metadata
EOF
  [ "$type" = "Regular File" ] && [ "$uid" = "$(/usr/bin/id -u)" ] \
    && [ "$links" = "1" ] || return 1
  case "$mode:$size" in *[!0-9:]*|:*) return 1 ;; esac
  [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] \
    && [ $((8#$mode & 8#077)) -eq 0 ] && [ $((8#$mode & 8#400)) -ne 0 ]
}

grok_reviewer_file_ready() {
  local file="$1" access="$2" metadata uid links mode size type
  [ -f "$file" ] && [ ! -L "$file" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%l:%Lp:%z:%HT' "$file" 2>/dev/null)" || return 1
  IFS=: read -r uid links mode size type <<EOF
$metadata
EOF
  [ "$type" = "Regular File" ] && [ "$uid" = "$(/usr/bin/id -u)" ] \
    && [ "$links" = "1" ] || return 1
  case "$mode:$size" in *[!0-9:]*|:*) return 1 ;; esac
  [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] || return 1
  case "$access" in
    executable) [ $((8#$mode & 8#111)) -ne 0 ] && [ $((8#$mode & 8#022)) -eq 0 ] ;;
    private) [ $((8#$mode & 8#077)) -eq 0 ] ;;
    *) return 1 ;;
  esac
}

grok_reviewer_directory_ready() {
  local directory="$1" metadata uid mode type
  [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
  metadata="$(/usr/bin/stat -f '%u:%Lp:%HT' "$directory" 2>/dev/null)" || return 1
  IFS=: read -r uid mode type <<EOF
$metadata
EOF
  [ "$type" = "Directory" ] && [ "$uid" = "$(/usr/bin/id -u)" ] || return 1
  case "$mode" in ''|*[!0-7]*) return 1 ;; esac
  [ $((8#$mode & 8#077)) -eq 0 ]
}

grok_reviewer_ready() {
  local root="$HOME/.grok-reviewer"
  grok_build_executable >/dev/null && grok_auth_ready \
    && grok_reviewer_directory_ready "$root" \
    && grok_reviewer_directory_ready "$root/bin" \
    && grok_reviewer_file_ready "$root/bin/grok" executable \
    && grok_reviewer_file_ready "$root/bin/reviewer-runtime.py" executable \
    && grok_reviewer_file_ready "$root/config.toml" private \
    && grok_reviewer_file_ready "$root/sandbox.toml" private \
    && grok_reviewer_file_ready "$root/requirements.toml" private
}

# 戻り値: 0=問題なし / 1=CLIに問題あり / 2=退避先を作れずCodexだけ未診断
run_doctor() {
  local missing=0
  local tmp_skipped=0
  DOCTOR_TMP_UNAVAILABLE=0
  section "セットアップ診断（変更は行いません）"
  if clt_ready; then
    printf '   %-20s %s\n' 'Command Line Tools:' "$(clt_version)"
  else
    printf '   %-20s %s\n' 'Command Line Tools:' '未導入'
    missing=1
  fi
  doctor_item 'Homebrew' brew --version || missing=1
  doctor_item 'Git' git --version || missing=1
  doctor_item 'tmux' tmux -V || missing=1
  local herdr_binary herdr_version
  herdr_binary="$(resolve_herdr_binary 2>/dev/null || true)"
  herdr_version="$(herdr_version_number "${herdr_binary:-herdr}" || true)"
  if [ -n "$herdr_binary" ] && [ -n "$herdr_version" ] \
    && version_at_least "$herdr_version" "$MIN_HERDR_VERSION" \
    && herdr_capabilities_ready "$herdr_binary"; then
    printf '   %-20s %s\n' 'Herdr:' "herdr $herdr_version"
  elif [ -n "$herdr_binary" ] && [ -n "$herdr_version" ]; then
    printf '   %-20s %s\n' 'Herdr:' \
      "herdr $herdr_version (${MIN_HERDR_VERSION}以上とworkspace/tab/pane/agent APIが必要)"
    missing=1
  else
    printf '   %-20s %s\n' 'Herdr:' '未導入または実行失敗'
    missing=1
  fi
  doctor_item 'Bun' bun --version || missing=1
  local grok_executable grok_version grok_status=0
  grok_executable="$(grok_build_executable)" || grok_executable=""
  if [ -n "$grok_executable" ] && ensure_doctor_tmp; then
    grok_version="$(/usr/bin/env -i HOME="$DOCTOR_TMP/grok" GROK_HOME="$DOCTOR_TMP/grok" \
      PATH=/usr/bin:/bin TERM=dumb TMPDIR="${TMPDIR:-/tmp}" \
      "$grok_executable" --version 2>/dev/null)" || grok_status=$?
    grok_version="${grok_version%%$'\n'*}"
    if [ "$grok_status" = "0" ] && [ -n "$grok_version" ]; then
      printf '   %-20s %s\n' 'Grok Build:' "$grok_version"
    else
      printf '   %-20s %s\n' 'Grok Build:' '実行失敗'
      missing=1
    fi
  elif [ -z "$grok_executable" ]; then
    printf '   %-20s %s\n' 'Grok Build:' '未導入またはunsafe'
    missing=1
  else
    printf '   %-20s %s\n' 'Grok Build:' '一時領域を確保できず未診断'
    tmp_skipped=1
  fi
  if grok_auth_ready; then
    printf '   %-20s %s\n' 'Grok login:' 'ready (owner-only auth)'
  else
    printf '   %-20s %s\n' 'Grok login:' '未ログインまたはunsafe'
    missing=1
  fi
  if grok_reviewer_ready; then
    printf '   %-20s %s\n' 'Grok reviewer:' 'ready (read-only検査)'
  else
    printf '   %-20s %s\n' 'Grok reviewer:' "$HOME/.grok-reviewer/bin/grok が未導入またはunsafe"
    missing=1
  fi
  if ! doctor_item 'Codex CLI' codex --version; then
    # 退避先を作れずに見送っただけなら、CLI自体の異常とは区別する。
    if [ "$DOCTOR_TMP_UNAVAILABLE" = "1" ]; then
      tmp_skipped=1
    else
      missing=1
    fi
  fi
  # 診断が終わった時点で退避先を消し、trapも外す。後続の処理へ持ち越さない。
  finish_doctor_tmp
  [ "$missing" = "0" ] || return 1
  [ "$tmp_skipped" = "0" ] || return 2
  return 0
}

require_interactive() {
  [ -t 0 ] && [ -t 1 ] || fail "$1には対話可能なターミナルが必要です"
}

install_clt() {
  section "Apple Command Line Tools"
  if clt_ready; then
    ok "導入済み: $(clt_version)"
    return
  fi

  require_interactive "Command Line Toolsのインストール"
  echo "   バージョン選択は不要です。表示されるmacOSダイアログで『インストール』を押してください。"
  /usr/bin/xcode-select --install >/dev/null 2>&1 || true
  echo "   完了を待っています（中止は Ctrl-C）..."
  local attempts=0
  while ! clt_ready; do
    /bin/sleep 5
    attempts=$((attempts + 1))
    [ "$attempts" -lt 360 ] || fail "30分以内にCommand Line Toolsを確認できませんでした。完了後に再実行してください"
  done
  ok "導入完了: $(clt_version)"
}

load_brew() {
  local brew_bin=""
  if command -v brew >/dev/null 2>&1; then
    brew_bin="$(command -v brew)"
  elif [ -x /opt/homebrew/bin/brew ]; then
    brew_bin=/opt/homebrew/bin/brew
  elif [ -x /usr/local/bin/brew ]; then
    brew_bin=/usr/local/bin/brew
  fi
  [ -n "$brew_bin" ] || return 1
  eval "$("$brew_bin" shellenv)"
}

append_profile_block() {
  local marker="$1" content="$2" profile="$HOME/.zprofile"
  if /usr/bin/grep -Fq "$marker" "$profile" 2>/dev/null; then return 0; fi
  if [ -L "$profile" ]; then fail ".zprofile symlinkは安全のため変更しません: $profile"; fi
  local mode=600
  if [ -e "$profile" ]; then
    [ -f "$profile" ] || fail ".zprofileがregular fileではありません: $profile"
    [ "$(/usr/bin/stat -f '%u' "$profile")" = "$(/usr/bin/id -u)" ] \
      || fail ".zprofileの所有者が現在のuserではありません: $profile"
    [ "$(/usr/bin/stat -f '%l' "$profile")" = "1" ] \
      || fail ".zprofile hardlinkは安全のため変更しません: $profile"
    mode="$(/usr/bin/stat -f '%Lp' "$profile")"
  fi
  local temp_file
  temp_file="$(/usr/bin/mktemp "$HOME/.zprofile.zerokun.XXXXXX")" \
    || fail ".zprofile用一時fileを作成できません"
  if [ -e "$profile" ]; then /bin/cat "$profile" > "$temp_file"; fi
  printf '\n%s\n%s\n' "$marker" "$content" >> "$temp_file"
  /bin/chmod "$mode" "$temp_file"
  /bin/mv -f "$temp_file" "$profile"
}

persist_brew_path() {
  local brew_bin line
  brew_bin="$(command -v brew)"
  line="eval \"\$(${brew_bin} shellenv)\""
  append_profile_block '# zerokun bootstrap: Homebrew' "$line"
}

secure_download() {
  local output="$1" url="$2"
  /usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp \
    /usr/bin/curl -q --fail --location --proto '=https' --proto-redir '=https' \
      --tlsv1.2 --noproxy '*' --output "$output" "$url"
}

# Downloaded installers and package managers perform their own second-stage
# network access. Give them the real account HOME only for their documented
# install destination, while forcing every config/cache lookup that can alter
# transport or Git routing into a fresh owner-only directory. env -i also
# removes proxy, custom-CA, GIT_CONFIG_COUNT and similar ambient overrides.
isolated_network_command() {
  local isolated_root status=0
  isolated_root="$(/usr/bin/mktemp -d /tmp/zerokun-network-env.XXXXXX)" \
    || fail "network command用一時directoryを作成できません"
  /bin/chmod 0700 "$isolated_root"
  /bin/mkdir "$isolated_root/curl" "$isolated_root/xdg-config" \
    "$isolated_root/xdg-cache" "$isolated_root/bun-cache"
  /bin/chmod 0700 "$isolated_root/curl" "$isolated_root/xdg-config" \
    "$isolated_root/xdg-cache" "$isolated_root/bun-cache"
  /usr/bin/env -i \
    HOME="$HOME" USER="$(/usr/bin/id -un)" LOGNAME="$(/usr/bin/id -un)" \
    SHELL="${SHELL:-/bin/zsh}" TERM="${TERM:-dumb}" \
    PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    TMPDIR=/tmp CURL_HOME="$isolated_root/curl" \
    XDG_CONFIG_HOME="$isolated_root/xdg-config" \
    XDG_CACHE_HOME="$isolated_root/xdg-cache" \
    BUN_INSTALL_CACHE_DIR="$isolated_root/bun-cache" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false \
    SSH_ASKPASS=/usr/bin/false "$@" || status=$?
  /bin/rm -rf "$isolated_root"
  return "$status"
}

install_homebrew() {
  local installer
  section "Homebrew"
  if ! load_brew; then
    require_interactive "Homebrewのインストール"
    installer="$(/usr/bin/mktemp /tmp/zerokun-homebrew-installer.XXXXXX)" \
      || fail "Homebrew公式installer用一時fileを作成できません"
    if ! secure_download "$installer" \
      https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh; then
      /bin/rm -f "$installer"
      fail "Homebrew公式installerを取得できませんでした"
    fi
    /bin/chmod 0700 "$installer"
    if ! isolated_network_command /bin/bash "$installer"; then
      /bin/rm -f "$installer"
      fail "Homebrew公式installerの実行に失敗しました"
    fi
    /bin/rm -f "$installer"
    load_brew || fail "HomebrewをPATHへ読み込めませんでした"
  fi
  persist_brew_path
  ok "$(first_line brew --version)"
}

bootstrap_safe_directory_chain() {
  local path="$1" rest component current metadata uid mode type permissions
  case "$path" in /*) ;; *) return 1 ;; esac
  rest="${path#/}"
  current=""
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) component="${rest%%/*}"; rest="${rest#*/}" ;;
      *) component="$rest"; rest="" ;;
    esac
    [ -n "$component" ] || continue
    current="$current/$component"
    [ -d "$current" ] && [ ! -L "$current" ] || return 1
    metadata="$(/usr/bin/stat -f '%u:%Lp:%HT' "$current" 2>/dev/null)" || return 1
    IFS=: read -r uid mode type <<EOF
$metadata
EOF
    [ "$type" = "Directory" ] || return 1
    [ "$uid" = "0" ] || [ "$uid" = "$(/usr/bin/id -u)" ] || return 1
    permissions=$((8#$mode))
    [ $((permissions & 8#22)) -eq 0 ] || return 1
  done
}

secure_standalone_codex() {
  [ -x /usr/bin/python3 ] || return 1
  /usr/bin/python3 -c '
import json
import os
import re
import stat
import sys

home = os.path.realpath(sys.argv[1])
uid = os.getuid()
allowed_owners = {0, uid}
target = "aarch64-apple-darwin" if os.uname().machine == "arm64" else "x86_64-apple-darwin" if os.uname().machine == "x86_64" else None
if target is None:
    raise SystemExit(1)
logical = os.path.join(home, ".local", "bin", "codex")
standalone = os.path.join(home, ".codex", "packages", "standalone")
current = os.path.join(standalone, "current")
releases = os.path.join(standalone, "releases")
entry = os.path.join(current, "bin", "codex")

def same(left, right):
    fields = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")
    return all(getattr(left, field) == getattr(right, field) for field in fields)

def safe_directories(path):
    current_path = os.path.sep
    root = os.lstat(current_path)
    if not stat.S_ISDIR(root.st_mode) or root.st_uid not in allowed_owners or root.st_mode & 0o022:
        raise SystemExit(1)
    for component in os.path.relpath(path, os.path.sep).split(os.path.sep):
        current_path = os.path.join(current_path, component)
        metadata = os.lstat(current_path)
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_uid not in allowed_owners or metadata.st_mode & 0o022:
            raise SystemExit(1)

def exact_link(path, expected):
    before = os.lstat(path)
    if not stat.S_ISLNK(before.st_mode) or before.st_uid not in allowed_owners or before.st_nlink != 1:
        raise SystemExit(1)
    raw = os.readlink(path)
    after = os.lstat(path)
    resolved = os.path.normpath(raw if os.path.isabs(raw) else os.path.join(os.path.dirname(path), raw))
    if not same(before, after) or resolved != expected:
        raise SystemExit(1)

safe_directories(os.path.dirname(logical))
safe_directories(releases)
exact_link(logical, entry)
current_before = os.lstat(current)
if not stat.S_ISLNK(current_before.st_mode) or current_before.st_uid not in allowed_owners or current_before.st_nlink != 1:
    raise SystemExit(1)
current_raw = os.readlink(current)
current_after = os.lstat(current)
release = os.path.normpath(current_raw if os.path.isabs(current_raw) else os.path.join(os.path.dirname(current), current_raw))
if not same(current_before, current_after) or os.path.dirname(release) != releases:
    raise SystemExit(1)
release_id = os.path.basename(release)
if not re.fullmatch(r"[A-Za-z0-9._-]+", release_id):
    raise SystemExit(1)
safe_directories(os.path.join(release, "bin"))
physical = os.path.join(release, "bin", "codex")
leaf_before = os.lstat(physical)
if not stat.S_ISREG(leaf_before.st_mode) or stat.S_ISLNK(leaf_before.st_mode) or leaf_before.st_nlink != 1 or leaf_before.st_uid not in allowed_owners or leaf_before.st_mode & 0o022 or not leaf_before.st_mode & 0o111:
    raise SystemExit(1)
leaf_fd = os.open(physical, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    leaf_opened = os.fstat(leaf_fd)
    header = os.pread(leaf_fd, 8, 0)
finally:
    os.close(leaf_fd)
expected_header = b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01" if target.startswith("aarch64") else b"\xcf\xfa\xed\xfe\x07\x00\x00\x01"
if not same(leaf_before, leaf_opened) or header != expected_header:
    raise SystemExit(1)
manifest_path = os.path.join(release, "codex-package.json")
manifest_before = os.lstat(manifest_path)
if not stat.S_ISREG(manifest_before.st_mode) or stat.S_ISLNK(manifest_before.st_mode) or manifest_before.st_nlink != 1 or manifest_before.st_uid not in allowed_owners or manifest_before.st_mode & 0o022 or not 0 < manifest_before.st_size <= 65536:
    raise SystemExit(1)
manifest_fd = os.open(manifest_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    manifest_opened = os.fstat(manifest_fd)
    raw_manifest = os.pread(manifest_fd, manifest_opened.st_size + 1, 0)
    manifest_after = os.fstat(manifest_fd)
finally:
    os.close(manifest_fd)
if not same(manifest_before, manifest_opened) or not same(manifest_opened, manifest_after) or len(raw_manifest) != manifest_opened.st_size:
    raise SystemExit(1)
manifest = json.loads(raw_manifest.decode("utf-8"))
expected_keys = {"layoutVersion", "version", "target", "variant", "entrypoint", "resourcesDir", "pathDir"}
version = manifest.get("version")
if set(manifest) != expected_keys or manifest.get("layoutVersion") != 1 or manifest.get("target") != target or manifest.get("variant") != "codex" or manifest.get("entrypoint") != "bin/codex" or manifest.get("resourcesDir") != "codex-resources" or manifest.get("pathDir") != "codex-path" or not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit(1)
parts = tuple(int(part) for part in version.split("."))
minimum = tuple(int(part) for part in sys.argv[2].split("."))
if len(minimum) != 3 or parts < minimum or release_id != version + "-" + target:
    raise SystemExit(1)
print(physical)
' "$HOME" "$MIN_CODEX_VERSION" 2>/dev/null
}

install_codex_standalone() {
  local installer
  installer="$(/usr/bin/mktemp /tmp/zerokun-codex-installer.XXXXXX)" \
    || fail "Codex公式installer用一時fileを作成できません"
  if ! secure_download "$installer" https://chatgpt.com/codex/install.sh; then
    /bin/rm -f "$installer"
    fail "Codex公式installerを取得できませんでした"
  fi
  /bin/chmod 700 "$installer"
  if ! isolated_network_command CODEX_NON_INTERACTIVE=true /bin/sh "$installer"; then
    /bin/rm -f "$installer"
    fail "Codex公式installerの実行に失敗しました"
  fi
  /bin/rm -f "$installer"
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  secure_standalone_codex >/dev/null \
    || fail "Codex公式standaloneのowner・path・native executable検証に失敗しました"
  append_profile_block '# zerokun bootstrap: Codex CLI' 'export PATH="$HOME/.local/bin:$PATH"'
}

install_herdr_standalone() {
  local installer
  [ -z "${HERDR_BIN_PATH:-}" ] \
    || fail "明示HERDR_BIN_PATHがHerdr ${MIN_HERDR_VERSION}以上の要件を満たしていません"
  installer="$(/usr/bin/mktemp /tmp/zerokun-herdr-installer.XXXXXX)" \
    || fail "Herdr公式installer用一時fileを作成できません"
  if ! secure_download "$installer" https://herdr.dev/install.sh; then
    /bin/rm -f "$installer"
    fail "Herdr公式installerを取得できませんでした"
  fi
  /bin/chmod 0700 "$installer"
  if ! isolated_network_command HERDR_INSTALL_DIR="$HOME/.local/bin" \
    /bin/sh "$installer"; then
    /bin/rm -f "$installer"
    fail "Herdr公式installerの実行に失敗しました"
  fi
  /bin/rm -f "$installer"
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  herdr_compatible \
    || fail "Herdr ${MIN_HERDR_VERSION}以上と必要なworkspace/tab/pane/agent APIを確認できません"
  append_profile_block '# zerokun bootstrap: Herdr' 'export PATH="$HOME/.local/bin:$PATH"'
}

install_grok_build() {
  local installer logical="$HOME/.grok/bin/grok"
  if grok_build_executable >/dev/null; then
    return
  fi
  if [ -e "$logical" ] || [ -L "$logical" ]; then
    fail "既存Grok Buildが安全な公式layoutではありません。手動で確認してください: $logical"
  fi
  installer="$(/usr/bin/mktemp /tmp/zerokun-grok-installer.XXXXXX)" \
    || fail "Grok Build公式installer用一時fileを作成できません"
  if ! secure_download "$installer" https://x.ai/cli/install.sh; then
    /bin/rm -f "$installer"
    fail "Grok Build公式installerを取得できませんでした"
  fi
  /bin/chmod 0700 "$installer"
  if ! isolated_network_command /bin/bash "$installer"; then
    /bin/rm -f "$installer"
    fail "Grok Build公式installerの実行に失敗しました"
  fi
  /bin/rm -f "$installer"
  grok_build_executable >/dev/null \
    || fail "Grok Build公式CLIのowner・path・executable検証に失敗しました"
  append_profile_block '# zerokun bootstrap: Grok Build' 'export PATH="$HOME/.grok/bin:$PATH"'
}

install_cli_tools() {
  local standalone_codex="$HOME/.local/bin/codex"
  section "tmux / Herdr / Codex CLI / Grok Build / Claude Code / Bun"
  if ! command -v tmux >/dev/null 2>&1; then
    isolated_network_command "$(command -v brew)" install tmux
  fi
  herdr_compatible || install_herdr_standalone
  hash -r
  herdr_compatible \
    || fail "Herdr ${MIN_HERDR_VERSION}以上と必要なworkspace/tab/pane/agent APIを確認できません"
  # Homebrew prefix is group-writable on a standard multi-user macOS install.
  # Keep the executable used by Zeroちゃん under the account-owned standalone path.
  if ! secure_standalone_codex >/dev/null; then
    install_codex_standalone
  fi
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  if ! command -v bun >/dev/null 2>&1; then
    local bun_installer
    bun_installer="$(/usr/bin/mktemp /tmp/zerokun-bun-installer.XXXXXX)" \
      || fail "Bun公式installer用一時fileを作成できません"
    if ! secure_download "$bun_installer" https://bun.com/install; then
      /bin/rm -f "$bun_installer"
      fail "Bun公式installerを取得できませんでした"
    fi
    /bin/chmod 0700 "$bun_installer"
    if ! isolated_network_command /bin/bash "$bun_installer"; then
      /bin/rm -f "$bun_installer"
      fail "Bun公式installerの実行に失敗しました"
    fi
    /bin/rm -f "$bun_installer"
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  install_grok_build
  export PATH="$HOME/.grok/bin:$PATH"
  hash -r
  append_profile_block '# zerokun bootstrap: Bun' 'export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"'
  for required in git tmux herdr bun; do
    command -v "$required" >/dev/null 2>&1 || fail "$required の導入を確認できません"
  done
  secure_standalone_codex >/dev/null \
    || fail "Codex公式standaloneの安全性を確認できませんでした"
  grok_build_executable >/dev/null \
    || fail "Grok Build公式CLIの安全性を確認できませんでした"
  resolve_claude_binary >/dev/null \
    || fail "Claude Codeがありません。公式Claude Codeを導入してから同じbootstrapを再実行してください"
  ok "必要なCLIを導入しました"
}

verify_logins() {
  local standalone_codex login_status
  section "事前ログイン状態"
  standalone_codex="$(secure_standalone_codex)" \
    || fail "Codex公式standaloneの安全性を確認できませんでした"
  login_status="$("$standalone_codex" login status 2>&1)" \
    || fail "Codexが未ログインです。HerdrでCodexへ先にログインしてください。Zeroちゃんは認証操作を行いません"
  case "$login_status" in
    *"Logged in using ChatGPT"*) ;;
    *) fail "CodexはChatGPT subscriptionログインが必要です。API key認証は使用しません" ;;
  esac
  grok_build_executable >/dev/null \
    || fail "Grok CLIの安全性を確認できませんでした"
  grok_auth_ready \
    || fail "Grok CLIが未ログインまたはauthがunsafeです。先にgrok loginを完了してください。Zeroちゃんは認証操作を行いません"
  claude_subscription_ready \
    || fail "Claude Codeはsubscription login済みである必要があります。Herdrで先にloginしてください。Zeroちゃんは認証操作を行いません"
  ok "Codex / Grok CLI / Claude Codeは事前ログイン済みです"
}

repo_is_clean() {
  [ -z "$(safe_git -C "$1" status --porcelain 2>/dev/null)" ]
}

safe_git() {
  /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin TMPDIR="${TMPDIR:-/tmp}" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_PAGER=cat \
    /usr/bin/git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
      -c credential.helper= -c core.sshCommand=/usr/bin/false \
      -c protocol.allow=never -c protocol.https.allow=always \
      -c protocol.file.allow=never "$@"
}

remote_matches_slug() {
  local slug="$1" remote="$2"
  case "$remote" in
    "https://github.com/$slug"|"https://github.com/$slug.git"|\
    "git@github.com:$slug"|"git@github.com:$slug.git"|\
    "ssh://git@github.com/$slug"|"ssh://git@github.com/$slug.git") return 0 ;;
    *) return 1 ;;
  esac
}

validate_existing_repo() {
  local slug="$1" target="$2" target_branch="$3"
  # This bootstrap is commonly downloaded as one file into a temporary
  # directory. Never trust an adjacent validator: the directory may be shared,
  # and the target checkout is not trusted until this validation succeeds.
  local validator_dir validator size status=0
  validator_dir="$(/usr/bin/mktemp -d /tmp/zerokun-repo-validator.XXXXXX)" \
    || { echo "repository validator用一時directoryを作成できません" >&2; return 1; }
  /bin/chmod 0700 "$validator_dir"
  validator="$validator_dir/validate-update-repo.ts"
  if ! secure_download "$validator" \
    "https://raw.githubusercontent.com/${slug}/${target_branch}/zerokun/validate-update-repo.ts"; then
    /bin/rm -f "$validator"
    /bin/rmdir "$validator_dir" 2>/dev/null || true
    return 1
  fi
  /bin/chmod 0600 "$validator"
  size="$(/usr/bin/stat -f '%z' "$validator" 2>/dev/null || true)"
  if ! bootstrap_owned_regular_file "$validator" \
    || [ -z "$size" ] || [ "$size" -le 0 ] || [ "$size" -gt 1048576 ]; then
    echo "downloadしたrepository validatorが安全なregular fileではありません" >&2
    /bin/rm -f "$validator"
    /bin/rmdir "$validator_dir" 2>/dev/null || true
    return 1
  fi
  bun --config=/dev/null --no-env-file "$validator" "$target" "$target_branch" || status=$?
  /bin/rm -f "$validator"
  /bin/rmdir "$validator_dir" 2>/dev/null || true
  return "$status"
}

repo_has_atomic_setup_delegate() {
  local target="$1" setup size
  setup="$target/zerokun/setup.sh"
  bootstrap_owned_regular_file "$setup" || return 1
  size="$(/usr/bin/stat -f '%z' "$setup" 2>/dev/null || true)"
  [ -n "$size" ] && [ "$size" -gt 0 ] && [ "$size" -le 1048576 ] || return 1
  /usr/bin/grep -Fq -- '--setup-supervisor' "$setup"
}

ensure_repo() {
  local slug="$1"
  local target="$2"
  local target_branch="${3:-main}"
  if [ -d "$target/.git" ]; then
    validate_existing_repo "$slug" "$target" "$target_branch" \
      || fail "既存ディレクトリのGit設定またはoriginが安全ではありません: $target"
    local current_branch
    current_branch="$(safe_git -C "$target" branch --show-current)"
    if repo_is_clean "$target" && [ "$current_branch" = "$target_branch" ]; then
      repo_has_atomic_setup_delegate "$target" \
        || fail "旧Codex版の既存checkoutは稼働中sourceを直接更新しません。空の別directoryを--repo-dirで指定してoffline bootstrapしてください: $target"
      safe_git -C "$target" fetch origin "$target_branch"
      safe_git -C "$target" branch --set-upstream-to="origin/$target_branch" "$target_branch"
      safe_git -C "$target" merge --ff-only "origin/$target_branch"
    elif repo_is_clean "$target" && [ "$current_branch" = "main" ] && [ "$target_branch" != "main" ]; then
      repo_has_atomic_setup_delegate "$target" \
        || fail "旧Codex版の既存checkoutは稼働中sourceを直接更新しません。空の別directoryを--repo-dirで指定してoffline bootstrapしてください: $target"
      safe_git -C "$target" fetch origin "$target_branch"
      if safe_git -C "$target" show-ref --verify --quiet "refs/heads/$target_branch"; then
        safe_git -C "$target" switch "$target_branch"
      else
        safe_git -C "$target" switch --create "$target_branch" --track "origin/$target_branch"
      fi
      safe_git -C "$target" branch --set-upstream-to="origin/$target_branch" "$target_branch"
      safe_git -C "$target" merge --ff-only "origin/$target_branch"
    else
      fail "既存作業を守るためCodex版への切替を停止しました。変更をcommit/stashし、mainまたは$target_branch branchで再実行してください: $target"
    fi
    validate_existing_repo "$slug" "$target" "$target_branch" \
      || fail "既存ディレクトリのtracking設定が安全ではありません: $target"
    return
  fi
  if [ -e "$target" ] && [ -n "$(/bin/ls -A "$target" 2>/dev/null)" ]; then
    fail "clone先が空ではありません: $target"
  fi
  /bin/mkdir -p "$(dirname "$target")"
  safe_git clone --branch "$target_branch" "https://github.com/${slug}.git" "$target"
  validate_existing_repo "$slug" "$target" "$target_branch" \
    || fail "clone直後のGit設定またはoriginを独立検証できません: $target"
}

install_repositories() {
  section "Zeroちゃんリポジトリ"
  ensure_repo zerocolored/zero-codex "$REPO_DIR" main
  ok "リポジトリを配置しました"
}

install_grok_reviewer() {
  section "専用advisor runtime"
  [ -f "$REPO_DIR/zerokun/install-grok-reviewer.ts" ] \
    || fail "Grok reviewer installerがありません: $REPO_DIR/zerokun/install-grok-reviewer.ts"
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/install-grok-reviewer.ts" install \
    || fail "専用Grok reviewerを導入できませんでした"
  grok_reviewer_ready || fail "専用Grok reviewerのowner-only配置を確認できませんでした"
  ok "専用read-only reviewerを導入しました"
}

ensure_project_workspace() {
  section "Slack作業repository"
  if [ -e "$PROJECT_DIR" ] && [ ! -d "$PROJECT_DIR" ]; then
    fail "--project-dirはdirectoryを指定してください: $PROJECT_DIR"
  fi
  if [ -d "$PROJECT_DIR" ] && [ ! -e "$PROJECT_DIR/.git" ]; then
    local existing_entries
    existing_entries="$(/bin/ls -A "$PROJECT_DIR" 2>/dev/null || true)"
    [ -z "$existing_entries" ] \
      || fail "未初期化projectに既存fileがあります。内容を確認してAGENTS.mdを用意してください: $PROJECT_DIR"
  fi
  /bin/mkdir -p "$PROJECT_DIR"
  local repo_real project_real agents_template agents_path entries
  repo_real="$(resolve_dir "$REPO_DIR")" || fail "zero repositoryを解決できません: $REPO_DIR"
  project_real="$(resolve_dir "$PROJECT_DIR")" || fail "project directoryを解決できません: $PROJECT_DIR"
  [ "$repo_real" != "$project_real" ] \
    || fail "Slackのwrite jobからruntimeを守るため、--project-dirはzero repositoryと別にしてください"
  if [ ! -e "$PROJECT_DIR/.git" ]; then
    safe_git init --initial-branch=main "$PROJECT_DIR" >/dev/null
  fi
  agents_template="$REPO_DIR/zerokun/templates/AGENTS.md"
  agents_path="$PROJECT_DIR/AGENTS.md"
  [ -f "$agents_template" ] && [ ! -L "$agents_template" ] \
    || fail "既定AGENTS.md templateがありません: $agents_template"
  if [ ! -e "$agents_path" ] && [ ! -L "$agents_path" ]; then
    if safe_git -C "$PROJECT_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
      fail "既存projectにAGENTS.mdがありません。project固有の指示を追加してから再実行してください: $agents_path"
    fi
    entries="$(/bin/ls -A "$PROJECT_DIR" | /usr/bin/grep -v '^\.git$' || true)"
    [ -z "$entries" ] \
      || fail "未初期化projectに既存fileがあります。内容を確認してAGENTS.mdを用意してください: $PROJECT_DIR"
    /bin/cp "$agents_template" "$agents_path"
    /bin/chmod 0644 "$agents_path"
    safe_git -C "$PROJECT_DIR" add -- AGENTS.md
    safe_git -C "$PROJECT_DIR" \
      -c user.name='Zeroちゃん Bootstrap' \
      -c user.email='zerochan-bootstrap@users.noreply.github.com' \
      commit -m 'chore: initialize Zeroちゃん workspace instructions' >/dev/null
  fi
  bootstrap_owned_regular_file "$agents_path" \
    || fail "AGENTS.mdはowner一致・hardlinkなしのregular fileにしてください: $agents_path"
  ok "Slack作業repository: $PROJECT_DIR"
}

run_setup() {
  section "Zeroちゃん配線"
  [ -f "$REPO_DIR/zerokun/setup.sh" ] || fail "setup.shがありません: $REPO_DIR/zerokun/setup.sh"
  ZEROKUN_BOOTSTRAP=1 ZEROKUN_PROJECT_DIR="$PROJECT_DIR" ZEROKUN_STATE_DIR="$STATE_DIR" \
    /bin/bash "$REPO_DIR/zerokun/setup.sh"
}

slack_tokens_ready() {
  local env_file="$STATE_DIR/.env"
  local content
  content="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$env_file" 2>/dev/null)" \
    || return 1
  [ "$(printf '%s\n' "$content" | /usr/bin/grep -Ec '^SLACK_BOT_TOKEN=' || true)" = "1" ] \
    && [ "$(printf '%s\n' "$content" | /usr/bin/grep -Ec '^SLACK_APP_TOKEN=' || true)" = "1" ] \
    && printf '%s\n' "$content" | /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' \
    && printf '%s\n' "$content" | /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$'
}

verify_slack_app_identity() {
  local bun_bin
  bun_bin="$(command -v bun)" || return 1
  /usr/bin/env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    "$bun_bin" --config=/dev/null --no-env-file "$REPO_DIR/zerokun/slack-app-identity.ts" verify-file "$STATE_DIR/.env"
}

save_slack_tokens() {
  local bot_token="$1"
  local app_token="$2"
  local env_file="$STATE_DIR/.env"
  local temp_file existing=""
  umask 077
  temp_file="$(/usr/bin/mktemp "$STATE_DIR/.env.zerokun.XXXXXX")" \
    || fail "Slack token用一時fileを作成できません"
  if [ -e "$env_file" ] || [ -L "$env_file" ]; then
    existing="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$env_file")" \
      || { /bin/rm -f "$temp_file"; fail ".envが安全な通常fileではありません"; }
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        SLACK_BOT_TOKEN=*|SLACK_APP_TOKEN=*) ;;
        *) printf '%s\n' "$line" >> "$temp_file" ;;
      esac
    done <<EOF
$existing
EOF
  fi
  printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$bot_token" "$app_token" >> "$temp_file"
  if ! bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" atomic-write-private "$env_file" < "$temp_file"; then
    /bin/rm -f "$temp_file"
    fail "Slack tokenを安全に保存できません"
  fi
  /bin/rm -f "$temp_file"
}

configure_access() {
  local access_file="$STATE_DIR/access.json"
  local existing_access=""
  if [ -e "$access_file" ] || [ -L "$access_file" ]; then
    existing_access="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$access_file")" \
      || fail "access.jsonが安全な通常fileではありません"
  fi
  if [ -n "$existing_access" ] && ! printf '%s\n' "$existing_access" \
    | /usr/bin/grep -q 'U_あなたのSlackユーザーID'; then
    configure_routes_from_access
    ok "access.jsonは設定済みです"
    return
  fi
  local user_id channel_id
  printf '   あなたのSlackユーザーID（UまたはWで始まる。後で設定するならEnter）: '
  IFS= read -r user_id
  [ -n "$user_id" ] || { warn "access.jsonは後で設定してください"; return; }
  case "$user_id" in U?*|W?*) ;; *) fail "SlackユーザーIDの形式が不正です" ;; esac
  case "$user_id" in *[!A-Z0-9]*) fail "SlackユーザーIDの形式が不正です" ;; esac
  printf '   許可するSlackチャンネルID（CまたはGで始まる。後で設定するならEnter）: '
  IFS= read -r channel_id
  [ -n "$channel_id" ] || { warn "チャンネルは後で追加してください"; return; }
  case "$channel_id" in C?*|G?*) ;; *) fail "SlackチャンネルIDの形式が不正です" ;; esac
  case "$channel_id" in *[!A-Z0-9]*) fail "SlackチャンネルIDの形式が不正です" ;; esac
  ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/access.ts" policy allowlist >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/access.ts" allow "$user_id" >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/access.ts" channel add "$channel_id" >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/access.ts" channel allow "$channel_id" "$user_id" >/dev/null
  configure_routes_from_access
  ok "Slack allowlistを設定しました"
}

configure_routes_from_access() {
  local access_file="$STATE_DIR/access.json"
  local routes_file="$STATE_DIR/routes.json"
  [ -f "$access_file" ] || return 0
  [ -d "$PROJECT_DIR" ] || fail "初期route先がありません: $PROJECT_DIR"
  ZEROKUN_ACCESS_FILE="$access_file" ZEROKUN_ROUTES_FILE="$routes_file" \
    ZEROKUN_SAFE_FILE="$REPO_DIR/zerokun/safe-file.ts" \
    ZEROKUN_ROUTE_PROJECT="$PROJECT_DIR" bun --config=/dev/null --no-env-file -e '
      import { realpathSync } from "fs";
      const { atomicWritePrivateFile, readOptionalPrivateFile } = await import(process.env.ZEROKUN_SAFE_FILE!);
      const access = JSON.parse((readOptionalPrivateFile(process.env.ZEROKUN_ACCESS_FILE!) ?? "{}"));
      const routePath = process.env.ZEROKUN_ROUTES_FILE!;
      const existingRoutes = readOptionalPrivateFile(routePath);
      const routes = existingRoutes === null ? {} : JSON.parse(existingRoutes);
      if (!routes || Array.isArray(routes) || typeof routes !== "object") {
        throw new Error("routes.json must be an object");
      }
      const project = realpathSync(process.env.ZEROKUN_ROUTE_PROJECT!);
      for (const channel of Object.keys(access.channels ?? {})) {
        if (!routes[channel]) routes[channel] = { repo_path: project, label: "Default project" };
      }
      atomicWritePrivateFile(routePath, JSON.stringify(routes, null, 2) + "\n");
    ' || fail "routes.jsonを安全に生成できませんでした"
  ok "許可チャンネルの初期routeを設定しました: $PROJECT_DIR"
}

validate_slack_names() {
  [ -n "$SLACK_APP_NAME" ] || fail "Slack Appの表示名を入力してください"
  [ "${#SLACK_APP_NAME}" -le 35 ] || fail "Slack Appの表示名は35文字以内にしてください"
  case "$SLACK_APP_NAME" in
    *\"*|*\\*) fail "Slack Appの表示名にダブルクォートまたはバックスラッシュは使用できません" ;;
  esac
  if printf '%s' "$SLACK_APP_NAME" | /usr/bin/grep -q '[[:cntrl:]]'; then
    fail "Slack Appの表示名に制御文字は使用できません"
  fi
  printf '%s\n' "$SLACK_BOT_USERNAME" | /usr/bin/grep -Eq '^[a-z0-9._-]{1,80}$' \
    || fail "Slack bot usernameは英小文字・数字・ハイフン・アンダースコア・ピリオドだけで指定してください"
}

choose_slack_names() {
  local entered_name
  if [ -z "$SLACK_APP_NAME" ]; then
    printf '   Slack Appの表示名（35文字以内） [Zeroちゃん]: '
    IFS= read -r entered_name
    SLACK_APP_NAME="${entered_name:-Zeroちゃん}"
  fi
  if [ -z "$SLACK_BOT_USERNAME" ]; then
    printf '   Slack bot username（英小文字・数字・-・_・.） [zerochan]: '
    IFS= read -r entered_name
    SLACK_BOT_USERNAME="${entered_name:-zerochan}"
  fi
  validate_slack_names
}

render_slack_manifest() {
  local source_manifest="$1"
  local target_manifest="$2"
  validate_slack_names
  /usr/bin/awk -v app_name="$SLACK_APP_NAME" -v bot_username="$SLACK_BOT_USERNAME" '
    $0 == "  name: Zeroちゃん" {
      print "  name: \"" app_name "\""
      app_name_replaced = 1
      next
    }
    $0 == "    display_name: zerochan" {
      print "    display_name: " bot_username
      bot_name_replaced = 1
      next
    }
    { print }
    END {
      if (!app_name_replaced || !bot_name_replaced) exit 3
    }
  ' "$source_manifest" > "$target_manifest" \
    || fail "Slack manifestの名前を生成できませんでした"
}

normalize_slack_token() {
  local value="$1"
  local env_key="$2"
  value="$(printf '%s' "$value" | /usr/bin/tr -d '\r' \
    | /usr/bin/sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in export\ *) value="${value#export }" ;; esac
  case "$value" in "$env_key="*) value="${value#*=}" ;; esac
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

read_slack_token() {
  local prefix="$1"
  local label="$2"
  local env_key="$3"
  local entered
  while true; do
    printf '   %s（入力内容は表示されません）: ' "$label"
    if ! IFS= read -r -s entered; then
      printf '\n'
      fail "${label}の入力を読み取れませんでした"
    fi
    printf '\n'
    SLACK_TOKEN_RESULT="$(normalize_slack_token "$entered" "$env_key")"
    if printf '%s\n' "$SLACK_TOKEN_RESULT" \
      | /usr/bin/grep -Eq "^${prefix}-[A-Za-z0-9._-]{10,}$"; then
      return
    fi
    if [ -z "$SLACK_TOKEN_RESULT" ]; then
      warn "${label}が未入力です。Slack画面からコピーして、もう一度入力してください"
    else
      warn "${label}は${prefix}-で始まる値です。コピーし直して、もう一度入力してください"
    fi
  done
}

configure_slack() {
  /bin/mkdir -p "$STATE_DIR"
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/managed-path.ts" prepare-root "$STATE_DIR" >/dev/null \
    || fail "state directoryを安全に準備できませんでした: $STATE_DIR"
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" validate-existing \
    "$STATE_DIR/.env" "$STATE_DIR/access.json" "$STATE_DIR/routes.json" \
    || fail "既存のSlack設定fileが安全ではありません"
  section "Slack App"
  if [ "$SKIP_SLACK" = "1" ]; then
    warn "--skip-slackにより省略しました"
    return
  fi
  if slack_tokens_ready; then
    if verify_slack_app_identity; then
      ok "同じSlack Appのトークン2つを確認しました"
      configure_access
      return
    fi
    warn "既存tokenのApp identityを確認できないため、2つとも入力し直します"
  fi
  require_interactive "Slack App設定"
  local manifest="$REPO_DIR/zerokun/templates/slack-app-manifest.yaml"
  local generated_manifest="$STATE_DIR/slack-app-manifest.generated.yaml"
  local temp_manifest
  [ -f "$manifest" ] || fail "Slack manifestがありません: $manifest"
  /bin/mkdir -p "$(dirname "$generated_manifest")"
  choose_slack_names
  umask 077
  temp_manifest="$(/usr/bin/mktemp "$STATE_DIR/.slack-manifest.zerokun.XXXXXX")" \
    || fail "Slack manifest用一時fileを作成できません"
  render_slack_manifest "$manifest" "$temp_manifest"
  if ! bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" atomic-write-private "$generated_manifest" < "$temp_manifest"; then
    /bin/rm -f "$temp_manifest"
    fail "Slack manifestを安全に保存できません"
  fi
  /bin/rm -f "$temp_manifest"
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy < "$generated_manifest"
    echo "   選んだ名前を反映したSlack App manifestをクリップボードへコピーしました。"
  fi
  echo "   生成したmanifest: $generated_manifest"
  echo "   Slack App作成URL: $SLACK_APP_CREATE_URL"
  /usr/bin/open "$SLACK_APP_CREATE_URL" >/dev/null 2>&1 || true
  cat <<EOF
   上のURLで Create New App → From a manifest を選び、manifestを貼り付けて作成します。
   App表示名は「${SLACK_APP_NAME}」、bot usernameは「${SLACK_BOT_USERNAME}」です。
   1. Basic Information → App-Level Tokens → Generate Token and Scopes
      → connections:write を追加し、xapp-をコピー
   2. OAuth & Permissions → Install to Workspace
      → Bot User OAuth Tokenのxoxb-をコピー
   このCodex版用に新しいAppを作成してください。別PCで稼働中のClaude版Appの
   xapp-/xoxb-トークンは使用しません。同じCodex stateでの再設定時だけ、
   そのCodex版Appの既存トークンを再利用できます。
EOF
  local bot_token app_token
  read_slack_token xapp 'App-Level Token（xapp-）' SLACK_APP_TOKEN
  app_token="$SLACK_TOKEN_RESULT"
  read_slack_token xoxb 'Bot User OAuth Token（xoxb-）' SLACK_BOT_TOKEN
  bot_token="$SLACK_TOKEN_RESULT"
  save_slack_tokens "$bot_token" "$app_token"
  verify_slack_app_identity \
    || fail "Bot TokenとApp-Level Tokenが同じSlack Appか確認できませんでした"
  ok "同じSlack Appのトークン2つを権限600で保存しました"
  configure_access
}

main() {
  local doctor_status=0
  require_macos
  if [ "$MODE" = "doctor" ]; then
    run_doctor || doctor_status=$?
    # 退避先を作れず見送った場合も診断としては未完なので、非0で返す。
    [ "$doctor_status" = "0" ] || return 1
    return 0
  fi
  if [ "$MODE" = "slack-only" ]; then
    echo "== Zeroちゃん Slack設定だけ再開 =="
    install_grok_reviewer
    configure_slack
    # Re-run setup after the new pair has been verified. This safely retires
    # any runner/gateway tied to the previous Codex Slack App on this PC.
    run_setup
    section "Slack設定完了"
    echo "   Herdrの専用paneで実行: zerokun"
    return
  fi

  echo "== Zeroちゃん macOS bootstrap =="
  install_clt
  install_homebrew
  install_cli_tools
  verify_logins
  install_repositories
  install_grok_reviewer
  ensure_project_workspace
  run_setup

  section "Codex 利用可能"
  echo "   この時点で別ターミナルからCodexを利用できます:"
  echo "   cd \"$PROJECT_DIR\" && codex"
  section "基本セットアップ完了"
  # 締めの診断は要約表示なので、ここで即座に落ちると案内とSlack設定が飛ぶ。
  # 案内は最後まで出しきり、CLIの異常が残っていたときだけ最後に非0で終える。
  run_doctor || doctor_status=$?
  case "$doctor_status" in
    0) ;;
    2) warn "一時領域を確保できずCodex CLIだけ未診断です。導入自体は完了しています" ;;
    *) warn "セットアップ診断で問題を検出しました。下の案内のあとに再確認してください" ;;
  esac
  echo "   Codex CLIを利用できます:"
  echo "   cd \"$PROJECT_DIR\" && codex"
  if [ "$WITH_SLACK" = "1" ]; then
    configure_slack
    section "Slack設定完了"
    echo "   Slack Appを対象チャンネルへ招待後、Herdrの専用paneで実行: zerokun"
  else
    warn "Slack設定は後回しにしました。Codexの利用には不要です"
    echo "   後からSlack設定だけ行う:"
    echo "   bash \"$REPO_DIR/zerokun/bootstrap-macos.sh\" --slack-only"
  fi
  # 「利用できます」と案内した以上、実際に使えない状態を成功で終わらせない。
  case "$doctor_status" in
    0|2) ;;
    *) fail "セットアップ診断の問題が残っています: bash \"$REPO_DIR/zerokun/bootstrap-macos.sh\" --doctor で確認してください" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main
fi
