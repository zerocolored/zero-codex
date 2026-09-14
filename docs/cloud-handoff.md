# PC間のクラウド引き継ぎ

SQLiteは各PCに残し、Supabase PostgreSQLでスレッドの担当を、非公開Storageで作業の保存データを共有します。通常の `zerochan update` だけでは有効になりません。

## Slackでの使い方

1. 利用上限を検出すると実行を停止し、作業を保存します。保存完了後に「利用上限のため待機中です。作業状態は保存しました。他のメンバーに引き継ぐ場合は、そのメンバーをメンションして『引き継いで』と言ってください」と通知します。
2. 同じスレッドで別PCのアプリへ `@担当アプリ 引き継いで` と返信すると、そのアプリが続行します。表示名は任意です。
3. 引き継がず待つ場合は、上限解除後に元のアプリへ `@担当アプリ 続けて` と返信します。時間が経過しただけでは自動再開しません。

宛先の自動選択やCodexアカウントの自動切り替えは行いません。共有チャンネルの同じスレッドを使い、双方のアプリを招待してください。アプリごとに別会話となるDM間の引き継ぎは対象外です。

## Supabaseの初回設定（管理者）

1. 専用プロジェクトのSQL Editorで `supabase/migrations/202609130001_cloud_handoff.sql` を一度適用します。共有テーブル4つ、RLS、担当移譲RPC、非公開 `zerochan-handoffs` bucketを作成します。
2. `zerochan_spaces` に共同作業用の行を1つ作成します。
3. Authenticationで各PC専用のAuthユーザーを作成します。各PCには異なるユーザーとSlack Appを割り当てます。
4. `zerochan_members` に次の所属を登録します。管理者のみが登録・無効化できます。

| 列 | 設定値 |
| --- | --- |
| `user_id` | PC専用AuthユーザーのUUID |
| `space_id` | 共同作業用spaceのUUID |
| `slack_team_id` | 実際のSlack workspace ID |
| `slack_bot_id` | PCのSlack Bot user ID（App IDではありません） |
| `enabled` | 有効なPCはtrue |

これはアクセス権の登録であり、引き継ぎのたびに宛先一覧を設定する仕組みではありません。共有するコード・添付資料を閲覧してよいPCだけを同じspaceへ登録してください。

## 各PCの設定

通常の [SETUP.md](../SETUP.md) に従い、専用Slack AppとCodexログインを準備した後、本人が操作できる端末で実行します。

```sh
zerochan cloud login
zerochan cloud activate
zerochan stop
zerochan start
zerochan cloud status
```

`login` ではプロジェクトURL、**publishable key**、PC専用Authユーザーのメールアドレスとパスワードを入力します。パスワードは非表示で、最初は未有効の認証ファイルだけを保存します。所属登録後の `activate` で有効化します。管理者のsecret/service-role keyは使用できません。

認証情報はowner-onlyのローカルstateに保存され、モデルの作業場所やクラウド保存データには含めません。Slack、チャット、コマンド引数へパスワードやトークンを貼らないでください。他PCのSQLiteや認証ファイルをコピーしてはいけません。

## 保存内容と制約

- 実行場所は各PC内です。Supabaseは引き継ぎ情報の保存先であり、クラウド上で開発プロセスを実行するわけではありません。
- dotenvx用の `.env.keys` はクラウドへ送りません。専用クローンで不足している場合、新規・再開・引き継ぎ後の実行直前に、そのPCの対応するローカルリポジトリからowner-onlyで補完します。既存の作業側設定は上書きせず、Gitと引き継ぎ保存の対象外にします。他PCでも、そのPC側に必要な復号設定を準備してください。
- 復号が必要なコマンドは `dotenvx run --strict -- <command>` を使い、復号失敗のままAPI呼び出しへ進めません。`MISSING_PRIVATE_KEY` はローカル復号設定の問題であり、APIキー失効の根拠ではありません。ファイルの補完成功だけでキーの適合性やAPI認証成功を保証するものではありません。
- 最新の統合ブランチから作成したタスク専用クローンを使います。共有作業場所にあった他者の未コミット差分は取り込みません。
- native Codexセッションは実際の作業フォルダと紐づけてローカルに保存します。同じフォルダなら再開し、クラウド導入前のセッションや別PCからの引き継ぎなど、フォルダが異なる場合は保存済みスレッド履歴を添えて新規セッションを開始します。旧セッションの削除はしません。導入前の共有フォルダに残る未コミット変更は保持しますが、新しいクローンへの自動移植は行いません。
- 基点コミット、staged/unstaged差分、削除・バイナリ・未追跡ファイル、添付ファイル、依頼と可視Codex出力を保存します。Slackに出していない可視コメントも対象です。非公開の推論、認証ファイル、無制限の生ツールログは共有しません。
- 未pushコミットの**変更内容**は差分に含めますが、元のコミットグラフは再現しません。元HEADは出所として記録します。受け手は基点コミットをGitHub remoteから取得できる必要があります。
- パッケージ上限512 MiB、個別ファイル上限50 MiBです。symlinkや保護対象ファイル、検出した機密情報は黙って欠落させず、保存未完了として通知します。会話中の検出可能な認証情報は伏せます。任意の資料に機密情報がないことを完全保証する検査ではありません。
- 復元・検査後に担当を切り替えます。同時取得は1台だけが成功し、同じSlackイベントの再配信では二重起動しません。A→B→Aでも履歴を保持します。
- 公開、デプロイ、DB操作など実行済みの外部副作用は巻き戻しません。続行時に現状を確認し、無条件に同じ操作を再実行しないよう履歴へ明記します。

## 保存や準備に失敗した場合

一時的な接続障害は依頼・ローカル作業を保持して再試行します。機密情報やサイズなど修正が必要な場合は自動再試行を止めて通知します。対象を確認した後の「続けて」で保存を再試行します。**保存完了通知が出るまでは他PCから引き継げません。** 所有者や所属の不一致は接続待ちと偽らず通知します。

## 検証方法

```sh
bun test zerokun/cloud-handoff.test.ts zerokun/cloud-runtime.test.ts zerokun/handoff-package.test.ts zerokun/handoff-coordinator.test.ts zerokun/handoff-control.test.ts zerokun/cloud-setup.test.ts
bun test zerokun/codex-app-server-executor.test.ts -t 'cloud legacy session migration|cloud quota'
bun run typecheck
```

`supabase/tests/handoff.sql` は移譲、重複取得、古い所有者、他spaceからのアクセス、上限解除時刻を実DBで検証し、テストデータをrollbackします。

`supabase/tests/live-handoff.ts` は `TVALIDATION` に登録した異なる2ユーザーの認証ファイルを**パスだけ**で受け取り、実Supabase Auth/RLS/Storage/RPCと2つの独立ローカルworkerでA→B→Aを検証します。小さな合成データを検証spaceに残します。本番Slackや実データを使うテストではありません。

```sh
bun supabase/tests/live-handoff.ts /path/to/validation-a.json /path/to/validation-b.json
```

2026-09-13に実クラウド検証で `live-handoff-passed`、epoch 3を確認しました。実Slackの操作と別の物理PCでの確認は、この検証とは区別してください。
