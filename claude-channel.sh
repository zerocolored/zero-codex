#!/usr/bin/env bash
#
# claude-channel — V1: channel 接続の素の Claude(Opus) を 1 コマンドで常駐起動する
#
#   - ocusnight 検証ループは「まだ」付けない（V2 で zellij 2 ペイン化して合体）
#   - caffeinate で Mac を寝かさない（24/7 待ち受け）
#   - --dangerously-skip-permissions で許可プロンプトを出さず無人で走らせる
#   - --channels で fakechat / slack 等からの入力を待ち受ける
#
# 使い方:
#   claude-channel                 # 既定: BellSalesAI を fakechat で待ち受け
#   claude-channel <project_dir>   # 作業対象ディレクトリを変える
#   CHANNEL=slack claude-channel   # channel を切り替える(V1.5 で slack bridge 導入後)
#
# ⚠️ セキュリティ注意:
#   --dangerously-skip-permissions + --channels は「外部から届いたメッセージで
#   無確認に任意コマンドが走る」状態。fakechat は localhost(自分だけ)なので安全。
#   Slack に差し替える時は、bridge 側の allowlist / pairing で投稿者を必ず絞ること。
#
set -euo pipefail

PROJECT="${1:-/Users/zerocolored-macpro-suetsugu/Desktop/Project/BellSalsesAI}"
CHANNEL="${CHANNEL:-fakechat}"
MARKETPLACE="${MARKETPLACE:-claude-plugins-official}"
MODEL="${MODEL:-opus}"
CH_DIR="$HOME/.claude/channels/slack"
JOB_RUNNER="$CH_DIR/job-runner.ts"
JOB_RUNNER_PID="$CH_DIR/job-runner.lock/pid"
JOB_RUNNER_LOG="$CH_DIR/job-runner.log"

# bun(channel MCP サーバーの実行に必須)を PATH に通す
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun が見つかりません。'curl -fsSL https://bun.sh/install | bash' で入れてください。" >&2
  exit 1
fi

if [ ! -d "$PROJECT" ]; then
  echo "❌ 作業ディレクトリが存在しません: $PROJECT" >&2
  exit 1
fi

job_runner_is_alive() {
  [ -f "$JOB_RUNNER_PID" ] || return 1
  local runner_pid
  runner_pid="$(tr -d '[:space:]' < "$JOB_RUNNER_PID")"
  [ -n "$runner_pid" ] \
    && kill -0 "$runner_pid" 2>/dev/null \
    && ps -o command= -p "$runner_pid" 2>/dev/null | grep -Eq 'job-runner\.ts[[:space:]]+daemon'
}

start_job_runner() {
  if job_runner_is_alive; then
    echo "   job-runner: running (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO workers=1)"
    return
  fi

  if [ ! -x "$JOB_RUNNER" ]; then
    echo "❌ SQLite job runner が未導入です: $JOB_RUNNER" >&2
    echo "   zerokun/setup.sh を再実行してください。" >&2
    exit 1
  fi

  mkdir -p "$CH_DIR"
  nohup caffeinate -dimsu bun "$JOB_RUNNER" daemon \
    >>"$JOB_RUNNER_LOG" 2>&1 </dev/null &
  local starter_pid=$!

  for _ in {1..30}; do
    if job_runner_is_alive; then
      echo "   job-runner: started (PID $(tr -d '[:space:]' < "$JOB_RUNNER_PID"), FIFO workers=1)"
      return
    fi
    if ! kill -0 "$starter_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  echo "❌ SQLite job runner の起動に失敗しました: $JOB_RUNNER_LOG" >&2
  tail -n 20 "$JOB_RUNNER_LOG" >&2 2>/dev/null || true
  exit 1
}

cd "$PROJECT"

echo "▶ claude-channel V1.5"
echo "   model    : $MODEL"
echo "   project  : $PROJECT"

if [ "$CHANNEL" = "slack" ] || [ "$CHANNEL" = "telegram" ]; then
  BRIDGE="${CHANNEL}-channel"   # slack-channel / telegram-channel
  # --- 単一インスタンスガード: 二重起動を防ぐ ---
  # Slack Socket Mode も Telegram long-polling も「単一コンシューマ」前提。
  # ボットを2個立てると1メッセージが両方の窓に配達され「二重処理・二重返信」になる
  # (Telegram は getUpdates が 409 Conflict を返し、Slack は黙ってロードバランスする)。
  # こちら側で起動時に1回だけ検査する。毎メッセージのコストはゼロ。
  # 10個以上 claude を開いていても、この特定パターンだけ拾う。
  BOT_PAT="dangerously-load-development-channels server:${BRIDGE}"
  EXISTING="$(pgrep -f "$BOT_PAT" 2>/dev/null || true)"
  if [ -n "$EXISTING" ]; then
    echo "⚠️  ${CHANNEL} ボットは既に起動中です(二重起動はメッセージ二重処理の原因):" >&2
    for p in $EXISTING; do
      ps -o pid=,tty=,command= -p "$p" 2>/dev/null | sed 's/^/     /' >&2 || true
    done
    echo "" >&2

    # 安全方針: 既定では「絶対に kill しない」。うっかり起動しても既存ボットは無傷で、
    # こちらの起動を中止するだけ。入れ替えは次の2つの“意図的な操作”でのみ発動する:
    #   (1) 対話プロンプトで y を入力
    #   (2) CLAUDE_CHANNEL_REPLACE=1 を明示的に付与(対話できない場面の上書き用)
    do_replace=0
    if [ "${CLAUDE_CHANNEL_REPLACE:-0}" = "1" ]; then
      do_replace=1
      echo "   CLAUDE_CHANNEL_REPLACE=1 が指定されています。" >&2
    elif [ -t 0 ]; then
      printf "   既存を止めて入れ替えますか? (y を打たない限り既存は無傷) [y/N]: " >&2
      read -r _ans || _ans=""
      case "$_ans" in [yY] | [yY][eE][sS]) do_replace=1 ;; esac
    fi

    if [ "$do_replace" = "1" ]; then
      echo "   → 既存(PID: $(echo $EXISTING | tr '\n' ' '))を終了して起動し直します..." >&2
      # shellcheck disable=SC2086
      kill $EXISTING 2>/dev/null || true
      sleep 1
    else
      echo "   → 起動を中止しました。既存ボットはそのまま稼働中です(無傷)。" >&2
      echo "     入れ替えたい時: 上のプロンプトで y / または CLAUDE_CHANNEL_REPLACE=1 を付けて実行" >&2
      exit 1
    fi
  fi

  # --- bridge モード (slack-channel / telegram-channel) ---
  # MCP サーバー "${BRIDGE}" を ~/.claude.json に登録済みである前提。
  # トークンは ~/.claude/channels/${CHANNEL}/.env に保存済みである前提。
  export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1   # Agent/SendMessage を有効化(スレッド分配に必須)
  if [ "$CHANNEL" = "slack" ]; then
    start_job_runner
  fi
  # bridge の MCP 定義は「専用 config ファイルがあればそれ経由で、この起動だけに」読み込む。
  # 専用ファイル(~/.claude/channels/<ch>/mcp.<bridge>.json)があれば --mcp-config で渡し、
  # グローバル ~/.claude.json から外しても本起動は server:<bridge> を解決できる。
  # これにより「普通に開いた他の claude が bridge を auto-start して Socket Mode 回線を奪う」事故を防ぐ。
  # 専用ファイルが無い ch(例: 旧来の telegram) は従来どおりグローバル登録を参照する(無傷)。
  MCP_CFG="$HOME/.claude/channels/${CHANNEL}/mcp.${BRIDGE}.json"
  MCP_ARGS=()
  if [ -f "$MCP_CFG" ]; then
    MCP_ARGS=(--mcp-config "$MCP_CFG")
    echo "   mcp-config: $MCP_CFG (この起動のみ ${BRIDGE} を読込)"
  fi
  # --- オーナー重厚モード (2026-08-07): トリアージ + オーナー CLAUDE.md をこの起動だけに適用 ---
  # 実体は ~/.claude/channels/<ch>/owner/claude-config (git clone。オーナー側更新は git pull で取込)。
  # 起動ごとに triage + CLAUDE.md を連結し --append-system-prompt-file で渡す。
  # ファイルが無い channel (telegram 等) では何もしない = 従来どおり。
  HEAVY_SRC="$HOME/.claude/channels/${CHANNEL}/owner/claude-config/CLAUDE.md"
  HEAVY_TRIAGE="$HOME/.claude/channels/${CHANNEL}/zerokun-triage.md"
  QUEUE_POLICY="$HOME/.claude/channels/${CHANNEL}/zerokun-queue-policy.md"
  HEAVY_OUT="$HOME/.claude/channels/${CHANNEL}/zerokun-heavy-mode.generated.md"
  HEAVY_ARGS=()
  if [ -f "$HEAVY_SRC" ] && [ -f "$HEAVY_TRIAGE" ]; then
    HEAVY_INPUTS=("$HEAVY_TRIAGE" "$HEAVY_SRC")
    [ ! -f "$QUEUE_POLICY" ] || HEAVY_INPUTS+=("$QUEUE_POLICY")
    if cat "${HEAVY_INPUTS[@]}" > "$HEAVY_OUT" 2>/dev/null && [ -s "$HEAVY_OUT" ]; then
      HEAVY_ARGS=(--append-system-prompt-file "$HEAVY_OUT")
      echo "   heavy-mode: ON (トリアージ + オーナー CLAUDE.md + SQLite queue policy)"
    fi
  fi
  echo "   channel  : server:${BRIDGE} (${CHANNEL} bridge)"
  echo "   caffeinate: ON (Mac を寝かせません / Ctrl-C で終了)"
  echo ""
  exec caffeinate -dimsu \
    claude \
      --model "$MODEL" \
      --dangerously-skip-permissions \
      "${MCP_ARGS[@]}" \
      "${HEAVY_ARGS[@]}" \
      --dangerously-load-development-channels "server:${BRIDGE}"
else
  # --- 公式 plugin channel モード (fakechat 等) ---
  echo "   channel  : plugin:${CHANNEL}@${MARKETPLACE}"
  echo "   caffeinate: ON (Mac を寝かせません / Ctrl-C で終了)"
  echo ""
  # caffeinate -dimsu: ディスプレイ/アイドル/ディスクスリープ抑止 + ユーザーアクティブ宣言
  exec caffeinate -dimsu \
    claude \
      --model "$MODEL" \
      --dangerously-skip-permissions \
      --channels "plugin:${CHANNEL}@${MARKETPLACE}"
fi
