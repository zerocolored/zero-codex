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

## 「一言でセットアップ」の範囲

Codexが技術的な選択、commandの順序、再実行、検証を引き受けます。完全無人という意味ではありません。
セットアップ後の各Slack依頼も、Zeroちゃんが準備・実装・review・公開へ分割せず、1つのprimary Codex
workflowとして実行します。Codexは対象projectの`AGENTS.md`に従い、依頼に含まれるGitHub操作や
deploy確認まで自分で進めます。ZeroちゃんはFIFO、同一thread継続、process回収、認証情報を隠した
GitHub transportだけを担当します。

次の外部認証だけは、画面を見ているユーザー本人の操作が必要です。

1. macOSのCommand Line Toolsなどのinstall dialog
2. Codex、Grok CLI、Claude Code、GitHub CLIの初回login
3. Slack workspaceの選択、App作成・installの承認、MFA／CAPTCHA／管理者承認
4. Codexが開く可視Terminalで、`xapp-`と`xoxb-`を内容が表示されないpromptへ直接貼る操作
5. 対象projectやSlack channelが依頼から分からない場合の、その場所またはIDの指定

Codexへtokenをchatで送らないでください。tokenはbootstrapの端末入力から
`~/.codex/zerokun/.env`へmode 0600で保存され、2つが同じSlack Appのものか検証されます。

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
**別の可視Terminal**で実行します。Codexのtool用PTYはtoken入力先にしません。

```bash
bash zerokun/bootstrap-macos.sh --doctor
bash zerokun/interactive-bootstrap.sh \
  --with-slack --repo-dir "$(pwd -P)"
```

launcherは可視Terminalを開き、そこでbootstrapを動かし、完了receiptを元のCodexへ返します。
ユーザーはinstall／login／Slack承認／masked token入力だけをそのwindowで行い、通常のcommand順序や
再実行はCodexへ任せます。

対象projectが既に決まっている場合は、その絶対pathも渡せます。単一Git repositoryだけでなく、
直下に複数repositoryを置いた親folderも指定できます。

```bash
bash zerokun/interactive-bootstrap.sh \
  --with-slack \
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

ZeroちゃんはAPI key認証を代用せず、login画面や秘密を勝手に操作しません。login後、Codexは
同じ`interactive-bootstrap.sh --with-slack ...`を再実行します。既存の安全な設定は上書きされません。

### 2. このMac専用のSlack Appを作る

別PCと同時稼働する通常の新規セットアップでは、bootstrapが表示名を確認し、選んだ名前を反映した
manifestを`~/.codex/zerokun/slack-app-manifest.generated.yaml`へ生成します。manifestは
クリップボードへコピーされ、SlackのApp作成画面が開きます。

Slack画面では次の順に進めます。

1. **Create New App** → **From a manifest** を選ぶ。
2. 利用するworkspaceを選び、生成済みYAML manifestを貼る。
3. 内容を確認して **Next** → **Create** を実行する。
4. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** を開く。
5. token名を付け、scopeに`connections:write`を追加して生成し、`xapp-...`を控える。
6. **OAuth & Permissions** → **Install to Workspace** を実行して許可する。
7. **Bot User OAuth Token**の`xoxb-...`を控える。
8. bootstrap端末へ戻り、表示されないpromptへ`xapp-...`、次に`xoxb-...`を直接貼る。

同梱manifestにはSocket Mode、必要なbot event、bot scopeが入っています。手作業でscopeを
足し引きしません。bootstrapはtokenの形式だけでなく、2つが同じAppに属することもSlackへ照合し、
一致した場合だけ保存します。

表示名を事前指定する場合は、例えば次のようにします。bot usernameは英小文字、数字、`-`、`_`、`.`だけです。

```bash
bash zerokun/interactive-bootstrap.sh \
  --with-slack \
  --repo-dir "$(pwd -P)" \
  --slack-app-name "ベルミちゃん" \
  --slack-bot-name bellmi
```

### 3. Appをchannelへ招待し、projectを紐付ける

Slackで利用したいchannelへ、今作ったAppを招待します。private channelも明示的な招待が必要です。
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

起動・停止・更新・権限のコマンド一覧は `zero help` で表示できます（`zerochan help` も同じ）。
bun・state・Slack資格情報に依存しないので、runtimeが壊れている時でも読めます。

最後にSlackでAppをメンションし、同じthreadへ実際に返信が来ることを確認します。

```text
@作成したApp 接続確認です。現在の対象project名だけ答えてください。
```

DMを使う場合は、最初に返るpairing codeを端末で承認します。

```bash
zerochan-access pair <表示されたcode>
```

repositoryの変更も許可する利用者だけ、別途write権限を付けます。

```bash
zerochan-access write allow <Slack user ID>
```

## 更新する

通常の更新は、対象projectまたはZeroちゃん本体のdirectoryから次の1コマンドで行います。

```bash
zerochan update
```

`origin/main`の候補版を検証し、fast-forward、setup、gateway／runnerの再起動まで自動で行います。
正常終了後に`zerochan stop`／`zerochan start`を追加実行する必要はありません。逆に、stop／startだけでは
checkoutの版は変わらないため、更新の代わりにはなりません。

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
