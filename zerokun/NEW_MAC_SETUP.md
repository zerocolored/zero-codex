# 新しい Mac へ Zero-kun for Codex を入れる

## 最短手順

まだ repository がない Mac では、`codex` ブランチの bootstrap を一度ファイルへ保存してから
実行します。

```bash
bootstrap_path="$(mktemp "${TMPDIR:-/tmp}/zerokun-bootstrap.XXXXXX")"
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/zerocolored/zero/codex/zerokun/bootstrap-macos.sh \
  --output "$bootstrap_path"
bash "$bootstrap_path" --with-slack
rm -f "$bootstrap_path"
```

実行前に保存したスクリプトの内容を確認できます。既に clone 済みなら、その repository で
`git switch codex` を実行してから `bash zerokun/bootstrap-macos.sh --with-slack` を使います。

スクリプトが扱うもの:

- Apple Command Line Tools
- Homebrew
- Git / Bun / tmux / Codex CLI 0.149.0以上
- Codex login
- zero repository の `codex` branch
- Zero-kun本体とは分離した既定`zerokun-workspace` repository（既存projectも指定可能）
- Zero-kun runtime、管理 CLI、watchdog
- Slack manifest の生成、token 入力、access 初期設定

Claude Code と Claude login は導入しません。

## 人が操作する箇所

macOS や外部サービスの確認画面だけは自動化しません。

1. Command Line Tools の install dialog
2. Codex CLI の browser login
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

ログイン画面を起動しない:

```bash
bash zerokun/bootstrap-macos.sh --skip-logins
```

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

bootstrap 完了後、新しい terminal を開きます。

```bash
codex login status
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

変更依頼も許可する利用者だけ write access を追加します。

```bash
zerokun-access write allow <Slack user ID>
```

write access を付けない利用者は、HOME/stateをdenyして対象repositoryと当該添付だけを読む
job専用permission profileで調査・説明だけを利用できます。

Zero-kun本体repositoryへのwrite jobはhost runtime保護のため拒否されます。変更対象は必ず別の
`--project-dir`/`routes.json`へ割り当ててください。Codex shellはHOME credentialを継承しないため、
commit identityは対象repositoryのlocal configへ設定し、認証pushは別の安全なHOME外方式を用意します。

## 再実行

`setup.sh` と bootstrap は既存の `.env` / `access.json` を上書きしません。Claude版からの
初回切替では旧runnerの新規claimを止め、実行中jobをdrainしてから停止し、待機jobをCodexへ
sessionなしで引き継ぎます。途中で停止した場合は
同じ command を再実行できます。自己更新は次を使います。

```bash
zerokun-update
```

`origin/codex` への fast-forward だけを行い、未コミット変更や未 push commit がある場合は
何も更新せず停止します。

## State path

新規環境の既定は次です。

```text
~/.codex/zerokun
```

旧版の`~/.claude/channels/slack`に`.env` / `access.json` / `jobs.sqlite3`のいずれかがある
設定済み環境では、token/access/queueを移行するため旧directoryを自動選択します。
空directoryは無視します。別の場所を使う場合は最初のsetupより前に設定します。

```bash
export ZEROKUN_STATE_DIR="$HOME/.codex/zerokun"
```

launchdからも同じ場所を参照できるようにする必要があります。自動選択されるpathのままなら
追加設定は不要です。
