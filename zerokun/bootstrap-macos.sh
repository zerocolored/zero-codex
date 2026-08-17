#!/usr/bin/env bash
# Fresh macOS -> Zero-kun bootstrap.
# This file can be copied to a new Mac and run before the private repositories exist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_REPO_DIR="$HOME/Desktop/Project/claude-channel-slack"
if [ -d "$SCRIPT_DIR/../.git" ] && [ -f "$SCRIPT_DIR/../server.ts" ]; then
  DEFAULT_REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

REPO_DIR="${ZEROKUN_REPO_DIR:-$DEFAULT_REPO_DIR}"
PROJECT_DIR="${ZEROKUN_PROJECT_DIR:-$HOME/Desktop/Project/BellSalsesAI}"
MODE="install"
SKIP_LOGINS=0
SKIP_SLACK=0
SKIP_PROJECTS=0

usage() {
  cat <<'EOF'
Usage: bootstrap-macos.sh [options]

新しいMacへゼロくん一式を導入します。Command Line Toolsはバージョンを固定せず、
そのmacOSにAppleが提供する適合版を `xcode-select --install` で導入します。

Options:
  --doctor              何も変更せず、必要ツールとバージョンだけ確認
  --skip-logins         GitHub / Claude / Codexの対話ログインを呼び出さない
  --skip-slack          Slack App作成とトークン入力の案内を省略
  --skip-projects       BellSalesAIの4リポをcloneしない
  --repo-dir PATH       zeroリポの配置先
  --project-dir PATH    BellSalesAIの配置先
  -h, --help            このヘルプを表示

ログイン、macOSのインストール確認ダイアログ、Slack App作成だけは人の操作が必要です。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --doctor) MODE="doctor" ;;
    --skip-logins) SKIP_LOGINS=1 ;;
    --skip-slack) SKIP_SLACK=1 ;;
    --skip-projects) SKIP_PROJECTS=1 ;;
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

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

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

doctor_item() {
  local label="$1"
  local command_name="$2"
  shift 2
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '   %-20s %s\n' "$label:" "$(first_line "$command_name" "$@")"
  else
    printf '   %-20s %s\n' "$label:" '未導入'
    return 1
  fi
}

run_doctor() {
  local missing=0
  section "セットアップ診断（変更は行いません）"
  if clt_ready; then
    printf '   %-20s %s\n' 'Command Line Tools:' "$(clt_version)"
  else
    printf '   %-20s %s\n' 'Command Line Tools:' '未導入'
    missing=1
  fi
  doctor_item 'Homebrew' brew --version || missing=1
  doctor_item 'Git' git --version || missing=1
  doctor_item 'GitHub CLI' gh --version || missing=1
  doctor_item 'tmux' tmux -V || missing=1
  doctor_item 'Bun' bun --version || missing=1
  doctor_item 'Claude Code' claude --version || missing=1
  doctor_item 'Codex CLI' codex --version || missing=1
  [ "$missing" = "0" ] || return 1
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

persist_brew_path() {
  local brew_bin
  brew_bin="$(command -v brew)"
  local marker="# zerokun bootstrap: Homebrew"
  if ! /usr/bin/grep -Fq "$marker" "$HOME/.zprofile" 2>/dev/null; then
    {
      printf '\n%s\n' "$marker"
      printf 'eval "$(%s shellenv)"\n' "$brew_bin"
    } >> "$HOME/.zprofile"
  fi
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

install_cli_tools() {
  section "GitHub CLI / tmux / Claude Code / Codex CLI / Bun"
  if ! command -v gh >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1; then
    brew install gh tmux
  fi
  if ! command -v claude >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
    brew install --cask claude-code codex
  fi
  if ! command -v bun >/dev/null 2>&1; then
    /usr/bin/curl -fsSL https://bun.com/install | /bin/bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  if ! /usr/bin/grep -Fq '# zerokun bootstrap: Bun' "$HOME/.zprofile" 2>/dev/null; then
    cat >> "$HOME/.zprofile" <<'EOF'

# zerokun bootstrap: Bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
  fi
  for required in git gh tmux bun claude codex; do
    command -v "$required" >/dev/null 2>&1 || fail "$required の導入を確認できません"
  done
  ok "必要なCLIを導入しました"
}

ensure_logins() {
  section "アカウントログイン"
  if [ "$SKIP_LOGINS" = "1" ]; then
    warn "--skip-loginsにより省略しました"
    return
  fi
  require_interactive "GitHub / Claude / Codexログイン"
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "   GitHubへログインします（privateリポ取得に必要）"
    gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth setup-git
  if ! claude auth status >/dev/null 2>&1; then
    echo "   Claude Codeへログインします"
    claude auth login
  fi
  if ! codex login status >/dev/null 2>&1; then
    echo "   Codex CLIへログインします"
    codex login
  fi
  ok "GitHub / Claude / Codexのログインを確認しました"
}

repo_is_clean() {
  [ -z "$(git -C "$1" status --porcelain 2>/dev/null)" ]
}

ensure_repo() {
  local slug="$1"
  local target="$2"
  if [ -d "$target/.git" ]; then
    local remote
    remote="$(git -C "$target" remote get-url origin 2>/dev/null || true)"
    case "$remote" in
      *"$slug"*) ;;
      *) fail "既存ディレクトリのoriginが想定と違います: $target ($remote)" ;;
    esac
    if repo_is_clean "$target" && [ "$(git -C "$target" branch --show-current)" = "main" ]; then
      git -C "$target" pull --ff-only
    else
      warn "既存作業を守るため更新を省略: $target"
    fi
    return
  fi
  if [ -e "$target" ] && [ -n "$(/bin/ls -A "$target" 2>/dev/null)" ]; then
    fail "clone先が空ではありません: $target"
  fi
  /bin/mkdir -p "$(dirname "$target")"
  gh repo clone "$slug" "$target"
}

install_repositories() {
  section "ゼロくんと作業リポ"
  ensure_repo zerocolored/zero "$REPO_DIR"
  if [ "$SKIP_PROJECTS" != "1" ]; then
    ensure_repo zerocolored/skills "$PROJECT_DIR"
    ensure_repo zerocolored/bsb_front "$PROJECT_DIR/bsb_front"
    ensure_repo zerocolored/bsb_back "$PROJECT_DIR/bsb_back"
    ensure_repo zerocolored/meeting-app "$PROJECT_DIR/meeting-app"
  fi
  ok "リポジトリを配置しました"
}

run_setup() {
  section "ゼロくん配線"
  [ -f "$REPO_DIR/zerokun/setup.sh" ] || fail "setup.shがありません: $REPO_DIR/zerokun/setup.sh"
  ZEROKUN_BOOTSTRAP=1 ZEROKUN_PROJECT_DIR="$PROJECT_DIR" /bin/bash "$REPO_DIR/zerokun/setup.sh"
}

slack_tokens_ready() {
  local env_file="$HOME/.claude/channels/slack/.env"
  /usr/bin/grep -Eq '^SLACK_BOT_TOKEN=xoxb-[A-Za-z0-9-]{10,}$' "$env_file" 2>/dev/null \
    && /usr/bin/grep -Eq '^SLACK_APP_TOKEN=xapp-[A-Za-z0-9-]{10,}$' "$env_file" 2>/dev/null
}

save_slack_tokens() {
  local bot_token="$1"
  local app_token="$2"
  local env_file="$HOME/.claude/channels/slack/.env"
  local temp_file="$env_file.tmp.$$"
  umask 077
  : > "$temp_file"
  if [ -f "$env_file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        SLACK_BOT_TOKEN=*|SLACK_APP_TOKEN=*) ;;
        *) printf '%s\n' "$line" >> "$temp_file" ;;
      esac
    done < "$env_file"
  fi
  printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$bot_token" "$app_token" >> "$temp_file"
  /bin/mv "$temp_file" "$env_file"
  /bin/chmod 600 "$env_file"
}

configure_access() {
  local access_file="$HOME/.claude/channels/slack/access.json"
  if [ -f "$access_file" ] && ! /usr/bin/grep -q 'U_あなたのSlackユーザーID' "$access_file"; then
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
  umask 077
  cat > "$access_file" <<EOF
{
  "dmPolicy": "allowlist",
  "allowFrom": ["$user_id"],
  "channels": {
    "$channel_id": {
      "requireMention": true,
      "allowFrom": ["$user_id"]
    }
  },
  "pending": {}
}
EOF
  /bin/chmod 600 "$access_file"
  ok "Slack allowlistを設定しました"
}

configure_slack() {
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
  [ -f "$manifest" ] || fail "Slack manifestがありません: $manifest"
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy < "$manifest"
    echo "   Slack App manifestをクリップボードへコピーしました。"
  fi
  /usr/bin/open 'https://api.slack.com/apps?new_app=1' >/dev/null 2>&1 || true
  cat <<EOF
   ブラウザで Create New App → From a manifest を選び、manifestを貼り付けて作成します。
   次に App-Level Tokenを connections:write で生成してxapp-を取得し、
   Install to Workspace後にBot User OAuth Tokenのxoxb-を取得してください。
EOF
  local bot_token app_token
  printf '   xoxb-トークン: '
  IFS= read -r -s bot_token
  printf '\n   xapp-トークン: '
  IFS= read -r -s app_token
  printf '\n'
  printf '%s\n' "$bot_token" | /usr/bin/grep -Eq '^xoxb-[A-Za-z0-9-]{10,}$' \
    || fail "Bot Tokenのxoxb-形式が不正です"
  printf '%s\n' "$app_token" | /usr/bin/grep -Eq '^xapp-[A-Za-z0-9-]{10,}$' \
    || fail "App Tokenのxapp-形式が不正です"
  save_slack_tokens "$bot_token" "$app_token"
  ok "Slackトークンを権限600で保存しました"
  configure_access
}

main() {
  require_macos
  if [ "$MODE" = "doctor" ]; then
    run_doctor
    return
  fi

  echo "== ゼロくん macOS bootstrap =="
  install_clt
  install_homebrew
  install_cli_tools
  ensure_logins
  if [ "$SKIP_LOGINS" = "1" ] && ! gh auth status --hostname github.com >/dev/null 2>&1; then
    fail "privateリポ取得前に gh auth login を実行するか、--skip-loginsを外してください"
  fi
  install_repositories
  run_setup
  configure_slack

  section "完了"
  run_doctor
  echo "   Slack Appを対象チャンネルへ招待後、新しいターミナルで次を実行してください:"
  echo "   zerokun"
}

main
