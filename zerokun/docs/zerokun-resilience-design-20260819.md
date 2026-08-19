# ゼロくん堅牢化 設計書（全5タスク）

作成: 2026-08-19。Slack調査と実コード読解（server.ts / job-runner.ts / jobs.sqlite3 実データ）に基づく。
**各タスクは独立に実装・PR 可能。** 優先順位: A → B → C → D（E の watchdog は独立なので並行可）。
リポ: zerocolored/zero、テストは bun test（既存 `zerokun/*.test.ts` の流儀に合わせる）。

方針の前提（決定済み）: **自動再起動はしない。** bridge は Muxy のゼロくん用タブ内の対話セッションで動かす現行運用を維持し、止まったことに「気づける」＋動いている間を「堅くする」のが本書の範囲。

## 共通の重要注意

- **反映経路が2種類ある（ハマりどころ）**:
  - `job-runner.ts` の実行実体は **`~/.claude/channels/slack/job-runner.ts`**（`zerokun/setup.sh` が `install` でコピーする方式）。**リポを直しただけでは動かない。** 反映は setup.sh 再実行か `install -m 0700 zerokun/job-runner.ts ~/.claude/channels/slack/job-runner.ts` + デーモン再起動。
  - `server.ts` はリポから直接起動（`claude-channel.sh` が `bun server.ts`）。こちらは `zerokun-restart` で反映される。
- `.env` / `access.json` / `jobs.sqlite3` / 各種 lock は `~/.claude/channels/slack/`。トークン値をログ・チャット・コミットに出さない。
- **TCC 制約**: `~/Desktop` 配下は launchd 背景プロセスから `Operation not permitted` になる（このMacで実証済みの既知問題）。launchd から実行するものは必ず `~/.claude/channels/slack/` 側に置く。

---

## タスクA: レート制限で死んだジョブの自動再開（最優先）

### 現状と実害
worker Claude が使用量上限（5時間制限等）で exit≠0 になると、`runQueuedJobs` の catch が `store.fail()` して**永久 failed**。人間が言い直すまで再開しない。実例（jobs.sqlite3 に現存）:
- job 9c5efaef (2026-08-17): stdout に `"resetsAt":1786949400,"rateLimitType":"five_hour"` と**リセット時刻の epoch が載ったまま**捨てられた
- job 51dcd0f8 (2026-08-18): 「You've hit your session limit · resets 1:30pm」を通知して failed

### 設計
1. **スキーマ**: `jobs` に `not_before INTEGER`（NULL可）を追加。既存DBがあるので `CREATE TABLE IF NOT EXISTS` では効かない — `PRAGMA table_info(jobs)` で列の有無を見て `ALTER TABLE jobs ADD COLUMN not_before INTEGER` を冪等に実行（JobStore コンストラクタ内）。
2. **claimNext**: 先頭の SELECT を `WHERE status='queued' AND (not_before IS NULL OR not_before <= ?)`（? = Date.now()）に変更。
3. **抽出関数**: `describeFailure` と同じイベント走査ロジックで `extractRateLimit(stdout): { rateLimited: boolean, resetsAtMs: number | null }` を追加。`resetsAt`（epoch秒）が取れなければ `now + 60min` をフォールバック。
4. **runQueuedJobs の catch 分岐**:
   - rateLimited → `store.requeueAt(job.id, resetsAtMs + 60_000, reason)`（status=queued, not_before セット, **session_id は温存**, worker_id/started_at クリア）。Slack 通知は failed ではなく「⏸ 使用量上限のため一時停止。HH:MM に自動再開します」。
   - 無限ループ防止: rate-limit 由来の requeue は `attempts >= 5` で打ち切って failed。
   - （任意）rate でも usage でもない一時的エラーは 1 回だけ即 requeue。Xenowind は 10秒×11回だが、ゼロくんの worker は 1 本が長時間走る構造なので控えめでよい。
5. **再開時の継続**: rate-limit requeue されたジョブはタスクB の経路で自分の session_id を `--resume` し、続きから走る。

### 受け入れ条件（テスト先行）
- 偽の rate-limit stdout（上記実例の形）で `extractRateLimit` が resetsAt を取れる / 取れない場合のフォールバック
- requeueAt 後、not_before 前は claimNext が返さず、経過後に返す
- attempts 上限超えで failed に落ちる
- 実機: 上限中に job を投げ、リセット後に自動で走り切って完了通知が来る

---

## タスクB: 中断ジョブを「続きから」再開（--resume）

### 現状
電源断/デーモン再起動時、`recoverInterrupted()` が running→queued に戻すところまでは動く（実績あり）。しかし `claimNext` が **session_id を無条件に上書き**（新規UUID、または同スレッドの過去 completed ジョブの session）するため、中断した自分のセッションには戻らず**白紙からやり直し**。作りかけの branch/worktree が残ったまま新規開始し、衝突・二度手間のリスク。Claude Code は transcript を常時ディスク保存しているので、Xenowind の resume_context 相当が `--resume` だけで手に入る。

### 設計
1. **claimNext**: `row.attempts > 0 && row.session_id !== null` なら「中断のやり直し」と判定 → `sessionId = row.session_id`, `resumed = 1`（新規UUID生成・prior completed 探索より優先）。
2. **buildWorkerPrompt**: `job.attempts > 1` のとき先頭に追記: 「前回の実行は途中で中断された。まず git branch / worktree / 途中成果を確認し、最初からやり直すのではなく続きから完了させること」。
3. **フォールバック**: `claude --resume <session_id>` が transcript 不在で失敗した場合は session_id を捨てて新規セッションで 1 回だけ再試行（executeClaudeJob の失敗種別で判定）。

### 受け入れ条件
- claimNext unit test: 中断ジョブ再claimで session_id 温存 + resumed=1 / 新規ジョブは従来どおり / スレッド継続（prior completed）も従来どおり
- 実機: job 実行中にデーモンを kill → 再起動 → 同じ session で続きから完了する

---

## タスクC: 停止中に来た新規メッセージの起動時回収（catch-up sweep）

### 現状
`server.ts` のポーラーは **threads.json にある既存スレッドの返信だけ**回収する。ゼロくん停止中に来た「新規の @メンション」と「DM」は起動後も配送されず消える。DM は server.ts 内コメントで「DM catch-up は一度も配っていない」と明記された公認ギャップ。

### 設計
1. 起動時（`slackApp.start()` 成功後）に 1 回だけ `catchupSweep()` を実行:
   - 対象: `access.json` の `channels` キー（C…）+ DM チャンネル一覧（`conversations.list types:im` — bot scope に im:read あり）。
   - 各チャンネルを `conversations.history`（oldest = now−48h、env `ZEROKUN_CATCHUP_WINDOW_H` で変更可）で走査。
   - 配送判定は既存部品を再利用: `delivered.json` に無い ts のみ、channel は resolveIsMention でメンション必須、DM は全件、gate を通す。**deliver() が dedup するので二重配送は構造的に起きない。**
   - 古い順に配送。チャンネルあたり上限（default 20件）でスパイク防止。件数を stderr にログ。
2. 判定ロジックは gate.ts の流儀で pure 関数に切り出す: `planCatchupSweep(history, deliveredKeys, policy, botUserId) → 配送リスト`（unit test 可能にするため）。

### 受け入れ条件
- planCatchupSweep の unit test（メンション有無 / DM / delivered 済み / 窓外 / 上限）
- 実機: ゼロくんを止める → DM と新規@メンションを送る → 起動 → 両方に応答が来る（従来はどちらも無反応）

---

## タスクD: plugin.lock の PID 再利用対策（小・30分）

### 現状
`acquirePluginLock`（server.ts:82-110）は `process.kill(pid, 0)` の生存確認のみ。Mac 再起動後に PID が無関係なプロセスへ再利用されていると「別インスタンス稼働中」と誤判定して**無言で exit(0)** → 「Claude は立つが Slack に繋がらない」。2026-06-08 に実発生した既知事象。

### 設計
`job-runner.ts` の `acquireDaemonLock` と同じ照合を移植: PID 生存に加えて `ps -o command= -p <pid>` の出力が `server\.ts` を含むかを確認。含まなければ stale lock として reclaim。約10行。

### 受け入れ条件
- 生きているが無関係な PID（例: 1）を plugin.lock に書いて起動 → stale と判定して reclaim し正常起動
- 本物の別インスタンス稼働中は従来どおり exit

---

## タスクE: watchdog（launchd 死活監視 → Slack DM 通知）

A〜D が効くのは「動いている時」。E は**そもそも止まったことに気づく**ための独立タスク（A〜D と並行実装可）。自動再起動はせず、復旧は人間が Muxy のゼロくん用タブで `zerokun` / `zerokun-restart` を打つ。

### 全体像

```
launchd (StartInterval 60s, RunAtLoad)
  → ~/.claude/channels/slack/watchdog.sh
    → bridge / job-runner の生存判定（ps 照合）
    → 状態遷移があれば Slack DM（bot トークンで curl 直叩き）
    → 状態を watchdog-state.json に保存
```

### 生存判定（既存実装の流儀を踏襲）
- **bridge**: `~/.claude/channels/slack/plugin.lock` の PID が生存 **かつ** `ps -o command= -p PID` に `server.ts` が含まれる（タスクD と同じ照合方式。PID 再利用の誤検知防止）。
  - plugin.lock は正常終了時に消える。**ファイル不在 = 停止扱い**（zerokun 未起動も検知対象なので意図どおり）。
- **job-runner**: `~/.claude/channels/slack/job-runner.lock/pid` の PID 生存 + command が `job-runner\.ts\s+daemon` に一致。
- どちらか一方でも down なら「停止」。DM にはどちらが死んでいるか明記する。
- 任意の加点: runner down かつ jobs.sqlite3 に queued が残っていれば「待機中ジョブあり」と文言を強める（sqlite3 依存を増やしたくなければ省略可）。

### 通知仕様（スパム防止が本体）
- 状態ファイル `~/.claude/channels/slack/watchdog-state.json`:
  `{ status: "up"|"down", downSince, lastAlertAt, consecutiveDownChecks }`
- 遷移ルール:
  - up→down: **2 回連続で down を観測してから**初回 DM（`zerokun-restart` の入れ替え瞬間の誤報防止）
  - down 継続: 60 分ごとに再通知（`lastAlertAt` で抑制）
  - down→up: 「✅ ゼロくん復旧」を 1 回だけ DM
- ミュート: `~/.claude/channels/slack/watchdog-off` が存在したら何もしない（メンテ・長期停止用）
- 送信方法: `.env` の `SLACK_BOT_TOKEN` で `conversations.open`（users=通知先）→ `chat.postMessage`。
  - 通知先 default = `access.json` の `allowFrom[0]`（現状 U0A0DCGSJA0 = 末次本人）。`ZEROKUN_WATCHDOG_NOTIFY` で上書き可。
  - 送信失敗でも exit 0（launchd に連続失敗ジョブ扱いさせない）。トークンをログに出さない。
- 文言例: `🚨 ゼロくん停止中（bridge: down / job-runner: up）10:12から。復旧: Muxyのゼロくん用タブで zerokun-restart`

### 配置と TCC 制約（このMacで一番重要な注意）
- **launchd から実行する実体は `~/.claude/channels/slack/watchdog.sh` に置く**（冒頭の共通注意どおり、~/Desktop のリポ内スクリプトを launchd から直接叩かない）。方式は job-runner.ts と同じ「リポが正本、setup.sh が state dir へ install」。
- watchdog 自体は Desktop 配下を一切読まない設計にする（判定材料は `~/.claude/channels/slack/` と `ps` と Slack API だけで完結する）。
- 実装言語は bash + curl + python3(標準ライブラリ、JSON整形用) のみ。launchd の PATH は最小なので bun 等を使う場合はフルパス必須だが、使わないのが安全。
- plist: `~/Library/LaunchAgents/com.zerokun.watchdog.plist`
  - `ProgramArguments`: `[/bin/bash, <HOME>/.claude/channels/slack/watchdog.sh]`
  - `StartInterval`: 60 / `RunAtLoad`: true
  - `StandardOutPath` / `StandardErrorPath`: `~/.claude/channels/slack/watchdog.log`
  - ログ肥大対策: スクリプト冒頭で 1MB 超なら truncate。

### 実装物一覧
1. `zerokun/watchdog.sh` — 本体（正本）
2. `zerokun/templates/com.zerokun.watchdog.plist.template` — `__HOME__` 置換式
3. `zerokun/setup.sh` に追記:
   - `install -m 0700 zerokun/watchdog.sh → $CH/watchdog.sh`
   - テンプレから plist 生成 → `launchctl bootout gui/$UID/com.zerokun.watchdog 2>/dev/null; launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.zerokun.watchdog.plist`（冪等）
4. `README.md` に 1 段落（ミュート方法 `touch watchdog-off`・通知先変更・ログ位置）
5. 環境変数（すべて任意）: `ZEROKUN_WATCHDOG_NOTIFY`（通知先 User ID）、`ZEROKUN_WATCHDOG_REALERT_MIN`（default 60）、`SLACK_STATE_DIR`（テスト用に state dir を差し替え）、`DRY_RUN=1`（送信せず本文を stdout へ）

### テストと受け入れ条件
`watchdog.sh --selftest` を用意する: `SLACK_STATE_DIR` を一時ディレクトリに向け、偽 lock を置いた各状態で `DRY_RUN=1` 実行し、送信本文と state 遷移を stdout で確認できること。実 Slack を使う確認は最後に 1 通だけ（テストと明記した DM）。

- (a) 両方生存: DM なし、state=up
- (b) plugin.lock 退避 → 1 周目 DM なし、2 周目で停止 DM 1 通
- (c) down 継続中は 60 分間隔でしか再通知しない
- (d) lock 復元 → 復旧 DM 1 通
- (e) `watchdog-off` 存在時は一切送らない
- (f) `zerokun-restart` の入れ替え中（数十秒 down）で誤報しない
- (g) launchd 登録後、`launchctl list | grep com.zerokun.watchdog` で稼働確認、watchdog.log に毎分の実行痕跡

### スコープ外（やらない）
- 自動再起動、Muxy タブ操作、bridge の launchd 常駐化

---

## 参照（既存コードの該当箇所）

- plugin.lock の形式と取得/解放: `server.ts:37, 82-119`（中身は PID 文字列のみ）
- job-runner のロックと ps 照合: `zerokun/job-runner.ts` `acquireDaemonLock`（`job-runner.lock/pid` + `ps -o command=` 照合）
- 中断ジョブの requeue: `zerokun/job-runner.ts` `recoverInterrupted` / claim は `claimNext`
- レート制限の失敗整形（判定ロジックの流用元）: `zerokun/job-runner.ts` `describeFailure`
- `.env` の読み方（`^(\w+)=(.*)$`）: `server.ts:54-61`
- 起動経路（bridge と job-runner をどう立てているか）: `claude-channel.sh:30-75`
- 配送済み台帳とスレッド回収ポーラー: `server.ts:861-968, 1193-1342`
