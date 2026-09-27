# ジョブに画面操作（Computer Use / CUA）をさせる

書き込み許可ジョブの実装ステージでは、Codex の標準 Computer Useでデスクトップアプリを直接操作できる。実機E2E（アプリの画面確認・録音操作など）をジョブ自身に完結させるための機能で、レビュー段・advisor・updater では従来どおり無効。

## 利用条件

| # | 条件 | 欠けたときの症状 | 対応 |
|---|---|---|---|
| 1 | zero-codex がゲートを開けている（`features.computer_use` を許可された実行段で true にする版） | ジョブが「このセッションにデスクトップ用Computer Useが公開されていない」と報告 | zero-codex を当該版以降へ更新 |
| 2 | CUA の実体＝ChatGPT.app 同梱の openai-bundled プラグインが有効（同版で `features.plugins` も同ゲート化・exec 経路は `--ignore-user-config` を外す） | 同上（Computer Useのツールが公開されない） | そのMacに ChatGPT.app（Codex desktop）が入っていること。公式の `codex plugin add computer-use@openai-bundled` で導入できる。`~/.codex/config.toml` の `[plugins."computer-use@openai-bundled"] enabled = true` を確認 |
| 3 | sandbox が CUA ランタイムの読み取りを許可（同版で `/System/Library/OpenSSL`・`/Applications/ChatGPT.app`・`~/.codex/computer-use`・Computer Use専用のplugin cacheを read 再許可） | `node_repl kernel exited unexpectedly` + `OpenSSL configuration error ... Operation not permitted` | zero-codex を当該版以降へ更新 |
| 4 | 対象アプリの**永続承認**（下記。Macごと・アプリごとに1回） | `Computer Use was not approved to use <アプリ名>` | 下の手順で「Always allow」を取る |

MCP接続自体を無効化している場合（`codex mcp get computer-use --json` の `enabled: false`）は、その設定も尊重する。プラグインのインストールだけでは接続の無効設定を上書きしない。

現行の公式プラグインは `node_repl` から `@oai/sky` を使う。Zerochanは、ChatGPT.appが導入した公式の `node_repl` 接続を、許可された主実行だけに引き継ぐ。実行ファイルだけでなく、導入済みのモジュール解決設定・接続情報・承認設定を保持する。プロジェクト側で追加・変更した接続や、利用者が無効化した接続は有効にしない。`computer-use` サーバーのツール一覧が取得できるだけでは、モデルによる画面操作の成功を意味しない。

## 条件4: アプリ承認を永続化する（Macごとに1回）

「Allow Computer Use to use "<アプリ>"?」の承認は**設定ファイルでは回避できない**（`computer_use.default_app_access` や `computer_use.macos.bundle_ids` を allow にしても対話承認は要求される）。headless ジョブは `approval_policy="never"` のため自動拒否になる。**一度だけ対話セッションで「Always allow」を選ぶと永続化**され、以後 headless でも自動通過する。

対話Codexで対象アプリを操作し、本人が表示されたアプリ名と権限内容を確認して承認する。自動で承認キーを送らない。

確認（headless で通るか）:

```bash
printf 'Read the installed computer-use skill. Use node_repl and the official @oai/sky package to get_app_state for <bundle id> once. Do not modify the app or access other apps. Report the actual approval or connection error if any.' | codex \
  -c features.computer_use=true -c features.plugins=true \
  -c 'approval_policy="never"' \
  exec --ignore-rules --skip-git-repo-check --json -
```

結果にアプリの UI ツリーが返れば成立。`not approved` が返るなら承認が永続化されていない（「Allow」や「Allow for this session」を選ぶと次回また要求されるので、必ず **Always allow**）。

## 権限の範囲

書き込みが許可された実行段だけで有効にし、レビュー・advisor履歴・updaterでは無効にする。ジョブ内の設定ファイルからホストの読み取り範囲は変更できない。

本人がインストールして有効にしたComputer Useだけを利用し、無効化済みのpluginをジョブから有効化しない。他のpluginはこの機能のために有効化しない。

CUAの実行に必要なアプリ・plugin runtimeを許可する。既存のmacOS権限やCodexのアプリ承認は維持し、未承認の場合は本人による承認が必要になる。ホスト音声再生ブリッジは提供しない。
