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

candidate_git_directory_metadata_safe() {
  local checked_path="$1" file_type="$2" owner="$3" group="$4" mode="$5"

  if [[ "$file_type" != "Directory"
    || ! "$owner" =~ ^[0-9]+$ || ! "$group" =~ ^[0-9]+$
    || ! "$mode" =~ ^[0-7]{3,4}$
    || ( "$owner" != "0" && "$owner" != "$EUID" ) ]]; then
    return 1
  fi
  if (( (8#$mode & 0022) == 0 )); then
    return 0
  fi
  if [[ "$checked_path" == "/Applications"
    && "$owner" == "0" && "$group" == "80" ]] \
    && (( 8#$mode == 8#775 )); then
    return 0
  fi
  return 1
}

# Xcode / Command Line Tools が選択されている開発者directoryからgitを解決する。
# updaterのcandidate sandboxはこのdirectoryを読めないため、そこでは使わない。
developer_candidate_git() {
  local developer_dir physical_developer_dir selected_app
  local metadata file_type owner group mode checked_path
  local -a checked_paths

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
    /Library/Developer/CommandLineTools)
      checked_paths=(
        "/"
        "/Library"
        "/Library/Developer"
      )
      ;;
    /Applications/*/Contents/Developer)
      selected_app="${physical_developer_dir#/Applications/}"
      selected_app="${selected_app%/Contents/Developer}"
      if [[ "$selected_app" == */* || "$selected_app" != Xcode*.app ]]; then
        echo 'error: candidate検証用の開発者directoryが許可範囲外です' >&2
        return 1
      fi
      checked_paths=(
        "/"
        "/Applications"
        "/Applications/$selected_app"
        "/Applications/$selected_app/Contents"
      )
      ;;
    *)
      echo 'error: candidate検証用の開発者directoryが許可範囲外です' >&2
      return 1
      ;;
  esac

  checked_paths+=(
    "$physical_developer_dir"
    "$physical_developer_dir/usr"
    "$physical_developer_dir/usr/bin"
  )
  for checked_path in "${checked_paths[@]}"; do
    metadata="$(LANG=C LC_ALL=C /usr/bin/stat -f '%HT:%u:%g:%Mp%Lp' "$checked_path" 2>/dev/null)" || {
      echo 'error: candidate検証用Gitのdirectoryを検証できません' >&2
      return 1
    }
    if [[ ! "$metadata" =~ ^([^:]+):([0-9]+):([0-9]+):([0-7]{4})$ ]]; then
      echo 'error: candidate検証用Gitのdirectory metadataが不正です' >&2
      return 1
    fi
    file_type="${BASH_REMATCH[1]}"
    owner="${BASH_REMATCH[2]}"
    group="${BASH_REMATCH[3]}"
    mode="${BASH_REMATCH[4]}"
    if ! candidate_git_directory_metadata_safe \
      "$checked_path" "$file_type" "$owner" "$group" "$mode"; then
      echo 'error: candidate検証用Gitのdirectoryが安全ではありません' >&2
      return 1
    fi
  done

  printf '%s\n' "$physical_developer_dir/usr/bin/git"
}

# staging済みcandidate Gitの1要素を、期待するfile種別・owner・mode・hard link数と
# 突き合わせる。expected_linksが空なら、directoryのようにlink数が可変のものとして
# link数を見ない。
staged_candidate_metadata_safe() {
  local target="$1" expected_type="$2" expected_mode="$3" expected_links="${4:-}"
  local metadata file_type owner links mode

  metadata="$(LANG=C LC_ALL=C /usr/bin/stat -f '%HT:%u:%l:%Lp' "$target" 2>/dev/null)" || {
    echo "error: staging済みcandidate検証用Gitの ${target} を検証できません" >&2
    return 1
  }
  if [[ ! "$metadata" =~ ^([^:]+):([0-9]+):([0-9]+):([0-7]{3,4})$ ]]; then
    echo "error: staging済みcandidate検証用Gitの ${target} のmetadataが不正です" >&2
    return 1
  fi
  file_type="${BASH_REMATCH[1]}"
  owner="${BASH_REMATCH[2]}"
  links="${BASH_REMATCH[3]}"
  mode="${BASH_REMATCH[4]}"
  if [[ "$file_type" != "$expected_type" || "$owner" != "$EUID" ]] \
    || (( 8#$mode != 8#$expected_mode )) \
    || [[ -n "$expected_links" && "$links" != "$expected_links" ]]; then
    echo "error: staging済みcandidate検証用Gitの ${target} が想定と異なります" >&2
    return 1
  fi
}

# updaterがstageVerifiedCandidateCodexで配置し、ZERO_CODEX_CANDIDATE_GITで渡してくる
# 検証済みgitを解決する。要求するstaging identityは zerokun/project-git.ts の
# candidateGitExecutable と同じにする。
staged_candidate_git() {
  local candidate physical trusted_bin candidate_root system_temporary

  candidate="${ZERO_CODEX_CANDIDATE_GIT:-}"
  if [[ -z "$candidate" || "$candidate" != /* || ${#candidate} -gt 1024 \
    || "$candidate" == *$'\n'* || "$candidate" =~ [[:cntrl:]] ]]; then
    echo 'error: staging済みcandidate検証用Gitのpathが不正です' >&2
    return 1
  fi
  physical="$(
    cd -P -- "$(dirname -- "$candidate")" 2>/dev/null \
      && printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$candidate")"
  )" || {
    echo 'error: staging済みcandidate検証用Gitを解決できません' >&2
    return 1
  }
  if [[ "$physical" != "$candidate" || "$(basename -- "$physical")" != 'git' ]]; then
    echo 'error: staging済みcandidate検証用Gitが物理pathではありません' >&2
    return 1
  fi
  trusted_bin="$(dirname -- "$physical")"
  candidate_root="$(dirname -- "$trusted_bin")"
  system_temporary="$(cd -P -- /tmp 2>/dev/null && pwd -P)" || {
    echo 'error: system temporary directoryを解決できません' >&2
    return 1
  }
  if [[ "$(dirname -- "$candidate_root")" != "$system_temporary" \
    || ! "$(basename -- "$candidate_root")" =~ ^zerokun-update-candidate-[A-Za-z0-9]+$ ]]; then
    echo 'error: staging済みcandidate検証用Gitの配置が想定外です' >&2
    return 1
  fi
  staged_candidate_metadata_safe "$candidate_root" 'Directory' 0700 || return 1
  staged_candidate_metadata_safe "$trusted_bin" 'Directory' 0500 || return 1
  staged_candidate_metadata_safe "$physical" 'Regular File' 0500 1 || return 1
  printf '%s\n' "$physical"
}

candidate_git_diff_check() {
  local candidate_git metadata owner mode

  # candidate sandboxはseatbelt内で走り、開発者directoryを読めない。updaterは
  # そこへ入る前に開発者directoryのgitを検証してtrusted-binへstageし、その物理path
  # をZERO_CODEX_CANDIDATE_GITで渡している。sandbox内で開発者directoryを引き直すと
  # 必ず失敗するので、渡されたstaging済みgitを使う。判定は zerokun/project-git.ts の
  # projectGitExecutable と同じく環境変数だけで行い、この関数を単体で呼べる状態に保つ。
  if [[ "${ZERO_CODEX_CANDIDATE_SANDBOX:-}" == "1" && "${CODEX_SANDBOX:-}" == "seatbelt" ]]; then
    candidate_git="$(staged_candidate_git)" || return 1
  elif [[ -n "${ZERO_CODEX_CANDIDATE_GIT:-}" ]]; then
    echo 'error: staging済みcandidate検証用Gitは検証済みCodex sandbox内でのみ使用できます' >&2
    return 1
  else
    candidate_git="$(developer_candidate_git)" || return 1
  fi
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
    zerokun/native-advisor-coverage.test.ts \
    zerokun/codex-app-server-capability.test.ts \
    zerokun/codex-app-server-session.test.ts \
    zerokun/seatbelt-fingerprint.test.ts \
    zerokun/inbound-attachment-cache.test.ts \
    zerokun/ephemeral-claude-session.test.ts \
    zerokun/public-readiness.test.ts \
    zerokun/project-layout.test.ts \
    zerokun/project-selection.test.ts \
    zerokun/codex-progress.test.ts \
    zerokun/lifecycle-notifications.test.ts \
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
    'Zeroちゃんの用途固定brokerだけをenabledのまま保持する'
  candidate_contract_test zerokun/update.test.ts \
    'candidate sandboxはpreflightと同じrandom named permissionをdefaultにする'
  candidate_contract_test zerokun/update.test.ts \
    'candidate sandboxのwhitespace checkはselected Gitをpagerなしで固定する'
  candidate_contract_test zerokun/update.test.ts \
    'candidate Git directory metadataはstock Applicationsだけを例外にする'
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
  # Process-heavy fixtures intentionally exercise detached children and
  # generation-safe cleanup. Bun's --isolate separates module globals but still
  # keeps every test file in one long-lived process, so child-process handles or
  # runtime pressure from an earlier file can stall an unrelated later file on
  # GitHub's macOS runner. Give every tracked test file a fresh Bun process and
  # let --no-orphans reap only that file's descendants before continuing.
  full_suite_count=0
  while IFS= read -r test_file; do
    [[ -n "$test_file" ]] || continue
    full_suite_count=$((full_suite_count + 1))
    bun test --isolate --no-orphans "$test_file"
  done < <(git ls-files -- '*test.ts')
  if [[ "$full_suite_count" -eq 0 ]]; then
    echo 'error: full test suite is empty' >&2
    exit 1
  fi
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
  zerokun/project-layout.ts \
  zerokun/project-selection.ts \
  zerokun/codex-supervisor.ts \
  zerokun/live-codex-permission-check.ts \
  zerokun/access.ts \
  zerokun/service-control-state.ts \
  zerokun/service-control.ts \
  zerokun/status.ts \
  zerokun/herdr-start.ts \
  zerokun/update.ts \
  zerokun/update-restart.ts \
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
  zerokun/interactive-bootstrap.sh \
  zerokun/watchdog.sh \
  zerokun/state-dir.sh
if [[ "$CANDIDATE_SANDBOX" == "1" ]]; then
  candidate_git_diff_check
else
  git diff --check
fi
