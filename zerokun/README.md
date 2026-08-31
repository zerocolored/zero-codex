# Zeroちゃん一式（Slack → Herdr → ローカルCodex）

## 結論

常駐するSlack gatewayが受信をSQLiteへ保存し、Herdr内から起動された1本のrunnerが
`codex app-server --stdio`をJSON-RPCで直列実行します。Codexはglobal→projectの`AGENTS.md`をjobごとに読み、
read jobのinvestigation、write jobの編集前design・編集後reviewでnative subagent・専用Grok reviewer・
各round専用のfresh Claude Code第五advisorを必須実行します。Claudeは非フォーカスの一時workspaceへ
新規起動し、回答取得後にそのworkspaceだけを自動で閉じます。既存Claude paneは再利用・`/clear`・closeしません。

## 導入

Codex CLI 0.149.0以上、Herdr 0.8.2以上（必要なworkspace/tab/pane/agent APIを含む）、
`codex login`と`grok login`済みのsubscription認証が必要です。Codexはdaemon起動時と各job attempt直前に
`Logged in using ChatGPT`を再検証します。Zeroちゃん自身はAPI keyを要求せず、認証画面も操作しません。

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
| `job-runner.ts` | SQLite FIFO、thread/session 所有権、Slack 通知 |
| `runner-launcher.ts` | runnerの独立process group起動、安全なlog接続 |
| `herdr-runtime.ts` | Herdr socket・pane・terminal・workspaceの起動前/各job再検証 |
| `herdr-job-monitor.ts` | job専用Herdr監視tabの永続state、安全な日本語タイムライン、再起動reconcile、自動close |
| `herdr-job-monitor-view.ts` | tokenを持たずrolling feedだけをterminalへ安全に表示するviewer |
| `codex-executor.ts` | sandboxを選び、App Server thread/turn/controlを検証 |
| `browser-verification-broker.ts` | fresh Chrome profileでlocalhostだけを描画・PNG検証 |
| `access.ts` | pairing、DM/channel、write 許可の端末 CLI |
| `project-channel-config.ts` | project-local channel設定と共有SQLite routeの同期 |
| `update.ts` | `origin/main` から安全に fast-forward 更新 |
| `update-request.ts` | Slack 自己更新を FIFO 外の detached worker へ渡す |
| `process-generation.ts` | macOS libprocによるmicrosecond process世代IDとsignal前再検証 |
| `seatbelt-fingerprint.ts` | setsid/reparent後も継承sandboxからjob固有processを再発見・回収 |
| `native-advisor-evidence.ts` | App Server履歴によるnative Codex advisorの親子・role・完了照合 |
| `ephemeral-claude-session.ts` | round専用Claude workspaceのreceipt・再起動cleanup |
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
8. Codexとround専用advisorの停止・exact workspace cleanup、結果checkpoint、SQLite terminal化のすべてが確定してから
   viewerのterminal write/drainとbindingを再確認する。正常完了と中止は監視tabをexact IDで閉じる。
   通常失敗は公開可能な固定分類の原因を表示し、全feedをseal/drainしてviewerを待機状態へ固定したうえで
   tabを確認用に残す。monitor obligationだけをretireするため、失敗tabは後続FIFOを止めない。rate-limit再開では
   同じtabとhealth監視を保持する。viewer・tab・heartbeatを証明できなくなった場合はCodexを停止し、
   後続jobを開始せず再起動reconcileへ渡す。
9. 実行中の監視tabを人が閉じた場合、tracked executorは回収しても、最終出力の実表示を後から証明できない。
   次回起動や`recover-interrupted`は当該jobを自動failed化せず、監視tab再作成も行わず、
   durable monitor obligationを保持してFIFOを止める。失敗確定後に確認用として残ったtabは閉じてよく、
   次回reconcileが残存stateだけを回収する。Slack deliveryだけはFIFOと独立に再試行する。
10. runner 停止中のread-only `running` jobは次回起動時に`queued`へ戻してresumeする。write jobは外部副作用が不確実なためfailedにし、状態確認後の手動再送を求める。

sessionはSlack thread・repository・write modeが同じ場合に最大20 jobまで再利用し、senderは
session keyに含めません。利用回数はjob retentionとは独立したappend-only台帳で記録し、古いjobをGCしても
20件上限を再利用しません。実行中jobへの同thread返信はsenderを問わず会話割り込みとして扱い、active
turnを安全な境界で一時停止してfresh read-only turnから先に回答します。active jobの固定済み権限で処理するため、active write jobでは同threadのread-only senderにも操作を
委任します。別threadは独立FIFOであり、完了後に作る新jobの権限はそのsenderから改めて判定します。

20 jobはCodex側のcontext window／自動compact制限ではなく、Zeroちゃんがnative physical threadを
更新するlocal safety policyです。これとは別に、terminal jobのrequest、同thread follow-up、公開済み
commentary／回答、最終結果または公開用失敗分類を`slack_thread_job_history`へsanitized blockとして永続化します。
次jobをclaimするtransaction内で、完全一致する`chat_id + thread_ts + repo_path`のimmutable snapshotを
`job_thread_history_snapshots`へ固定します。native resumeはprovider側の会話を使って二重注入せず、fresh
threadだけがsnapshotをcurrent requestより前のuntrusted referenceとして受け取ります。write mode／senderは
snapshot scopeではないため、権限を継承せずに同じ会話だけを継続できます。failed／completed job、daemon再起動、
20 job rotation、protocol変更、job retention GCをまたいでもarchiveは残ります。

永続archive自体をscopeごとの直近64 jobへ圧縮し、省略済みjob数とcutoffだけを別台帳へ残します。
snapshotも直近64 job block、128 Ki文字／256 KiBを上限とし、UTF-8 block境界で古いものから省略します。
各archiveはevent数・文字数・byte数も制限します。credential、URL、machine-local path、Slack／内部ID、
`<zerokun_files>`成果物path、host control風markerは保存前に除去し、履歴本文はhost authority、write許可、
UI/UX承認、phase、repository、sandboxを変更できません。添付は件数だけ保持し、binaryは保持しません。
upgrade前にすでにretention GCされたjobはbackfillできないため、その範囲だけはSlack本文または再添付から
改めて確認します。

Claude第五advisorは各roundで`fifth-advisor-<nonce>` workspaceをfresh作成し、そこに一意なClaudeを
起動します。完全なmarker付き回答、repository/protected snapshot不変、exact workspace消失の3条件が
揃った場合だけ必須第五枠を採択します。既存workspace/paneは入力・focus・closeしません。Herdrに
compare-and-sendの原子的APIはないため、送達後の曖昧な結果では同じpromptを再送しません。

並列 worker はありません。別threadのrequestは全て1本のFIFOです。ただし実行中の同じthreadへの
認可済み返信は、別userからでも現在turnを一時停止し、同じCodex threadのfresh read-only turnで
先に回答するため、新規jobにしません。単なる質問は元taskをそのまま再開し、更新依頼は回答のSlack
配送後だけdurable inputへ昇格します。完全一致の`中止`（mention除去・NFKC正規化後）は
先行する未送信controlをdurableに取り消して
`turn/interrupt`します。App Serverの最終入力barrierが閉じた後も、round専用advisor cleanupとDB terminal確定が
終わるまでは同threadの完全一致`中止`だけを元jobへdurableに束縛します。barrier後の通常返信は次の
FIFO入力として保持し、後から`中止`が届いても元jobに束縛されていない返信を削除しません。後発の別threadは現在taskと
所有workspaceのcleanupが終わってから開始します。受付返信は enqueue 直後に
返り、terminal通知はjobと同じSQLite transactionへ保存されます。Slack APIの遅延や一時失敗は
後続jobを止めず、durable notification workerが独立して再試行します。

## Codex 実行契約

read-only jobは次の1 process、write jobは同じCodex threadを順次resumeするfresh 3 process以上で
実行します。write jobの基本順序はread-only準備→write実装→read-only reviewです。reviewが必須修正を
返した場合だけwrite実装→read-only reviewを最大3 review roundまで繰り返します。前processとその全子processの
回収を確認するまで次processを起動しません。未信頼のSlack本文はprocess argvへ入れず、JSON-RPCの
`turn/start` inputとして渡します。Grok reviewerへ渡す同じcanonical本文は専用launcherのstdinから
owner-only一時fileへ固定し、公式`--prompt-file`だけをargvへ載せます。

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
  named permission profile、AGENTS instruction sourceが全て一致した場合だけ保存します。
- 実行中の同thread返信には`turn/steer`で安全な停止markerだけを送り、返信本文は別のfresh read-only
  `turn/start`へ渡します。完全一致の`中止`は`turn/interrupt`です。各controlはSQLite receiptを
  JSON writeより先に固定し、曖昧な送達を自動再送しません。
- write実装またはread-only review中の更新依頼は、回答のSlack配送を確認した後に入力へ昇格し、
  現phaseを終了してfresh read-only準備から再開します。新しい内容を編集前のinvestigation/designなしで
  実装・公開しません。phaseごとの`prepared → dispatching → acknowledged → observed` receiptと最終sealで、
  process間の入力変更・中止・未処理inboundをfail-closeにします。
- `turn/completed`までに届いた最後の`agentMessage`だけをbounded projectionへ残し、長いturnの
  `item/completed`を全件保持しません。terminal本文は公開根拠にせず、完了turnは毎回
  `thread/items/list`を正本として全page走査します。一度成功したjournalのfinal欠落や後続`-32601`を
  terminal／snapshotで補完しません。最初のrequestが同一methodの数値`-32601`だったreleaseだけ、
  full指定の`thread/turns/list`と`thread/read`を両方読み、最大4 snapshot内でselected turnが
  2回連続完全一致した場合に限って代用します。片endpointの失敗や不一致はfail-closeします。
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
- 実効config preflight、Grokのcustom reviewer sandbox、native advisor履歴用App Server、brokerから起動する
  Herdr／fifth-advisor helperも同じjob tagを継承します。brokerとreviewer launcher自身はexact-generation
  ledgerで追跡し、executor登録より前にcrashしてもtag pair自体をdurable obligationとしてstartup時に
  全owner processから再発見し、固定点回収が終わるまで次jobをclaimしません。
- resume先がないと公式responseで確定した場合だけsessionを消し、新規`thread/start`へ1回fallbackします。
- 安全規則は`developerInstructions`、未信頼のSlack本文はCodexのJSON-RPC input、Grok launcherのstdin、
  またはowner-only Claude prompt fileへ分けます。Slack/Codex本文からshell commandを組み立てず、Claudeへの
  transportは検証済みhelperの`send --owned`からHerdrのowner-only local socket APIへ直接渡す経路だけに限定します。
- workspace作成応答前の中断でnonce labelが見つからない場合はabsence guardを削除せず、runner起動時と
  job claim前に同じlabelが遅れて現れていないことを再検証します。
- `<trust-args>` はread/writeとも `-a never` で、sandbox bypassを使いません。
- App Serverは`--ignore-user-config`を持たず、subscription認証済みの`CODEX_HOME`とそのuser configを読みます。
  起動直前の`config/read`が返す実際のeffective configをuser/project/managed/MDM込みで照合し、
  endpoint/provider差替え、legacy sandbox、named permission変更をfail-closeで拒否します。child environmentは
  PATH/HOME/CODEX_HOME/locale/proxy等のallowlistで作り、token/key/passwordや
  `ZEROKUN_*`をCodex shellへ継承しません。
- `AGENTS.md`の探索は無効化しません。Herdr identityと`project_doc_max_bytes=262144`は
  runtime側の信頼済み設定として毎job固定し、対象repository直下の物理`AGENTS.md`がApp Serverの
  `instructionSources`へ実際に含まれることもhandshakeで検証します。
- apps・plugins・hookと一般MCPは無効化し、用途固定の開始用
  `zerokun_advisors/advisor_round`と状態照会用`advisor_round_poll`だけを有効にします。
  Web検索はwrite許可jobだけに限定し、command networkとSlack関連domainをpermission profileで制限します。
  Slack tokenは子へ渡さず、Slack投稿をdeveloper instructionsでも禁止します。

## 権限

受信可否と repository write は別です。

- 通常: minimal runtime + repository read + 当該添付read + job outbox/scratch write
- `writeAllowFrom` の sender: minimal runtime + repository/`.git` write + network + localhost bind
- 全read job: `investigation-1`、全write job: `design-1`と`review-1`を最低契約とし、native subagentは
  read-onlyの準備・review processだけで起動します。write implementation processではnative multi-agentと
  advisor brokerを無効化し、localhost限定browser verifierだけを有効化します。review processでは
  repositoryをread-onlyのままlocalhost bindと同じverifierを使えます。専用Grok launcherとround専用fresh Claudeの起動・cleanupはhost-side brokerの
  `advisor_round`（durable開始）と`advisor_round_poll`（短い状態照会）だけがread-onlyで代行。
  Grok reviewer本体とCodex jobは壁時計上限なしで継続し、pollの回数・合計時間にも上限を設けない。
  Claude第五advisorのacquisitionはroundごとに最大1時間。terminal結果は
  1回目のpollでrandom receiptと共に渡し、そのreceiptを次pollで返した時だけ完了journalへ昇格する

macOSではCodexの外側sandbox内からGrokの独立sandboxやHerdrのUnix socketを直接利用できないため、
それらは用途固定flagと非秘密の一時path、固定repository・固定Herdr identityを持つbrokerへ分離します。
Slack本文はGrok launcherのstdinから渡し、Claude本文はowner-only prompt fileと検証済み
`fifth-advisor.py send --owned`からHerdr local socket APIを通してfresh workspaceのexact agentへ1回だけ送ります。送達可能receipt後の
timeout/stalledは曖昧送達として再送しません。2本のGrok launcherは
startup lock内でstale回収・run directory作成・owner receiptを一体化し、並行起動や電源断残骸で相互破壊しません。Codex shellへGrok auth、
Herdr socket、account HOMEは公開せず、read/writeともrepository限定sandboxを維持します。
Grok/Claudeは各roundで必ず1回ずつ試行します。認証切れ、rate limit、起動不能、回答不成立は
安全に終了した利用不能結果としてreason digestと共にjournalへ残し、利用可能なadvisor証拠で処理を続けます。
Zeroちゃん自身はloginやOAuth操作を行いません。Grok processを回収できない、作成済みClaude workspaceの
exact cleanupが成立しない、repository/inputが変化した場合はterminal結果にせず、Slackへの成功公開を拒否します。
runnerは各roundのowner-only journalとreceiptを検査し、成功した外部advisorにはPID/response digestまたは
fresh Claude response/cleanup receiptを、利用不能枠には安全なcontainment evidenceを要求します。
native Codex 2件はさらに、最初のturn前に親direct-child baselineを固定し、全source kindの`thread/list`と
公式turn履歴を全page照合します。`thread/items/list`未対応を同一methodの最初の数値`-32601`でだけ判定し、
その場合はfull指定の`thread/turns/list`と`thread/read`を両方使い、最大4 snapshot内で連続する2回が
完全一致する固定点として照合します。現在の親turnから直接spawn
された一意な`solution_analyst`/`risk_reviewer`、baseline以外の余分な子なし、子の単一completed full turn、
round固有marker、host計算digest、各advisorのlisted childなしがすべて一致した場合だけ採択します。setupは
公式Codex自身が生成するexperimental protocol型のsource/activity kindをexact検査し、必要な履歴APIが
変わったreleaseを起動前に拒否します。

Zeroちゃん本体のrepositoryはhost runtimeの信頼境界なので、そこへのwrite jobは許可者であっても
拒否します。bootstrapは本体と別の`zerokun-workspace`を、最小安全指示の`AGENTS.md`初期commit付き
既定projectとして初期化します。既存projectのproject固有`AGENTS.md`は任意で、存在する場合だけ
global `AGENTS.md`の後に読み込みとinstruction sourceを検証します。

両profileともHOME、state全体、共用tempを先にdenyし、必要なpathだけをより具体的なruleで
再許可します。Codex CLI 0.149.0以上を必須とし、古いCLIはjob受付前に拒否します。
通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。またHOMEのglobal
Git/GitHub credentialは公開しないため、remote操作にはHOME外の安全な認証が別途必要です。
Codex shell HOMEはread/writeともjob scratchへ分離します。専用Grok launcherが必要とするaccount HOMEは
brokerの固定子processだけが使い、model shellへは渡しません。commitするprojectでは
`user.name`/`user.email`をrepository local configへ設定してください。

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
- human 向け mention だけの雑談は channel policy に従って除外
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
zerochan start      # 新しい「Zeroちゃん runtime」tabを作って再開
zerochan --restart  # 従来互換。通常は stop → start を使用
zerochan status
zerochan unset slack-channel
zerokun             # 互換alias。現在directoryで起動
zerokun-status
zerokun-jobs status
zerochan-access status
zerokun-update
```

チャンネルは利用するSlack Appを招待し、対象projectで `zerochan set slack-channel C...` を実行すると
利用できます。新しい依頼はメンション、同じthreadの続きはメンション不要です。設定はGitに
含まれない `.zerochan/config.json` に保存され、`routes.json`の編集は不要です。最初の
`zerochan start`だけが共有gateway/runnerを起動し、別projectからの起動は同じserviceへ参加して終了します。
既存threadは最初のprojectへ固定されたままです。DMは共有gatewayを起動したprojectを使います。
multi-repository workspaceのmemberは初回設定時に`.zerochan/workspace.json`へ固定されます。
隠しfolder、symlink、Gitではない直下項目は作業対象外で、変更した各memberは個別に
test・commit・pushされます。直下repositoryの追加・削除時は、意図しない対象拡大を防ぐため
設定を自動更新せず起動を停止します。

log:

```bash
tail -f "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/job-runner.log"
```

in-place cutoverでは`ZEROKUN_LEGACY_CUTOVER=1`も併せて指定してください。配置先だけを
変更する場合は`ZEROKUN_STATE_DIR`を明示します。

完了jobはterminal通知と全成果物の配送checkpointが確定してから既定30日で削除します。
Slack eventのidempotency tombstoneは既定10年保持し、runtime logは20MBで上限化します。
即時maintenanceは`zerokun-jobs gc`で実行できます。ただしcanonical Slack本文はCodex、2つのGrok reviewer、
round専用Claude第五advisorへ送られ、`thread/start`は`ephemeral:false`です。local GCや一時workspaceのcloseは
各provider側の履歴削除を保証しないため、秘密・credential・個人情報を依頼へ貼り付けないでください。

Claude promptの送達境界後にcrashした場合、同じpromptは再送しません。次回起動または
`zerokun-jobs recover-interrupted`がowner-only intent/workspace/closed receiptを検証し、作成済みのexact
workspaceだけをcloseします。すでにverified close receiptまで永続化されていれば再closeせず消失確認として
採用します。所有identityやprotected metadataを証明できない場合は他workspaceを推測して操作せず、
cleanup pendingとしてFIFOを停止します。各lifecycle receiptはowner-only staging fileを完全write・fsync後に
macOSのno-replace renameで公開し、公開前crashで残った固定staging fileだけをidentity検証後に破棄します。

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
