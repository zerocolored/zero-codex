# Zero-kun for Codex

Slack の DM・メンションをローカルの Codex CLI へ安全に渡す、macOS 向けの常駐ゲートウェイです。
この `zero-codex` リポジトリは Claude Code を起動しません。必要なのは Codex CLI のログインです。

## 仕組み

```text
Slack Socket Mode
  ↓ access.json で受信認可
server.ts（添付をローカル保存し、SQLiteへcommit）
  ↓ jobs.sqlite3 / 1本のFIFO
job-runner.ts
  ↓ codex exec --json / codex exec resume
Codex CLI（job専用 permission profile）
  ↓ 最終回答と明示された成果物だけ
Slack bot
```

- Slack 受信と Codex 実行を別プロセスに分離しています。Codex が長時間動いても受信を続けます。
- job は SQLite に先に保存し、常に1件ずつ FIFO で処理します。再起動時、read-only job は再開し、write job は外部副作用の二重実行を避けるため failed にして確認・再送を求めます。
- 同じ Slack スレッド・repository・sender・write mode では Codex の thread ID を最大5 jobまで再利用します。旧 Claude Code の
  待機jobはsession IDを破棄してCodexへ移行し、完了済み履歴のsession IDはCodexへ渡しません。
- Codex 子プロセスには Slack token や任意の親process環境を渡しません。Slack 投稿は gateway/runner の bot 経路だけです。
- 受信許可と書込み許可は別です。既定profileはrepository readとjob outbox writeだけ、明示した利用者だけ
  repository・`.git` write とネットワークを使えます。
- Socket Mode 停止中の DM・メンションと、採用済みスレッドの未メンション返信を履歴から回収します。

Codex CLI 連携は安定した非対話実行インターフェースである
`codex exec --json`、`thread.started.thread_id`、`codex exec resume`、
`--output-last-message` を使います。job本体はapp-serverで実行しませんが、起動前のmanaged/MDMを含む
実効permission検査には実験的な`app-server config/read`と`configRequirements/read`を使うため、
CIで対応するCodex CLI versionごとにprotocol互換性を確認します。

## 必要なもの

- macOS
- Git、Bun、tmux
- Codex CLI 0.149.0 以上（`codex login status` が成功すること）
- App を作成できる Slack workspace

Claude Code、Claude のログイン、Claude channel/MCP、Anthropic API key は不要です。

## セットアップ

`zero-codex` を既に clone 済みなら:

```bash
git switch main
bash zerokun/setup.sh
codex login status
```

別PCのClaude版と比較する場合は、旧PCと既存Slack Appをそのまま残し、このPCでは
`zero-codex`、`~/.codex/zerokun`、新しいSlack Appを使います。旧Appの`xapp-`/`xoxb-`
tokenをこのPCへコピーしないでください。同一PCでClaude版とCodex版を同時稼働させる構成は
サポートしません。

同一PCのClaude版を完全に置き換える場合だけ、旧 `zero` cloneを残したまま`zero-codex`を
別directoryへcloneし、旧stateを明示してsetupします。

```bash
ZEROKUN_LEGACY_CUTOVER=1 \
ZEROKUN_STATE_DIR="$HOME/.claude/channels/slack" \
bash zerokun/setup.sh
```

この明示的なcutoverでは旧runnerをdrainして停止し、待機jobをCodex queueへ引き継ぎます。

新しい Mac へ一式入れる場合:

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

先にファイルを保存するため、実行前に内容を確認できます。既に `zero-codex` をclone済みなら、その repository で
`git switch main` を実行してから `bash zerokun/bootstrap-macos.sh --with-slack` を使えます。

bootstrapはZero-kun本体とは別の`zerokun-workspace` Git repositoryを既定projectとして作ります。
既存projectを使う場合は`--project-dir /absolute/path/to/project`を指定してください。
Zero-kun本体はhost runtimeなので、そこを対象にしたSlack write jobは常に拒否されます。

依存関係だけ診断する場合は `--doctor`、導入済み環境で Slack 設定だけ再開する場合は
`--slack-only` を使います。詳しくは
[`zerokun/NEW_MAC_SETUP.md`](zerokun/NEW_MAC_SETUP.md) を参照してください。

### Slack App

推奨はこのPCのCodex版専用に新しいSlack Appを作ることです。
[`zerokun/templates/slack-app-manifest.yaml`](zerokun/templates/slack-app-manifest.yaml)
を Slack の **Create New App → From a manifest** へ貼り、その後:

1. App-Level Token に `connections:write` を付け、`xapp-...` を取得する。
2. Workspace へ Install し、Bot User OAuth Token `xoxb-...` を取得する。
3. 次のファイルへ保存する（既存ファイルは setup が上書きしません）。

```bash
~/.codex/zerokun/.env
```

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

既定stateは常に `~/.codex/zerokun` です。旧版の`~/.claude/channels/slack`は
自動選択せず、token・access・queue・routesを暗黙に流用しません。in-place cutover時だけ
`ZEROKUN_LEGACY_CUTOVER=1`と`ZEROKUN_STATE_DIR`の両方で旧stateを明示してください。

## Access 設定

DM の初回メッセージには pairing code が返ります。表示された code を正確に指定します。
code の省略や自動承認はできません。

```bash
zerokun-access pair abc123
zerokun-access status
```

チャンネルを有効にする例:

```bash
zerokun-access channel add C0123456789
zerokun-access channel allow C0123456789 U0123456789
```

受信を許可しても repository write は許可されません。書込みが必要な利用者だけ別に付与します。

```bash
zerokun-access write allow U0123456789
zerokun-access write deny U0123456789
```

全コマンドと設定項目は [`ACCESS.md`](ACCESS.md) にあります。

## 起動と運用

```bash
# setup後、新しいterminalで
zerokun

# 別terminalから
zerokun-status
zerokun-jobs status
```

`zerokun` は永続 job runner を独立process groupへ起動してから Slack gateway を前景で起動します。gateway は
`Ctrl-C` で停止しますが、runner はそのsignalを受けず未処理 queue のため常駐します。macOS の watchdog が
60秒ごとに両方を確認します。

更新:

```bash
zerokun-update
```

更新対象は `origin/main` の fast-forward のみです。未コミット変更や未 push の local commit
がある場合は停止します。書込み許可済みの利用者は Slack で「ゼロくんを更新して」と依頼でき、
通常 FIFO の外にある detached updater が自己デッドロックを避けて実行します。
remoteの候補commitは隔離cloneをCodex sandbox内でsandbox-safe contract test・型検査・build・shell検査してから
live branchをfast-forwardします。macOSはsandboxの入れ子を拒否するため、実Codex sandbox・tmux・process制御を
使うintegration testは通常の`verify.sh`と公開CIで全件実行し、候補sandbox内では再実行しません。
更新元は`https://github.com/zerocolored/zero-codex(.git)`だけで、local Git configは安全なallowlist外の
helper・include・HTTP/credential設定があれば実行前に停止します。
停止前に更新journalとSQLiteの整合snapshotを作成し、setupまたは再起動後の接続確認に失敗した場合は
旧commit・旧DB・旧serviceへ自動rollbackします。強制終了でjournalが残った場合も次回起動前に
rollbackを完了します。

## Routing

チャンネルごとの作業 repository は state dir の `routes.json` で固定します。

```json
{
  "C0123456789": {
    "repo_path": "/Users/me/Desktop/Project/example",
    "label": "example"
  }
}
```

DM は launcher に渡した project directory、チャンネルは route の directoryを使います。
一度採用した Slack thread の route は SQLite に固定され、途中で設定を変えても別 repository
へ飛びません。

## セキュリティ境界

- 未登録 channel、未許可 DM、bot DM は受け取りません。
- pairing は1時間で失効し、同時 pending は3件までです。
- Codex 0.149.0+ の named permission profile を使います。minimal runtimeから始め、
  対象repository、当該jobの添付、scratch、outboxだけを許可します。HOME・state・共用tempはdenyします。
- read senderはrepository readのみ、write senderだけrepository・`.git` writeとnetworkを許可し、
  どちらも `-a never` で対話的な権限昇格を行いません。
- host runtimeをSlack経由で書き換えられないよう、Zero-kun自身のrepositoryへのwrite jobは拒否します。
  Codex shellのHOME/TMPDIRはjob scratchへ隔離されるため、commit identityはprojectのlocal
  `.git/config`へ設定してください。HOMEのcredentialを使うpushは既定ではできません。
- 通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
  linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。HOMEのglobal
  Git/GitHub credentialは公開しないため、remote操作は安全なHOME外認証がない環境では利用できません。
- Codex は`--ignore-user-config --ignore-rules`で起動し、起動直前の`config/read`でnamed
  permissionの実効値をmanaged/MDM layerまで照合します。安全規則は`developer_instructions`、
  未信頼のSlack本文はstdinへ分離します。子環境は必要変数のallowlistです。
- apps・plugins・MCP・hookは無効化し、Web検索はwrite許可jobだけに限定します。
  write jobのcommand networkはproxyを通し、Slack関連domainだけは常に拒否します。
- 添付と成果物は50MBまでです。成果物はjob専用 `outbox/<job-id>/` 直下のregular fileをrunner専用
  sealed領域へ移してから上限付きFDで読み、任意path・symlink・device/FIFOを拒否します。
- terminal本文と成果物単位のdelivery checkpointはSQLiteへ別々に保存します。本文成功後に添付だけ失敗しても本文は再投稿しません。成果物は指数backoffで5回試し、なお失敗する場合は打切り通知を1回投稿します。checkpoint確定済みの成果物は再送しませんが、Slack upload成功直後・checkpoint確定前のprocess crashでは同じfileが再uploadされる可能性があるat-least-once配送です。空fileは添付しません。
- Codex stdout/stderr logは各20MBを上限にし、解析用memoryは各1MBのtailに制限します。
- 完了jobは通知と成果物の配送checkpointが全て確定した後だけretention対象になります。既定30日で
  job固有fileをGCし、Slack再配送を防ぐidempotency tombstoneは既定10年保持します。runtime logも
  20MBで上限化します。`zerokun-jobs gc`で即時実行できます。
- `danger-full-access`、Slack 上の承認ボタン、Codex からの Slack API 呼出しは使いません。

## 主なファイル

- `server.ts`: Slack Socket Mode、access gate、添付取得、durable enqueue、履歴回収
- `zerokun/job-runner.ts`: SQLite queue、session/thread 所有権、Slack 完了通知
- `zerokun/runner-launcher.ts`: runnerの独立process group起動、安全なlog接続
- `zerokun/codex-executor.ts`: Codex CLI 実行、JSONL/session解析、sandbox分離
- `zerokun/access.ts`: pairing・受信権限・書込み権限の管理 CLI
- `codex-channel.sh`: standalone gateway と runner の launcher
- `zerokun/update.ts`: `main` ブランチ用の安全な自己更新
- `zerokun/watchdog.sh`: bridge/runner の状態監視

## 開発時の検証

```bash
bun install
bun run verify
```

`verify` は型検査、全test、build、shell構文検査を実行します。同じ完全検証を
`.github/workflows/codex.yml` がmacOSで実行します。実際のSlack接続には有効な
`xoxb-` / `xapp-` tokenが必要です。テストsuiteはtokenや外部Slack workspaceを変更しません。

## License

Apache-2.0
