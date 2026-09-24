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
#   3. Chrome拡張の判定と導入              Claude / Vimium / ChatGPT
#   4. codex-config を clone し install.py  global AGENTS.md と instruction上限
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
#   bash zerokun/quick-setup.sh --force-extensions  Chrome拡張をmachine policyで強制install
#   bash zerokun/quick-setup.sh --no-wait           本人操作の待ち合わせをせず判定だけ出す
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

TARGET_PROJECT="${ZEROKUN_PROJECT_DIR:-}"
SLACK_APP_NAME=""
SLACK_BOT_NAME=""
SLACK_CHANNELS=()
DOCTOR=0
SKIP_SLACK=0
SKIP_CODEX_CONFIG=0
SKIP_PERMISSIONS=0
SKIP_CHROME=0
FORCE_EXTENSIONS=0
WAIT_FOR_GRANT=1

# このMacで実際に使っている拡張。すべてWeb Store配布のため policy でも install できる。
CHROME_EXTENSIONS=(
  "fcoeoabgfenejglbffodgkkbkcdhcgfn:Claude"
  "dbepggeogbaibhgnhhndojpepiihcmeb:Vimium"
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
    --force-extensions) FORCE_EXTENSIONS=1 ;;
    --no-wait) WAIT_FOR_GRANT=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
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
  sqlite3 "$SYS_TCC" 'select 1 from access limit 1;' >/dev/null 2>&1
}

# tcc_auth <service> <client> -> 2=許可 / 0=拒否 / 空=未設定
tcc_auth() {
  sqlite3 "$SYS_TCC" \
    "select max(auth_value) from access where service='$1' and client='$2';" 2>/dev/null
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
      pause_for_grant || return 0
      if tcc_db_readable; then
        ok "フルディスクアクセス: 許可を確認"
      else
        warn "まだ反映されていません。terminal.appを再起動してから再実行してください"
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
# --force-extensions を付けた場合だけ、machine policy で強制installする。
check_chrome() {
  local mode="$1" id name found profile any_missing=0
  step "Chrome拡張"

  if [ ! -d "$HOME/Library/Application Support/Google/Chrome" ]; then
    warn "Google Chromeのprofileが見つかりません。Chromeを一度起動してから再実行してください"
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

    if [ "$FORCE_EXTENSIONS" = 1 ]; then
      # Chromeはmachine policyとして /Library/Preferences/com.google.Chrome を読む。
      # 全てWeb Store配布のためforcelistで入る。Chromeに「組織によって管理されています」が付く。
      if sudo defaults read /Library/Preferences/com.google.Chrome ExtensionInstallForcelist 2>/dev/null | grep -q "$id"; then
        ok "$name: policy登録済み (Chrome再起動で入ります)"
      else
        sudo defaults write /Library/Preferences/com.google.Chrome ExtensionInstallForcelist \
          -array-add "$id;https://clients2.google.com/service/update2/crx"
        ok "$name: policy登録 (Chrome再起動で入ります)"
      fi
    else
      open "https://chromewebstore.google.com/detail/$id" >/dev/null 2>&1 || true
      echo "    Web Storeを開きました。「Chromeに追加」を押してください。"
      pause_for_grant || true
    fi
  done

  if [ "$any_missing" = 1 ] && [ "$mode" = fix ] && [ "$FORCE_EXTENSIONS" = 1 ]; then
    echo "    ※ policyを外す場合:"
    echo "      sudo defaults delete /Library/Preferences/com.google.Chrome ExtensionInstallForcelist"
  fi
  return 0
}

# Grok Buildは ~/.grok/bin へ入り、bootstrap直後のshellではPATHに乗っていない。
# Homebrewとbunも、profileを読み直していないshellから呼べるようにしておく。
export PATH="$HOME/.grok/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

[ -f "$BOOTSTRAP" ] || fail "bootstrap-macos.sh が見つかりません: $BOOTSTRAP"

echo "== Zeroちゃん quick setup =="
echo "   repo: $REPO_DIR"

if [ "$DOCTOR" = 1 ]; then
  bash "$BOOTSTRAP" --doctor || true
  [ "$SKIP_PERMISSIONS" = 1 ] || check_permissions check
  [ "$SKIP_CHROME" = 1 ] || check_chrome check
  exit 0
fi

# ------------------------------------------------------------------ 1. 基本導入
step "基本導入 (Herdr / Codex CLI / Grok Build / Claude Code / Bun)"
bash "$BOOTSTRAP" --skip-slack
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

if [ "$SKIP_CHROME" = 1 ]; then
  warn "--skip-chrome によりChrome拡張を省略"
else
  check_chrome fix
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

# ------------------------------------------------------------------ 5. Slack
if [ "$SKIP_SLACK" = 1 ]; then
  warn "--skip-slack によりSlack設定を省略"
else
  step "Slack App 設定"
  echo "  ※ 同時稼働するMacではSlack Appを分けます。既存Appを共有すると状態が分断されます。"
  echo "  ※ token (xapp- / xoxb-) は表示されないpromptへ直接貼ります。chatへ送らないでください。"

  slack_args=(--slack-only)
  [ -n "$SLACK_APP_NAME" ] && slack_args+=(--slack-app-name "$SLACK_APP_NAME")
  [ -n "$SLACK_BOT_NAME" ] && slack_args+=(--slack-bot-name "$SLACK_BOT_NAME")
  bash "$BOOTSTRAP" "${slack_args[@]}"
  ok "Slack設定 完了"
fi

# -------------------------------------------------------------- 6. channel紐付け
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
      warn "紐付け失敗: $ch"
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

if [ -n "$TARGET_PROJECT" ] && [ -d "$TARGET_PROJECT" ]; then
  cd "$TARGET_PROJECT"
fi
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
