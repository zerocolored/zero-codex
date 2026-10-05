# ジョブに画面操作（Computer Use / CUA）をさせる

## ブラウザの確認ダイアログで停止する場合

JavaScriptの確認ダイアログが開くと、クリックのCDP応答がタイムアウトすることがあります。
Zeroちゃんはジョブ用のブラウザruntimeで入力・ダイアログ応答時の接続を保持し、
同じタブの`getJsDialog()`から確認を処理できるようにします。インストール済みの配布物や
ネイティブの承認処理は変更しません。対応箇所が異なる新版は元の実装で動作します。

クリックのタイムアウトだけを理由に公開操作を繰り返さず、確認ダイアログと反映状態を先に調べます。
修正前の実行ですでに接続が失われたタブは、元のタブと未保存内容を保持し、同じURLの新しいタブで
保存済み内容・公開状態を確認してから続行します。Chrome全体の取得が拒否されたことを、
対象サイトの限定操作まで禁止されたという意味には読み替えません。

書き込み許可ジョブの実装ステージでは、Codex の標準 Computer Useでデスクトップアプリを直接操作できる。実機E2E（アプリの画面確認・録音操作など）をジョブ自身に完結させるための機能で、レビュー段・advisor・updater では従来どおり無効。

## 利用条件

| # | 条件 | 欠けたときの症状 | 対応 |
|---|---|---|---|
| 1 | zero-codex がゲートを開けている（`features.computer_use` を許可された実行段で true にする版） | ジョブが「このセッションにデスクトップ用Computer Useが公開されていない」と報告 | zero-codex を当該版以降へ更新 |
| 2 | CUA の実体＝ChatGPT.app 同梱の openai-bundled プラグインが有効（同版で `features.plugins` も同ゲート化・exec 経路は `--ignore-user-config` を外す） | 同上（Computer Useのツールが公開されない） | そのMacに ChatGPT.app（Codex desktop）が入っていること。公式の `codex plugin add computer-use@openai-bundled` で導入できる。`~/.codex/config.toml` の `[plugins."computer-use@openai-bundled"] enabled = true` を確認 |
| 3 | sandbox が CUA ランタイムの読み取りを許可（同版で `/System/Library/OpenSSL`・`/Applications/ChatGPT.app`・`~/.codex/computer-use`・Computer Use専用のplugin cacheを read 再許可） | `node_repl kernel exited unexpectedly` + `OpenSSL configuration error ... Operation not permitted` | zero-codex を当該版以降へ更新 |
| 4 | 公式のアプリ承認要求をZeroちゃんが処理できる | `Computer Use was not approved to use <アプリ名>` | アプリ承認対応版へ更新し、実際の要求と応答を確認する |

MCP接続自体を無効化している場合（`codex mcp get computer-use --json` の `enabled: false`）は、その設定も尊重する。プラグインのインストールだけでは接続の無効設定を上書きしない。

現行の公式プラグインは `node_repl` から `@oai/sky` を使う。Zerochanは、ChatGPT.appが導入した公式の `node_repl` 接続を、許可された主実行だけに引き継ぐ。実行ファイルだけでなく、導入済みのモジュール解決設定・接続情報・承認設定を保持する。プロジェクト側で追加・変更した接続や、利用者が無効化した接続は有効にしない。`computer-use` サーバーのツール一覧が取得できるだけでは、モデルによる画面操作の成功を意味しない。

## 条件4: 常時許可を公式の承認処理へ渡す

Zeroちゃんに依頼した作業で必要なアプリ操作は、運用者の「常に許可」という方針で実行します。
書き込みが許可された主実行では、公式Node接続のComputer Useアプリ承認要求へ
`action: "accept"`と`_meta: {persist: "always"}`を返します。
公式側が永続化を認めず`session`だけを提示した場合は、その範囲で許可します。
Slackでの再確認や、本人による公開ボタンの操作へ差し戻さず、同じ処理を続行します。
アプリ承認の保存は公式側が行います。承認ファイルやOSの権限データベースを直接書き換えません。

主実行は`approval_policy="on-request"`と`approvals_reviewer="auto_review"`を使用します。
アプリ承認はAuto-reviewとは別の`mcpServer/elicitation/request`として届きます。
従来はアップロード確認以外を一律`cancel`にしていたため、アプリ承認要求も取り消されていました。
接続や機能の有効化だけでは、この不具合は解消しません。

対象は、現在の主実行thread/turnに届いた、公式Computer Useのアプリ識別子を持つ空フォームです。
録音、ファイル送信、その他のフォーム入力をアプリ承認として扱いません。
組織のアプリ制限、OSの画面収録・アクセシビリティ権限、個々の操作へのネイティブ審査は引き続き適用されます。

確認には、実際のZeroちゃんの主実行で`@oai/sky`の`get_app_state`を使います。
新規承認要求への応答だけでなく、アプリ状態の取得成功と次の実行でも利用できることを確認します。
ツール一覧取得やテスト用App Serverの成功だけでは、実機で使えた証拠にはしません。

## 権限の範囲

書き込みが許可された実行段だけで有効にし、レビュー・advisor履歴・updaterでは無効にする。ジョブ内の設定ファイルからホストの読み取り範囲は変更できない。

本人がインストールして有効にしたComputer Useだけを利用し、無効化済みのpluginをジョブから有効化しない。他のpluginはこの機能のために有効化しない。

CUAの実行に必要なアプリ・plugin runtimeを許可する。既存のmacOS権限と組織ポリシーを維持し、公式のアプリ承認要求は上記の常時許可方針で処理する。ホスト音声再生ブリッジは提供しない。
