#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zerokun-verify.XXXXXX")"
cleanup_verify() { rm -rf "$BUILD_DIR"; }
trap cleanup_verify EXIT

cd "$ROOT"
bun install --frozen-lockfile --silent
bun test
bun run typecheck

for entry in \
  server.ts \
  zerokun/job-runner.ts \
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
