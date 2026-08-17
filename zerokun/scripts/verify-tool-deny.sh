#!/usr/bin/env bash
#
# verify-tool-deny.sh — denylist が「本当に Claude Code の実挙動として」効くかを確かめる。
#
# なぜ必要か:
#   ゼロくんが本人名義で Slack へ投稿しない保証は、最終的に Claude Code の
#   `--disallowed-tools` の glob 照合に乗っている。ユニットテストは定数の形しか
#   見られない(自前の照合を書けば、それは実装の写経になる)。実 CLI を1回叩くのが
#   唯一の正直な確認方法なので、再現手順をスクリプトとして置いておく。
#
# 何をするか:
#   Slack に触らないダミー MCP サーバーを、検証したい「サーバー名」で登録して
#   claude を起動し、そのツールに到達できたかどうかだけを見る。
#   期待は BLOCKED(遮断) / TOOL_REACHED(到達)。
#
# 使い方:
#   zerokun/scripts/verify-tool-deny.sh
#
# 注意:
#   - 実際に claude を数回呼ぶので少し課金される(haiku・数百トークン)。CI 常時実行向きではない。
#   - `--setting-sources project` で起動する。~/.claude/settings.json の permissions.deny を
#     読み込むと「フラグが効いたのか設定が効いたのか」が切り分けられなくなるため。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$REPO_DIR/zerokun/scripts/deny-fixture-mcp.ts"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MODEL="${DENY_CHECK_MODEL:-haiku}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0

# $1 = 見出し / $2 = MCP サーバー名 / $3 = 期待(BLOCKED|TOOL_REACHED) / 残り = deny パターン
check() {
  local label="$1" server="$2" want="$3"
  shift 3

  local cfg="$WORK/$server.json"
  cat > "$cfg" <<EOF
{"mcpServers":{"$server":{"type":"stdio","command":"$BUN_BIN","args":["run","$FIXTURE"]}}}
EOF

  local deny_args=()
  if [ "$#" -gt 0 ]; then
    deny_args=(--disallowed-tools "$@")
  fi

  local out
  out="$(cd "$WORK" && "$CLAUDE_BIN" --model "$MODEL" \
    --permission-mode bypassPermissions \
    --setting-sources project \
    --strict-mcp-config --mcp-config "$cfg" \
    ${deny_args[@]+"${deny_args[@]}"} \
    -p "Call the tool named reply from the $server MCP server with empty arguments. Reply with exactly what the tool returned. If the tool is blocked or unavailable, reply exactly BLOCKED." \
    < /dev/null 2>&1 | tail -1 | tr -d '[:space:]')"

  if [ "$out" = "$want" ]; then
    printf '  ok   %-58s -> %s\n' "$label" "$out"
  else
    printf '  FAIL %-58s -> %s (want %s)\n' "$label" "$out" "$want"
    failures=$((failures + 1))
  fi
}

WORKER_DENY=('mcp__claude_ai_*' 'mcp__slack__*' 'mcp__slack_*')
BRIDGE_DENY=('mcp__claude_ai_Slack*' 'mcp__slack__*' 'mcp__slack_*')

echo "▶ control (deny 無し。ここが TOOL_REACHED でないと以降の結果に意味がない)"
check "no deny / slack" slack TOOL_REACHED

echo "▶ worker denylist (zerokun/job-runner.ts)"
check "claude.ai Slack connector"        claude_ai_Slack           BLOCKED      "${WORKER_DENY[@]}"
check "同 connector が改名されても塞ぐ"  claude_ai_Slack_Workspace BLOCKED      "${WORKER_DENY[@]}"
check "hosted slack MCP"                 slack                     BLOCKED      "${WORKER_DENY[@]}"
check "bot 経路は巻き込まない"           slack-channel             TOOL_REACHED "${WORKER_DENY[@]}"

echo "▶ bridge denylist (claude-channel.sh)"
check "claude.ai Slack connector"        claude_ai_Slack           BLOCKED      "${BRIDGE_DENY[@]}"
check "同 connector が改名されても塞ぐ"  claude_ai_Slack_Workspace BLOCKED      "${BRIDGE_DENY[@]}"
check "Slack 以外の connector は残す"    claude_ai_Notion          TOOL_REACHED "${BRIDGE_DENY[@]}"
check "bot 経路は巻き込まない"           slack-channel             TOOL_REACHED "${BRIDGE_DENY[@]}"

echo ""
if [ "$failures" -eq 0 ]; then
  echo "✅ すべて期待どおり"
else
  echo "❌ $failures 件が期待と違います" >&2
  exit 1
fi
