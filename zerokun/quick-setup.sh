#!/usr/bin/env bash
# 新しいMacへZeroちゃんを導入する手順を1コマンドにまとめる。
#
# bootstrap-macos.sh が導入するのはZeroちゃんruntimeまでで、
# codex-configのglobal AGENTS.md配置、Slack channelの紐付け、起動は別作業として残る。
# 新しいMacを立ち上げるたび、この残りを手で順番に叩いていた。それをまとめる。
#
# 実行する順番:
#   1. bootstrap-macos.sh --skip-slack     CLI一式(Herdr / Codex / Grok / Claude Code / Bun)
#   2. codex-config を clone し install.py  global AGENTS.md と instruction上限
#   3. bootstrap-macos.sh --slack-only      Slack App作成とtoken登録
#   4. zerochan set slack-channel           指定channelを対象projectへ紐付け
#   5. zerochan start                       起動
#
# login(Codex / Grok / Claude Code / GitHub CLI)はブラウザ認証のため自動化しない。
# 未loginの段階で停止し、実行すべきcommandを表示する。login後に同じcommandで再開できる。
#
# 使い方:
#   bash zerokun/quick-setup.sh --project /path/to/project \
#     --app-name 'Zeroちゃん-新Mac' --bot-name zerochan-new-mac \
#     --channel C0123456789 --channel C0987654321
#
#   bash zerokun/quick-setup.sh --doctor        何も変更せず状態だけ表示
#   bash zerokun/quick-setup.sh --skip-slack    Slack設定を省略
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

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
    --doctor) DOCTOR=1 ;;
    --skip-slack) SKIP_SLACK=1 ;;
    --skip-codex-config) SKIP_CODEX_CONFIG=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明なオプション: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✅ %s\033[0m\n' "$1"; }
warn() { printf '  \033[33m⚠️  %s\033[0m\n' "$1"; }
fail() { printf '  \033[31m❌ %s\033[0m\n' "$1" >&2; exit 1; }

# Grok Buildは ~/.grok/bin へ入り、bootstrap直後のshellではPATHに乗っていない。
# Homebrewとbunも、profileを読み直していないshellから呼べるようにしておく。
export PATH="$HOME/.grok/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH"

[ -f "$BOOTSTRAP" ] || fail "bootstrap-macos.sh が見つかりません: $BOOTSTRAP"

echo "== Zeroちゃん quick setup =="
echo "   repo: $REPO_DIR"

if [ "$DOCTOR" = 1 ]; then
  exec bash "$BOOTSTRAP" --doctor
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

# ------------------------------------------------------------ 3. codex-config
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

# ------------------------------------------------------------------ 4. Slack
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

# -------------------------------------------------------------- 5. channel紐付け
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

# ------------------------------------------------------------------ 6. 起動
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
