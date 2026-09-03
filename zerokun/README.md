# Zeroちゃん一式（Slack → Herdr → ローカルCodex）

## 結論

常駐するSlack gatewayが受信をSQLiteへ保存し、Herdr内から起動された1本のrunnerが
`codex app-server --stdio`をJSON-RPCで直列実行します。Codexはglobal→projectの`AGENTS.md`をjobごとに読み、
read jobは回答まで、write jobは調査・設計・実装・review・Git・依頼されたmerge／deploy確認までを
1つのprimary Codex workflowで完遂します。Zeroちゃんは独自のphaseやadvisor照合を追加しません。

## 導入

Codex CLI 0.149.0以上、Herdr 0.8.2以上（必要なworkspace/tab/pane/agent APIを含む）、
`codex login`と`grok login`済みのsubscription認証、GitHub CLIと`gh auth status --hostname github.com`が
成功するGitHub認証が必要です。Codexはdaemon起動時と各job attempt直前に
`Logged in using ChatGPT`を再検証します。Zeroちゃん自身はAPI keyを要求せず、認証画面も操作しません。

GitHub未認証のMacでは起動前に人が`gh auth login --hostname github.com --git-protocol https --web`を
一度実行します。稼働中のZeroちゃんはloginを行わず、CodexへGitHub credentialを渡しません。Codexは
repository限定の`zerokun_github`経由で認証済みpush・PR・approve・merge・checks確認を実行できます。
このbrokerはcredential transportだけを担当し、作業方針や公開順序はCodexと`AGENTS.md`が決めます。

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
# `Logged in using ChatGPT` と表示されることを確認
# Herdrの専用pane内で対象projectへ移動して実行
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start
```

対象folder直下にfrontend／backend／appなどの通常cloneが2件以上ある場合は、対象folder自身が
Git repositoryでなくてもmulti-repository workspaceとして起動できます。

## Runtime 構成

| ファイル | 役割 |
|---|---|
| `../codex-channel.sh` | `zerochan start/stop`の検証とservice controllerへの委譲 |
| `service-control.ts` | job保護付き停止、専用runtime tab作成、安定起動確認 |
| `../server.ts` | Slack Socket Mode、access gate、添付取得、durable enqueue、catch-up |
| `job-runner.ts` | SQLite FIFO、thread/session 所有権、Slack 通知、返信宛先判定ledger |
| `slack-thread-intent.ts` | 匿名化したthread文脈をsubscription Codexで宛先分類 |
| `runner-launcher.ts` | runnerの独立process group起動、安全なlog接続 |
| `herdr-runtime.ts` | Herdr socket・pane・terminal・workspaceの起動前/各job再検証 |
| `herdr-job-monitor.ts` | job専用Herdr監視tabの永続state、安全な日本語タイムライン、再起動reconcile、自動close |
| `herdr-job-monitor-view.ts` | tokenを持たずrolling feedだけをterminalへ安全に表示するviewer |
| `codex-executor.ts` | sandboxを選び、App Server thread/turn/controlを検証 |
| `browser-verification-broker.ts` | fresh Chrome profileでlocalhostだけを描画・PNG検証 |
| `github-credential-broker.ts` | operator credentialを隠したrepository限定GitHub transport |
| `access.ts` | pairing、DM/channel、write 許可の端末 CLI |
| `project-channel-config.ts` | project-local channel設定と共有SQLite routeの同期 |
| `update.ts` | `origin/main` から安全に fast-forward 更新 |
| `update-request.ts` | Slack 自己更新を FIFO 外の detached worker へ渡す |
| `process-generation.ts` | macOS libprocによるmicrosecond process世代IDとsignal前再検証 |
| `seatbelt-fingerprint.ts` | setsid/reparent後も継承sandboxからjob固有processを再発見・回収 |
| `watchdog.sh` | gateway と runner の状態遷移を監視 |

## Durable FIFO

state dir の `jobs.sqlite3` に、認可済み Slack event を transaction で保存します。

1. gateway が route と write 権限を決め、Slack event metadataを`inbound_deliveries`へ先に保存する。
2. 添付をdeadline・50MB上限付きでdownloadし、`jobs` と `slack_threads` を同じtransactionで保存する。
3. 添付取得が5回失敗したeventはfailed jobとterminal通知へ退避し、後続eventのFIFOを進める。
4. runner が `runtime=codex` の先頭1件だけ claim する。
5. 同じHerdr workspaceへ非フォーカスの監視tabを作り、viewerの
   durable receipt・PID世代・argv・cwd・heartbeatを確認してからCodexを起動する。画面上のone-time
   markerは運用証拠であり、再起動後の正本にはしない。
6. supervisorがPID registrationを先に永続化し、`thread/start`または`thread/resume`の
   handshakeを検証した時点でthread IDをDBへ保存する。
7. 正常終了/失敗とterminal通知を同じtransactionで保存し、Slack投稿成功後に通知済みにする。
8. Codexとその所有processの停止、結果checkpoint、SQLite terminal化のすべてが確定してから
   viewerのterminal write/drainとbindingを再確認する。正常完了と中止は監視tabをexact IDで閉じる。
   通常失敗は公開可能な固定分類の原因を表示し、全feedをseal/drainしてviewerを待機状態へ固定したうえで
   tabを確認用に残す。monitor obligationだけをretireするため、失敗tabは後続FIFOを止めない。rate-limit再開では
   同じtabとhealth監視を保持する。viewer・tab・heartbeatを証明できなくなった場合はCodexを停止し、
   後続jobを開始せず再起動reconcileへ渡す。
9. 実行中の監視tabを人が閉じた場合、tracked executorは回収しても、最終出力の実表示を後から証明できない。
   次回起動や`recover-interrupted`は当該jobを自動failed化せず、監視tab再作成も行わず、
   durable monitor obligationを保持してFIFOを止める。失敗確定後に確認用として残ったtabは閉じてよく、
   次回reconcileが残存stateだけを回収する。Slack deliveryだけはFIFOと独立に再試行する。
10. 通常stopは実行中jobがあれば拒否する。`zerochan stop --force`では所有processだけを停止し、
    待機job・同一thread履歴・Codex sessionを保持して、次回start後の再開判断へ渡す。

sessionはSlack thread・repository・write modeが同じ場合に最大20 jobまで再利用し、senderは
session keyに含めません。利用回数はjob retentionとは独立したappend-only台帳で記録し、古いjobをGCしても
20件上限を再利用しません。実行中jobへの同thread返信はsenderを問わず同じCodex workflowへ渡します。
active jobの固定済み権限で処理するため、active write jobでは同threadのread-only senderにも操作を
委任します。別threadは独立FIFOであり、完了後に作る新jobの権限はそのsenderから改めて判定します。

20 jobはCodex側のcontext window／自動compact制限ではなく、Zeroちゃんがnative physical threadを
更新するlocal safety policyです。これとは別に、terminal jobのrequest、同thread follow-up、公開済み
commentary／回答、最終結果または公開用失敗分類を`slack_thread_job_history`へsanitized blockとして永続化します。
次jobをclaimするtransaction内で、完全一致する`chat_id + thread_ts + repo_path`のimmutable snapshotを
`job_thread_history_snapshots`へ固定します。native resumeはprovider側の会話を使って二重注入せず、fresh
threadだけがsnapshotをcurrent requestより前のuntrusted referenceとして受け取ります。write mode／senderは
snapshot scopeではないため、権限を継承せずに同じ会話だけを継続できます。failed／completed job、daemon再起動、
20 job rotation、protocol変更、job retention GCをまたいでもarchiveは残ります。

公開、継続、中止、branch方向などSlack本文の意味は、このdurable historyとcurrent requestを受け取った
Codexが判断します。write許可は利用可能な能力を示すだけで、GitHub公開の要求ではありません。質問・調査、
実装、既存PRのapprove／merge、deploy確認を別のhost phaseへ分けず、同じCodex workflowがlive Git／GitHub
状態を読みながら依頼どおり進めます。Zeroちゃんはrepository境界とcredential transportを提供しますが、
Codexの結論を別のreview snapshotやpublication coordinatorで差し戻しません。

永続archive自体をscopeごとの直近64 jobへ圧縮し、省略済みjob数とcutoffだけを別台帳へ残します。
snapshotも直近64 job block、128 Ki文字／256 KiBを上限とし、UTF-8 block境界で古いものから省略します。
各archiveはevent数・文字数・byte数も制限します。credential、URL、machine-local path、Slack／内部ID、
`<zerokun_files>`成果物path、host control風markerは保存前に除去し、履歴本文はhost authority、write許可、
UI/UX承認、repository、sandboxを変更できません。添付は件数だけ保持し、binaryは保持しません。
upgrade前にすでにretention GCされたjobはbackfillできないため、その範囲だけはSlack本文または再添付から
改めて確認します。

並列 worker はありません。別threadのrequestは全て1本のFIFOです。ただし実行中の同じthreadへの
認可済み返信は、別userからでも同じCodex threadへ渡すため、新規会話として扱いません。単なる質問は
元taskの文脈で回答し、更新依頼は同じworkflowのdurable inputへ昇格します。完全一致の`中止`
（mention除去・NFKC正規化後）は
先行する未送信controlをdurableに取り消して
`turn/interrupt`します。App Serverの最終入力barrierが閉じた後も、Codex process回収とDB terminal確定が
終わるまでは同threadの完全一致`中止`だけを元jobへdurableに束縛します。barrier後の通常返信は次の
FIFO入力として保持し、後から`中止`が届いても元jobに束縛されていない返信を削除しません。後発の別threadは現在taskと
所有processのcleanupが終わってから開始します。受付返信は enqueue 直後に
返り、terminal通知はjobと同じSQLite transactionへ保存されます。Slack APIの遅延や一時失敗は
後続jobを止めず、durable notification workerが独立して再試行します。

## Codex 実行契約

read-only／write jobとも、1つのprimary Codex processと1つの`complete` turnで実行します。write jobでは
`AGENTS.md`を読んだCodexが調査・design・実装・review・test・Git・依頼されたmerge／deploy確認を最後まで
担当します。Zeroちゃんはprepare／implementation／reviewへprocess分割せず、review markerや外部advisor
receiptの照合で結果を差し戻しません。未信頼のSlack本文はprocess argvへ入れず、JSON-RPCの
`turn/start` inputとして渡します。

```text
codex <trust-args> -C <repo> \
  -c 'permissions.zerokun_job.filesystem={":minimal"="read",<job固有rules>}' \
  -c permissions.zerokun_job.network.enabled=<false|true> \
  -c default_permissions="zerokun_job" \
  -c project_doc_max_bytes=262144 \
  app-server --stdio
```

- 新規sessionは`thread/start`、継続sessionは`thread/resume`を使います。session IDをZeroちゃん側で
  推測・採番せず、responseのthread ID、物理cwd、OpenAI provider、model、`approvalPolicy: never`、
  named permission profile、AGENTS instruction sourceが全て一致した場合だけ保存します。通常失敗でも
  session自体を明示的にretireしていなければ、同じSlack threadの次jobでそのsessionをresumeします。
- 実行中の同thread返信は`turn/steer`で同じturnへ渡し、Codexが質問と作業更新を現在の文脈で判断します。
  完全一致の`中止`は`turn/interrupt`です。各controlはSQLite receiptをJSON writeより先に固定し、
  曖昧な送達を自動再送しません。
- `turn/completed`の`itemsView:"full"`に最終`agentMessage`があれば、その公式terminal結果を採用します。
  terminalがsummaryまたは本文欠落の場合だけ、`thread/items/list`等のbounded履歴APIへfallbackします。
  正常なterminal本文を別endpointとの完全一致不足だけで破棄しません。
- job本体に終了時間制限はありません。App Serverの`error` notificationはterminalではなく、
  `willRetry: true`ではrate-limitを含む同一turnの内部retryを待ちます。host側で同じpromptを
  再投入しません。`willRetry: false`の構造化rate-limitはSQLiteへ待刻を保存し、read-only jobは
  回数・合計時間上限なしでFIFO先頭に保持します。write jobは、初回turnが未送達だとdurable receiptで
  証明できる場合以外、副作用を二重実行しません。
- App Serverの論理完了後は同じsupervisor世代のCodexと子processを回収し、残留ゼロを
  確認してから結果を返します。
- supervisorは通常の親子/PGID追跡に加え、state内のjob固有Seatbelt allow/deny tagをkernelへ照会します。
  commandが`setsid`、stdio close、PID 1へのreparentを行っても、matching generationを全て停止して固定点を
  作り、再開後のTERMには通常cleanupの壁時計上限を設けません。完全一致の`中止`、host abort、内部fault、
  crash recovery時だけbounded KILLへ進み、3回連続で空になるまでv4 cleanup receiptを発行しません。
  relayの明示cancelが必要だった場合も成功へ昇格しません。tag identityはregistrationに
  永続化されるため、runner crash後の起動時recoveryでも同じ検査を行います。
- 実効config preflight、localhost browser broker、GitHub credential brokerも同じjob tagを継承します。
  executor登録より前にcrashしてもtag pairをdurable obligationとしてstartup時に再発見し、固定点回収が
  終わるまで次jobをclaimしません。
- resume先がないと公式responseで確定した場合だけsessionを消し、新規`thread/start`へ1回fallbackします。
- 安全規則は`developerInstructions`、未信頼のSlack本文はCodexのJSON-RPC inputへ分けます。
  Slack/Codex本文からhost shell commandを組み立てません。
- `<trust-args>` はread/writeとも `-a never` で、sandbox bypassを使いません。
- App Serverは`--ignore-user-config`を持たず、subscription認証済みの`CODEX_HOME`とそのuser configを読みます。
  起動直前の`config/read`が返す実際のeffective configをuser/project/managed/MDM込みで照合し、
  endpoint/provider差替え、legacy sandbox、named permission変更をfail-closeで拒否します。child environmentは
  PATH/HOME/CODEX_HOME/locale/proxy等のallowlistで作り、token/key/passwordや
  `ZEROKUN_*`をCodex shellへ継承しません。
- `AGENTS.md`の探索は無効化しません。Herdr identityと`project_doc_max_bytes=262144`は
  runtime側の信頼済み設定として毎job固定し、対象repository直下の物理`AGENTS.md`がApp Serverの
  `instructionSources`へ実際に含まれることもhandshakeで検証します。
- apps・plugins・hookと一般MCPは無効化し、必要なwrite jobで`zerokun_browser`と
  `zerokun_github`だけを追加します。
  Web検索はwrite許可jobだけに限定し、command networkとSlack関連domainをpermission profileで制限します。
  Slack tokenは子へ渡さず、Slack投稿をdeveloper instructionsでも禁止します。

## 権限

受信可否と repository write は別です。

- 通常: minimal runtime + repository read + 当該添付read + job outbox/scratch write
- `writeAllowFrom` の sender: minimal runtime + repository/`.git` write + network + localhost bind
- read senderは1つのread-only Codex workflow、write senderは1つのwrite-authorized Codex workflowを使います。
  advisor、review、test、Git、deployの進め方はCodexが`AGENTS.md`から決め、Zeroちゃんは別phaseへ分割しません。
- write jobではlocalhost限定browser verifierとrepository限定GitHub credential brokerを利用できます。
  brokerはSlack token、GitHub token、operator HOMEをmodelへ公開せず、Codexが選んだ操作だけを実行します。

Zeroちゃん本体のrepositoryはhost runtimeの信頼境界なので、そこへのwrite jobは許可者であっても
拒否します。bootstrapは本体と別の`zerokun-workspace`を、最小安全指示の`AGENTS.md`初期commit付き
既定projectとして初期化します。既存projectのproject固有`AGENTS.md`は任意で、存在する場合だけ
global `AGENTS.md`の後に読み込みとinstruction sourceを検証します。

両profileともHOME、state全体、共用tempを先にdenyし、必要なpathだけをより具体的なruleで
再許可します。Codex CLI 0.149.0以上を必須とし、古いCLIはjob受付前に拒否します。
通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。またHOMEのglobal
Git/GitHub credentialはmodelへ公開しません。認証済み操作はhost runtimeがlogin済み`gh`を使う
repository限定brokerへ委譲します。Codexはそのtoolでbranch publish、PR作成・承認・merge、GitHub
checks確認を行えます。Codex shell HOMEはread/writeともjob scratchへ分離します。commit identityはZeroちゃんが中立の固定値を
子processへ設定するため、repository localの`user.name`/`user.email`は必須ではありません。

Codex から Slack tool/API を呼ばせません。最終文は runner が bot token で投稿します。成果物を
返す場合は最終文末の `<zerokun_files>["/absolute/path"]</zerokun_files>` を runner が解釈します。
job専用`outbox/<job-id>/`直下の空でないregular fileだけをrunner専用sealed領域へ移し、open済みFDから
50MB上限で読みます。他path、空file、symlink、device/FIFOはuploadしません。terminal本文と成果物ごとの
送信直前に同じbyte列を軽量走査し、平文で明白なcredential patternがあるfileだけ添付を省略します。
PNG・PDF・ZIPなど形式自体は制限せず、archive展開、復号、OCRは行いません。
送信済み状態をSQLiteへ別々に残すため、添付失敗時に本文は再投稿しません。upload URL取得までの確実な
未送信失敗だけを指数backoffで再試行します。byte転送後は完了receiptまで同じprocessで待ち、突然死や
応答欠落で結果を証明できない場合は重複防止のためbyteを自動再送せずambiguousに固定し、永続化したSlack file IDを`files.info`で同じchannel・threadへ照合します。upload URL取得までの未送信失敗は回数で捨てず再試行し、曖昧な成果物だけ最大5回の配送状態
確認後も確定できなければ打切り通知を1回投稿します。checkpoint確定済みfileは再送しません。
Codex stdout/stderr logはfileごとに20MB、解析用memoryは1MB tailへ制限します。

## Thread と履歴回収

`slack_threads` は `(chat_id, thread_ts)` ごとに repository を固定します。gateway は:

- 起動時に直近の DM と channel mention を履歴から回収
- 未採用threadの途中でAppが初めてメンションされた場合、先頭からそのメンションまでのhuman投稿と
  添付を時系列の1タスクへまとめる。取得前にSQLiteへ保存するため、一時的なSlack読取失敗や再起動でも
  再試行でき、既に採用済みのthreadは再構築しない
- 48時間以内に活動した採用済み thread を60秒ごとに poll
- Socket Modeで受信した採用済みthreadの返信は60秒を待たず、現在turnのlive controlとして優先回収
- 採用済みthreadまたはAppが明示メンションされたthreadのhuman返信は、直前文脈を含むdurableなLLM宛先判定を先に通す
- Zeroちゃん宛てでないメンバー間の会話はreaction・投稿・queue・割り込みを一切発生させず無視
- 分類器障害時は誤受付／誤無視に確定せず、本文・添付ID・同じsnapshotをSQLiteに残した常駐workerからbackoff再試行
- DM follow-up は現在の DM allowlist を再確認
- senderが変わっても同threadならactive jobを安全に一時停止して先に回答し、そのjobの固定済み権限を引き継ぐ
- Socket Modeと履歴回収のどちらもdurable handoff後に同じ`eyes`リアクションを付ける
- 監視tabへ投影された本人の`💬 commentary`を発生ごとにdurable通知として同じthreadへ投稿し、
  固定時刻の状況問い合わせは行わない。未配送commentaryをterminalが追い越すこともない
- 正常完了時はterminal本文・成果物の配送後に元メッセージへ`white_check_mark`を付け、reactionだけ
  失敗した場合は本文を再投稿せず同じ永続台帳から再試行する
- Slack本文はアシスタントの一人称で簡潔で温かい日本語と自然な絵文字1〜2個を使い、固定の表示名や内部engine名を出さない
- live event と poll の重複を `(chat_id, message_ts)` で排除
- fresh stateでは検証済みSlack App IDごとの履歴下限を保存し、別PCへtokenだけを移した際の旧依頼再実行を防止

旧stateを`ZEROKUN_LEGACY_CUTOVER=1`と`ZEROKUN_STATE_DIR`で明示したin-place cutoverでは、旧 `threads.json` をSQLiteへ
importし、旧runnerをdrain/停止してから入れ替えます。旧待機jobはClaude sessionを破棄して
Codex queueへ引き継ぎ、停止後もrunningだった不確実なjobは二重実行せずfailed通知にします。

## State

既定は常に `~/.codex/zerokun` です。旧版の`~/.claude/channels/slack`は自動選択せず、
access・queue・process stateを暗黙に流用しません。旧PCのgatewayを停止する移行では既存Slack Appのtokenを
新stateへ安全に移して再利用できます。bootstrapがApp別の履歴下限をfresh DBへ固定するため、旧依頼は
再実行されません。移行中は新gatewayの起動までSlackへ新しい依頼を投稿しません。複数PCを同時稼働する場合は
PCごとに別のSlack Appを作成します。
同一PCのin-place cutoverだけcutoverフラグと旧stateを明示します。

```text
.env
access.json
jobs.sqlite3
job-logs/
job-monitors/<job-id>/
inbox/
outbox/<job-id>/
tmp/<job-id>/
plugin.lock
job-runner.lock/
executors/
sandbox-obligations/<job-id>/<attempt-nonce>/
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
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start
zerochan stop       # 実行中jobがある場合は何も停止せず拒否
zerochan stop --force # 所有processを停止し、待機jobと再開用履歴を保持
zerochan start      # 新しい「Zeroちゃん runtime」tabを作って再開
zerochan --restart  # 従来互換。通常は stop → start を使用
zerochan status
zerochan unset slack-channel
zerokun             # 互換alias。現在directoryで起動
zerokun-status
zerokun-jobs status
zerochan-access status
zerochan update
```

チャンネルは利用するSlack Appを招待し、対象projectで `zerochan set slack-channel C...` を実行すると
利用できます。新しい依頼はメンション、同じthreadの続きはメンション不要です。設定はGitに
含まれない `.zerochan/config.json` に保存され、`routes.json`の編集は不要です。最初の
`zerochan start`だけが共有gateway/runnerを起動し、別projectからの起動は同じserviceへ参加して終了します。
既存threadは最初のprojectへ固定されたままです。DMは共有gatewayを起動したprojectを使います。
multi-repository workspaceのmemberは初回設定時に`.zerochan/workspace.json`へ固定されます。
隠しfolder、symlink、Gitではない直下項目は作業対象外で、変更した各memberは個別に
test・commitされます。必要なpush・PR・merge・deploy確認も同じCodex workflowが担当します。
workspace memberだけがwrite permissionとGitHub brokerの対象になります。直下repositoryの追加・削除時は、意図しない対象拡大を防ぐため
設定を自動更新せず起動を停止します。

log:

```bash
tail -f "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/job-runner.log"
```

in-place cutoverでは`ZEROKUN_LEGACY_CUTOVER=1`も併せて指定してください。配置先だけを
変更する場合は`ZEROKUN_STATE_DIR`を明示します。

完了jobはterminal通知と全成果物の配送checkpointが確定してから既定30日で削除します。
Slack eventのidempotency tombstoneは既定10年保持し、runtime logは20MBで上限化します。
即時maintenanceは`zerokun-jobs gc`で実行できます。canonical Slack本文はCodexと、必要に応じて
Codexが起動したadvisorへ送られ、`thread/start`は`ephemeral:false`です。local GCは各provider側の
履歴削除を保証しないため、秘密・credential・個人情報を依頼へ貼り付けないでください。

watchdog は停止を2回連続検出した時だけ通知し、復旧も通知します。自動 restart はしません。

`zerochan update`導入前の旧Codex版からの初回更新だけは、Slack経由や新subcommandではなく、
冒頭の公開`bootstrap-macos.sh`を端末から実行し、旧checkoutとは別の
空directory（例: `--repo-dir "$HOME/Desktop/Project/zero-codex-next"`）へ配置します。旧updater経由の
setupはstate変更前に停止して旧版へrollbackし、新checkoutのsetupが同じstateをlockしてserviceを
切り替えます。以後は`zerochan update`を利用できます。`zerochan stop` → `zerochan start`は
同じ版の再起動だけを行い、更新の代わりにはなりません。
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
