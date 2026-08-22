#!/usr/bin/env bash
# Fresh macOS -> Zero-kun bootstrap.
# This file can be copied to a new Mac and run before any project repository exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$HOME/Desktop/Project/zero"
if [ -d "$SCRIPT_DIR/../.git" ] && [ -f "$SCRIPT_DIR/../server.ts" ]; then
  DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

REPO_DIR="${ZEROKUN_REPO_DIR:-$DEFAULT_REPO_DIR}"
PROJECT_DIR="${ZEROKUN_PROJECT_DIR:-$(dirname "$REPO_DIR")/zerokun-workspace}"
if [ -n "${ZEROKUN_STATE_DIR:-}" ]; then
  STATE_DIR="$ZEROKUN_STATE_DIR"
elif [ -n "${SLACK_STATE_DIR:-}" ]; then
  STATE_DIR="$SLACK_STATE_DIR"
elif [ -f "$HOME/.claude/channels/slack/jobs.sqlite3" ] \
  || [ -f "$HOME/.claude/channels/slack/.env" ] \
  || [ -f "$HOME/.claude/channels/slack/access.json" ]; then
  STATE_DIR="$HOME/.claude/channels/slack"
else
  STATE_DIR="$HOME/.codex/zerokun"
fi
MODE="install"
SKIP_LOGINS=0
SKIP_SLACK=0
WITH_SLACK=0
SLACK_APP_NAME="${ZEROKUN_SLACK_APP_NAME:-}"
SLACK_BOT_USERNAME="${ZEROKUN_SLACK_BOT_USERNAME:-}"
SLACK_APP_CREATE_URL="https://api.slack.com/apps?new_app=1"
MIN_CODEX_VERSION="0.149.0"

codex_version_number() {
  codex --version 2>/dev/null | sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1
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

usage() {
  cat <<'EOF'
Usage: bootstrap-macos.sh [options]

新しいMacへゼロくん一式を導入します。Command Line Toolsはバージョンを固定せず、
そのmacOSにAppleが提供する適合版を `xcode-select --install` で導入します。

Options:
  --doctor              何も変更せず、必要ツールとバージョンだけ確認
  --skip-logins         Codexの対話ログインを呼び出さない
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
    --skip-logins) SKIP_LOGINS=1 ;;
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
    if /bin/mkdir "$DOCTOR_TMP/codex" 2>/dev/null; then
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
  doctor_item 'Bun' bun --version || missing=1
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

install_homebrew() {
  section "Homebrew"
  if ! load_brew; then
    require_interactive "Homebrewのインストール"
    /bin/bash -c "$(/usr/bin/curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    load_brew || fail "HomebrewをPATHへ読み込めませんでした"
  fi
  persist_brew_path
  ok "$(first_line brew --version)"
}

install_codex_standalone() {
  local installer curl_bin
  curl_bin="${ZEROKUN_CURL_BIN:-/usr/bin/curl}"
  installer="$(/usr/bin/mktemp /tmp/zerokun-codex-installer.XXXXXX)" \
    || fail "Codex公式installer用一時fileを作成できません"
  if ! "$curl_bin" -fsSL https://chatgpt.com/codex/install.sh --output "$installer"; then
    /bin/rm -f "$installer"
    fail "Codex公式installerを取得できませんでした"
  fi
  /bin/chmod 700 "$installer"
  if ! CODEX_NON_INTERACTIVE=true /bin/sh "$installer"; then
    /bin/rm -f "$installer"
    fail "Codex公式installerの実行に失敗しました"
  fi
  /bin/rm -f "$installer"
  export PATH="$HOME/.local/bin:$PATH"
  hash -r
  append_profile_block '# zerokun bootstrap: Codex CLI' 'export PATH="$HOME/.local/bin:$PATH"'
}

install_cli_tools() {
  section "tmux / Codex CLI / Bun"
  if ! command -v tmux >/dev/null 2>&1; then
    brew install tmux
  fi
  if ! command -v codex >/dev/null 2>&1; then
    brew install --cask codex
  elif ! version_at_least "$(codex_version_number)" "$MIN_CODEX_VERSION"; then
    if ! brew upgrade --cask codex; then
      warn "HomebrewのCodex更新に失敗したため公式installerへ切り替えます"
    fi
  fi
  if ! command -v codex >/dev/null 2>&1 \
    || ! version_at_least "$(codex_version_number)" "$MIN_CODEX_VERSION"; then
    install_codex_standalone
  fi
  if ! command -v bun >/dev/null 2>&1; then
    /usr/bin/curl -fsSL https://bun.com/install | /bin/bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  append_profile_block '# zerokun bootstrap: Bun' 'export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"'
  for required in git tmux bun codex; do
    command -v "$required" >/dev/null 2>&1 || fail "$required の導入を確認できません"
  done
  version_at_least "$(codex_version_number)" "$MIN_CODEX_VERSION" \
    || fail "Codex CLI $MIN_CODEX_VERSION 以上を導入できませんでした"
  ok "必要なCLIを導入しました"
}

ensure_logins() {
  section "Codexログイン"
  if [ "$SKIP_LOGINS" = "1" ]; then
    warn "--skip-loginsにより省略しました"
    return
  fi
  require_interactive "Codexログイン"
  if ! codex login status >/dev/null 2>&1; then
    echo "   Codex CLIへログインします"
    codex login
  fi
  ok "Codexのログインを確認しました"
}

repo_is_clean() {
  [ -z "$(safe_git -C "$1" status --porcelain 2>/dev/null)" ]
}

safe_git() {
  local file_protocol=never
  [ "${ZEROKUN_UPDATE_TESTING:-0}" != "1" ] || file_protocol=always
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/usr/bin/false SSH_ASKPASS=/usr/bin/false GIT_PAGER=cat \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
      -c credential.helper= -c core.sshCommand=/usr/bin/false \
      -c protocol.allow=never -c protocol.https.allow=always \
      -c protocol.file.allow="$file_protocol" "$@"
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
  local validator="$SCRIPT_DIR/validate-update-repo.ts"
  local downloaded_validator=""
  if [ ! -f "$validator" ]; then
    # The documented fresh-Mac path downloads this bootstrap as one standalone
    # file. A rerun after clone must not depend on a sibling that was never
    # downloaded, and must not execute the unvalidated checkout's validator.
    downloaded_validator="$(/usr/bin/mktemp /tmp/zerokun-repo-validator.XXXXXX)" \
      || { echo "repository validator用一時fileを作成できません" >&2; return 1; }
    validator="$downloaded_validator"
    if ! /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 \
      "https://raw.githubusercontent.com/${slug}/${target_branch}/zerokun/validate-update-repo.ts" \
      --output "$validator"; then
      /bin/rm -f "$downloaded_validator"
      return 1
    fi
  fi
  local status=0
  bun "$validator" "$target" "$target_branch" || status=$?
  [ -z "$downloaded_validator" ] || /bin/rm -f "$downloaded_validator"
  return "$status"
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
      safe_git -C "$target" fetch origin "$target_branch"
      safe_git -C "$target" branch --set-upstream-to="origin/$target_branch" "$target_branch"
      safe_git -C "$target" merge --ff-only "origin/$target_branch"
    elif repo_is_clean "$target" && [ "$current_branch" = "main" ] && [ "$target_branch" != "main" ]; then
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
}

install_repositories() {
  section "ゼロくんリポジトリ"
  ensure_repo zerocolored/zero "$REPO_DIR" codex
  ok "リポジトリを配置しました"
}

ensure_project_workspace() {
  section "Slack作業repository"
  /bin/mkdir -p "$PROJECT_DIR"
  local repo_real project_real
  repo_real="$(resolve_dir "$REPO_DIR")" || fail "zero repositoryを解決できません: $REPO_DIR"
  project_real="$(resolve_dir "$PROJECT_DIR")" || fail "project directoryを解決できません: $PROJECT_DIR"
  [ "$repo_real" != "$project_real" ] \
    || fail "Slackのwrite jobからruntimeを守るため、--project-dirはzero repositoryと別にしてください"
  if [ ! -e "$PROJECT_DIR/.git" ]; then
    safe_git init --initial-branch=main "$PROJECT_DIR" >/dev/null
  fi
  ok "Slack作業repository: $PROJECT_DIR"
}

run_setup() {
  section "ゼロくん配線"
  [ -f "$REPO_DIR/zerokun/setup.sh" ] || fail "setup.shがありません: $REPO_DIR/zerokun/setup.sh"
  ZEROKUN_BOOTSTRAP=1 ZEROKUN_PROJECT_DIR="$PROJECT_DIR" ZEROKUN_STATE_DIR="$STATE_DIR" \
    /bin/bash "$REPO_DIR/zerokun/setup.sh"
}

slack_tokens_ready() {
  local env_file="$STATE_DIR/.env"
  local content
  content="$(bun "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$env_file" 2>/dev/null)" \
    || return 1
  printf '%s\n' "$content" | /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9._-]{10,}$' \
    && printf '%s\n' "$content" | /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9._-]{10,}$'
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
    existing="$(bun "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$env_file")" \
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
  if ! bun "$REPO_DIR/zerokun/safe-file.ts" atomic-write-private "$env_file" < "$temp_file"; then
    /bin/rm -f "$temp_file"
    fail "Slack tokenを安全に保存できません"
  fi
  /bin/rm -f "$temp_file"
}

configure_access() {
  local access_file="$STATE_DIR/access.json"
  local existing_access=""
  if [ -e "$access_file" ] || [ -L "$access_file" ]; then
    existing_access="$(bun "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$access_file")" \
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
  ZEROKUN_STATE_DIR="$STATE_DIR" bun "$REPO_DIR/zerokun/access.ts" policy allowlist >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun "$REPO_DIR/zerokun/access.ts" allow "$user_id" >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun "$REPO_DIR/zerokun/access.ts" channel add "$channel_id" >/dev/null
  ZEROKUN_STATE_DIR="$STATE_DIR" bun "$REPO_DIR/zerokun/access.ts" channel allow "$channel_id" "$user_id" >/dev/null
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
    ZEROKUN_ROUTE_PROJECT="$PROJECT_DIR" bun -e '
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
    printf '   Slack Appの表示名（例: ゼロくん-新Mac、35文字以内）: '
    IFS= read -r SLACK_APP_NAME
  fi
  if [ -z "$SLACK_BOT_USERNAME" ]; then
    printf '   Slack bot username（英小文字・数字・-・_・.） [zerokun-new-mac]: '
    IFS= read -r entered_name
    SLACK_BOT_USERNAME="${entered_name:-zerokun-new-mac}"
  fi
  validate_slack_names
}

render_slack_manifest() {
  local source_manifest="$1"
  local target_manifest="$2"
  validate_slack_names
  /usr/bin/awk -v app_name="$SLACK_APP_NAME" -v bot_username="$SLACK_BOT_USERNAME" '
    $0 == "  name: Zero-kun Custom" {
      print "  name: \"" app_name "\""
      app_name_replaced = 1
      next
    }
    $0 == "    display_name: zerokun-custom" {
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
  bun "$REPO_DIR/zerokun/managed-path.ts" prepare-root "$STATE_DIR" >/dev/null \
    || fail "state directoryを安全に準備できませんでした: $STATE_DIR"
  bun "$REPO_DIR/zerokun/safe-file.ts" validate-existing \
    "$STATE_DIR/.env" "$STATE_DIR/access.json" "$STATE_DIR/routes.json" \
    || fail "既存のSlack設定fileが安全ではありません"
  section "Slack App"
  if [ "$SKIP_SLACK" = "1" ]; then
    warn "--skip-slackにより省略しました"
    return
  fi
  if slack_tokens_ready; then
    ok "Slackトークンは設定済みです"
    configure_access
    return
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
  if ! bun "$REPO_DIR/zerokun/safe-file.ts" atomic-write-private "$generated_manifest" < "$temp_manifest"; then
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
   Appを既に作成済みなら、新しく作らず既存Appのトークンを使用してください。
EOF
  local bot_token app_token
  read_slack_token xapp 'App-Level Token（xapp-）' SLACK_APP_TOKEN
  app_token="$SLACK_TOKEN_RESULT"
  read_slack_token xoxb 'Bot User OAuth Token（xoxb-）' SLACK_BOT_TOKEN
  bot_token="$SLACK_TOKEN_RESULT"
  save_slack_tokens "$bot_token" "$app_token"
  ok "Slackトークンを権限600で保存しました"
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
    echo "== ゼロくん Slack設定だけ再開 =="
    configure_slack
    section "Slack設定完了"
    echo "   新しいターミナルで実行: zerokun"
    return
  fi

  echo "== ゼロくん macOS bootstrap =="
  install_clt
  install_homebrew
  install_cli_tools
  ensure_logins
  install_repositories
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
    echo "   Slack Appを対象チャンネルへ招待後、新しいターミナルで実行: zerokun"
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
