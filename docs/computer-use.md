# ジョブに画面操作（Computer Use / CUA）をさせる

書き込み許可ジョブの実装ステージでは、codex の Computer Use（`mcp__cua_repl.js`）でデスクトップアプリを直接操作できる。実機E2E（アプリの画面確認・録音操作など）をジョブ自身に完結させるための機能で、レビュー段・advisor・updater では従来どおり無効。

## 動くまでに必要な4条件（どれか欠けると症状の異なるブロックになる）

| # | 条件 | 欠けたときの症状 | 対応 |
|---|---|---|---|
| 1 | zero-codex がゲートを開けている（`features.computer_use` を実装ステージで true にする版。2026-09-18 の fix/computer-use-write-stage 以降） | ジョブが「このセッションにデスクトップ用Computer Useが公開されていない」と報告 | zero-codex を当該版以降へ更新 |
| 2 | CUA の実体＝ChatGPT.app 同梱の openai-bundled プラグインが有効（同版で `features.plugins` も同ゲート化・exec 経路は `--ignore-user-config` を外す） | 同上（ツール一覧に `mcp__cua_repl.js` が無い） | そのMacに ChatGPT.app（Codex desktop）が入っていること。`~/.codex/config.toml` の `[plugins."computer-use@openai-bundled"] enabled = true` を確認 |
| 3 | sandbox が CUA ランタイムの読み取りを許可（同版で `/System/Library/OpenSSL`・`/Applications/ChatGPT.app`・`~/.codex/computer-use`・`~/.codex/plugins` を read 再許可） | `node_repl kernel exited unexpectedly` + `OpenSSL configuration error ... Operation not permitted` | zero-codex を当該版以降へ更新 |
| 4 | 対象アプリの**永続承認**（下記。Macごと・アプリごとに1回） | `Computer Use was not approved to use <アプリ名>` | 下の手順で「Always allow」を取る |

## 条件4: アプリ承認を永続化する（Macごとに1回）

「Allow Computer Use to use "<アプリ>"?」の承認は**設定ファイルでは回避できない**（`computer_use.default_app_access` や `computer_use.macos.bundle_ids` を allow にしても対話承認は要求される）。headless ジョブは `approval_policy="never"` のため自動拒否になる。**一度だけ対話セッションで「Always allow」を選ぶと永続化**され、以後 headless でも自動通過する。

手順（対話 codex を開ける環境ならどこでもよい。herdr 経由の例）:

```bash
herdr tab create --workspace w2 --cwd <作業dir> --label cua-approve --no-focus
herdr agent start cua-approver --kind codex --pane <上で出た pane_id>
herdr agent prompt cua-approver "mcp__cua_repl.js を1回だけ呼んでください。code: var b = await cua.getApp('<bundle id>'); String(b ? 'APP_OK' : 'APP_NULL'); 他の操作は一切しないでください。"
# 「Allow Computer Use to use ...?」が出たら
herdr agent send-keys cua-approver "3"      # 3 = Always allow
herdr agent send-keys cua-approver "Enter"
```

確認（headless で通るか）:

```bash
printf 'Call mcp__cua_repl.js once with code: var b = await cua.getApp("<bundle id>"); String(b ? "APP_OK" : "APP_NULL"); Report the result. Do nothing else.' | codex \
  -c features.computer_use=true -c features.plugins=true \
  -c 'approval_policy="never"' \
  exec --ignore-rules --skip-git-repo-check --json -
```

結果にアプリの UI ツリーが返れば成立。`not approved` が返るなら承認が永続化されていない（「Allow」や「Allow for this session」を選ぶと次回また要求されるので、必ず **Always allow**）。

## プロジェクト固有の読み取りパス（E2E素材・アプリのログ等）

CUA での実機E2Eは、対象アプリのログや QA 素材など**プロジェクト固有のパス**を読む必要がある。project リポジトリ直下に `.zerokun/computer-use-read-paths`（1行1パス、`#` コメント可、`~/` 展開あり）を置くと、computer_use 許可ジョブに限りそのパスを read で許可する。

```
# 例（BellSalesAI）
~/Library/Application Support/BellSalesAI-QA/sales-roleplay-20260916
~/Library/Application Support/com.meeting-app.meeting-app/logs
```

安全のため許可域は `/Applications` と `~/Library/Application Support` 配下に限定している（repo はジョブ自身が書けるため、HOME 直下の資格情報等へは広げない）。範囲外・存在しないパスは黙って無視する。

このほか computer_use 許可時は、CUAService がスクリーンショットを書き出すユーザーtempの `com.openai.sky.CUAService` ディレクトリ（write）と `/Applications`（read）を自動で許可する。

## 音声再生（afplay はsandbox内で必ず失敗する）

codex のカスタム権限サンドボックスは CoreAudio を封じるため、ジョブ内の `afplay` は `AudioQueueStart failed (-1)`（SIGABRT）で落ちる。computer_use 許可ジョブでは、ランナーが**音声ブリッジ**を起動して再生を肩代わりする。

ジョブ側の使い方（file protocol）:

1. 再生したい WAV を**自分の scratch か artifact 配下**に置く
2. `$TMPDIR/zerokun-audio/request-<英数nonce>.json` へ `{"wav": "<WAVの絶対パス>"}` を書く（`$TMPDIR` はジョブの scratch）
3. `$TMPDIR/zerokun-audio/result-<nonce>.json` を待つ。成功なら `{"startedAtMs","endedAtMs","exitCode"}`、失敗なら `{"error"}`。`startedAtMs`/`endedAtMs` はランナーの実時刻で、再生窓の照合に使える

範囲外のパス・symlink 持ち出し・64MB 超は `error` になる。再生は直列（同時要求は順番待ち）。

## 設計メモ

- ゲート条件は `executionWriteEnabled && browserAccessEnabled`。ブラウザ操作許可と同じ「書き込みジョブの実装ステージのみ」で、レビュー段（read-only）には出さない。
- sandbox の HOME deny は維持したまま、CUA が読む固定パスだけを read 再許可している。
- 音声の録音承認（`Computer Use was not approved to record computer audio`）は別の承認で、こちらは session 永続のみ。録音を伴う操作は現状ブロックされ得る（必要になったら別途設計）。
