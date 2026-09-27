#!/usr/bin/env bash
# 新しいMacへZeroちゃんを導入する手順を1コマンドにまとめる。
#
# bootstrap-macos.sh が導入するのはZeroちゃんruntimeまでで、
# codex-configのglobal AGENTS.md配置、Slack channelの紐付け、起動は別作業として残る。
# 新しいMacを立ち上げるたび、この残りを手で順番に叩いていた。それをまとめる。
#
# 実行する順番:
#   1. bootstrap-macos.sh --skip-slack     CLI一式(Herdr / Codex / Grok / Claude Code / Bun)
#   2. macOS権限(TCC)の判定と案内          フルディスク / アクセシビリティ / 画面収録
#   3. codex-config を clone し install.py  global AGENTS.md と instruction上限
#   4. Chrome拡張 (Claude / ChatGPT) と go-chrome-mcp の導入
#   5. bootstrap-macos.sh --slack-only      Slack App作成とtoken登録
#   6. zerochan set slack-channel           指定channelを対象projectへ紐付け
#   7. zerochan start                       起動
#
# TCCの許可はscriptから付与できない(TCC.dbはSIP保護、tccutilはresetのみ)。判定と
# 設定paneの提示までを自動化し、付与そのものは本人が押す。押したら同じ判定へ戻る。
#
# login(Codex / Grok / Claude Code / GitHub CLI)はブラウザ認証のため自動化しない。
# 未loginの段階で停止し、実行すべきcommandを表示する。login後に同じcommandで再開できる。
#
# 使い方:
#   bash zerokun/quick-setup.sh --project /path/to/project \
#     --app-name 'Zeroちゃん-新Mac' --bot-name zerochan-new-mac \
#     --channel C0123456789 --channel C0987654321
#
#   bash zerokun/quick-setup.sh --doctor            何も変更せず状態だけ表示
#   bash zerokun/quick-setup.sh --skip-slack        Slack設定を省略
#   bash zerokun/quick-setup.sh --skip-permissions  TCCの判定を省略
#   bash zerokun/quick-setup.sh --skip-chrome       Chrome拡張を省略
#   bash zerokun/quick-setup.sh --skip-go-chrome-mcp go-chrome-mcpを省略
#   bash zerokun/quick-setup.sh --force-extensions  Chrome拡張のpolicy設定値を書き込む (適用は別途確認)
#   bash zerokun/quick-setup.sh --no-wait           本人操作を待たず通常の導入を進める
#
# Herdr serverが動いていないと`zerochan start`はworkspace createに失敗する。
# Herdrのpane内で実行するか、先に`herdr`でserverを起動しておく。

set -euo pipefail
unset BUN_OPTIONS BUN_CONFIG_PRELOAD NODE_OPTIONS

SCRIPT_DIR="$(CDPATH='' cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(CDPATH='' cd -P "$SCRIPT_DIR/.." && pwd -P)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap-macos.sh"

PROJECT_ROOT="$(dirname "$REPO_DIR")"
CODEX_CONFIG_DIR="${CODEX_CONFIG_DIR:-$PROJECT_ROOT/codex-config}"
CODEX_CONFIG_REPO="${CODEX_CONFIG_REPO:-https://github.com/zerocolored/codex-config.git}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
GO_CHROME_MCP_DIR="${GO_CHROME_MCP_DIR:-$PROJECT_ROOT/go-chrome-mcp}"
GO_CHROME_MCP_REPO="${GO_CHROME_MCP_REPO:-https://github.com/ernie1358/go-chrome-mcp.git}"

TARGET_PROJECT="${ZEROKUN_PROJECT_DIR:-$PROJECT_ROOT/zerokun-workspace}"
SLACK_APP_NAME=""
SLACK_BOT_NAME=""
SLACK_CHANNELS=()
DOCTOR=0
SKIP_SLACK=0
SKIP_CODEX_CONFIG=0
SKIP_PERMISSIONS=0
SKIP_CHROME=0
SKIP_GO_CHROME_MCP=0
FORCE_EXTENSIONS=0
WAIT_FOR_GRANT=1
MANUAL_PENDING=()

# このMacで実際に使っている拡張。すべてWeb Store配布のため policy でも install できる。
CHROME_EXTENSIONS=(
  "fcoeoabgfenejglbffodgkkbkcdhcgfn:Claude"
  "hehggadaopoacecdllhhajmbjkdcmajg:ChatGPT"
)

usage() {
  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--project-dir)
      [ "$#" -ge 2 ] || { echo "$1 に値がありません" >&2; exit 2; }
      TARGET_PROJECT="$2"; shift ;;
    --app-name|--slack-app-name)
      [ "$#" -ge 2 ] || { echo "$1 に値がありません" >&2; exit 2; }
      SLACK_APP_NAME="$2"; shift ;;
    --bot-name|--slack-bot-name)
      [ "$#" -ge 2 ] || { echo "$1 に値がありません" >&2; exit 2; }
      SLACK_BOT_NAME="$2"; shift ;;
    --channel)
      [ "$#" -ge 2 ] || { echo "--channel に値がありません" >&2; exit 2; }
      SLACK_CHANNELS+=("$2"); shift ;;
    --chrome-extension)
      [ "$#" -ge 2 ] || { echo "--chrome-extension に値がありません" >&2; exit 2; }
      case "$2" in *:*) CHROME_EXTENSIONS+=("$2") ;; *) CHROME_EXTENSIONS+=("$2:$2") ;; esac
      shift ;;
    --doctor) DOCTOR=1 ;;
    --skip-slack) SKIP_SLACK=1 ;;
    --skip-codex-config) SKIP_CODEX_CONFIG=1 ;;
    --skip-permissions) SKIP_PERMISSIONS=1 ;;
    --skip-chrome) SKIP_CHROME=1 ;;
    --skip-go-chrome-mcp) SKIP_GO_CHROME_MCP=1 ;;
    --force-extensions) FORCE_EXTENSIONS=1 ;;
    --no-wait) WAIT_FOR_GRANT=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for extension in "${CHROME_EXTENSIONS[@]}"; do
  [[ "${extension%%:*}" =~ ^[a-p]{32}$ ]] \
    || { echo "Chrome拡張IDはa-pの32文字で指定してください" >&2; exit 2; }
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✅ %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m⚠️  %s\033[0m\n' "$1"; }
fail() { printf '  \033[31m❌ %s\033[0m\n' "$1" >&2; exit 1; }

# ------------------------------------------------- macOS権限 / Chrome拡張の共通処理
#
# TCCの許可はscriptから付与できない。TCC.dbはSIP保護で書き込めず、tccutilはresetしか持たない。
# ここでできるのは「現状の判定」と「不足している設定paneを開いて対象を提示する」ところまで。
# 付与そのものは本人操作で、押し終わったら同じ判定へ戻る。
#
# 判定はTCC.dbを直接読む。systemのTCC.dbはフルディスクアクセスが無いと読めないため、
# 「読めたか」がそのままフルディスクアクセスの判定になる。

SYS_TCC="/Library/Application Support/com.apple.TCC/TCC.db"

tcc_db_readable() {
  command -v sqlite3 >/dev/null 2>&1 || return 1
  sqlite3 -readonly "$SYS_TCC" 'select 1 from access limit 1;' >/dev/null 2>&1
}

# tcc_auth <service> <client> -> 2=許可 / 0=拒否 / 空=未設定
tcc_auth() {
  sqlite3 -readonly "$SYS_TCC" \
    "select max(auth_value) from access where service='$1' and client='$2';" 2>/dev/null || true
}

open_pane() { open "x-apple.systempreferences:com.apple.preference.security?$1" >/dev/null 2>&1 || true; }

# Zeroちゃんを動かすterminal.appを特定する。TCCはCLIではなくこのappに対して付く。
# Herdr(tmux系)の中ではserverがlaunchdへ付け替えられるため親prosessを遡っても
# terminal.appに届かない。そのため次の順で決める。
#   1. --terminal-app で明示
#   2. 親prosessを遡って見つかった .app
#   3. TERM_PROGRAM
#   4. 見つからない場合は、install済みのterminal.app全部の状態を並べる
TERMINAL_CANDIDATES=(
  "/System/Applications/Utilities/Terminal.app"
  "/Applications/Utilities/Terminal.app"
  "/Applications/Muxy.app"
  "/Applications/cmux.app"
  "/Applications/Ghostty.app"
  "/Applications/iTerm.app"
  "/Applications/Warp.app"
  "/Applications/WezTerm.app"
  "/Applications/kitty.app"
  "/Applications/Alacritty.app"
  "/Applications/Hyper.app"
)

host_app_path() {
  local pid="$PPID" exe app=""
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    exe="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$exe" in
      */*.app/Contents/MacOS/*) app="${exe%%.app/Contents/MacOS/*}.app"; break ;;
    esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  done
  if [ -z "$app" ]; then
    case "${TERM_PROGRAM:-}" in
      Apple_Terminal) app="/System/Applications/Utilities/Terminal.app" ;;
      iTerm.app) app="/Applications/iTerm.app" ;;
      ghostty) app="/Applications/Ghostty.app" ;;
      WarpTerminal) app="/Applications/Warp.app" ;;
      WezTerm) app="/Applications/WezTerm.app" ;;
    esac
    [ -d "${app:-/nonexistent}" ] || app=""
  fi
  [ -n "$app" ] && printf '%s\n' "$app"
}

app_bundle_id() {
  local app="$1"
  [ -n "$app" ] && [ -d "$app" ] || return 1
  defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null
}

mark() { case "$1" in 2) printf '✅' ;; 0) printf '🚫' ;; *) printf '—' ;; esac; }

# Zeroちゃんが動かすCLIの実体path。これ自体がTCCのclientとして登録される。
runtime_binaries() {
  local cli p
  for cli in codex claude grok bun node python3; do
    p="$(command -v "$cli" 2>/dev/null)" || continue
    p="$(readlink -f "$p" 2>/dev/null || printf '%s' "$p")"
    printf '%s\n' "$p"
  done
  printf '%s\n' /bin/bash
}

pause_for_grant() {
  [ "$WAIT_FOR_GRANT" = 1 ] || return 0
  [ -t 0 ] || return 0
  local answer=""
  read -r -p "  許可を与えたらEnter (s + Enter で後回し): " answer || true
  [ "$answer" = "s" ] && return 1
  return 0
}

# ------------------------------------------------------------------ macOS権限
# $1 = check  判定だけ / fix  不足していれば設定paneを開いて案内する
check_permissions() {
  local mode="$1" app app_id ready=0 shown=0

  step "macOS権限 (TCC)"

  # 1. フルディスクアクセス。systemのTCC.dbを読めるかどうかがそのまま判定になる。
  #    Zeroちゃんの既定の置き場 ~/Desktop/Project はTCC保護下で、launchd/cron経由の
  #    実行はこれが無いと Operation not permitted で止まる。
  if tcc_db_readable; then
    ok "フルディスクアクセス: この実行元は許可済み"
  else
    warn "フルディスクアクセス: 未許可 (TCC.dbが読めないため他の判定もできません)"
    if [ "$mode" = fix ]; then
      printf '    「フルディスクアクセス」へ次を追加します(pathはclipboardへ入れました)。\n'
      printf '      ・使用中のterminal.app\n'
      runtime_binaries | sed 's/^/      ・/'
      runtime_binaries | pbcopy 2>/dev/null || true
      open_pane Privacy_AllFiles
      pause_for_grant || { MANUAL_PENDING+=("macOSのフルディスクアクセスを確認してください"); return 0; }
      if tcc_db_readable; then
        ok "フルディスクアクセス: 許可を確認"
      else
        warn "まだ反映されていません。terminal.appを再起動してから再実行してください"
        MANUAL_PENDING+=("macOSのフルディスクアクセスを確認してください")
        return 0
      fi
    else
      return 0
    fi
  fi

  # 2. アクセシビリティ / 画面収録 / フルディスクアクセスを、terminal.app単位で並べる。
  app="$(host_app_path || true)"
  app_id="$(app_bundle_id "$app" || true)"
  [ -n "$app_id" ] && ok "実行元と判定: $app_id" \
    || warn "実行元のterminal.appを特定できません (Herdrの中では親prosessを遡れません)"

  echo "    ゼロちゃんを動かすterminal.appに次の3つが必要です。"
  echo "      列: アクセシビリティ / 画面収録 / フルディスクアクセス   ✅許可 🚫拒否 —未設定"

  local cand cid a s_ f
  for cand in "${TERMINAL_CANDIDATES[@]}"; do
    cid="$(app_bundle_id "$cand" || true)"
    [ -n "$cid" ] || continue
    a="$(tcc_auth kTCCServiceAccessibility "$cid")"
    s_="$(tcc_auth kTCCServiceScreenCapture "$cid")"
    f="$(tcc_auth kTCCServiceSystemPolicyAllFiles "$cid")"
    shown=1
    printf '      %s %s %s  %s%s\n' "$(mark "$a")" "$(mark "$s_")" "$(mark "$f")" "$cid" \
      "$([ "$cid" = "${app_id:-}" ] && printf ' ← 実行中' || true)"
    # 実行元を特定できている場合はそのappだけを判定対象にする。
    if [ "$a" = 2 ] && [ "$s_" = 2 ] && [ "$f" = 2 ]; then
      if [ -z "${app_id:-}" ] || [ "$cid" = "$app_id" ]; then
        ready=1
      fi
    fi
  done
  [ "$shown" = 1 ] || warn "候補のterminal.appが見つかりませんでした"

  if [ "$ready" = 1 ]; then
    ok "3つとも揃っているterminal.appがあります"
  else
    warn "3つ揃っているterminal.appがありません"
    if [ "$mode" = fix ]; then
      MANUAL_PENDING+=("macOSのアクセシビリティ・画面収録・フルディスクアクセスを再確認してください")
      echo "    設定paneを順に開きます。使うterminal.appを追加してチェックを入れてください。"
      for pane in Privacy_Accessibility Privacy_ScreenCapture Privacy_AllFiles; do
        open_pane "$pane"
        pause_for_grant || break
      done
    fi
  fi

  # 3. オートメーション(AppleEvents)は事前付与ができない。初回利用時のdialogで許可する。
  echo "    ※ オートメーション(Apple Events)は事前に付与できません。"
  echo "      Slack / Chrome を最初に操作したときのdialogで許可してください。"
  echo "      誤って拒否した場合: tccutil reset AppleEvents ${app_id:-<bundle id>}"
  return 0
}

# ------------------------------------------------------------------ Chrome拡張
# 既定は Web Store のページを開いて本人に追加してもらう。
# --force-extensions はpolicy設定値の書込みだけを行い、適用は本人が確認する。
check_chrome() {
  local mode="$1" id name found profile any_missing=0
  step "Chrome拡張"

  if [ ! -d "$HOME/Library/Application Support/Google/Chrome" ]; then
    warn "Google Chromeのprofileが見つかりません。Chromeを一度起動してから再実行してください"
    [ "$mode" != fix ] || MANUAL_PENDING+=("Chromeを起動して拡張の導入を確認してください")
    return 0
  fi

  for entry in "${CHROME_EXTENSIONS[@]}"; do
    id="${entry%%:*}"; name="${entry#*:}"
    found=0
    for profile in "$HOME/Library/Application Support/Google/Chrome"/*/Extensions; do
      [ -d "$profile/$id" ] && found=1 && break
    done
    if [ "$found" = 1 ]; then
      ok "$name: 導入済み"
      continue
    fi
    any_missing=1
    warn "$name: 未導入 ($id)"
    [ "$mode" = fix ] || continue
    MANUAL_PENDING+=("Chrome拡張 $name の導入・有効化を確認してください")

    if [ "$FORCE_EXTENSIONS" = 1 ]; then
      # defaultsはrecommended levelであり、強制導入の適用成功を保証しない。
      # 設定値の書込みとChromeでの有効性確認を区別する。
      if sudo defaults read /Library/Preferences/com.google.Chrome ExtensionInstallForcelist 2>/dev/null | grep -q "$id"; then
        warn "$name: 設定値は登録済みですが、強制導入の適用は未確認です"
      else
        sudo defaults write /Library/Preferences/com.google.Chrome ExtensionInstallForcelist \
          -array-add "$id;https://clients2.google.com/service/update2/crx"
        warn "$name: 設定値を書き込みましたが、強制導入の適用は未確認です"
      fi
    else
      open "https://chromewebstore.google.com/detail/$id" >/dev/null 2>&1 || true
      echo "    Web Storeを開きました。「Chromeに追加」を押してください。"
      pause_for_grant || true
    fi
  done

  if [ "$any_missing" = 1 ] && [ "$mode" = fix ] && [ "$FORCE_EXTENSIONS" = 1 ]; then
    echo "    chrome://policy で適用を確認してください。defaults方式は強制導入を保証しません。"
    echo "    強制導入が必要なら、管理者がChromeの構成profile/MDMで配布してください。"
    echo "    ※ policyを外す場合は、管理者が今回追加した拡張IDだけを取り除いてください。"
    echo "      他の拡張のpolicyは残してください。"
  fi
  return 0
}

# Grok Buildは ~/.grok/bin へ入り、bootstrap直後のshellではPATHに乗っていない。
# Homebrewとbunも、profileを読み直していないshellから呼べるようにしておく。
CALLER_PATH="$PATH"
export PATH="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# ------------------------------------------------------------ go-chrome-mcp
# ClaudeやCodexから実Chromeを操作するMCP。Web Storeには無く、unpackedで読み込む。
# unpackedの拡張はpolicyでinstallできないため、読み込みだけは本人がchrome://extensionsで行う。
# scriptが行うのは clone / npm install / MCP登録 / 読み込み済みかの判定。
setup_go_chrome_mcp() {
  local mode="$1" loaded=0

  step "go-chrome-mcp (実Chrome操作のMCP)"

  if [ "$mode" = fix ]; then
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      command -v brew >/dev/null 2>&1 || fail "Node.js/npmの導入に必要なHomebrewがありません"
      brew install node || fail "Node.js/npmを導入できません"
    fi
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
      || fail "Node.js/npmを解決できません"
  fi

  if [ -d "$GO_CHROME_MCP_DIR/.git" ]; then
    ok "clone済み: $GO_CHROME_MCP_DIR"
  elif [ "$mode" = fix ]; then
    mkdir -p "$(dirname "$GO_CHROME_MCP_DIR")"
    git clone "$GO_CHROME_MCP_REPO" "$GO_CHROME_MCP_DIR"
    ok "clone完了: $GO_CHROME_MCP_DIR"
  else
    warn "未clone: $GO_CHROME_MCP_DIR"
    return 0
  fi

  if [ -d "$GO_CHROME_MCP_DIR/node_modules" ]; then
    ok "依存: 導入済み"
  elif [ "$mode" = fix ]; then
    (cd "$GO_CHROME_MCP_DIR" && npm install --silent) \
      || fail "npm installに失敗したためMCP設定は登録しません"
    ok "npm install 完了"
  else
    warn "依存: 未導入"
  fi
  if [ "$mode" = fix ]; then
    (cd "$GO_CHROME_MCP_DIR" && npm ls --omit=dev --depth=0 >/dev/null 2>&1) \
      || fail "MCPの依存関係を確認できないため設定は登録しません"
  fi

  # Claude Code への登録 (~/.claude.json の mcpServers)
  if [ "$mode" != fix ]; then
    if python3 - "$HOME/.claude.json" <<'PY_CHECK'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as source:
        data = json.load(source)
    servers = data.get("mcpServers", {}) if isinstance(data, dict) else {}
    registered = isinstance(servers, dict) and "go-chrome-mcp" in servers
except (OSError, ValueError):
    registered = False
sys.exit(0 if registered else 1)
PY_CHECK
    then
      ok "Claude Code: 登録済み"
    else
      warn "Claude Code: 未登録"
    fi
  else
    [ -f "$GO_CHROME_MCP_DIR/mcp-broker.js" ] \
      || fail "mcp-broker.jsがありません。MCP設定は登録しません"
    python3 - "$HOME/.claude.json" "$GO_CHROME_MCP_DIR" <<'PY'
import json, os, stat, sys, tempfile
path, repo = sys.argv[1], sys.argv[2]
entry = {"type": "stdio", "command": "node",
         "args": [os.path.join(repo, "mcp-broker.js")], "env": {}}
data = {}
original = None
identity = None
def identity_of(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
if os.path.lexists(path):
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.getuid():
        raise SystemExit("既存Claude設定は通常fileではないため変更しません")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as f:
        identity = identity_of(os.fstat(f.fileno()))
        if identity != identity_of(metadata): raise SystemExit("Claude設定が変化したため変更しません")
        original = f.read()
    data = json.loads(original)
servers = data.setdefault("mcpServers", {})
if "go-chrome-mcp" in servers:
    print("  ✅ Claude Code: 既存MCP設定を保持 (無効化や独自設定も変更しません)")
else:
    servers["go-chrome-mcp"] = entry
    if original is not None:
        backup, backup_path = tempfile.mkstemp(prefix=".claude.json.backup-", dir=os.path.dirname(path))
        with os.fdopen(backup, "w") as f:
            f.write(original); f.flush(); os.fsync(f.fileno())
    fd, temporary = tempfile.mkstemp(prefix=".claude.json.next-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush(); os.fsync(f.fileno())
        current = identity_of(os.lstat(path)) if os.path.lexists(path) else None
        if current != identity: raise SystemExit("Claude設定が並行更新されたため変更しません")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print("  ✅ Claude Code: mcpServersへ登録 (~/.claude.json)")
PY
  fi

  # CLIにTOMLのparse/escapingを任せ、quoted tableや特殊文字pathも保持する。
  if CODEX_HOME="$CODEX_HOME" codex mcp get go-chrome-mcp >/dev/null 2>&1; then
    ok "Codex: 既存MCP設定を保持 (無効化や独自設定も変更しません)"
  elif [ "$mode" = fix ]; then
    CODEX_HOME="$CODEX_HOME" codex mcp add go-chrome-mcp -- node "$GO_CHROME_MCP_DIR/mcp-broker.js" >/dev/null \
      || fail "CodexへのMCP登録に失敗しました"
    ok "Codex: config.tomlへ登録"
  else
    warn "Codex: 未登録"
  fi

  # 拡張が読み込まれているか。unpackedは location=4 と実path で判定できる。
  loaded="$(python3 - "$GO_CHROME_MCP_DIR" <<'PY'
import glob, json, os, sys
repo = os.path.realpath(sys.argv[1])
root = os.path.expanduser("~/Library/Application Support/Google/Chrome")
for f in glob.glob(os.path.join(root, "*", "Secure Preferences")):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    for ext in d.get("extensions", {}).get("settings", {}).values():
        p = ext.get("path", "")
        if p and ext.get("location") == 4 and ext.get("state") == 1 and os.path.realpath(p) == repo:
            print(os.path.basename(os.path.dirname(f)))
            sys.exit(0)
print("")
PY
)"

  if [ -n "$loaded" ]; then
    ok "Chrome拡張: 読み込み済み ($loaded)"
  else
    warn "Chrome拡張: 未読み込み"
    [ "$mode" != fix ] || MANUAL_PENDING+=("go-chrome-mcp拡張の読み込み・有効化を確認してください")
    echo "    unpackedの拡張はpolicyでinstallできません。次は本人操作です。"
    echo "      1. Chromeで chrome://extensions を開く (コマンドラインからは開けません)"
    echo "      2. 「デベロッパーモード」をON"
    echo "      3. 「パッケージ化されていない拡張機能を読み込む」"
    echo "      4. $GO_CHROME_MCP_DIR を選ぶ"
    if [ "$mode" = fix ]; then
      printf '%s' "$GO_CHROME_MCP_DIR" | pbcopy 2>/dev/null \
        && echo "    (pathはclipboardへ入れました。⇧⌘G で貼れます)"
    fi
    [ "$mode" = fix ] && { pause_for_grant || true; }
  fi
  return 0
}

[ -f "$BOOTSTRAP" ] || fail "bootstrap-macos.sh が見つかりません: $BOOTSTRAP"

echo "== Zeroちゃん quick setup =="
echo "   repo: $REPO_DIR"

if [ "$DOCTOR" = 1 ]; then
  doctor_status=0
  PATH="$CALLER_PATH" bash "$BOOTSTRAP" --doctor || doctor_status=1
  [ "$SKIP_PERMISSIONS" = 1 ] || check_permissions check
  [ "$SKIP_CHROME" = 1 ] || check_chrome check
  [ "$SKIP_GO_CHROME_MCP" = 1 ] || setup_go_chrome_mcp check
  exit "$doctor_status"
fi


# ------------------------------------------------------------------ 1. 基本導入
bootstrap_args=(--repo-dir "$REPO_DIR")
if [ -n "$TARGET_PROJECT" ]; then
  [ ! -e "$TARGET_PROJECT" ] || [ -d "$TARGET_PROJECT" ] \
    || fail "対象projectはdirectoryで指定してください: $TARGET_PROJECT"
  if [ -d "$TARGET_PROJECT" ]; then
    TARGET_PROJECT="$(CDPATH='' cd -P "$TARGET_PROJECT" && pwd -P)"
  else
    case "$TARGET_PROJECT" in /*) ;; *) TARGET_PROJECT="$PWD/$TARGET_PROJECT" ;; esac
  fi
  [ "$TARGET_PROJECT" != "$REPO_DIR" ] || fail "対象projectはZeroちゃん本体と別にしてください"
  bootstrap_args+=(--project-dir "$TARGET_PROJECT")
elif [ "${#SLACK_CHANNELS[@]}" -gt 0 ]; then
  fail "--channelには--projectが必要です"
fi
step "基本導入 (Herdr / Codex CLI / Grok Build / Claude Code / Bun)"
bash "$BOOTSTRAP" --skip-slack "${bootstrap_args[@]}"
ok "基本導入 完了"

# ------------------------------------------------------------------ 2. login確認
step "login状態の確認"

missing=()
for cli in codex grok gh; do
  command -v "$cli" >/dev/null 2>&1 || missing+=("$cli")
done

if [ "${#missing[@]}" -gt 0 ]; then
  warn "PATHから見つからないCLI: ${missing[*]}"
  cat <<'EOF'
    新しいterminalを開くか、profileを読み直してから再実行してください。
    導入先の既定は次のとおりです。
      grok  : ~/.grok/bin/grok
      bun   : ~/.bun/bin/bun
      その他: /opt/homebrew/bin
EOF
  fail "CLIを解決できないため中断"
fi
ok "CLIを解決"

cat <<'EOF'

  ※ 次のloginはブラウザ認証のため自動化しません。未了なら別terminalで実施します。
      codex login
      grok login
      gh auth login --hostname github.com --git-protocol https --web
      claude            (Herdrの一時paneで起動しsubscription loginを完了して終了する)
EOF

# ------------------------------------------------- 3. macOS権限 / Chrome拡張
if [ "$SKIP_PERMISSIONS" = 1 ]; then
  warn "--skip-permissions によりTCCの判定を省略"
else
  check_permissions fix
fi

# ------------------------------------------------------------ 4. codex-config
if [ "$SKIP_CODEX_CONFIG" = 1 ]; then
  warn "--skip-codex-config によりglobal AGENTS.mdの配置を省略"
else
  step "codex-config を配置 (global AGENTS.md)"

  if [ -d "$CODEX_CONFIG_DIR/.git" ]; then
    ok "clone済み: $CODEX_CONFIG_DIR"
  else
    mkdir -p "$(dirname "$CODEX_CONFIG_DIR")"
    git clone "$CODEX_CONFIG_REPO" "$CODEX_CONFIG_DIR"
    ok "clone完了: $CODEX_CONFIG_DIR"
  fi

  [ -f "$CODEX_CONFIG_DIR/install.py" ] \
    || fail "install.py がありません: $CODEX_CONFIG_DIR/install.py"

  # --backup    上書き前に ~/.codex-config-backups/ へ退避する
  # --ensure-doc-limit
  #             codex-configのglobal AGENTS.mdはCodexの既定instruction上限32KiBを超える。
  #             config.tomlのproject_doc_max_bytesを引き上げないと末尾が読み込まれない。
  python3 "$CODEX_CONFIG_DIR/install.py" --backup --ensure-doc-limit
  ok "install.py 適用完了"

  if [ -f "$CODEX_HOME/AGENTS.md" ]; then
    ok "配置確認: $CODEX_HOME/AGENTS.md ($(wc -c < "$CODEX_HOME/AGENTS.md" | tr -d ' ') bytes)"
  else
    fail "$CODEX_HOME/AGENTS.md が作られていません"
  fi

  if [ -f "$CODEX_CONFIG_DIR/setup_herdr.py" ] && command -v herdr >/dev/null 2>&1; then
    if python3 "$CODEX_CONFIG_DIR/setup_herdr.py" --dry-run >/dev/null 2>&1; then
      python3 "$CODEX_CONFIG_DIR/setup_herdr.py"
      ok "Herdr連携 適用完了"
    else
      warn "Herdr連携をスキップ (setup_herdr.py --dry-run が通らない)"
    fi
  fi
fi

# --------------------------------------------- 5. Chrome拡張 / go-chrome-mcp
if [ "$SKIP_CHROME" = 1 ]; then
  warn "--skip-chrome によりChrome拡張を省略"
else
  check_chrome fix
fi

# go-chrome-mcpのCodex登録はconfig.tomlへ追記するため、codex-configの適用より後に行う。
if [ "$SKIP_GO_CHROME_MCP" = 1 ]; then
  warn "--skip-go-chrome-mcp によりgo-chrome-mcpを省略"
else
  setup_go_chrome_mcp fix
fi

# ------------------------------------------------------------------ 6. Slack
if [ "$SKIP_SLACK" = 1 ]; then
  warn "--skip-slack によりSlack設定を省略"
else
  step "Slack App 設定"
  echo "  ※ 同時稼働するMacではSlack Appを分けます。既存Appを共有すると状態が分断されます。"
  echo "  ※ token (xapp- / xoxb-) は表示されないpromptへ直接貼ります。chatへ送らないでください。"

  slack_args=(--slack-only "${bootstrap_args[@]}")
  [ -n "$SLACK_APP_NAME" ] && slack_args+=(--slack-app-name "$SLACK_APP_NAME")
  [ -n "$SLACK_BOT_NAME" ] && slack_args+=(--slack-bot-name "$SLACK_BOT_NAME")
  bash "$BOOTSTRAP" "${slack_args[@]}"
  ok "Slack設定 完了"
fi

# -------------------------------------------------------------- 7. channel紐付け
if [ "${#SLACK_CHANNELS[@]}" -eq 0 ]; then
  warn "--channel の指定が無いため紐付けを省略"
  echo "    後から行う場合: cd <project> && zerochan set slack-channel <ID>"
else
  step "Slack channelの紐付け"
  [ -n "$TARGET_PROJECT" ] || fail "--project が未指定のためchannelを紐付けできません"
  [ -d "$TARGET_PROJECT" ] || fail "対象projectがありません: $TARGET_PROJECT"
  cd "$TARGET_PROJECT"
  ok "対象project: $TARGET_PROJECT"

  for ch in "${SLACK_CHANNELS[@]}"; do
    if zerochan set slack-channel "$ch"; then
      ok "紐付け: $ch"
    else
      fail "紐付け失敗: $ch。起動せず停止しました"
    fi
  done
fi

# ------------------------------------------------------------------ 7. 起動
step "起動"

if ! herdr status >/dev/null 2>&1; then
  warn "Herdr serverの稼働を確認できません"
  echo "    Herdrの外で実行している場合、zerochan startはworkspace createに失敗します。"
  echo "    先に 'herdr' でserverを起動し、そのpane内で実行し直してください。"
fi

[ -d "$TARGET_PROJECT" ] || fail "bootstrapが対象projectを作成していません: $TARGET_PROJECT"
cd "$TARGET_PROJECT"
zerochan start
ok "zerochan start 実行"

cat <<EOF

== 残りの手動作業 ==

  1. Slackの対象channelへAppを招待する
       /invite @<App表示名>
  2. Slackの実メンションまたはDMで応答を確認する

== よく使うcommand ==

  zerochan status            状態確認
  zerochan stop              停止
  zerochan stop --force      実行中jobごと強制停止
  zerochan update            更新
  python3 ${CODEX_CONFIG_DIR}/update.py   codex-configの更新

EOF

if [ "${#MANUAL_PENDING[@]}" -gt 0 ]; then
  for pending in "${MANUAL_PENDING[@]}"; do
    warn "未確認: $pending"
  done
fi
