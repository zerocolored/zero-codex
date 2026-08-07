#!/usr/bin/env bash
# ゼロくん新マシンセットアップ
# 使い方: リポを clone した直後に `bash zerokun/setup.sh` を1回実行するだけ。
# 既存の設定ファイル(.env / access.json 等)があるマシンでは上書きしない(再実行しても安全)。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CH="$HOME/.claude/channels/slack"
TPL="$REPO_DIR/zerokun/templates"

echo "== ゼロくんセットアップ開始 (repo: $REPO_DIR)"

# 0. 依存確認
command -v bun >/dev/null 2>&1 || { echo "❌ bun がありません → curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "❌ claude CLI がありません → https://claude.com/claude-code"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "❌ git がありません"; exit 1; }
(cd "$REPO_DIR" && bun install --silent)

# 1. 設定ディレクトリ
mkdir -p "$CH/inbox" "$CH/approved"

# 2. 設定ファイル(既存があれば触らない)
[ -f "$CH/access.json" ] || cp "$TPL/access.json.example" "$CH/access.json"
[ -f "$CH/.env" ] || { cp "$TPL/env.example" "$CH/.env"; chmod 600 "$CH/.env"; }
[ -f "$CH/zerokun-triage.md" ] || cp "$TPL/zerokun-triage.md" "$CH/zerokun-triage.md"

# mcp 定義はこのマシンのパスに合わせて毎回生成(中身は経路情報だけなので上書きOK)
sed -e "s|__BUN__|$(command -v bun)|" -e "s|__REPO__|$REPO_DIR|" \
  "$TPL/mcp.slack-channel.json.template" > "$CH/mcp.slack-channel.json"

# 3. オーナー重厚モード(CLAUDE.md + /dev)の clone / 更新
# ※ ernie1358 の2リポは private。GitHub ログイン済みで、かつオーナーから
#    リポへの閲覧権限をもらっているアカウントが必要。
need_clone=0
for r in claude-config claude-skills; do
  [ -d "$CH/owner/$r/.git" ] || need_clone=1
done
if [ "$need_clone" = "1" ] && ! git ls-remote -q https://github.com/ernie1358/claude-config.git >/dev/null 2>&1; then
  echo "❌ ernie1358/claude-config にアクセスできません。"
  echo "   → gh auth login で GitHub にログインし、オーナーに閲覧権限(collaborator招待)を依頼してください。"
  exit 1
fi
mkdir -p "$CH/owner"
for r in claude-config claude-skills; do
  if [ -d "$CH/owner/$r/.git" ]; then
    git -C "$CH/owner/$r" pull -q --ff-only || echo "⚠️ owner/$r の pull に失敗(続行)"
  else
    git clone -q "https://github.com/ernie1358/$r.git" "$CH/owner/$r"
  fi
done

# 4. スキルの symlink (スレッド振り分け + /dev)
mkdir -p "$HOME/.claude/skills"
ln -sfn "$REPO_DIR/skills/threads" "$HOME/.claude/skills/threads"
ln -sfn "$CH/owner/claude-skills/dev" "$HOME/.claude/skills/dev"

# 5. 起動コマンド (claude-channel → このリポの起動スクリプト)
mkdir -p "$HOME/.local/bin"
ln -sfn "$REPO_DIR/claude-channel.sh" "$HOME/.local/bin/claude-channel"

# 6. zsh エイリアス(未登録なら追記)
if ! grep -q "alias zerokun=" "$HOME/.zshrc" 2>/dev/null; then
  cat >> "$HOME/.zshrc" <<'EOF'

# ゼロくん（Slack から自分の Claude を動かすボット）— zerokun/setup.sh が追記
export PATH="$HOME/.local/bin:$PATH"
alias zerokun='CHANNEL=slack claude-channel ~/Desktop/Project/BellSalsesAI'
alias zerokun-restart='CLAUDE_CHANNEL_REPLACE=1 CHANNEL=slack claude-channel ~/Desktop/Project/BellSalsesAI'
alias zerokun-status='pgrep -fl "dangerously-load-development-channels server:slack-channel" || echo "ゼロくんは停止中"'
EOF
  echo "   .zshrc にエイリアスを追記しました(新しいターミナルで有効)"
fi

echo ""
echo "✅ 配線完了。残りの手動ステップ:"
echo "  1. $CH/.env に Slack トークン2つを貼る (xoxb- / xapp-)"
echo "  2. $CH/access.json に許可する Slack ユーザーID/チャンネルIDを入れる"
echo "  3. claude にログイン済みか確認"
echo "  4. 作業リポを ~/Desktop/Project/BellSalsesAI に用意(別プロジェクト機なら .zshrc の zerokun エイリアスの引数をそのプロジェクトに変更)"
echo "  5. 新しいターミナルで: zerokun"
