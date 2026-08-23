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
    zerokun/codex-config-preflight.test.ts \
    zerokun/public-readiness.test.ts \
    zerokun/queue-contract.test.ts \
    zerokun/slack-app-identity.test.ts \
    zerokun/process-tree.test.ts

  # Keep the authoritative SQLite/updater tests in their original files, but
  # run only cases that do not create a nested Codex sandbox, tmux session, or
  # managed process. One invocation per case makes a renamed/missing contract
  # fail instead of silently matching the remaining alternatives.
  candidate_contract_test() {
    bun test "$1" -t "$2"
  }
  candidate_contract_test zerokun/job-runner.test.ts \
    'gateway再起動時にprocessing inboundをpendingへ戻してFIFOを再開する'
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
    '本文成功後の添付失敗は本文を再投稿せず5回で打ち切る'
  candidate_contract_test zerokun/update.test.ts \
    'standalone Codexを絶対pathへ固定しcandidate PATHでも解決できる'
  candidate_contract_test zerokun/update.test.ts \
    'standalone Codexを古いBun隣接版より優先し、最低version未満は採用しない'
  candidate_contract_test zerokun/update.test.ts \
    'updaterのcustom Codexは相対pathやgroup/world writable実体を拒否する'
  candidate_contract_test zerokun/update.test.ts \
    'candidate sandboxはpreflightと同じrandom named permissionをdefaultにする'
  candidate_contract_test zerokun/update.test.ts \
    'rollback用SQLite snapshotをsidecarごと原子的に復元する'
  candidate_contract_test zerokun/update.test.ts \
    'rollbackはGitを戻してからSQLiteを復元し旧setupを実行する'
else
  bun test
fi
bun run typecheck

for entry in \
  server.ts \
  zerokun/job-runner.ts \
  zerokun/runner-launcher.ts \
  zerokun/codex-executor.ts \
  zerokun/codex-supervisor.ts \
  zerokun/live-codex-permission-check.ts \
  zerokun/access.ts \
  zerokun/update.ts \
  zerokun/update-request.ts
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
git diff --check
