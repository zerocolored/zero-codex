# 新しいMacへZeroちゃんを入れる

## 最短手順

まだ repository がない Mac では、`zero-codex` の `main` ブランチにある bootstrap を一度ファイルへ保存してから
実行します。

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

実行前に保存したスクリプトの内容を確認できます。既に `zero-codex` をclone済みなら、その repository で
`git switch main` を実行してから `bash zerokun/bootstrap-macos.sh --with-slack` を使います。

スクリプトが扱うもの:

- Apple Command Line Tools
- Homebrew
- Git / Bun / tmux / Herdr 0.8.2以上（必要なworkspace/tab/pane/agent APIを含む） / Codex CLI 0.149.0以上
- Codex / Grok CLI / Claude Code（Zeroちゃん自身はlogin操作をしない）
- zero-codex repository の `main` branch（既定 `~/Desktop/Project/zero-codex`）
- Zeroちゃん本体とは分離し、最小安全指示の`AGENTS.md`を初期commitした既定
  `zerokun-workspace` repository（`AGENTS.md`のある既存projectも指定可能）
- Zeroちゃん runtime、管理 CLI、watchdog
- Slack manifest の生成、token 入力、access 初期設定

専用Grok reviewerとClaude Code第五advisorは必須です。Claudeはあらかじめsubscription login済みにし、
Zeroちゃんは各round専用のfresh Herdr workspaceへ起動して、回答後にそのworkspaceだけを閉じます。
既存Claude paneは利用しません。read jobではinvestigation、write jobでは編集前designと編集後reviewの
必須5者とcleanup receiptが揃わない限り、Slackへ成功回答を公開しません。

## 人が操作する箇所

macOS や外部サービスの確認画面だけは自動化しません。

1. Command Line Tools の install dialog
2. Codex / Grok CLI / Claude Code のlogin
3. Slack App 作成・Workspace install
4. App-Level Token（`xapp-...`）と Bot Token（`xoxb-...`）の貼付け
5. Slack user/channel ID の選択

token は terminal 入力から state dir の `.env` へ mode 0600 で保存します。標準出力へ token を
表示しません。

## 段階的に行う

まず何も変更せず診断:

```bash
bash zerokun/bootstrap-macos.sh --doctor
```

基本導入だけ行い Slack を後回し:

```bash
bash zerokun/bootstrap-macos.sh --skip-slack
```

後から Slack 設定だけ再開:

```bash
bash zerokun/bootstrap-macos.sh --slack-only
```

bootstrapはログイン画面を自動操作しません。新しいMacでは最初の実行でCLIを導入し、未ログインなら
安全に停止します。そのあとHerdr上で次を実行し、同じbootstrap commandをもう一度実行してください。

```bash
codex login
grok login
# Herdrの一時paneで `claude` を起動し、subscription loginを完了して終了
codex login status
# `Logged in using ChatGPT` と表示されることを確認
```

これは初回だけの人による認証です。稼働中のZeroちゃんは既存のsubscription loginを利用し、API keyの
取得・Grok API/Codex APIの呼出し・追加認証を行いません。
Slack thread本文はCodexとread-only advisor（Grok 2件、round専用fresh Claude）へ送られます。
Grokは専用`grok -p` launcherのstdin、Claudeはowner-only prompt fileと検証済みhelperの
`send --owned`からHerdr local socket APIへ直接送ります。Claude workspaceはround後にexact closeします。
各provider側の履歴保持はlocal stateの30日GCやworkspace closeでは削除されないため、秘密・credential・
個人情報を依頼へ貼り付けないでください。

配置先を変える:

```bash
bash zerokun/bootstrap-macos.sh \
  --repo-dir "$HOME/src/zero" \
  --project-dir "$HOME/src/my-project" \
  --with-slack
```

その他:

```text
--slack-app-name NAME
--slack-bot-name NAME
```

bot username は Slack の制約により英小文字・数字・`-`・`_`・`.` だけです。

## 初回起動

bootstrap完了後、HerdrにZeroちゃん専用paneを用意して、そのpaneで起動します。

```bash
codex login status
# `Logged in using ChatGPT` 以外（API key認証を含む）ではZeroちゃんは起動しません
zerokun-access status
zerokun
```

別 terminal で確認:

```bash
zerokun-status
zerokun-jobs status
```

Slack で DM し、返された code を端末で承認します。

```bash
zerokun-access pair <6桁code>
```

認可後の依頼が実行段階へ入ると、同じHerdr workspaceに`Zeroちゃん #<待ち順>`という監視tabが
フォーカスを奪わず自動作成されます。このtabは実際の1本のCodex processの出力を表示するだけで、
別のCodexを起動しません。rate-limit待機中は残り、Codex・round専用advisor cleanup・結果確定が
すべて終わり、terminalへの最終出力が表示済みだと確認できると自動で閉じます。viewerのPID世代・
argv・cwd・heartbeatやtab identityが実行中に失われた場合は、実行を止めて後続queueを開始しません。
監視tabを誤って閉じると、最終出力の実表示を後から証明できないため、`zerokun`の再起動や
`zerokun-jobs recover-interrupted`でも自動failed化や監視tab再作成は行いません。
durable monitor obligationを保持して後続queueを停止します。監視tabは手動で閉じないでください。
Slack deliveryだけはFIFOと独立に再試行します。

変更依頼も許可する利用者だけ write access を追加します。

```bash
zerokun-access write allow <Slack user ID>
```

write access を付けない利用者は、HOME/stateをdenyして対象repositoryと当該添付だけを読む
job専用permission profileで調査・説明だけを利用できます。

Zeroちゃん本体repositoryへのwrite jobはhost runtime保護のため拒否されます。変更対象は必ず別の
`--project-dir`/`routes.json`へ割り当ててください。Codex shellはHOME credentialを継承しないため、
commit identityは対象repositoryのlocal configへ設定し、認証pushは別の安全なHOME外方式を用意します。

## 再実行

`setup.sh` と bootstrap はCodex state内の既存 `.env` / `access.json` を上書きしません。
別PCのClaude版は停止せず、そのSlack Appやtokenも流用しません。途中で停止した場合は
同じcommandを再実行できます。自己更新は次を使います。

```bash
zerokun-update
```

`origin/main` への fast-forward だけを行い、未コミット変更や未 push commit がある場合は
何も更新せず停止します。

## State path

新規環境の既定は次です。

```text
~/.codex/zerokun
```

旧版の`~/.claude/channels/slack`は存在しても自動選択しません。新しいMacでは
新しいSlack App、token、DB、access、routesをCodex stateへ作成します。別の場所を使う場合、
または同一PCでin-place cutoverする場合だけ、最初のsetupより前に明示します。

```bash
export ZEROKUN_LEGACY_CUTOVER=1
export ZEROKUN_STATE_DIR="$HOME/.claude/channels/slack"
```

setupはlaunchdにも同じ場所とcutoverフラグを設定します。別PC比較ではこの2つを使わず、既定の
`~/.codex/zerokun`を使ってください。
