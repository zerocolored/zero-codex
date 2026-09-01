# Zeroちゃん

Slack の DM・メンションを、Herdr上で動くローカルのCodexへ安全に渡すmacOS向けゲートウェイです。
Slack Appの表示名はセットアップ時に自由に設定できます。Slackへ投稿する本文は一人称で、表示名を
固定しません。ローカルの監視tabや管理ログでは、runtime名として `Zeroちゃん` を使います。

## 仕組み

```text
Slack Socket Mode
  ↓ access.json で受信認可
server.ts（添付をローカル保存し、SQLiteへcommit）
  ↓ jobs.sqlite3 / 1本のFIFO
job-runner.ts
  ├→ task専用Herdr監視tab（安全な日本語タイムライン）
  ↓ verified Herdr context / codex app-server --stdio
Codex App Server（read jobはRO、write jobはRO準備→RW実装→ROレビューの別process）
  └→ 各advisor round専用のfresh Claude workspace（回答取得後にexact close）
  ↓ 最終回答と明示された成果物だけ
Slack bot
```

- Slack 受信と Codex 実行を別プロセスに分離しています。Codex が長時間動いても受信を続けます。
- job は SQLite に先に保存し、常に1件ずつ FIFO で処理します。再起動時、read-only job は再開し、write job は外部副作用の二重実行を避けるため failed にして確認・再送を求めます。ただし、実装を一度も開始していないUI/UX承認待ちは専用状態で安全に待機を継続します。
- 同じ Slack スレッド・repository・write mode では、senderが変わっても Codex の thread ID を最大20 jobまで再利用します。旧 Claude Code の
  待機jobはsession IDを破棄してCodexへ移行し、完了済み履歴のsession IDはCodexへ渡しません。利用回数は
  job本体とは別の永続台帳で数えるため、30日GCで古いjobが消えても20件上限は戻りません。
- この20件はCodexのcontext windowや自動compactの上限ではなく、Zeroちゃんが物理Codex threadを安全に
  更新するためのlocal上限です。会話そのものは別のsanitized論理履歴としてSQLiteへjob単位で保存し、
  失敗・完了・daemon再起動・write mode変更・物理thread更新・30日job GCの後も、同じchannel・Slack
  thread・repositoryの次のfresh Codex threadへ引き継ぎます。native resume時は同じ内容を二重注入しません。
  senderは履歴scopeに含めないため、同じthread内なら別userの返信も同じ会話として扱います。
- 論理履歴の永続archive自体をscopeごとの直近64 jobに圧縮し、省略件数だけを台帳へ残します。
  各実行snapshotも直近64 job blockかつ128 Ki文字／256 KiBまでです。現在の依頼とhost権限が常に優先され、
  過去の回答は参考情報として再確認されます。credential、local path、内部ID、成果物pathは保存前に除去し、
  添付は件数だけ残すため、後から実ファイルが必要な場合は再添付してください。導入前にすでに30日GCされた
  jobは復元できません。
- 実行中の同じSlackスレッドへの返信は、別userからでも現在turnを安全な境界で一時停止し、同じ
  Codex threadのfresh read-only turnで先に回答してから元のtaskを再開します。回答が単なる質問なら
  元入力は変えず、更新依頼なら回答がSlackへ届いたことを確認した後だけtask入力へ昇格します。
  完全一致の`中止`（mentionと全角空白は正規化）は`turn/interrupt`です。別スレッドはFIFOのままで、
  実行中に限ってそのスレッド自体を操作権限の境界とするため、返信者個人がread-onlyでもactive write
  jobへ追加入力できます。write権限を共有したくない相手は同じ実行中スレッドへ参加させないでください。
  最終入力barrier後の通常返信は次のFIFO入力として保持し、その後に`中止`が届いても削除しません。
- 重要なUI/UX変更はread-only準備で止まり、現在状態の`Before.png`と隔離proposalの`After.png`を
  ローカルpathではなく実ファイルとして元のSlack threadへ添付します。2枚の共有と承認依頼本文が
  完了するまで実装phaseへ進まず、完了後も同じthreadの人間の返信をSQLiteへ永続化して待ちます。
  `はい`や`この方向で進めてください`のような無条件の明示承認だけが、同じ入力・同じrepositoryの
  実装を解放します。質問、却下、条件付き回答、添付付き回答、repository変更は承認にせず、回答内容を
  取り込んだ新しいBefore／After提案へ戻ります。待機中はworkerと監視tabを解放し、別threadのjobは
  続行できますが、同じthreadの後続jobは承認対象を追い越しません。`中止`は待機中も利用できます。
- 長時間jobでは、Codex本人が監視tabへ出した短い日本語の`💬 commentary`を、その発生ごとに
  同じSlack threadへFIFOで投稿します。固定時刻の問い合わせ、固定stage文、推測の進捗率は使いません。
  配送はSQLiteへ先に保存して再試行し、terminalは未配送のcommentaryを追い越しません。
  受付には`eyes`、正常完了時には元メッセージへ`white_check_mark` reactionを付けます。本文は
  Slackアシスタントとして一人称の簡潔で温かい日本語と自然な絵文字1〜2個を使い、固定の表示名や
  内部engine名は表示しません。
- Codex 子プロセスには Slack token や任意の親process環境を渡しません。Slack 投稿は gateway/runner の bot 経路だけです。
- 起動時のHerdr socket・pane・terminal・workspaceを固定し、job開始前に同じidentityを再検証します。
  staleなHerdr環境ではCodexを起動しません。
- job開始時に同じHerdr workspaceへ非フォーカスの`Zeroちゃん #<queue>`監視tabを1つ作り、実行中の
  開始・調査・テスト・レビュー・完了を人が読める日本語タイムラインで表示します。生のJSON-RPC、コマンド全文、
  絶対path、内部ID、認証情報は表示せず、診断用stdout/stderrだけをowner-onlyの`job-logs`へ保存します。監視tab内でCodexを
  再起動することはなく、rate-limit再開中は
  同じtabを保持します。正常完了と中止ではCodex・round専用advisorの終了・SQLite terminal確定後に
  自動で閉じます。通常失敗では、安全な固定分類の原因と最終出力を表示してtabを確認用に残します。
  失敗tabは次のFIFO jobを妨げず、確認後に利用者が閉じると管理stateも次回照合時に回収されます。
  viewerのprocess世代・argv・cwd・heartbeatを実行前からclose直前まで監視し、terminalへの最終出力の
  drain完了も確認します。create/run/closeの応答や監視状態が曖昧な場合はIDを推測・操作せず、
  後続jobを開始しないfail-closed動作になります。実行中の監視tabを人が閉じた場合も同様に停止し、
  次回起動や`recover-interrupted`でも自動failed化・監視tab再作成は行いません。最終出力を
  表示した証拠を失ったjobとdurable monitor faultを保持してFIFOを止めるため、監視tabを手動で閉じないで
  ください。Slackへの通知配送だけはFIFOと独立して再試行します。
- `project_doc_max_bytes=262144`をruntime側で固定し、global→projectの`AGENTS.md`をjobごとに読み直します。
  App Server handshakeで存在するglobal／projectのowner-owned regular `AGENTS.md`が実際の
  `instructionSources`に含まれることを物理pathで照合し、同名の無関係fileでは代替しません。
  project側の`AGENTS.md`は任意です。
  公開前の決定的な最低契約として、read jobはread-only processでinvestigationを行います。write jobは
  同じCodex threadを、read-only準備（investigation/design）→write実装→read-only reviewのfresh processへ
  順番にresumeします。各processを子processごと完全回収してから次を起動し、write processではadvisor MCPと
  native multi-agentを無効化します。AGENTS.mdに従うnative subagent、専用Grok reviewer、各round専用の
  fresh Claude Code第五advisorはread-only phaseだけで実行します。第五advisorはHerdrの非フォーカス
  workspaceへ新規起動し、回答取得の成否にかかわらず、そのroundが所有するworkspaceだけを閉じます。
  既存のClaude paneは列挙しても入力・再利用・`/clear`・closeしません。
- 受信許可と書込み許可は別です。既定profileはrepository readとjob outbox writeだけです。`writeAllowFrom` を
  明示した利用者だけrepository・`.git` writeとネットワークを使えますが、Mac全体のsandboxは解除しません。
- write許可されたWebタスクでは、read-only準備とimplementation/review processに`verify_local_page`を公開します。
  既存Chrome session・拡張・個人profileは使わず、署名済みGoogle Chromeをowner-onlyの一時profileで起動し、
  明示したlocalhost origin以外のHTTP/WebSocketをdeny-by-default proxyで遮断します。HTTP 2xx、描画後DOMの
  期待文字列、1280×720 PNG、遮断request数、Chrome子processと一時profileの回収をまとめて返します。
  準備phaseでは製品repositoryを書き換えず、現在画面とscratch内だけの提案画面を撮影します。画像は
  完全decode後にpixel-bearing chunkだけへ再封印し、metadataとローカルpathをSlackへ持ち出しません。
- Grok/Claude連携は、Codex shellへcredentialやHerdr socketを渡さない用途固定のhost-side MCP brokerが
  read-onlyで代行します。brokerが公開するtoolは開始用`advisor_round`と状態照会用`advisor_round_poll`だけで、対象repository・pane・実行fileを
  Slack本文やmodel側から指定できません。各必須roundについて、startup receiptを排他作成して
  安全に並行起動する別PIDのGrok solution/risk 2件と
  fresh Claudeの完全回答とexact cleanup receiptをhost journalで検証できない回答はSlackへ公開しません。
  canonical Slack thread本文と必要な一次情報は、Codex本体に加えて2つのGrok reviewerと、条件を満たす
  round専用Claude第五advisorへ送られます。Grok本文は専用launcherのstdinから渡します。Claude本文は
  owner-only request directoryの固定`prompt`へ保存し、検証済みhelperの`send --owned`がHerdrのlocal
  socket APIへ直接渡して、fresh workspaceの一意なagentへ1回送ります。送達境界後のtimeoutやstalledでは
  再送せず、同じmarkerを追跡します。
  reviewer/helperが通常終了後の子process回収にbounded forceを必要とした場合、その回答は採択・公開しません。
  どちらもprocess argvへ本文を載せません。秘密・credential・個人情報をSlack依頼へ貼り付けないでください。
- native Codex advisorはmodelの自己申告IDだけを信用しません。最初のturnより前に親のdirect-child
  baselineを固定し、親App Server turn終了後、全source kindを指定した`thread/list`と公式turn履歴を
  全page照合します。`thread/items/list`が使えるreleaseではそのjournalを正本にし、最初のrequestが
  同一methodの数値`-32601`を返した場合だけ、`thread/turns/list(itemsView:"full")`と
  `thread/read(includeTurns:true)`の両方を使い、最大4 snapshot内で連続する2回が完全一致する
  固定点読取りで代用します。現在turnが直接作成した
  `solution_analyst`/`risk_reviewer`各1件、baseline以外の余分な子なし、完了turn、round固有markerと
  host計算digest、各advisor直下のlisted childなしを確認してからjournalを採択します。
- Socket Mode 停止中の DM・メンションと、採用済みスレッドの未メンション返信を履歴から回収します。

Codex CLI 連携は`codex app-server --stdio`を使います。`thread/start` / `thread/resume`で
threadとpermission handshakeを固定し、`turn/start`、`turn/steer`、`turn/interrupt`を同じ順序付き
JSON-RPC sessionで処理します。長いturnの`item/completed`通知は全件保持せず最終回答候補だけを投影し、
`turn/completed`はliveness signalとしてだけ扱い、本文がfullでも必ず公式の全page履歴と照合して最終回答を
決定します。`thread/items/list`が成功するreleaseではそのjournalだけが公開根拠です。最初のrequestが
同一methodの数値`-32601`だった場合だけ、`thread/turns/list(itemsView:"full")`と
`thread/read(includeTurns:true)`の両方を最大4 snapshot読み、同じselected turnが2回連続で完全一致してから
代用します。片側の失敗、不一致、final欠落をterminal本文で補完しません。job本体に最長時間は設けません。`willRetry: true`の
rate-limitはApp Serverの同一turn内retryを待ち、host側で同じpromptを再投入しません。起動前の
managed/MDMを含む実効permission検査には`app-server config/read`と`configRequirements/read`を使います。
setupとCIはインストール済み公式Codex自身にprotocol型を生成させ、上記の履歴method・field・pagination、
全`ThreadSourceKind`、`SubAgentActivityKind`のexact shapeも起動前に確認します。互換性が崩れたreleaseでは
job受付前に停止します。

write実装中またはreview中に同じSlackスレッドから返信が来た場合も、現在phaseを安全な境界で
一時停止し、fresh read-only turnでその返信へ先に回答します。更新依頼と判定し、かつ回答をSlackへ
届けた後だけ入力へ昇格し、新しい内容を未設計のままwrite processで実装せず、同じCodex threadを
fresh read-only準備から再開します。phase開始のJSON write前、応答受領後、最終公開直前の
各境界はSQLite receiptへ固定し、入力revision・中止・未処理inboundをtransaction内で再確認します。

## 必要なもの

- macOS
- Git、Bun、tmux、Herdr 0.8.2 以上（必要なworkspace/tab/pane/agent APIを含む）
- Codex CLI 0.149.0 以上（`codex login status`が`Logged in using ChatGPT`と返すこと）
- GitHub CLI (`gh`) と、対象repositoryへbranch push・PR作成できるlogin済みGitHub account
- Slack workspaceと、既存Appのtokenを管理できる権限（新規Appを使う場合はApp作成・install権限）
- このMacでsubscription login済みのGrok CLIとClaude Code（Zeroちゃん稼働中にAPI key認証は行いません）

通常jobのためにClaude channel/MCPや既存Claude paneは不要です。各必須roundでZeroちゃんが
`fifth-advisor-<nonce>` workspaceとClaude paneを非フォーカスで新規作成し、回答とsnapshotを検証後、
そのexact workspaceだけを自動で閉じます。既存のClaude Code sessionやClaude版Slack Appは変更しません。
prompt送達後に中断しても同じpromptは再送せず、owner-only receiptから作成済みworkspaceだけを
`zerokun-jobs recover-interrupted`または次回起動で回収します。所有identityやcleanupを証明できない場合は
別workspaceを推測して閉じず、FIFOをfail-closedで停止します。workspace作成応答前の中断でnonce labelも
観測されなかった場合はabsence guardを保持し、後続jobのclaim前ごとに同じlabelが現れていないことを再検証します。

## セットアップ

### 別のMacで使うときの選び方

最初に、旧PCを止めて移行するのか、複数PCを同時に動かすのかを決めます。

| 利用方法 | Slack Appとtoken |
| --- | --- |
| 旧PCのgatewayを停止して新PCへ移行 | 既存Slack Appの`xapp-...`と`xoxb-...`を再利用できます。新しいAppの作成・installは不要です。 |
| 複数PCを同時に稼働 | 稼働するPCごとに別のSlack Appとtokenを用意します。表示名はPCごとに変えられます。 |

同じSlack AppのSocket Mode接続を複数PCで同時に開くと、各payloadはどれか1接続へ送られ、
分配先は保証されません。そのため、同じApp/tokenを同時利用するとPCごとのqueue・thread・project状態が
分断されます。詳しくは[SlackのSocket Modeドキュメント](https://docs.slack.dev/apis/events-api/using-socket-mode/)
を参照してください。

### 1. 本体を導入する

新PCでrepositoryをcloneし、基本セットアップを実行します。

```bash
git clone https://github.com/zerocolored/zero-codex.git
cd zero-codex
git switch main
bash zerokun/bootstrap-macos.sh --skip-slack
```

bootstrapがCodex／Grok CLI／Claude Codeの未ログインを検出して停止した場合だけ、Herdr上で
`codex login`、`grok login`、Claude Codeのsubscription loginを人が完了し、同じcommandを
再実行します。稼働中のシステムがAPI keyを要求したり、認証画面を操作したりすることはありません。

GitHubへの公開も、Zeroちゃんを起動する前に人が一度だけ認証します。既に`gh auth status`が
成功するMacでは再認証不要です。

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
```

Zeroちゃんは認証画面を開かず、tokenやSSH keyをCodexへ渡しません。実装processはlocal commitまでを
担当し、最終read-only reviewと入力seal後に、host runtimeがその完全一致SHAを非強制pushしてPRを作成します。
依頼が公開・継続・中止のどれを意味するか、どのbranchへ進めるかは、同じSlackスレッドの履歴を読んだ
Codexが判断します。host runtimeはSlack本文をregex等で再解釈してCodexの判断を却下しません。
host側に残すのは、write jobの実行権限、対象repositoryとcommit SHAの固定、非強制push、receiptによる
重複送信防止といった機械的な実行境界だけです。
共有checkoutのHEADやstatusが別セッションによって変わっても、完了済みのCodex turnをhostが破棄して
prepareから自動再試行しません。Codexがlive Git状態を読み直し、他者変更を保持しながら隔離worktree等で
継続方法を決めます。公開時のremote・branch・完全一致SHA検証は従来どおり維持します。
pushまたはPRのreceiptをSQLiteへ保存できるまで成功通知は出さず、再起動後もCodexを再実行せず公開だけを再開します。
実装processはCodexが選んだbase commitからhost指定feature branchを隔離worktreeに作り、commit後にその隔離worktreeだけを閉じます。共有checkoutは最初から最後まで変更せず、reviewは固定feature branchのcommit差分を確認します。認証を持つhost publisherもcheckoutを変更しないため、次の依頼を前のPRへ積み重ねず、local filter等をhost権限で起動しません。

既にclone済みなら、次だけで構いません。

```bash
git switch main
bash zerokun/bootstrap-macos.sh --skip-slack
```

bootstrapは公式standalone Codexをaccount-owned領域へ導入してからsetupを実行します。
Homebrew/npm版だけを使った直接`setup.sh`は、後日の安全な自己更新と同じ信頼条件を満たさないため公開手順では使いません。

### 2A. 旧PCを止めて移行する

移行中は新しい依頼を投稿しないでください。新PCのgatewayが起動するまで、この短い
静止区間を作ることで、旧PCと新PCのどちらにも同じ依頼を処理させません。

1. 旧PCで`zerokun-jobs status`を確認し、実行中・待機中jobがなくなるまで待ちます。
2. `SLACK_APP_TOKEN`と`SLACK_BOT_TOKEN`の2値だけを、AirDropや暗号化されたpassword managerなどの
   安全な経路で新PCへ移します。tokenをGit、Slack投稿、issue、通常ログへ貼らないでください。
3. 新PCの`~/.codex/zerokun/.env`へ2値を保存し、`chmod 600 ~/.codex/zerokun/.env`を実行します。
4. 新PCで`bash zerokun/bootstrap-macos.sh --slack-only`を実行します。既存Appのtoken identityを検証し、
   App IDに結び付いた履歴下限を保存します。このcommandだけではSocket Mode gatewayを起動しません。
5. 旧PCで`touch "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/watchdog-off"`を実行し、停止警報を無効にします。
6. 旧PCで`zerochan stop`を実行し、`zerochan status`でgateway停止を確認します。
7. 下の「3. projectとSlackチャンネルを設定して起動する」を新PCで終えてから、Slackへの依頼を再開します。

`jobs.sqlite3`、process lock、監視tab、inbox/outboxなどのruntime stateはコピーしません。channel紐付け、
DM pairing、repository write許可は新PCで設定し直します。履歴下限より前の旧依頼は新しい空DBでも
再実行されず、下限より後に届いた依頼は通常の履歴回収とdurable dedupの対象です。旧PCのgatewayを再び起動する場合は、先に
新PC側を`zerochan stop`で停止するか、そのPC用の別Slack Appへ切り替えてください。

### 2B. 複数PCを同時に動かす

PCごとに新しいSlack Appを作ります。例えば、このPCの表示名を「ベルミちゃん」にする場合:

```bash
bash zerokun/bootstrap-macos.sh --slack-only \
  --slack-app-name "ベルミちゃん" \
  --slack-bot-name bellmi
```

基本セットアップとSlack設定を最初から続けて行う場合は、`--slack-only`を`--with-slack`へ
置き換えます。

生成されたmanifestでAppを作成・installし、そのApp自身の`xapp-...`と`xoxb-...`を入力します。
別PCのtokenは使いません。同じSlackチャンネルへ複数のAppを招待しても構いませんが、新規依頼では
処理させたいAppをメンションしてください。

### 3. projectとSlackチャンネルを設定して起動する

対象projectを新PCへcloneし、Herdrの専用paneで次を実行します。複数repositoryをまとめた親folderも
対象にできます。

```bash
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start
```

複数channelを同じprojectへ紐付ける場合は、channel IDを変えて`zerochan set slack-channel`を繰り返します。
Appを各channelへ招待したうえで、新しい依頼はそのAppをメンションします。同じthreadの続きは
再メンション不要です。メンションなしで始まったthreadでも、途中の返信でAppをメンションすると、
先頭コメントからその返信までのhuman投稿と添付を時系列の1タスクとして受け付けます。
別の参加者がメンションしても利用できます。DMは最初に表示されるcodeを
`zerochan-access pair <code>`で承認し、
repositoryの変更を許可する利用者だけ`zerochan-access write allow <Slack user ID>`を実行します。

同一PCのClaude版を完全に置き換える場合だけ、旧 `zero` cloneを残したまま`zero-codex`を
別directoryへcloneし、旧stateを明示してsetupします。

```bash
ZEROKUN_LEGACY_CUTOVER=1 \
ZEROKUN_STATE_DIR="$HOME/.claude/channels/slack" \
bash zerokun/bootstrap-macos.sh
```

この明示的なcutoverでは旧runnerをdrainして停止し、待機jobをCodex queueへ引き継ぎます。

repositoryを手動cloneせず、公開bootstrapを先に取得して一式を導入することもできます:

```bash
bootstrap_dir="$(/usr/bin/mktemp -d /tmp/zerokun-bootstrap.XXXXXX)"
/bin/chmod 700 "$bootstrap_dir"
bootstrap_path="$bootstrap_dir/bootstrap-macos.sh"
/usr/bin/env -i PATH=/usr/bin:/bin TMPDIR=/tmp \
  /usr/bin/curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --noproxy '*' --output "$bootstrap_path" \
    https://raw.githubusercontent.com/zerocolored/zero-codex/main/zerokun/bootstrap-macos.sh
bash "$bootstrap_path" --skip-slack
/bin/rm -f "$bootstrap_path"
/bin/rmdir "$bootstrap_dir"
```

先にファイルを保存するため、実行前に内容を確認できます。このあと
`cd ~/Desktop/Project/zero-codex`を実行し、上の「2A」または「2B」のSlack設定へ進みます。

bootstrapはZeroちゃん本体とは別の`zerokun-workspace` Git repositoryを、最小安全指示の`AGENTS.md`
初期commit付きで作ります。既存projectを初期workspace／DMのdefault projectに使う場合は、
`--project-dir /absolute/path/to/project`を指定できます。DMの新規threadは、起動時に
`zerochan`を実行した物理directoryを使います。
Zeroちゃん本体はhost runtimeなので、そこを対象にしたSlack write jobは常に拒否されます。
対象directory自体がGit repositoryでなくても、直下に通常cloneされたGit repositoryが2件以上
ある場合はmulti-repository workspaceとして利用できます。

依存関係だけ診断する場合は `--doctor`、導入済み環境で Slack 設定だけ再開する場合は
`--slack-only` を使います。詳しくは
[`zerokun/NEW_MAC_SETUP.md`](zerokun/NEW_MAC_SETUP.md) を参照してください。

### Slack App

新規Appを作る場合、manifestの既定表示名は `Zeroちゃん`、Slack bot usernameはSlackの文字制約に
合わせて `zerochan` です。`--slack-app-name`と`--slack-bot-name`で変更できます。Slackへ投稿する本文は
一人称なので、「ベルミちゃん」など別の表示名でもコード変更は不要です。旧PCのgatewayを停止する移行では、
既存Appのtokenを新PCへ安全に移して`--slack-only`を使うため、この作成手順は不要です。
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
自動選択せず、token・access・queueを暗黙に流用しません。in-place cutover時だけ
`ZEROKUN_LEGACY_CUTOVER=1`と`ZEROKUN_STATE_DIR`の両方で旧stateを明示してください。

## Access 設定

DM の初回メッセージには pairing code が返ります。表示された code を正確に指定します。
code の省略や自動承認はできません。

```bash
zerochan-access pair abc123
zerochan-access status
```

チャンネルは利用するSlack Appを招待し、対象projectで `zerochan set slack-channel <channel-id>` を
実行すると利用できます。参加者は全員利用でき、bot投稿は無視します。新しい依頼は
そのSlack Appへのメンションが必要ですが、同じスレッドの続きはメンション不要です。

受信を許可しても repository write は許可されません。書込みが必要な利用者だけ別に付与します。

```bash
zerochan-access write allow U0123456789
zerochan-access write deny U0123456789
```

全コマンドと設定項目は [`ACCESS.md`](ACCESS.md) にあります。

## 起動と運用

```bash
# setup後、Herdrの専用paneで対象projectへ移動して起動
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start

# runtime log tabごと安全に停止・再作成
zerochan stop
zerochan start

# 設定・解除・確認
zerochan status
zerochan unset slack-channel

# 別terminalから
zerokun-status
zerokun-jobs status
```

frontend／backend／appのような複数repositoryを1つの親folderに置いている場合は、その親folderで
同じコマンドを実行します。初回設定時に検出した直下repository一覧を
`.zerochan/workspace.json`へ固定し、各repositoryを個別にtest・commitし、最終review後にhostが
push・PR作成します。隠しfolder、
symlink、Gitではない直下項目は作業対象に含めません。

実装前のread-only準備で、Codexは変更が必要なrepositoryだけを宣言します。hostはその最小scopeを
permission、review、publicationへ同じまま結び付けるため、対象外の兄弟repositoryのbranchやremote設定に
影響されません。途中の同thread依頼でscopeが広がる場合も、新しいrepositoryを編集する前にbaselineへ追加します。

`zerochan start` はHerdr外からの起動を拒否します。引数やexportは不要です。実行した物理directoryを
対象projectとして、現在のHerdr workspaceへ新しい `Zeroちゃん runtime` tabを作り、gatewayとrunnerの
安定起動を確認して元のterminalへ戻ります。既に正常稼働中なら何も入れ替えません。

runtime log tabを作り直す場合は `zerochan stop` → `zerochan start` を使います。`stop`はrunnerの
新規job取得を止めてから実行中jobが0件であることを再確認し、実行中ならprocessへsignalせず拒否します。
待機中jobとSlack channel設定は保持されます。停止に成功するとgateway、runner、所有確認できたruntime tabを
終了し、意図的停止中のwatchdog警報を抑止します。裸の`zerochan`、`zerokun`、`zerochan --restart`は
従来運用との互換用に残ります。通常運用では`start`/`stop`を使用してください。

更新:

```bash
zerokun-update
```

更新対象は `origin/main` の fast-forward のみです。未コミット変更や未 push の local commit
がある場合は停止します。書込み許可済みの利用者は Slack で「このアプリを更新してください」と依頼でき、
通常 FIFO の外にある detached updater が自己デッドロックを避けて実行します。
remoteの候補commitは隔離cloneをCodex sandbox内でsandbox-safe contract test・型検査・build・shell検査してから
live branchをfast-forwardします。macOSはsandboxの入れ子を拒否するため、実Codex sandbox・tmux・process制御を
使うintegration testは通常の`verify.sh`と公開CIで全件実行し、候補sandbox内では再実行しません。
更新元は`https://github.com/zerocolored/zero-codex(.git)`だけで、local Git configは安全なallowlist外の
helper・include・HTTP/credential設定があれば実行前に停止します。
停止前に更新journalとSQLiteの整合snapshotを作成し、setupまたは再起動後の接続確認に失敗した場合は
旧commit・旧DB・旧serviceへ自動rollbackします。強制終了でjournalが残った場合も次回起動前に
rollbackを完了します。

安全なprocess-group委譲に対応する前の旧Codex版から、最初の1回だけは`zerokun-update`やSlack経由で
更新できません。旧updaterは変更開始前に停止して旧版へrollbackするため、上記の公開
`bootstrap-macos.sh`を端末から実行し、旧checkoutとは別の空directoryへ配置してください。

```bash
bootstrap_dir="$(/usr/bin/mktemp -d /tmp/zerokun-bootstrap.XXXXXX)"
/bin/chmod 700 "$bootstrap_dir"
bootstrap_path="$bootstrap_dir/bootstrap-macos.sh"
/usr/bin/curl -q --fail --location --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --noproxy '*' --output "$bootstrap_path" \
  https://raw.githubusercontent.com/zerocolored/zero-codex/main/zerokun/bootstrap-macos.sh
bash "$bootstrap_path" --repo-dir "$HOME/Desktop/Project/zero-codex-next" --skip-slack
/bin/rm -f "$bootstrap_path"
/bin/rmdir "$bootstrap_dir"
```

同じstate directoryを引き継いだ新checkoutのsetupがlock取得・旧service停止・配線切替を行い、
旧checkoutを直接fast-forwardしません。以後の更新は
`zerokun-update`で行えます。stateへ配置する自己更新runtimeは、全依存fileを検証済みbundleへ
publishしてからentrypointをatomicに切り替えるため、途中終了しても旧bundleを維持します。

更新中のprocess回収はmacOSのmicrosecond世代IDでPID/PGID再利用を判別し、観測不能または残存processが
ある場合はlockを永続的に保持してrollbackを止めます。保証対象はZeroちゃん同梱commandが委譲された
process groupを維持する通常実行です。`setsid`、double-fork、daemonizeで意図的にgroup外へ逃げる独自setupは
対応外なので、custom setupへそのような処理を追加しないでください。primaryとgateがprocess-levelの
SIGKILL等で強制終了した場合でも、
保存済みPGIDが存在しないことをkernelが確認できれば、別processへsignalせず古いlockだけを回収します。
cleanup不確実性を明示的に記録したlockは、PGID消滅後も自動回収しません。
突然の電源断に対するfilesystem durabilityは保証対象外です。再起動後に更新journalが残る場合は、
serviceを起動せずoffline bootstrapで復旧してください。

## Routing

project directoryで `zerochan set slack-channel C...` を実行すると、設定はlocal-onlyの
`.zerochan/config.json`へ保存され、稼働中gatewayへ即時反映されます。`routes.json`の手動編集や
利用者allowlistは不要です。同じSlackチャンネルを別projectへ同時登録することはできません。
multi-repository workspaceでは同じ`.zerochan` directoryに、固定member一覧の
`workspace.json`も保存されます。repositoryの追加・削除を検出した場合は、意図しない対象拡大を
避けるため自動採用せず起動を停止します。

明示routeをまだ一度も設定していない移行直後だけ、従来どおり新しいchannel threadはgatewayを
起動したprojectへ入ります。一度設定した後の未設定channelでは、全routeを解除した場合もproject
設定コマンドを案内し、別projectへ推測配送しません。
DMはgatewayを起動したprojectを使います。一度採用したSlack threadのprojectは最初の受理時にSQLiteへ
固定され、route解除・再登録や別directoryからの再起動後も別repositoryへ飛びません。Slackからの
自己更新後もgatewayの起動projectを維持し、DMのdefaultや既存threadの固定先を変更しません。

## セキュリティ境界

- Zeroちゃんが参加していないchannel、未許可DM、bot投稿は受け取りません。
- pairing は1時間で失効し、同時 pending は3件までです。
- Codex 0.149.0+ の named permission profile を使います。minimal runtimeから始め、
  対象repository、当該jobの添付、scratch、outboxだけを許可します。HOME・state・共用tempはdenyします。
- read senderはrepository readのみ、write senderだけrepository・`.git` writeとnetworkを許可し、
  どちらも `-a never` で対話的な権限昇格を行いません。
- host runtimeをSlack経由で書き換えられないよう、Zeroちゃん自身のrepositoryへのwrite jobは拒否します。
  Codex shellのHOME/TMPDIRはjob scratchへ隔離し、commitには固定の中立identityを使います。
  CodexへHOME credentialを公開せず、Codex自身によるpush・PR作成も許可しません。
- 通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
  linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。HOMEのglobal
  Git/GitHub credentialはmodelへ公開しません。review済みSHAの公開だけはhost runtimeがlogin済み`gh`を
  credential helperとして使い、canonical `github.com` origin、非強制の単一branch、tag・submoduleなしに固定します。
- App Serverは認証済み`CODEX_HOME`を使うためuser configも読みます。そのため起動直前の
  `config/read`が返す実際のeffective configそのものをuser/project/managed/MDM layer込みで照合し、
  endpoint/provider差替え、legacy sandbox、named permissionの変更を拒否します。安全規則は
  `developerInstructions`、未信頼のSlack本文はJSON-RPC inputへ分離し、子環境はallowlistです。
- Codexが返す`instructionSources`を照合し、存在するglobal `AGENTS.md`とproject
  `AGENTS.md`が読み込まれたことを確認します。project側の`AGENTS.md`は任意で、存在しないだけでは
  jobを停止しません。
- `thread/start`は`ephemeral:false`なので、Codex/provider側のnative履歴はZeroちゃんのSQLiteとは別に
  残り得ます。Grok/Claude側にも各serviceの保持方針が適用されます。Claudeはroundごとにfresh sessionを
  起動してworkspaceを閉じますが、provider側の履歴削除を保証するものではありません。
- apps・plugins・hookと一般MCPは無効化し、用途固定の`zerokun_advisors/advisor_round`と
  `advisor_round_poll`だけを有効にします。
  Web検索はwrite許可jobだけに限定し、write jobのcommand networkはproxyを通してSlack関連domainを拒否します。
- read jobは`investigation-1`、write jobはread-only準備の`investigation-1`/`design-1`と、別の
  read-only processで行う`review-1`のbroker journalを公開条件にします。write実装processはbrokerや
  subagentを持たず、各phaseのApp Server processは同時に存在しません。
  journalは固定job/context digest、異なるGrok PID、solution/risk response digest、Claudeの採択response、
  fresh lifecycleとcleanup receipt digestを持ち、欠落・途中状態・改変時は完成本文があってもfail-closeします。
- Codex job本体とGrok reviewerには全体の壁時計上限を設けません。Claude第五advisorの回答取得だけは
  AGENTS.md契約どおりroundごとに最大1時間で、超過時も所有workspaceをexact cleanupしてpanel未成立にします。
  reviewerはdurable start後にbackgroundで継続し、Codexは完了まで回数・合計時間上限なしでpollします。
  terminal本文と一緒に返すrandom receiptを次pollで照合できた場合だけjournalを完了へ昇格します。
  30秒のMCP設定は各start/pollという制御通信だけのhang検出で、reviewerを停止しません。
  Slackの完全一致`中止`で明示的に止めます。個々のHerdr/Slack/RPC制御commandだけはhang検出用deadlineを持ちます。
- App Serverの`turn/completed`と、fullな`agentMessage`を含むturn履歴が同じthread/turn IDで揃った
  時点を論理完了として封印します。その後、同じsupervisor世代だけを停止し、
  全子process回収を確認してから結果を公開するため、Codexの後処理が長時間残っても次jobと重なりません。
- process回収は親子・PGID・microsecond世代のdurable ledgerに加え、job固有のowner-only Seatbelt tagを
  使用します。通常のCodex commandが`setsid`、stdio close、PID 1へのreparentでpolling追跡を抜けても、
  kernelの継承sandbox signatureから`SIGSTOP`で固定点を作り、`SIGCONT`とexact-generation `SIGTERM`の後は
  壁時計上限なしで自然終了を待ちます。完全一致の`中止`、host abort、内部追跡fault、runner crash recovery
  だけがbounded `SIGKILL`を許可し、その後3回の空走査を完了するまでregistrationを`cleanup-confirmed`に
  しません。relayを明示cancelしなければ終われなかった場合もcleanup不確実としてFIFOを開きません。
  runner crash後は同じtag identityを使って
  recoveryし、欠落・差替え・照会不能ならFIFOを開きません。実効config preflight、Grokのcustom reviewer
  sandbox、native履歴用App Server、brokerから起動するHerdr／fifth-advisor helperも同じtagを継承します。
  brokerとreviewer launcher自身はexact-generation ledgerで追跡し、executor登録前のcrashはtag pair自体から
  startupで回収します。
- このlocal process排他の対象は、公式Codex/Grokが通常のfork/execで起動したprocessと、Herdrでround専用に
  作成したClaude workspace/paneです。launchd/XPC、外部daemon、remote serviceへの意図的handoffまで終了証明するものでは
  ありません。その経路を増やさないためhooks/apps/plugins、任意MCP、shellからのSlack操作を無効にしています。
- 添付と成果物は50MBまでです。成果物はjob専用 `outbox/<job-id>/` 直下のregular fileをrunner専用
  sealed領域へ移してから上限付きFDで読み、任意path・symlink・device/FIFOを拒否します。
- 成果物の形式は制限せず、PNG・PDF・ZIPを含む任意binaryをそのまま扱います。Slackへ渡す同じbyte列を
  軽量走査し、平文で明白なtoken・password・private keyらしき文字列があるfileだけ添付を省略します。
  archive展開、復号、OCRは行わない社内利用向けbest-effort検査です。
- terminal本文と成果物単位のdelivery checkpointはSQLiteへ別々に保存します。本文成功後に添付だけ失敗しても本文は再投稿しません。upload URL取得までの確実な未送信失敗は回数で捨てず、指数backoffで再試行します。byte転送開始時にはSlack file IDを永続化し、完了receiptまで同じprocessで待ちます。突然死や応答欠落で結果を証明できない場合は重複防止のためbyteを自動再送せず、`files.info`で同じchannel・threadへの共有を確認します。成果物ごとに最大5回確認しても確定できない場合だけ、その成果物の添付を打ち切って通知します。checkpoint確定済みの成果物は再送せず、空fileも添付しません。
- Codex stdout/stderr logは各20MBを上限にし、解析用memoryは各1MBのtailに制限します。
- 完了jobは通知と成果物の配送checkpointが全て確定した後だけretention対象になります。既定30日で
  job固有fileをGCし、Slack再配送を防ぐidempotency tombstoneは既定10年保持します。runtime logも
  20MBで上限化します。`zerokun-jobs gc`で即時実行できます。このlocal GCはCodex、Grok、Claude、Slack
  各provider側の履歴削除を行いません。
- `danger-full-access`やsandbox bypass、Slack 上の承認ボタン、Codex からの Slack API 呼出しは使いません。

## 主なファイル

- `server.ts`: Slack Socket Mode、access gate、添付取得、durable enqueue、履歴回収
- `zerokun/job-runner.ts`: SQLite queue、session/thread 所有権、Slack 完了通知
- `zerokun/runner-launcher.ts`: runnerの独立process group起動、安全なlog接続
- `zerokun/codex-executor.ts`: Codex App Server実行、turn/control処理、sandbox分離
- `zerokun/browser-verification-broker.ts`: localhost限定のChrome描画・PNG検証
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
