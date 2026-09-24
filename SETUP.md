# 新しいMacへZeroちゃんをセットアップする

このファイルが、別のMacへZeroちゃんを導入するための正本です。
repositoryをcloneしたあとCodexへ一言依頼すれば、Codexは[`AGENTS.md`](AGENTS.md)に従って
この手順を読み、診断、導入、Slack設定、起動、実応答確認まで進めます。
[OpenAI公式のAGENTS.md仕様](https://learn.chatgpt.com/docs/agent-configuration/agents-md)どおり、
Codexは作業前にproject rootの指示を読み込みます。

```bash
git clone https://github.com/zerocolored/zero-codex.git
cd zero-codex
codex
```

Codexには次のように依頼します。

```text
セットアップして
```

## Codexを使わず1コマンドで行う

Codexへ依頼せず、同じ範囲をshellから通す場合は[`zerokun/quick-setup.sh`](zerokun/quick-setup.sh)を使います。
`bootstrap-macos.sh`の基本導入に加えて、codex-configのglobal `AGENTS.md`配置、Slack設定、
channel紐付け、起動までを1コマンドで順に実行します。

```bash
bash zerokun/quick-setup.sh \
  --project /absolute/path/to/project \
  --app-name 'Zeroちゃん-新Mac' --bot-name zerochan-new-mac \
  --channel C0123456789
```

`--channel`は繰り返し指定できます。`--doctor`は何も変更せず状態だけを表示し、
`--skip-slack` / `--skip-codex-config` / `--skip-permissions` / `--skip-chrome` /
`--skip-go-chrome-mcp`はそれぞれの段階を省略します。

### macOS権限(TCC)

Zeroちゃんを動かすterminal.appには、**アクセシビリティ / 画面収録 / フルディスクアクセス**が要ります。
既定の置き場`~/Desktop/Project`はTCC保護下にあり、フルディスクアクセスが無いと
launchd・cron経由の実行が`Operation not permitted`で止まります。

**この許可はscriptから付与できません。** `TCC.db`はSIP保護で書き込めず、`tccutil`はresetしか持ちません。
quick-setup.shが行うのは次までで、チェックを入れるのは本人です。

1. systemの`TCC.db`を読んで、install済みのterminal.appごとに3つの状態を一覧する
2. 不足していれば該当の設定paneを開き、Enterで再判定する
3. フルディスクアクセスへ追加するCLIの実体path(`codex` / `claude` / `grok` / `bun` / `node` / `python3` / `/bin/bash`)をclipboardへ入れる

オートメーション(Apple Events)は事前付与ができません。Slack・Chromeを最初に操作したときの
dialogで許可します。誤って拒否した場合は`tccutil reset AppleEvents <bundle id>`で出し直せます。

### Chrome拡張

既定でClaude・ChatGPTの導入を確認し、未導入ならWeb Storeのページを開きます。
`--chrome-extension <id>`で追加でき、`--force-extensions`を付けた場合は
machine policy(`/Library/Preferences/com.google.Chrome`の`ExtensionInstallForcelist`)で
強制installします。この場合Chromeに「組織によって管理されています」が付き、ユーザーは拡張を無効化できません。

```bash
sudo defaults delete /Library/Preferences/com.google.Chrome ExtensionInstallForcelist   # 取り消す
```

### go-chrome-mcp

実Chromeを操作するMCP([ernie1358/go-chrome-mcp](https://github.com/ernie1358/go-chrome-mcp))を
導入します。clone、`npm install`、Claude Code(`~/.claude.json`の`mcpServers`)とCodex
(`~/.codex/config.toml`の`[mcp_servers.go-chrome-mcp]`)への登録、読み込み済みかの判定までを行います。
置き場の既定はzero-codexと同じ階層の`go-chrome-mcp`で、`GO_CHROME_MCP_DIR`で変えられます。

**拡張の読み込みだけは本人操作です。** Web Storeではなくunpackedで読み込むため、policyでは
installできません。またChromeはコマンドラインから`chrome://extensions`を開けません。

1. Chromeで`chrome://extensions`を開く
2. 「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」
4. cloneしたdirectoryを選ぶ(pathはclipboardへ入れてあります)

読み込み済みかどうかは、Chromeのprofileが持つ`location=4`(unpacked)と実pathの一致で判定します。
Codexへの登録は`config.toml`への追記のため、codex-configの適用より後に実行します。

loginは自動化せず、未了の段階で停止して実行すべきcommandを表示します。
Herdr serverが動いていないと`zerochan start`はworkspace createに失敗するため、
Herdrのpane内で実行するか、先に`herdr`でserverを起動しておきます。

## 「一言でセットアップ」の範囲

CodexなどのAIエージェントが技術的な選択、commandの順序、再実行、検証に加え、ブラウザでの
Slack App作成・設定・インストールも代行します。ユーザーへ作成手順を渡して任せる運用にはしません。
完全無人という意味ではなく、本人にしかできない操作だけを必要な時点で依頼し、終わったらAIが続行します。
セットアップ後の各Slack依頼も、Zeroちゃんが準備・実装・review・公開へ分割せず、1つのprimary Codex
workflowとして実行します。Codexは対象projectの`AGENTS.md`に従い、依頼に含まれるGitHub操作や
deploy確認まで自分で進めます。ZeroちゃんはFIFO、同一thread継続、process回収、認証情報を隠した
GitHub transportだけを担当します。

Primary Codexのmodelは`gpt-6-astra`、reasoning effortは`low`としてrelease codeに固定されています。
利用者のCodex設定、shell環境、state内`.env`を揃える必要はなく、どのMacでも同じ値で起動します。
Grok、Claude、review用Codexの選択には`AGENTS.md`のadvisor契約が別途適用されます。

次の本人操作や情報指定だけは、必要な場合にユーザーへ依頼します。Slack App作成そのものは含みません。

1. macOSのCommand Line Toolsなどのinstall dialog
2. Codex、Grok CLI、Claude Code、GitHub CLIの初回login
3. Slackの未ログイン解消、MFA／CAPTCHA／管理者本人による承認。通常のApp作成・install操作はAIが代行する
4. 対象project、Slack workspace／channelが依頼から一意に分からない場合の、その指定

トークンの取得・登録もAIが担当します。ユーザーへコピー・貼り付けを通常手順として依頼しません。
AIはSlackのコピー操作から可視Terminalの非表示promptへ、値をツール出力に表示しない経路で転送し、
`zerochan set slack-app`で登録します。トークンをchat、command argv、環境変数、通常logへ記載しません。
登録コマンドが2つのtokenのApp identityを照合し、App別stateの`.env`へmode 0600で保存します。

## 先に決めること: Slack Appを新しく作るか

| 利用方法 | Slack App |
| --- | --- |
| 旧PCを止めず、新PCも同時に使う | **PCごとに新しいSlack Appを作る。** 新規Macの既定はこちらです。 |
| 旧PCのgatewayを停止して新PCへ移行する | 既存Appの`xapp-`と`xoxb-`を安全に移して再利用できる。 |

同じSlack Appで複数のSocket Mode接続を開くこと自体はできますが、Slackは複数接続を
load balancingに使い、payloadがどの接続へ届くかを固定しません。Zeroちゃんはqueue、thread、
project紐付けをMacごとに持つため、同じAppを2台で同時利用すると状態が分断されます。
同時稼働するMacでは必ずAppを分けてください。

- [Slack公式: Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack公式: Creating apps using manifests](https://api.slack.com/reference/manifests)
- [Slack公式: Quickstart](https://docs.slack.dev/quickstart/)

## Codexが実行する手順

### 1. 診断と基本導入

clone rootで現在状態を確認します。完全セットアップは、Codexが次のlauncherから開く
**別の可視Terminal**で実行します。まずSlack設定を含めず基本導入を終え、次節でAIがAppを作成して
`zerochan set slack-app`へ登録します。Codexのtool用PTYへtoken値を文字列で渡しません。

```bash
bash zerokun/bootstrap-macos.sh --doctor
bash zerokun/interactive-bootstrap.sh \
  --repo-dir "$(pwd -P)"
```

launcherは可視Terminalを開き、そこでbootstrapを動かし、完了receiptを元のCodexへ返します。
ユーザーは本人操作が必要なinstall dialog／login／管理者承認だけを行います。
通常のcommand順序、Slack App作成・設定・トークン取得・非表示入力、再実行はCodexが担当します。

対象projectが既に決まっている場合は、その絶対pathも渡せます。単一Git repositoryだけでなく、
直下に複数repositoryを置いた親folderも指定できます。

```bash
bash zerokun/interactive-bootstrap.sh \
  --repo-dir "$(pwd -P)" \
  --project-dir /absolute/path/to/project
```

bootstrapはApple Command Line Tools、Homebrew、Git、GitHub CLI、Bun、tmux、Herdr、
公式standalone Codex、Grok Build、Anthropic公式native Claude Code、Zeroちゃんruntimeを
導入・検証します。Claude Code CLIがない場合も自動導入し、人が行うのはsubscription loginだけです。
[Anthropic公式のClaude Codeセットアップ](https://docs.anthropic.com/en/docs/claude-code/getting-started)
を取得元・手順の正本にします。

未loginで停止した場合は、ユーザー本人が必要なloginを完了します。

```bash
codex login
grok login
# Herdrの一時paneで claude を起動し、subscription loginを完了して終了する
gh auth login --hostname github.com --git-protocol https --web
```

これは初回セットアップ用です。稼働後にGrok 1.0.5が既知の未認証応答だけを返した場合は、
ZeroちゃんがmacOSの固定OAuth helperをphase内で1回だけ試します。復旧できない場合もGrok枠だけを
利用不能として扱い、primary Codexのtaskは継続します。rate limit、quota、network障害ではOAuthを
起動しません。

再認証は専用の一時HOMEで実行し、CLIが成功して安全な認証ファイルを生成した場合だけ、
開始時から変わっていない実HOMEの認証情報へ原子的に反映します。反映前の失敗・中断では
既存の認証情報を保持します。反映後の中断では新しい認証情報が残る場合があります。
並行する手動loginを完全に排他できないため、自動復旧中に別途`grok login`を実行しないでください。
OAuthの旧32文字・UUID形式のstateと通常のANSI表示に対応しています。
このhelperはZeroちゃん専用の同梱物です。codex-configのAGENTS.mdやhelperだけを更新しても
置き換わらないため、Zeroちゃん側の修正版は`zerochan update`で配備してください。

ZeroちゃんはAPI key認証を代用せず、login画面や秘密を勝手に操作しません。login後、Codexは
同じ基本導入の`interactive-bootstrap.sh ...`を再実行します。既存の安全な設定は上書きされません。

### 2. AIがブラウザでこのMac専用のSlack Appを作る

AIは同梱の`zerokun/templates/slack-app-manifest.yaml`を元に、指定された表示名・bot usernameを
反映した非秘密のmanifestを一時ファイルへ用意し、SlackのApp作成画面を開きます。
source templateは変更せず、必要なscope・event・Socket Mode設定も維持します。

ここからもAIエージェントが、利用可能なChrome拡張・ブラウザ操作ツール・Computer Useで操作します。
既存のログイン済みブラウザを優先し、対象workspaceと既存Appを確認して、作成済みならそのAppから
続けます。中断・再実行のたびに重複Appを作らないでください。App名・対象workspaceが依頼から
決まっていれば再質問せず進め、不明な業務上の選択だけ確認します。

次の1〜8はすべてAIが担当する操作です。通常の作成・インストール許可はセットアップ依頼の範囲で進め、
本人のログイン、MFA／CAPTCHA、管理者承認が現れたときだけ、その操作をユーザーへ依頼します。
トークン取得と非表示入力もAIが代行します。登録用Terminalを先に用意し、ブラウザのコピー操作と
Terminalへの貼り付けを使います。clipboard本文を読み出して応答・ツール引数へ転載せず、
秘密が表示される画面のスクリーンショットやDOM全文を取得しません。

1. **Create New App** → **From a manifest** を選ぶ。
2. 利用するworkspaceを選び、生成済みYAML manifestを貼る。
3. 内容を確認して **Next** → **Create** を実行する。
4. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** を開く。
5. token名を付け、scopeに`connections:write`を追加して生成する。生成したApp-Level Tokenは
   同じAppの画面から登録時にコピーする。必要な転送前に一度限りの表示を閉じない。
6. **OAuth & Permissions** → **Install to Workspace** を実行して許可する。
7. **Bot User OAuth Token**の取得場所を開く。token表示を失わないよう必要なら別タブを使い、
   同じAppから`xoxb-...`と`xapp-...`を順にコピーできる状態にする。
8. AIが可視Terminalで`zerochan set slack-app`を実行する。既存App一覧が出た場合、新規登録は`n`を選ぶ。
   表示されたpromptを確認し、**Bot Token（xoxb-）→ App-Level Token（xapp-）**の順に、
   ブラウザでコピーした値をその都度非表示入力欄へ貼り付けて確定する。トークンを通常のshell promptへ
   貼らず、登録成功とApp IDを確認する。登録済みなら番号を選び、再生成・再登録しない。

これはAIによる可視UI操作の手順であり、登録コマンドに自動トークン取得APIや秘密転送機能が
備わっているという意味ではありません。利用中のツールで秘密を露出せずコピー・貼り付けできなければ、
まず別の利用可能なUI操作経路を確認し、なければ不足する接続・権限・機能を具体的に報告します。
自動登録できたと偽らず、人の入力へ切り替える場合もその理由と必要な操作だけを明示します。

ブラウザ操作ツールが接続できない場合は、利用可能な別の操作経路を確認します。
どれも使えなければ、ブラウザ接続・拡張の許可など不足する1操作だけを依頼し、復旧後はAIが続行します。
作成手順をユーザーに丸投げしたり、Appを作成・設定できたと推測して完了扱いにしたりしません。

同梱manifestにはSocket Mode、必要なbot event、bot scopeが入っています。手作業でscopeを
足し引きしません。登録コマンドはtokenの形式だけでなく、2つが同じAppに属することもSlackへ照合し、
一致した場合だけ保存します。

表示名・bot usernameは、例えば「ベルミちゃん」・`bellmi`をmanifestへ反映します。
bot usernameは英小文字、数字、`-`、`_`、`.`だけです。
既存の`--with-slack`／`--slack-only` bootstrapを再開する場合もAIが非表示入力を代行しますが、
そのprompt順は**xapp → xoxb**で登録コマンドと逆です。現在表示されたラベルを正本にしてください。

### 3. Appをchannelへ招待し、projectを紐付ける

同一PCへ追加のSlack Appを登録する場合は、`zerochan set slack-app` を使います。
AIが前節と同じ方法でBot TokenとApp-Level Tokenを取得し、対話端末で非表示入力します。
コマンドが同じAppの組み合わせであることを確認して保存します。
登録はPC単位なので、次回からはトークンを入力せず一覧から選択できます
（失効や権限変更時は認証情報の更新が必要です）。
プロジェクト外で実行した場合は登録だけを行います。対象プロジェクトへ `cd` した後、
再び `zerochan set slack-app` を実行して登録済みAppを選択してください。
既存の単一App設定は移動せずに取り込むため、キューや履歴は保持されます。

`zerochan help` は全体の操作一覧、`zerochan <command> --help` は個別の説明です。
トークン未設定時でもヘルプは表示できます。

AIがSlack画面で利用したいchannelへ、今作ったAppを招待します。private channelも明示的な招待が必要です。
channel IDはSlackのchannel詳細またはchannel link末尾の`C...`／`G...`で確認します。

対象projectの物理directoryへ移動して設定します。

```bash
cd /absolute/path/to/project
zerochan set slack-channel C0123456789
zerochan status
```

`zerochan status`は、このprojectに保存されたchannel紐付けを表示します。複数channelを同じprojectで
使う場合は、IDを変えて`zerochan set slack-channel`を繰り返します。同じchannelを複数projectへ
同時には紐付けません。

### 4. 起動する

対象projectをcurrent directoryにして起動します。通常Terminalや通常のCodexから実行しても、
`zerochan start`が対象project専用のHerdr workspaceを作成・選択し、そのroot paneへ起動を
自動で引き継ぎます。`HERDR_ENV`のexportやpane IDの指定は不要です。

```bash
cd /absolute/path/to/project
zerochan start
```

`zerochan`だけでも起動できます。`zerochan start`は重複起動を避けて既存processを共有します。
runtime log tabを作り直したい場合は`zerochan stop`のあと`zerochan start`を実行します。
実行中jobがあって通常停止を拒否された場合だけ、`zerochan stop --force`でZeroちゃん所有のprocessを
強制停止できます。待機中jobは保持され、途中のjobは同じSlack threadから再開できます。

### 5. 完了確認

別のterminalまたはpaneで次を確認します。

```bash
zerokun-status
zerokun-jobs status
cd /absolute/path/to/project && zerochan status
```

- `zerokun-status`: gateway processが稼働中であること
- `zerokun-jobs status`: queue／runnerが利用可能であること
- `zerochan status`: 対象projectとchannelの紐付けが意図どおりであること

最後にSlackでAppをメンションし、同じthreadへ実際に返信が来ることを確認します。

```text
@作成したApp 接続確認です。現在の対象project名だけ答えてください。
```

DMを使う場合は、最初に返るpairing codeを端末で承認します。

```bash
zerochan-access pair <表示されたcode>
```

チャンネルの人間の参加者は、個別登録なしでrepository変更も依頼できます。
DMでrepositoryの変更も許可する場合だけ、別途write権限を付けます。

```bash
zerochan-access write allow <Slack user ID>
```

## 更新する

通常の更新は、対象projectまたはZeroちゃん本体のdirectoryから次の1コマンドで行います。

```bash
zerochan update
```

起動中の自動更新は既定で有効です。30分ごとに確認し、全アプリの実行中作業が終わってから
更新・再起動します。`zerochan auto-update status` で確認、`zerochan auto-update off` で
このMac全体の自動更新を無効化できます。再び有効にする場合は `zerochan auto-update on`。
設定変更は再起動不要です。完了・失敗だけを登録済みユーザーへDM（未登録なら設定済みチャンネル）で通知します。

`origin/main`の候補版を検証し、fast-forward、setup、gateway／runnerの再起動まで自動で行います。
正常終了後に`zerochan stop`／`zerochan start`を追加実行する必要はありません。逆に、stop／startだけでは
checkoutの版は変わらないため、更新の代わりにはなりません。

Claudeの回答取得を調べる場合は、state directory（既定 `~/.codex/zerokun`）の
`advisor-journal/<job>/<attempt>/revision-*/claude-response-*.json` を確認します。
各取得の行数、状態、マーカー判定理由と、最後に所有identityを確認できた端末出力を保存します。
回答の成否にかかわらずworkspace削除後も残り、再試行は別ファイルになります。
本文は最大64 KiBの先頭・末尾で、完全なセッション履歴ではありません。credential検出時は
本文全体を伏せ、URL・email・ユーザーホーム名も伏せます。任意の個人情報まで検出できる
保証はないため、owner-onlyのローカル診断として扱い、Slackなどへファイル全体を転載しないでください。
保存失敗は `responseDiagnostic.status=unavailable` となり、cleanupは継続します。

中断された更新transactionの復旧を案内された場合だけ、次を使います。

```bash
zerochan update --recover-only
```

`zerochan update`をまだ認識しない古い版からの初回移行は、通常の新Mac導入と同じ公開
`bootstrap-macos.sh`を使います。別の空directoryへ新checkoutを作り、同じstateを引き継いで
配線を切り替えます。移行後の更新コマンドはすべて`zerochan update`です。

## 旧PCを止めて移行する場合だけ

1. 旧PCで`zerokun-jobs status`を確認し、running／queued jobがない状態にする。
2. 旧PCで`touch "${ZEROKUN_STATE_DIR:-$HOME/.codex/zerokun}/watchdog-off"`を実行する。
3. 旧PCで`zerochan stop`を実行し、`zerokun-status`が停止中になったことを確認する。
4. `xapp-`と`xoxb-`の2値だけをpassword manager等の安全な経路で新PCへ移す。
5. 新PCで基本bootstrap後に`bash zerokun/interactive-bootstrap.sh --slack-only`を実行し、
   開いた可視Terminalで2値を
   表示されないpromptへ入力する。
6. 新PCでproject/channel設定、起動、Slack実応答確認まで完了してから依頼を再開する。

`jobs.sqlite3`、lock、監視tab、inbox/outboxはコピーしません。旧PCを再び起動する場合は、先に
新PCを停止するか、そのPC用の別Slack Appへ切り替えてください。

## 中断・再実行

### クラウド引き継ぎを追加する場合（リリース前検証中）

通常セットアップに加え、[クラウド引き継ぎの設定](docs/cloud-handoff.md) が必要です。
各PCは別のSlack App・別のSupabase Authユーザーで接続します。
`zerochan cloud login` は端末で認証し、`zerochan cloud activate` は管理者による所属登録を確認して有効化します。
管理者キーや別PCのセッションは流用しません。所属するSlack team・Bot user IDを確認してから有効化してください。

- bootstrapは再実行可能で、既存の安全な`.env`やaccess設定を無条件に上書きしません。
- Slack Appを作成済みでtoken入力前に中断した場合は、同じcommandを再実行してSlack設定から続けます。
- `xapp-`と`xoxb-`が別Appのものなら保存せず停止します。同じAppからコピーし直します。
- workspace管理者の承認が必要なら、その承認後に同じcommandを再実行します。
- gateway log tabだけ作り直す場合は`zerochan stop` → 対象projectで`zerochan start`です。
- 導入状態だけを読み取り確認する場合は`bash zerokun/bootstrap-macos.sh --doctor`を使います。

## 完了条件

Codexは次をすべて観測してからセットアップ完了と報告します。

- bootstrapがexit 0で終了した
- Codex／Grok／Claude Code／GitHub CLIの必要なloginが利用可能だった
- `xapp-`と`xoxb-`が同じSlack Appとして検証され、owner-only stateへ保存された
- Appが利用channelへ招待され、project/channel紐付けが表示できた
- 自動作成または既存のHerdr workspace内でgatewayとrunnerが稼働した
- Slackの実メンションまたはDMにZeroちゃんが返信した

外部認証やworkspace権限がない場合は、その物理的な未完了点だけを明示し、セットアップ完了とは報告しません。
