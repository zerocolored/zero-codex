#!/usr/bin/env bash
# Linux/WSL2 用: Slack App の token 2 値を非表示入力で受け取り、state の .env へ owner-only で保存する。
# bootstrap-macos.sh の configure_slack（read_slack_token / save_slack_tokens /
# verify_slack_app_identity / initialize_slack_catchup_floor / configure_access）と同じ手順。
# 自分の端末（Windows Terminal の Ubuntu タブなど）で対話的に実行する。token は argv・環境変数・
# ログに載せない。
#
#   bash zerokun/linux/register-slack-tokens.sh
set -euo pipefail
unset BUN_OPTIONS BUN_CONFIG_PRELOAD NODE_OPTIONS

REPO_DIR="$(CDPATH='' cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
STATE_DIR="${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

fail() { printf '❌ %s\n' "$*" >&2; exit 1; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
ok()   { printf '✅ %s\n' "$*"; }

[ -t 0 ] || fail "対話端末で実行してください（token を非表示で入力するため）"
command -v bun >/dev/null 2>&1 || fail "bun がありません"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

normalize_slack_token() {
  local value="$1" env_key="$2"
  value="$(printf '%s' "$value" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in export\ *) value="${value#export }" ;; esac
  case "$value" in "$env_key="*) value="${value#*=}" ;; esac
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

read_slack_token() {
  local prefix="$1" label="$2" env_key="$3" entered
  while true; do
    printf '   %s（入力内容は表示されません）: ' "$label"
    IFS= read -r -s entered || { printf '\n'; fail "${label}の入力を読み取れませんでした"; }
    printf '\n'
    SLACK_TOKEN_RESULT="$(normalize_slack_token "$entered" "$env_key")"
    if printf '%s\n' "$SLACK_TOKEN_RESULT" | grep -Eq "^${prefix}-[A-Za-z0-9._-]{10,}$"; then
      return
    fi
    if [ -z "$SLACK_TOKEN_RESULT" ]; then
      warn "${label}が未入力です。Slack画面からコピーして、もう一度入力してください"
    else
      warn "${label}は${prefix}-で始まる値です。コピーし直して、もう一度入力してください"
    fi
  done
}

save_slack_tokens() {
  local bot_token="$1" app_token="$2" env_file="$STATE_DIR/.env" temp_file existing=""
  umask 077
  temp_file="$(mktemp "$STATE_DIR/.env.zerokun.XXXXXX")" || fail "Slack token用一時fileを作成できません"
  if [ -e "$env_file" ] || [ -L "$env_file" ]; then
    existing="$(bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" read-owned-regular "$env_file")" \
      || { rm -f "$temp_file"; fail ".envが安全な通常fileではありません"; }
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
    rm -f "$temp_file"
    fail "Slack tokenを安全に保存できません"
  fi
  rm -f "$temp_file"
}

echo "== Zeroちゃん Slack token 登録（Linux/WSL2） =="
echo "   state: $STATE_DIR"
echo "   同じ Slack App の 2 値を順に貼り付けてください。"
read_slack_token xapp 'App-Level Token（xapp-）' SLACK_APP_TOKEN
app_token="$SLACK_TOKEN_RESULT"
read_slack_token xoxb 'Bot User OAuth Token（xoxb-）' SLACK_BOT_TOKEN
bot_token="$SLACK_TOKEN_RESULT"
save_slack_tokens "$bot_token" "$app_token"
unset app_token bot_token SLACK_TOKEN_RESULT

env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/slack-app-identity.ts" verify-file "$STATE_DIR/.env" \
  || fail "Bot TokenとApp-Level Tokenが同じSlack Appか確認できませんでした（別Appの組み合わせなら保存し直してください）"
ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file \
  "$REPO_DIR/zerokun/job-runner.ts" initialize-slack-catchup-floor >/dev/null \
  || fail "Slack履歴の安全な開始時刻を保存できませんでした"
ok "同じSlack Appのトークン2つを権限600で保存しました: $STATE_DIR/.env"

access_file="$STATE_DIR/access.json"
if [ -e "$access_file" ] || [ -L "$access_file" ]; then
  bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/safe-file.ts" validate-owned-regular "$access_file" \
    || fail "access.jsonが安全な通常fileではありません"
else
  cp "$REPO_DIR/zerokun/templates/access.json.example" "$access_file" || fail "access.jsonを作成できませんでした"
  chmod 600 "$access_file"
fi
ZEROKUN_STATE_DIR="$STATE_DIR" bun --config=/dev/null --no-env-file "$REPO_DIR/zerokun/access.ts" status >/dev/null \
  || fail "access.jsonを読み取れませんでした"
ok "チャンネルは招待後、対象projectの zerochan set slack-channel <ID> で紐付けます"
echo "   DMは初回メッセージで表示されるcodeを zerochan-access pair <code> へ渡します。"
