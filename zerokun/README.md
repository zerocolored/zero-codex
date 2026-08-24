# ゼロくん一式（Slack → ローカル Codex）

## 結論

`zero-codex` リポジトリでは Claude Code の channel/MCP/skills/subagent dispatcher を使いません。
常駐する Slack gateway が受信を SQLite に保存し、1本の runner が Codex CLI を
`exec` / `exec resume` で直列実行します。

## 導入

Codex CLI 0.149.0以上と`codex login`済みの認証が必要です。

```bash
bootstrap_dir="$(/usr/bin/mktemp -d /tmp/zerokun-bootstrap.XXXXXX)"
/bin/chmod 700 "$bootstrap_dir"
bootstrap_path="$bootstrap_dir/bootstrap-macos.sh"
/usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp \
  /usr/bin/curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --noproxy '*' --output "$bootstrap_path" \
    https://raw.githubusercontent.com/zerocolored/zero-codex/main/zerokun/bootstrap-macos.sh
bash "$bootstrap_path" --with-slack
/bin/rm -f "$bootstrap_path"
/bin/rmdir "$bootstrap_dir"
```

既に `zero-codex` をclone済みなら、その repository で`git switch main`を実行してから
`bash zerokun/bootstrap-macos.sh --with-slack`を使います。

既にclone済みの場合も、公式standalone Codexを同じ信頼条件で検証するbootstrapを使います:

```bash
bash zerokun/bootstrap-macos.sh --with-slack
codex login status
zerokun
```

## Runtime 構成

| ファイル | 役割 |
|---|---|
| `../codex-channel.sh` | runner を常駐起動し、gateway を前景起動 |
| `../server.ts` | Slack Socket Mode、access gate、添付取得、durable enqueue、catch-up |
| `job-runner.ts` | SQLite FIFO、thread/session 所有権、Slack 通知 |
| `runner-launcher.ts` | runnerの独立process group起動、安全なlog接続 |
| `codex-executor.ts` | sandbox を選び、Codex JSONL を解析して exec/resume |
| `access.ts` | pairing、DM/channel、write 許可の端末 CLI |
| `update.ts` | `origin/main` から安全に fast-forward 更新 |
| `update-request.ts` | Slack 自己更新を FIFO 外の detached worker へ渡す |
| `process-generation.ts` | macOS libprocによるmicrosecond process世代IDとsignal前再検証 |
| `watchdog.sh` | gateway と runner の状態遷移を監視 |

## Durable FIFO

state dir の `jobs.sqlite3` に、認可済み Slack event を transaction で保存します。

1. gateway が route と write 権限を決め、Slack event metadataを`inbound_deliveries`へ先に保存する。
2. 添付をdeadline・50MB上限付きでdownloadし、`jobs` と `slack_threads` を同じtransactionで保存する。
3. 添付取得が5回失敗したeventはfailed jobとterminal通知へ退避し、後続eventのFIFOを進める。
4. runner が `runtime=codex` の先頭1件だけ claim する。
5. supervisorがPID registrationを先に永続化し、`thread.started.thread_id`を受けた時点でDBへ保存する。
6. 正常終了/失敗とterminal通知を同じtransactionで保存し、Slack投稿成功後に通知済みにする。
7. runner 停止中のread-only `running` jobは次回起動時に`queued`へ戻してresumeする。write jobは外部副作用が不確実なためfailedにし、状態確認後の手動再送を求める。

session は Slack thread・repository・sender・write mode の組が同じ場合だけ再利用します。権限変更やsenderを跨いで
過去の write-authorized context を resume しません。

並列 worker はありません。同一 thread の session 競合、分類ミスによる二重実行、軽量/重量 queue
間の順序逆転を避けるため、v1 は全 request を1本の FIFO に入れます。受付返信は enqueue 直後に
返るため、待ち時間は Slack 上で確認できます。

## Codex 実行契約

新規 job:

```text
codex -a never -C <repo> \
  -c 'permissions.zerokun_job.filesystem={":minimal"="read",<job固有rules>}' \
  -c permissions.zerokun_job.network.enabled=<false|true> \
  -c default_permissions="zerokun_job" \
  -c developer_instructions=<安全規則> \
  exec --ignore-user-config --ignore-rules --skip-git-repo-check --json \
  --output-last-message <final-file> -
```

継続 job:

```text
codex ... exec ... resume <thread-id> -
```

- 新規 session ID を Zero-kun 側で推測・採番しません。
- JSONL の `thread.started.thread_id` だけを Codex thread ID として採用します。
- 完了本文は `--output-last-message` のfileを優先し、無い場合だけ最後の
  `item.completed/agent_message` を使います。
- resume 先が無いエラーだけ session を消して新規 exec へ1回 fallback します。
- 構造化された `error` / `turn.failed` だけを rate limit 判定します。read-only jobは合計5回の実行まで再開し、write jobは外部副作用が不確実なため自動再開しません。
- 安全規則は`developer_instructions`、未信頼のSlack本文はstdinへ分け、process listへ本文を出しません。
- `--ignore-user-config --ignore-rules`を使い、起動直前の`config/read`でnamed permissionの
  実効値をmanaged/MDM layerまで照合します。child environmentは
  PATH/HOME/CODEX_HOME/locale/proxy等のallowlistで作り、token/key/passwordや
  `ZEROKUN_*`をCodex shellへ継承しません。
- apps・plugins・MCP・hookは無効化し、Web検索はwrite許可jobだけに限定します。
  write jobのcommand networkはproxyを通し、Slack関連domainだけは常に拒否します。

## 権限

受信可否と repository write は別です。

- 通常: minimal runtime + repository read + 当該添付read + job outbox/scratch write
- `writeAllowFrom` の sender: minimal runtime + repository/`.git` write + network

Zero-kun本体のrepositoryはhost runtimeの信頼境界なので、そこへのwrite jobは許可者であっても
拒否します。bootstrapは本体と別の`zerokun-workspace`を既定projectとして初期化します。

両profileともHOME、state全体、共用tempを先にdenyし、必要なpathだけをより具体的なruleで
再許可します。Codex CLI 0.149.0以上を必須とし、古いCLIはjob受付前に拒否します。
通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。またHOMEのglobal
Git/GitHub credentialは公開しないため、remote操作にはHOME外の安全な認証が別途必要です。
Codex shellのHOMEもjob scratchへ分離するため、commitするprojectでは`user.name`/`user.email`を
repository local configへ設定してください。

Codex から Slack tool/API を呼ばせません。最終文は runner が bot token で投稿します。成果物を
返す場合は最終文末の `<zerokun_files>["/absolute/path"]</zerokun_files>` を runner が解釈します。
job専用`outbox/<job-id>/`直下の空でないregular fileだけをrunner専用sealed領域へ移し、open済みFDから
50MB上限で読みます。他path、空file、symlink、device/FIFOはuploadしません。terminal本文と成果物ごとの
送信済み状態をSQLiteへ別々に残すため、添付失敗時に本文は再投稿しません。成果物は指数backoffで5回試し、
失敗が続けば打切り通知を1回投稿します。checkpoint確定済みfileは再送しませんが、Slack upload成功直後・
checkpoint確定前にprocessが落ちた場合だけは同じfileが再uploadされ得るat-least-once配送です。
Codex stdout/stderr logはfileごとに20MB、解析用memoryは1MB tailへ制限します。

## Thread と履歴回収

`slack_threads` は `(chat_id, thread_ts)` ごとに repository を固定します。gateway は:

- 起動時に直近の DM と channel mention を履歴から回収
- 48時間以内に活動した採用済み thread を60秒ごとに poll
- human 向け mention だけの雑談は channel policy に従って除外
- DM follow-up は現在の DM allowlist を再確認
- live event と poll の重複を `(chat_id, message_ts)` で排除

旧stateを`ZEROKUN_LEGACY_CUTOVER=1`と`ZEROKUN_STATE_DIR`で明示したin-place cutoverでは、旧 `threads.json` をSQLiteへ
importし、旧runnerをdrain/停止してから入れ替えます。旧待機jobはClaude sessionを破棄して
Codex queueへ引き継ぎ、停止後もrunningだった不確実なjobは二重実行せずfailed通知にします。

## State

既定は常に `~/.codex/zerokun` です。旧版の`~/.claude/channels/slack`は自動選択せず、
別PCのClaude版のtoken・access・queue・routesを暗黙に流用しません。比較時はこのPC専用の
新しいSlack Appを作成します。同一PCのin-place cutoverだけcutoverフラグと旧stateを明示します。

```text
.env
access.json
routes.json
jobs.sqlite3
job-logs/
inbox/
outbox/<job-id>/
tmp/<job-id>/
plugin.lock
job-runner.lock/
executors/
gateway-ready.json
watchdog-state.json
```

新しい場所へ分離する場合:

```bash
export ZEROKUN_STATE_DIR="$HOME/.codex/zerokun"
bash zerokun/bootstrap-macos.sh --with-slack
```

すべての launcher/CLI/launchd に同じ環境変数を渡してください。途中で state dir を分けると、
token、access、queue、lock が別物になります。

## 運用コマンド

```bash
zerokun
zerokun-status
zerokun-jobs status
zerokun-access status
zerokun-update
```

log:

```bash
tail -f "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/job-runner.log"
```

in-place cutoverでは`ZEROKUN_LEGACY_CUTOVER=1`も併せて指定してください。配置先だけを
変更する場合は`ZEROKUN_STATE_DIR`を明示します。

完了jobはterminal通知と全成果物の配送checkpointが確定してから既定30日で削除します。
Slack eventのidempotency tombstoneは既定10年保持し、runtime logは20MBで上限化します。
即時maintenanceは`zerokun-jobs gc`で実行できます。

watchdog は停止を2回連続検出した時だけ通知し、復旧も通知します。自動 restart はしません。

安全なprocess-group委譲を持たない旧Codex版からの初回更新だけは、Slack経由や
`zerokun-update`ではなく、冒頭の公開`bootstrap-macos.sh`を端末から実行し、旧checkoutとは別の
空directory（例: `--repo-dir "$HOME/Desktop/Project/zero-codex-next"`）へ配置します。旧updater経由の
setupはstate変更前に停止して旧版へrollbackし、新checkoutのsetupが同じstateをlockしてserviceを
切り替えます。以後は`zerokun-update`を利用できます。
自己更新用runtimeは全import companionをversioned bundleへpublishした後にentrypointをatomic切替します。
process-levelのSIGKILLはfail-closedで復旧しますが、突然の電源断に対するfilesystem durabilityは
保証対象外です。再起動後にjournalが残る場合はserviceを起動せずoffline bootstrapで復旧してください。

## 検証

```bash
bun run verify
```

unit/integration test は fake Codex/Slack を使い、実 workspace や外部サービスを書き換えません。
macOSでCodex CLIがある場合は、実`codex sandbox`のstate deny・添付read・outbox/`.git` writeと
new/resume引数parserもmodelを呼ばずに検証します。自己更新の候補commitは外側のCodex sandbox内で
sandbox-safe contract test・型検査・build・shell検査を実行します。macOSで入れ子にできない
実sandbox・tmux・process制御testは通常の`verify.sh`と公開CIだけで全件実行します。
