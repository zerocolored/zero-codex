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
Codex App Server（1 jobにつき1つのprimary Codex workflow）
  ├→ AGENTS.mdに従って調査・実装・review・Git・deployを自律実行
  └→ 必要時だけ認証情報を隠したGitHub／localhost確認toolを利用
  ↓ 最終回答と明示された成果物だけ
Slack bot
```

- Slack 受信と Codex 実行を別プロセスに分離しています。Codex が長時間動いても受信を続けます。
- job は SQLite に先に保存し、常に1件ずつ FIFO で処理します。session、入力、途中経過、配送状態を
  durableに保持し、runner再起動後も確定済み結果を重複実行せず回収します。
- 同じ Slack スレッド・repository・write mode では、senderが変わっても Codex の thread ID を最大20 jobまで再利用します。通常失敗後も、executorが明示的にretireしていない有効なsessionなら次の依頼でresumeします。旧 Claude Code の
  待機jobはsession IDを破棄してCodexへ移行し、完了済み履歴のsession IDはCodexへ渡しません。利用回数は
  job本体とは別の永続台帳で数えるため、30日GCで古いjobが消えても20件上限は戻りません。
- この20件はCodexのcontext windowや自動compactの上限ではなく、Zeroちゃんが物理Codex threadを安全に
  更新するためのlocal上限です。会話そのものは別のsanitized論理履歴としてSQLiteへjob単位で保存し、
  失敗・完了・daemon再起動・write mode変更・物理thread更新・30日job GCの後も、同じchannel・Slack
  thread・repositoryの次のfresh Codex threadへ引き継ぎます。native resume時は同じ内容を二重注入しません。
  senderは履歴scopeに含めないため、同じthread内なら別userからZeroちゃん宛てに届いた返信も同じ会話として扱います。
- 採用済みSlackスレッドの人間による返信は、受付・リアクション・割り込み・キュー投入より前に、
  直前のスレッド文脈を含む専用LLMで宛先を判定します。Zeroちゃん宛てと判断できた返信だけを既存フローへ渡し、
  メンバー同士の会話は投稿もリアクションもせず完全に無視します。宛先は正規表現では決めません。
  分類器のcapacity・timeout・不正出力時も誤受付せず、本文・添付ID・同じsnapshotをSQLiteへ残し、
  Slackの再送がなくても常駐workerがbackoff後に再判定して既存フローを再開します。
- 論理履歴の永続archive自体をscopeごとの直近64 jobに圧縮し、省略件数だけを台帳へ残します。
  各実行snapshotも直近64 job blockかつ128 Ki文字／256 KiBまでです。現在の依頼とhost権限が常に優先され、
  過去の回答は参考情報として再確認されます。credential、local path、内部ID、成果物pathは保存前に除去し、
  添付は件数だけ残すため、後から実ファイルが必要な場合は再添付してください。導入前にすでに30日GCされた
  jobは復元できません。
- 実行中の同じSlackスレッドへの返信は、別userからでも同じCodex threadへ渡します。単なる質問は
  現在作業の文脈で先に回答し、更新依頼は同じworkflowの入力へ昇格して続行します。
  完全一致の`中止`（mentionと全角空白は正規化）は`turn/interrupt`です。別スレッドはFIFOのままで、
  実行中に限ってそのスレッド自体を操作権限の境界とするため、返信者個人がread-onlyでもactive write
  jobへ追加入力できます。write権限を共有したくない相手は同じ実行中スレッドへ参加させないでください。
  最終入力barrier後の通常返信は次のFIFO入力として保持し、その後に`中止`が届いても削除しません。
- 重要なUI/UX変更ではCodexが製品編集前に止まり、現在状態の`Before.png`と隔離proposalの`After.png`を
  ローカルpathではなく実ファイルとして元のSlack threadへ添付します。2枚の共有と承認依頼本文が
  完了するまで製品を編集せず、同じthreadの人間の返信をSQLiteへ永続化して待ちます。
  `はい`や`この方向で進めてください`のような無条件の明示承認だけが、同じ入力・同じrepositoryの
  実装を解放します。質問、却下、条件付き回答は承認にせず、Codexが回答内容を踏まえて必要な提案更新を
  判断します。待機中はworkerと監視tabを解放し、別threadのjobは
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
  同じtabを保持します。正常完了と中止ではCodexとその所有processの終了・SQLite terminal確定後に
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
  project側の`AGENTS.md`は任意です。調査、advisor、実装、review、test、Git、PR、merge、deployの
  手順と判断は、この指示を読んだprimary Codex自身が1つのworkflow内で担当します。Zeroちゃんは
  独自のprepare／implementation／review／publication phaseやreview照合を追加しません。
- 受信許可と書込み許可は別です。既定profileはrepository readとjob outbox writeだけです。`writeAllowFrom` を
  明示した利用者だけrepository・`.git` writeとネットワークを使えますが、Mac全体のsandboxは解除しません。
- write許可されたWebタスクでは、primary Codexに`verify_local_page`を公開します。
  既存Chrome session・拡張・個人profileは使わず、署名済みGoogle Chromeをowner-onlyの一時profileで起動し、
  明示したlocalhost origin以外のHTTP/WebSocketをdeny-by-default proxyで遮断します。HTTP 2xx、描画後DOMの
  期待文字列、1280×720 PNG、遮断request数、Chrome子processと一時profileの回収をまとめて返します。
  UI/UX承認前は製品repositoryを書き換えず、現在画面とscratch内だけの提案画面を撮影します。画像は
  完全decode後にpixel-bearing chunkだけへ再封印し、metadataとローカルpathをSlackへ持ち出しません。
- advisorの要否、人数、取得結果の扱いは`AGENTS.md`に従ってCodexが決めます。Zeroちゃんはadvisorを
  起動・poll・照合するhost-side brokerを本番jobへ注入せず、advisor欠員をjob失敗へ変換しません。
  秘密・credential・個人情報をSlack依頼へ貼り付けないでください。
- Socket Mode 停止中の DM・メンションと、採用済みスレッドの未メンション返信を履歴から回収します。

Codex CLI 連携は`codex app-server --stdio`を使います。`thread/start` / `thread/resume`で
threadとpermission handshakeを固定し、`turn/start`、`turn/steer`、`turn/interrupt`を同じ順序付き
JSON-RPC sessionで処理します。write jobも1つの`complete` turnで調査から依頼された最終操作まで進め、
Zeroちゃんが後から別processで設計やreviewをやり直すことはありません。完了した同一Slack threadへの
返信は保存済みCodex threadを`thread/resume`し、物理sessionを更新した場合もsanitized論理履歴を渡します。
job本体に最長時間は設けません。`willRetry: true`のrate-limitはApp Serverの同一turn内retryを待ち、
host側で同じpromptを再投入しません。起動前の
managed/MDMを含む実効permission検査には`app-server config/read`と`configRequirements/read`を使います。
同じSlackスレッドの途中入力は現在turnへ安全に割り込み、単なる質問か作業更新かの意味判断もCodexへ
委ねます。Zeroちゃんは配送順序、重複防止、取消、process回収だけを管理します。

## 必要なもの

- macOS
- Git、Bun、tmux、Herdr 0.8.2 以上（必要なworkspace/tab/pane/agent APIを含む）
- Codex CLI 0.149.0 以上（`codex login status`が`Logged in using ChatGPT`と返すこと）
- GitHub CLI (`gh`) と、対象repositoryへbranch push・PR作成できるlogin済みGitHub account
- Slack workspaceと、既存Appのtokenを管理できる権限（新規Appを使う場合はApp作成・install権限）
- このMacでsubscription login済みのGrok CLIとClaude Code（Zeroちゃん稼働中にAPI key認証は行いません）

advisor CLIはprojectの`AGENTS.md`が利用を求める場合にprimary Codexが直接使います。Zeroちゃんが
別のreview roundやClaude workspaceを強制的に追加することはありません。advisorが利用不能でも、
`AGENTS.md`のbest-effort規則に従ってCodex本体の作業を継続します。

## セットアップ

新しいMacでは、repositoryをcloneしてCodexへ**「セットアップして」**と依頼できます。
Codexが読む正本、Slack Appの作り方、人にしか行えないlogin、project/channel設定、起動、
Slack実応答までの完了条件は[`SETUP.md`](SETUP.md)に一本化しています。

以下は運用上の補足です。新規導入は先に`SETUP.md`を使用してください。

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

Zeroちゃんは認証画面を開かず、tokenやSSH keyをCodexへ渡しません。代わりに、現在jobのrepositoryだけを
操作できる`zerokun_github`をCodexへ公開します。これは認証済み`gh`／Git pushを実行する薄いtransportで、
作業手順や安全判定を決める別のorchestratorではありません。branch選択、commit、push、PR作成・承認・
merge、checks待機、deploy確認は、依頼と各repositoryの`AGENTS.md`を読んだCodexが同じworkflow内で判断・
実行します。GitHub外の実環境確認はCodexが対象projectの通常手順やlocalhost browser確認で行います。

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
3. 新PCで`bash zerokun/interactive-bootstrap.sh --slack-only`を
   実行し、開いた可視Terminalの表示されないpromptへ2値を貼ります。`.env`を手書きしません。
4. bootstrapが既存Appのtoken identityを検証し、App IDに結び付いた履歴下限を保存します。
   このcommandだけではSocket Mode gatewayを起動しません。
5. 旧PCで`touch "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/watchdog-off"`を実行し、停止警報を無効にします。
6. 旧PCで`zerochan stop`を実行し、`zerokun-status`でgateway停止を確認します。
7. 下の「3. projectとSlackチャンネルを設定して起動する」を新PCで終えてから、Slackへの依頼を再開します。

`jobs.sqlite3`、process lock、監視tab、inbox/outboxなどのruntime stateはコピーしません。channel紐付け、
DM pairing、repository write許可は新PCで設定し直します。履歴下限より前の旧依頼は新しい空DBでも
再実行されず、下限より後に届いた依頼は通常の履歴回収とdurable dedupの対象です。旧PCのgatewayを再び起動する場合は、先に
新PC側を`zerochan stop`で停止するか、そのPC用の別Slack Appへ切り替えてください。

### 2B. 複数PCを同時に動かす

PCごとに新しいSlack Appを作ります。例えば、このPCの表示名を「ベルミちゃん」にする場合:

```bash
bash zerokun/interactive-bootstrap.sh \
  --slack-only \
  --slack-app-name "ベルミちゃん" \
  --slack-bot-name bellmi
```

基本セットアップとSlack設定を最初から続けて行う場合は、`--slack-only`を`--with-slack`へ
置き換えます。

生成されたmanifestでAppを作成・installし、そのApp自身の`xapp-...`と`xoxb-...`を入力します。
別PCのtokenは使いません。同じSlackチャンネルへ複数のAppを招待しても構いませんが、新規依頼では
処理させたいAppをメンションしてください。

### 3. projectとSlackチャンネルを設定して起動する

対象projectを新PCへcloneし、通常TerminalまたはHerdrで次を実行します。Herdr外なら専用workspaceが
自動作成されます。複数repositoryをまとめた親folderも対象にできます。

```bash
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start
```

複数channelを同じprojectへ紐付ける場合は、channel IDを変えて`zerochan set slack-channel`を繰り返します。
Appを各channelへ招待したうえで、新しい依頼はそのAppをメンションします。同じthreadの続きは
再メンション不要ですが、各返信は文脈込みのLLM判定でApp宛てと確認された場合だけ処理されます。
メンションなしで始まったthreadでも、途中の返信でAppをメンションすると、
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
`--slack-only` を使います。導入の正本は[`SETUP.md`](SETUP.md)です。旧リンク
[`zerokun/NEW_MAC_SETUP.md`](zerokun/NEW_MAC_SETUP.md)からも同じ正本へ案内します。

### Slack App

新規Appを作る場合、manifestの既定表示名は `Zeroちゃん`、Slack bot usernameはSlackの文字制約に
合わせて `zerochan` です。`--slack-app-name`と`--slack-bot-name`で変更できます。Slackへ投稿する本文は
一人称なので、「ベルミちゃん」など別の表示名でもコード変更は不要です。旧PCのgatewayを停止する移行では、
既存Appのtokenを新PCへ安全に移して`--slack-only`を使うため、この作成手順は不要です。
[`zerokun/templates/slack-app-manifest.yaml`](zerokun/templates/slack-app-manifest.yaml)
を Slack の **Create New App → From a manifest** へ貼り、その後:

1. App-Level Token に `connections:write` を付け、`xapp-...` を取得する。
2. Workspace へ Install し、Bot User OAuth Token `xoxb-...` を取得する。
3. Codexが`interactive-bootstrap.sh --with-slack`で開いた可視Terminalへ戻り、内容が表示されない
   promptへ`xapp-...`、`xoxb-...`の順で貼る。tokenをchat、command引数、手書き`.env`へ載せません。

新しいMacの完全な手順とSlack画面上の操作は[`SETUP.md`](SETUP.md)を正本にします。

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
# setup後、対象projectへ移動して起動（Herdr外なら専用workspaceを自動作成）
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan start

# runtime log tabごと安全に停止・再作成
zerochan stop
zerochan start

# 実行中jobも中断して強制停止（通常stopが拒否した場合だけ）
zerochan stop --force

# 設定・解除・確認
zerochan status
zerochan unset slack-channel

# 別terminalから
zerokun-status
zerokun-jobs status
```

frontend／backend／appのような複数repositoryを1つの親folderに置いている場合は、その親folderで
同じコマンドを実行します。初回設定時に検出した直下repository一覧を
`.zerochan/workspace.json`へ固定します。Codexは依頼に必要なmemberだけを選び、各repositoryの規約に
従ってtest・commit・GitHub操作を完遂します。隠しfolder、
symlink、Gitではない直下項目は作業対象に含めません。

利用者のwrite許可は能力の上限であり、GitHub公開が必要という意味ではありません。質問・調査なら
Codexは変更せず回答し、公開依頼なら他者の未commit作業を保持したまま必要なrepositoryだけを操作します。
Zeroちゃんはmember境界をpermissionへ反映しますが、対象選択、review、publication planを上書きしません。

`zerochan start` はHerdr外からの起動を拒否します。引数やexportは不要です。実行した物理directoryを
対象projectとして、現在のHerdr workspaceへ新しい `Zeroちゃん runtime` tabを作り、gatewayとrunnerの
安定起動を確認して元のterminalへ戻ります。既に正常稼働中なら何も入れ替えません。

runtime log tabを作り直す場合は `zerochan stop` → `zerochan start` を使います。`stop`はrunnerの
新規job取得を止めてから実行中jobが0件であることを再確認し、実行中ならprocessへsignalせず拒否します。
待機中jobとSlack channel設定は保持されます。停止に成功するとgateway、runner、所有確認できたruntime tabを
終了し、意図的停止中のwatchdog警報を抑止します。裸の`zerochan`、`zerokun`、`zerochan --restart`は
従来運用との互換用に残ります。通常運用では`start`/`stop`を使用してください。

実行中jobが原因で通常停止できない場合は`zerochan stop --force`を使えます。これはZeroちゃんが記録した
exact process generationだけを停止し、待機中jobとchannel設定は保持します。停止時点までに結果保存が完了した
jobは確定し、それ以外の実行中jobは「強制停止による中断」として履歴・Codex sessionを残します。同じSlack
threadで「再開して」と送れば、保存済み履歴を参照して続行できます。完了済みのrepository変更や外部操作は
自動で巻き戻しません。

更新:

```bash
zerochan update
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

`zerochan update`導入前の旧Codex版から、最初の1回だけは新subcommandやSlack経由で
更新できません。旧版の更新処理は変更開始前に停止してrollbackするため、上記の公開
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
`zerochan update`で行えます。`zerochan stop` → `zerochan start`は同じ版の再起動であり、
更新の代わりにはなりません。stateへ配置する自己更新runtimeは、全依存fileを検証済みbundleへ
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
  CodexへHOME credentialを公開せず、認証が必要なGitHub操作だけをrepository限定brokerへ渡します。
- 通常cloneに加え、Gitの登録・back pointer・gitlink・`core.worktree`を検証できる正規の
  linked worktree/submoduleを許可します。偽の`.git` pointerは拒否します。HOMEのglobal
  Git/GitHub credentialはmodelへ公開しません。brokerはlogin済み`gh`をcredential helperとして使い、
  current projectのcanonical `github.com` repositoryだけを操作します。作業判断はCodexが行います。
- App Serverは認証済み`CODEX_HOME`を使うためuser configも読みます。そのため起動直前の
  `config/read`が返す実際のeffective configそのものをuser/project/managed/MDM layer込みで照合し、
  endpoint/provider差替え、legacy sandbox、named permissionの変更を拒否します。安全規則は
  `developerInstructions`、未信頼のSlack本文はJSON-RPC inputへ分離し、子環境はallowlistです。
- Codexが返す`instructionSources`を照合し、存在するglobal `AGENTS.md`とproject
  `AGENTS.md`が読み込まれたことを確認します。project側の`AGENTS.md`は任意で、存在しないだけでは
  jobを停止しません。
- `thread/start`は`ephemeral:false`なので、Codex/provider側のnative履歴はZeroちゃんのSQLiteとは別に
  残り得ます。Codexがadvisorを利用した場合は各providerの保持方針も適用されます。
- apps・plugins・hookと一般MCPは無効化し、localhost表示確認用`zerokun_browser`と、認証情報を
  隠したGitHub transport用`zerokun_github`だけを必要なwrite jobで有効にします。
  Web検索はwrite許可jobだけに限定し、write jobのcommand networkはproxyを通してSlack関連domainを拒否します。
- Zeroちゃんはadvisor数、review round、phase marker、publication planを成功条件として照合しません。
  `AGENTS.md`に従った相談とreviewはprimary Codexのworkflow内で完結し、利用不能なadvisorだけを理由に
  Slack jobを失敗させません。Slackの完全一致`中止`では現在turnを明示的に止めます。
- App Serverの`turn/completed`と、fullな`agentMessage`を含むturn履歴が同じthread/turn IDで揃った
  時点を論理完了として封印します。その後、同じsupervisor世代だけを停止し、
  全子process回収を確認してから結果を公開するため、Codexの後処理が長時間残っても次jobと重なりません。
- process回収は親子・PGID・microsecond世代のdurable ledgerに加え、job固有のowner-only Seatbelt tagを
  使用します。通常のCodex commandが`setsid`、stdio close、PID 1へのreparentでpolling追跡を抜けても、
  kernelの継承sandbox signatureから`SIGSTOP`で固定点を作り、`SIGCONT`とexact-generation `SIGTERM`の後は
  壁時計上限なしで自然終了を待ちます。完全一致の`中止`、host abort、内部追跡fault、runner crash recovery
  だけがbounded `SIGKILL`を許可し、その後3回の空走査を完了するまでregistrationを`cleanup-confirmed`に
  しません。relayを明示cancelしなければ終われなかった場合もcleanup不確実としてFIFOを開きません。
  runner crash後は同じtag identityを使ってrecoveryし、job所有processの固定点回収後にFIFOを再開します。
- このlocal process排他の対象は、公式Codexが通常のfork/execで起動したprocessです。launchd/XPC、
  外部daemon、remote serviceへの意図的handoffまで終了証明するものではありません。その経路を増やさないため
  hooks/apps/plugins、任意MCP、shellからのSlack操作を無効にしています。
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
- sandbox bypass、Slack上の承認ボタン、CodexからのSlack API呼出しは使いません。

## 主なファイル

- `server.ts`: Slack Socket Mode、access gate、添付取得、durable enqueue、履歴回収
- `zerokun/job-runner.ts`: SQLite queue、session/thread 所有権、Slack 完了通知
- `zerokun/runner-launcher.ts`: runnerの独立process group起動、安全なlog接続
- `zerokun/codex-executor.ts`: Codex App Server実行、turn/control処理、sandbox分離
- `zerokun/browser-verification-broker.ts`: localhost限定のChrome描画・PNG検証
- `zerokun/github-credential-broker.ts`: credentialを隠したrepository限定GitHub transport
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
