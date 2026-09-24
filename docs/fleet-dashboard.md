# 稼働状況ページ

承認済みの共通パスワード方式。Cloudflare Worker（静的画面＋読み取りAPI）と既存Supabaseを使う。閲覧ページから作業・停止・再起動は実行できない。

公開先: https://zerochan-fleet.s-hashimoto-dcd.workers.dev

## 表示の意味

- 30秒ごとに報告。サーバー受信から90秒経つと「状態不明」。PCスリープ・通信断も空きとは表示しない。
- Slack接続とrunnerの10秒ごとの生存報告（35秒以内）が必要。キュー・開始延期・更新待ちを空きから区別する。
- 別タスクの承認待ちだけなら、新規受付可能として表示できる。
- 最後の受付は新規依頼と続きの指示の受理時刻。heartbeatで更新しない。
- 要約は現在の実行試行で**実際にSlackへ配送済み**の短い進捗のみ。依頼全文・結果本文・ログ・添付は取得しない。資格情報・ローカルパスを検出した要約は送らず「要約更新待ち」にする。自然文の個人情報を完全検出する保証はないため、閲覧パスワードの共有範囲を限定する。
- 同じSlackアプリを別PCで同時起動すると、各PCを別行に残して重複稼働を表示する。名前で上書きしない。
- 送信・認証・Webの障害は監視だけへ影響し、ジョブ処理の停止条件にしない。

## 管理者の初回公開

1. 専用Supabaseプロジェクトへ `supabase/migrations/202609250001_fleet.sql` を適用する。既存の `zerochan_spaces` とAuth利用者を使用する。
2. `zerochan_fleet_viewers` に対象space、共通パスワードのbcrypt hash、Worker用のランダムgateway secretのSHA-256 hexを管理者権限で登録する。パスワードはUTF-8で72 bytes以内。推奨は十分長いランダムASCII。平文をSQL履歴・Git・チャットへ保存しない。gateway secretと閲覧パスワードは別の値。
3. `fleet-web/wrangler.jsonc` を基に、Cloudflareの変数 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`FLEET_SPACE_ID` を設定。管理/service-role keyを使わない。
4. `FLEET_GATEWAY_SECRET` は `wrangler secret put FLEET_GATEWAY_SECRET` の標準入力から登録。`bunx wrangler deploy --config fleet-web/wrangler.jsonc` で公開する。Workerのassets bindingがHTML/CSS/JSを配信し、APIはSupabase RPCへ接続する。
5. 未ログインの `/api/status` が401、ログイン後だけ一覧200、ログアウト後401であることを実ブラウザで検証する。

パスワード変更時は、管理者が同じtransactionでpassword_hashを更新し、そのspaceの `zerochan_fleet_sessions` を削除する。7日セッションを即失効できる。ログイン試行はIPのHMACごとに15分10回まで。生IPはDBへ保存しない。

## 各PC・アプリの登録

1. 対応版へ `zerochan update`。対象プロジェクトで `zerochan fleet identity` を実行し、このPCのランダムinstallation IDを取得する。PC名・OSユーザー名を識別子にしない。
2. このPCのいずれかのアプリで `zerochan cloud login` 済みなら、その認証を使える。未設定なら同コマンドでPC専用Authを設定する。監視だけなら `cloud activate` は不要。監視登録は引き継ぎ有効化を変更しない。
3. 管理者が `zerochan_fleet_instances` に `id`（新UUID）、`user_id`（認証の利用者）、`space_id`、`installation_id`、`app_id`、`team_id`、`name`（表示名）、`pc_label`（任意のPC表示名）を登録する。別PCでは別のinstallation/instance IDを使う。同じアプリでも上書きしない。
4. 対象プロジェクトで `zerochan fleet register <instance-id> <認証済みSlack-app-id>` を実行。認証元は同じPCの登録済みアプリだけを選べる。同じsessionファイルとrefresh lockを使い、refresh tokenを複製しない。
5. 作業終了後に再起動。`zerochan fleet status` で設定を確認。Webで最終通信が更新されることを確認する。登録のみ・未起動の行は「状態不明」のまま。

設定は各アプリのprivate state内 `fleet.json`。projectLabelは省略すると起動プロジェクトのbasename。必要な場合だけ任意の短い表示名を設定する。フルパスは送らない。installation IDのファイルはPCごとに作られるので他PCへコピーしない。

`zerochan fleet off` で送信設定を退避する。稼働中の送信停止は作業終了後の再起動で反映。DBの登録は消えず、90秒後に状態不明になる。完全に一覧から除外するときは管理者が該当instanceのenabledをfalseにする。

## 検証

```sh
bun test zerokun/fleet-status.test.ts zerokun/fleet-web.test.ts
bun run typecheck
bun fleet-web/dev.ts --demo
```

demoはlocalhost限定・架空データ・パスワードdemo。実機の稼働証拠ではない。本番公開には含めない。

SQL契約は**専用の空ローカルDBのみ**で実行する（bootstrapを本番へ適用しない）:

```sh
psql -d <専用テストDB> -v ON_ERROR_STOP=1 \
  -f supabase/tests/fleet-bootstrap.sql \
  -f supabase/migrations/202609250001_fleet.sql \
  -f supabase/tests/fleet.sql
```

匿名閲覧・閲覧者書込・別送信者なりすまし・送信順逆転・再起動前の送信を拒否し、ログイン／失効／試行制限を検証する。実機では送信中のアプリ、Slack切断、runner停止、Web通信断、スリープ復帰、複数PCを別途確認する。

## 2026-09-25の検証記録

- 対象テスト: `bun test zerokun/fleet-status.test.ts zerokun/fleet-web.test.ts` — 14件成功、62 assertions。実SQLiteの配送済み進捗投影、認証共有、状態・backoff、HTTP認証、redirect非追従、Supabaseの204ログアウト応答を含む。
- `bun run typecheck`、`bash -n codex-channel.sh zerokun/cli-help.sh`、`git diff --check` — exit 0。
- `bash zerokun/verify.sh` — exit 0、105 test files・2,035件成功・失敗0。型検査とentry buildも成功。
- 専用ローカルPostgreSQLで上記SQL契約を実行しexit 0。テストデータはtransaction rollback。
- 実Supabaseにmigrationと8アプリの登録を適用。認証付きbegin/report成功、同一sequenceの再送はfalse。接続不明の検証送信を「空き」に偽装していない。
- 実Cloudflare URLをChromeで操作。未認証401→パスワードログイン→8登録行→ログアウト200→未認証401。1280幅と390幅で横溢れなし、JavaScript error 0。
- 公開ログイン画面でTab／Shift+Tabによるパスワード欄と送信ボタンの移動を確認。
- 検証専用Slackアプリを通常の`zerochan start`で起動し、実gateway・runnerからのheartbeatが公開画面へ届き「すぐ着手可能」になることを確認。作業フォルダはbasenameのみ表示。本番アプリの実行中ジョブには触れていない。
- 同じアプリを`zerochan stop`で正常停止し、公開画面が90秒の鮮度期限で「状態不明」になることを実ブラウザで確認。検証用プロセスは停止し、一時登録はdisabledへ変更して一覧から除外した。
- syntheticブラウザ検証ではstale、別PC重複、HTMLの文字列表示、ネットワーク失敗、空一覧を確認。別の物理PCからの実送信とは区別する。
- 公開時、Worker runtimeがredirect:errorを拒否したためmanual＋非2xx拒否に修正。Supabase void RPCの204も明示的に扱う。どちらも回帰テストへ追加。
- 最終レビューround 1・差分round 2でGPT／Claudeの回答を取得。必須指摘（パス非送信、認証ファイルのactivate追従、handoff権限との分離、監視からscheduler停止確認を呼ばない）を修正。Grokは各roundで起動したが15分以上経っても最終回答がなく、owned processを終了し未取得として記録した。認証失敗とは判定していない。
- Claude専用workspaceは両roundともclose済み、protected snapshot不変、caller維持。並行workspace増減によるcatalog driftのみwarning。safe modeとprompt契約はOS sandboxによる完全な非変更保証ではない。

残る運用確認: 他の物理PCの登録・送信、実機スリープ復帰、稼働中プロセスへの更新反映。登録だけでは送信開始にならない。進行中の仕事や別のupdateを中断せず、更新後のheartbeatを確認する。
