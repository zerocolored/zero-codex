# ゼロくん一式（Slack → ローカル Claude ボット）

このリポがゼロくんの実体。Slack 受信(bridge)・スレッド振り分け(threads)・SQLite直列job queue・
起動スクリプト・オーナー重厚モード(トリアージ + レベル別検証 + /dev)の配線・
新マシンセットアップを全部含む。

## 新しいMacのセットアップ

最短手順は [NEW_MAC_SETUP.md](NEW_MAC_SETUP.md) が正本。旧Macから`bootstrap-macos.sh`を
1ファイルだけAirDropし、新Macで次を実行する。

```bash
bash ~/Downloads/bootstrap-macos.sh
```

Command Line Toolsはバージョン選択不要。スクリプトが`xcode-select --install`を呼び、
そのmacOSに適合する版の導入完了を待つ。Homebrew、GitHub CLI、tmux、Bun、Claude Code、
Codex CLI、3つのBellSalesAI実装リポを含む必要リポ、ゼロくん配線まで自動で行う。

人の操作が残るのは、macOSの確認ダイアログ、各アカウントのログイン、
Slack App作成とトークン入力だけ。Slack Appは用意済みmanifestから作成する。

### 既にclone済みの場合

```bash
bash ~/Desktop/Project/claude-channel-slack/zerokun/bootstrap-macos.sh
```

必要CLIとログインがすべて済んでおり、配線だけ再実行する場合に限り
`bash zerokun/setup.sh`を直接使う。

## 構成

| 場所 | 役割 |
|---|---|
| `server.ts` / `gate.ts` | Slack bridge 本体(受信・許可判定) |
| `skills/threads/` | スレッドごとの担当AI振り分け |
| `zerokun/job-runner.ts` | SQLiteへjobを永続化し、全チャンネル共通で1件ずつFIFO実行 |
| `claude-channel.sh` | 起動スクリプト(`zerokun` コマンドの実体)。オーナー重厚モードの読み込み配線込み |
| `zerokun/setup.sh` | 新マシンセットアップ(配線の再現) |
| `zerokun/bootstrap-macos.sh` | まっさらなMacのCLT・CLI・ログイン・clone・Slack設定を順番に実行 |
| `zerokun/NEW_MAC_SETUP.md` | 新Macセットアップ手順の正本 |
| `zerokun/update.ts` | 3リポを安全に更新・検証し、ゼロくんとjob runnerを再起動 |
| `zerokun/update-request.ts` | Slack更新依頼を独立workerへ渡し、元スレッドへ完了通知 |
| `skills/zerokun-update/` | 「ゼロくん更新して」を専用更新経路へ送るSkill |
| `zerokun/templates/` | 設定ファイルの雛形(トークン等の秘密は含まない) |
| `~/.claude/channels/slack/` | 実際の設定・状態(トークン・許可リスト・スレッド対応表)。**git 管理外** |
| `~/.claude/channels/slack/owner/` | オーナーの CLAUDE.md + /dev スキル(ernie1358 の2リポを clone。更新は `git pull`) |

## SQLite直列job queue

コード・設定・docs変更、長い調査、テスト/build、commit/push、PRなどの依頼は、
スレッド担当が`enqueue_job`を1回だけ呼び、`~/.claude/channels/slack/jobs.sqlite3`へ保存する。
job runnerのワーカー数は設定変更できない固定値`1`で、別チャンネル・別スレッドの依頼も
受付順に1件ずつ実行する。軽い説明や短い読み取り確認はキューへ入れず、スレッド担当が即答する。

```bash
zerokun-jobs status
tail -f ~/.claude/channels/slack/job-runner.log
```

- 同じSlackイベントの再配信は`chat_id + message_id`で重複登録を防ぐ
- daemon再起動時は`running`だったjobを`queued`へ戻す
- 失敗したjobは`failed`へ確定し、次のjobは止めない
- 同じSlackスレッドの後続jobは、最大5件まで同じClaude sessionを再開する

## 重厚モードの仕組み

起動時に `zerokun-triage.md`(トリアージ) + オーナー `CLAUDE.md`(レベル別モード) を連結し、
`--append-system-prompt-file` で**ゼロくんの Claude にだけ**注入する。
普通に `claude` と打って開くセッションには一切影響しない。

- トリアージ: ごく簡単な質問・軽微な UI 変更 → 単独即答 / それ以外 → レベル別多人数検証、実装は /dev
- レベル2以上は codex CLI が必要(`brew install` 等で導入し OpenAI アカウントでログイン)

## 運用の注意

- 更新は `zerokun-update` を使う。実行中jobの完了を待ち、3リポを事前検査してから
  `origin/main` へfast-forwardし、全テスト・build・setup・再起動・プロセス確認まで行う。
  dirty worktreeまたは未マージbranchが1つでもあれば、作業内容を上書きせず停止する。
- 通常はSlackで「ゼロくん更新して」と依頼する。専用Skillが受付後に独立workerを起動し、
  完了・失敗を同じスレッドへ通知する。`zerokun-update`はSlackが使えない場合の手動経路として残す。
- 更新後のSlack botはdetached tmux session `zerokun-slack`で常駐する。
  画面確認は`tmux attach -t zerokun-slack`、確認後に抜ける操作は`Ctrl-b`→`d`。
- 停止は Ctrl-C か通常の kill。`kill -9` 禁止(plugin.lock が残って次回起動が無言で死ぬ)
- 二重起動は起動スクリプトがガードする(既存がいたら中止)
- 詳細な運用ドキュメントは Notion「AI管理 → ノートDB」の引継書を参照
