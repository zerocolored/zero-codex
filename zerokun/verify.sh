#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_SANDBOX=0
if [[ "${1:-}" == "--candidate-sandbox" && $# -eq 1 ]]; then
  if [[ "${ZERO_CODEX_CANDIDATE_SANDBOX:-}" != "1" || "${CODEX_SANDBOX:-}" != "seatbelt" ]]; then
    echo 'error: --candidate-sandbox はupdaterのmacOS sandbox内でのみ使用できます' >&2
    exit 2
  fi
  CANDIDATE_SANDBOX=1
elif [[ $# -ne 0 ]]; then
  echo 'usage: bash zerokun/verify.sh [--candidate-sandbox]' >&2
  exit 2
fi

candidate_git_diff_check() {
  local developer_dir physical_developer_dir selected_app candidate_git
  local metadata owner mode checked_path

  developer_dir="$(
    /usr/bin/env -i \
      PATH=/usr/bin:/bin \
      HOME=/var/empty \
      LANG=C \
      LC_ALL=C \
      /usr/bin/xcode-select -p </dev/null
  )" || {
    echo 'error: candidate検証用の開発者directoryを解決できません' >&2
    return 1
  }
  developer_dir="${developer_dir%/}"
  if [[ -z "$developer_dir" || "$developer_dir" == "/" \
    || "$developer_dir" != /* || ${#developer_dir} -gt 1024 \
    || "$developer_dir" == *$'\n'* || "$developer_dir" =~ [[:cntrl:]] ]]; then
    echo 'error: candidate検証用の開発者directoryが不正です' >&2
    return 1
  fi
  physical_developer_dir="$(
    cd -P -- "$developer_dir" 2>/dev/null && pwd -P
  )" || {
    echo 'error: candidate検証用の開発者directoryを検証できません' >&2
    return 1
  }
  if [[ "$physical_developer_dir" != "$developer_dir" ]]; then
    echo 'error: candidate検証用の開発者directoryが物理pathではありません' >&2
    return 1
  fi
  case "$physical_developer_dir" in
    /Library/Developer/CommandLineTools) ;;
    /Applications/*/Contents/Developer)
      selected_app="${physical_developer_dir#/Applications/}"
      selected_app="${selected_app%/Contents/Developer}"
      if [[ "$selected_app" == */* || "$selected_app" != Xcode*.app ]]; then
        echo 'error: candidate検証用の開発者directoryが許可範囲外です' >&2
        return 1
      fi
      ;;
    *)
      echo 'error: candidate検証用の開発者directoryが許可範囲外です' >&2
      return 1
      ;;
  esac

  for checked_path in \
    "$physical_developer_dir" \
    "$physical_developer_dir/usr" \
    "$physical_developer_dir/usr/bin"
  do
    metadata="$(/usr/bin/stat -f '%u:%Lp' "$checked_path" 2>/dev/null)" || {
      echo 'error: candidate検証用Gitのdirectoryを検証できません' >&2
      return 1
    }
    if [[ ! "$metadata" =~ ^([0-9]+):([0-7]{3,4})$ ]]; then
      echo 'error: candidate検証用Gitのdirectory metadataが不正です' >&2
      return 1
    fi
    owner="${BASH_REMATCH[1]}"
    mode="${BASH_REMATCH[2]}"
    if [[ "$owner" != "0" && "$owner" != "$EUID" ]]; then
      echo 'error: candidate検証用Gitのdirectory ownerが不正です' >&2
      return 1
    fi
    if (( (8#$mode & 0002) != 0 )); then
      echo 'error: candidate検証用Gitのdirectoryがworld-writableです' >&2
      return 1
    fi
  done

  candidate_git="$physical_developer_dir/usr/bin/git"
  if [[ ! -f "$candidate_git" || -L "$candidate_git" || ! -x "$candidate_git" ]]; then
    echo 'error: candidate検証用Gitが安全な実行fileではありません' >&2
    return 1
  fi
  metadata="$(/usr/bin/stat -f '%u:%l:%Lp' "$candidate_git" 2>/dev/null)" || {
    echo 'error: candidate検証用Gitを検証できません' >&2
    return 1
  }
  if [[ ! "$metadata" =~ ^([0-9]+):1:([0-7]{3,4})$ ]]; then
    echo 'error: candidate検証用Gitのmetadataが不正です' >&2
    return 1
  fi
  owner="${BASH_REMATCH[1]}"
  mode="${BASH_REMATCH[2]}"
  if [[ "$owner" != "0" && "$owner" != "$EUID" ]]; then
    echo 'error: candidate検証用Gitのownerが不正です' >&2
    return 1
  fi
  if (( (8#$mode & 0022) != 0 )); then
    echo 'error: candidate検証用Gitがgroup/world-writableです' >&2
    return 1
  fi

  candidate_selected_git() {
    /usr/bin/env -i \
      PATH=/usr/bin:/bin \
      HOME=/var/empty \
      TMPDIR=/var/empty \
      XDG_CONFIG_HOME=/var/empty \
      LANG=C \
      LC_ALL=C \
      TERM=dumb \
      GIT_CONFIG_NOSYSTEM=1 \
      GIT_CONFIG_GLOBAL=/dev/null \
      GIT_ATTR_NOSYSTEM=1 \
      GIT_TERMINAL_PROMPT=0 \
      GIT_ASKPASS=/usr/bin/false \
      SSH_ASKPASS=/usr/bin/false \
      GIT_PAGER=cat \
      GIT_OPTIONAL_LOCKS=0 \
      "$candidate_git" --no-pager -c core.fsmonitor=false "$@" </dev/null
  }
  candidate_selected_git \
    diff --cached --check --no-ext-diff --no-textconv --no-color HEAD -- || return 1
  candidate_selected_git \
    diff --check --no-ext-diff --no-textconv --no-color --
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zerokun-verify.XXXXXX")"
cleanup_verify() { rm -rf "$BUILD_DIR"; }
trap cleanup_verify EXIT

cd "$ROOT"
bun install --frozen-lockfile --silent
if [[ "$CANDIDATE_SANDBOX" == "1" ]]; then
  # macOS Seatbelt cannot be nested. Run the sandbox-safe contract suite here;
  # the complete integration suite (including nested Codex/tmux/process tests)
  # remains mandatory in CI and normal `verify.sh` runs.
  bun test \
    gate.test.ts \
    server-resilience.test.ts \
    zerokun/routing.test.ts \
    zerokun/herdr-runtime.test.ts \
    zerokun/herdr-job-monitor.test.ts \
    zerokun/native-advisor-evidence.test.ts \
    zerokun/codex-app-server-capability.test.ts \
    zerokun/codex-app-server-session.test.ts \
    zerokun/seatbelt-fingerprint.test.ts \
    zerokun/inbound-attachment-cache.test.ts \
    zerokun/ephemeral-claude-session.test.ts \
    zerokun/public-readiness.test.ts \
    zerokun/queue-contract.test.ts \
    zerokun/slack-app-identity.test.ts \
    zerokun/process-generation.test.ts \
    zerokun/process-tree.test.ts \
    zerokun/update-runtime.test.ts

  # Keep the authoritative SQLite/updater tests in their original files, but
  # run only cases that do not create a nested Codex sandbox, tmux session, or
  # managed process. One invocation per case makes a renamed/missing contract
  # fail instead of silently matching the remaining alternatives.
  candidate_contract_test() {
    bun test "$1" -t "$2"
  }
  candidate_contract_test zerokun/process-lock.test.ts \
    '公開中hardlinkのownerを読めなくても例外化やreclaimをしない'
  candidate_contract_test zerokun/process-lock.test.ts \
    '不正なowner内容は取得成功や削除として扱わない'
  candidate_contract_test zerokun/process-lock.test.ts \
    'kill成功後のps失敗や空出力をdeadにしない'
  candidate_contract_test zerokun/process-lock.test.ts \
    '正規化start時刻の一致とPID再利用を区別する'
  candidate_contract_test zerokun/process-lock.test.ts \
    'process groupはESRCHだけを自動回収可能なdeadとみなす'
  candidate_contract_test zerokun/process-lock.test.ts \
    '凍結した旧v2 readerは高精度追加fieldを無視できv3はfail-closedにする'
  candidate_contract_test zerokun/job-runner.test.ts \
    'gateway再起動時にprocessing inboundをpendingへ戻してFIFOを再開する'
  candidate_contract_test zerokun/job-runner.test.ts \
    '先行steerを追い越した中止は対象入力をtombstone化して新規job復活を防ぐ'
  candidate_contract_test zerokun/job-runner.test.ts \
    '同一threadの別sender追記も後続中止が追い越してtombstone化する'
  candidate_contract_test zerokun/job-runner.test.ts \
    'write job中の同一thread返信は別senderのread-only判定でも即時controlを優先する'
  candidate_contract_test zerokun/job-runner.test.ts \
    'upgrade前pending exact中止をmigrationでinterruptへ再分類する'
  candidate_contract_test zerokun/job-runner.test.ts \
    '旧Claudeの実行中jobは副作用を二重実行せずfailedとして再送を求める'
  candidate_contract_test zerokun/job-runner.test.ts \
    '10件をFIFOで1件ずつ実行する'
  candidate_contract_test zerokun/job-runner.test.ts \
    'runner再起動時のwrite jobは副作用を二重実行せずfailedにする'
  candidate_contract_test zerokun/job-runner.test.ts \
    'Slack失敗後もDBへ残り、daemon再開相当のflushで再送する'
  candidate_contract_test zerokun/job-runner.test.ts \
    '成果物単位のdelivery checkpointで再送時の重複uploadを防ぐ'
  candidate_contract_test zerokun/job-runner.test.ts \
    'byte開始後の曖昧性だけをartifact単位で5回確認して打ち切る'
  candidate_contract_test zerokun/codex-config-preflight.test.ts \
    'discovered stdio/HTTP MCPを一つのtop-level tableで無効transportへ固定する'
  candidate_contract_test zerokun/codex-config-preflight.test.ts \
    'MCP transportが欠落またはstdio/HTTP併存ならfail closedする'
  candidate_contract_test zerokun/codex-config-preflight.test.ts \
    'Zeroちゃんbrokerだけをenabledのまま保持する'
  candidate_contract_test zerokun/update.test.ts \
    'candidate sandboxはpreflightと同じrandom named permissionをdefaultにする'
  candidate_contract_test zerokun/update.test.ts \
    'candidate sandboxのwhitespace checkはselected Gitをpagerなしで固定する'
  candidate_contract_test zerokun/update.test.ts \
    'rollback用SQLite snapshotをsidecarごと原子的に復元する'
  candidate_contract_test zerokun/update.test.ts \
    'rollbackはGitを戻してからSQLiteを復元し旧setupを実行する'
  candidate_contract_test zerokun/update.test.ts \
    'setupは依存導入やproject初期化より前にupdate lockへ参加する'
  candidate_contract_test zerokun/update.test.ts \
    '全detached commandはlease登録後に開始しreaper後にだけ解除する'
  candidate_contract_test zerokun/update.test.ts \
    'cleanup evidenceが一つでも不確実ならundelegateを許可しない'
  candidate_contract_test zerokun/update.test.ts \
    'setup timeoutはlegacy drainと15分の作業budgetを必ず覆う'
  candidate_contract_test zerokun/install-fifth-advisor.test.ts \
    'bundled helperをowner-onlyで配置して内容まで固定する'
  candidate_contract_test zerokun/install-fifth-advisor.test.ts \
    '改変、hardlink、symlink directoryを拒否する'
  candidate_contract_test zerokun/install-fifth-advisor.test.ts \
    'host共有helperを変更せずZero専用namespaceだけへ配置する'
else
  bun test
fi
bun run typecheck

for entry in \
  server.ts \
  zerokun/job-runner.ts \
  zerokun/runner-launcher.ts \
  zerokun/herdr-runtime.ts \
  zerokun/herdr-job-monitor.ts \
  zerokun/herdr-job-monitor-view.ts \
  zerokun/standalone-codex.ts \
  zerokun/codex-executor.ts \
  zerokun/codex-supervisor.ts \
  zerokun/live-codex-permission-check.ts \
  zerokun/access.ts \
  zerokun/update.ts \
  zerokun/update-request.ts \
  zerokun/update-runtime.ts
do
  output="$BUILD_DIR/${entry//\//-}.js"
  bun build "$entry" --target=bun --outfile "$output" >/dev/null
done

bash -n \
  codex-channel.sh \
  zerokun/setup.sh \
  zerokun/bootstrap-macos.sh \
  zerokun/watchdog.sh \
  zerokun/state-dir.sh
if [[ "$CANDIDATE_SANDBOX" == "1" ]]; then
  candidate_git_diff_check
else
  git diff --check
fi
