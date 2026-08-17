# 新しいMacへゼロくんを入れる手順

## 結論

旧Macから`bootstrap-macos.sh`を1ファイルだけAirDropし、新Macのターミナルで実行する。

```bash
bash ~/Downloads/bootstrap-macos.sh
```

これで次を自動実行する。

- Apple Command Line Toolsの確認と導入
- Homebrewの導入
- GitHub CLI、tmux、Bun、Claude Code、Codex CLIの導入
- GitHub、Claude、Codexのログイン画面の起動
- `zero`は`main`、`skills`と3つの実装リポは`develop`でclone
- SQLite直列queue、Skill、MCP、起動コマンドの配線
- Chrome、Muxy、VS Code等のアプリと開発依存関係の導入
- TypeScript buildとmeeting-appのRustチェック

ここまで完了した時点でClaude CodeとCodexを利用できる。Slack設定は標準では実行せず、最後に必要なときだけ行う。

## Command Line Toolsのバージョン

**バージョンは選ばない。** `xcode-select --install`が、そのMacのmacOSに対応する版をAppleから導入する。
ゼロくんにフル版Xcodeは不要。ターミナルからの導入では、通常Apple Accountへのログインも不要。

導入済み版は次で確認できる。

```bash
pkgutil --pkg-info=com.apple.pkg.CLTools_Executables
```

ゼロくんに必要なツールをまとめて確認するときは次を使う。これは何も変更しない。

```bash
bash zerokun/bootstrap-macos.sh --doctor
```

## 人が行う操作

スクリプトが順番に画面を開く。次だけは自動化しない。

1. macOSが表示するCommand Line Toolsのインストール確認
2. Homebrewが求めるMacの管理者パスワード
3. GitHub、Claude、Codexのブラウザログイン
4. Linear、Supabase等のブラウザログイン

Slack App作成は基本セットアップ完了後に、必要なときだけ次で行う。

```bash
bash "$HOME/Desktop/Project/claude-channel-slack/zerokun/bootstrap-macos.sh" --slack-only
```

Slackトークンは画面に表示せず、形式が違えば終了せず再入力を求める。正しい値は
`~/.claude/channels/slack/.env`へ権限600で保存される。

Slack App作成前に、スクリプトがAppの表示名を聞く。既存の「ゼロくん」と区別できる
`ゼロくん-新Mac`などを入力する。続くbot usernameはSlackの制約により日本語を使えないため、
`zerokun-new-mac`のように英小文字・数字・`-`・`_`・`.`だけで指定する。
入力した名前を反映したmanifestがクリップボードへコピーされ、作成URLもターミナルへ表示される。

## 初回起動

Slack Appを対象チャンネルへ招待し、新しいターミナルで実行する。

```bash
zerokun
```

Slackからゼロくんを更新するときは、「ゼロくん更新して」と送る。

## 再実行とオプション

bootstrapは再実行可能。設定済みトークンは上書きせず、dirty worktreeも自動更新しない。

```bash
# ログイン画面を開かない
bash zerokun/bootstrap-macos.sh --skip-logins

# 基本セットアップ後に続けてSlackも設定する（標準では実行しない）
bash zerokun/bootstrap-macos.sh --with-slack

# 後からSlack設定だけ再開する
bash zerokun/bootstrap-macos.sh --slack-only

# Slack App名を先に指定する
bash zerokun/bootstrap-macos.sh --slack-only --slack-app-name 'ゼロくん-新Mac' --slack-bot-name zerokun-new-mac

# BellSalesAIの各リポをcloneしない
bash zerokun/bootstrap-macos.sh --skip-projects
```

`zero`はprivateリポのため、まっさらなMacでは旧MacからbootstrapファイルをAirDropするのが最短。
GitHub Desktop等で先に`zero`をclone済みなら、リポ内の`zerokun/bootstrap-macos.sh`をそのまま実行する。
