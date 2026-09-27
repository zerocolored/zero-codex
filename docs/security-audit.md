# Slack セキュリティ検査

ゼロちゃん宛てに「セキュリティチェックして」と投稿すると、通常の開発セッションとは別の検査フローになります。既存の開発用 AGENTS.md を読み込まない専用 Codex がコードを評価し、ホストが検査ツールを順番に実行します。コード修正、依存更新、修復ループ、Git commit は行いません。

全工程が成功・指摘あり・検査不能・失敗・中断のいずれかになった後、`レポート_YYYY-MM-DD.md` とサマリーを元の Slack スレッドへ送ります。検査不能を「脆弱性なし」と扱いません。「上のレポートの内容を修正して」は通常の開発へ流れ、同じプロジェクト・スレッドの最新の完了レポート全文を渡します。別プロジェクトのレポートは渡しません。

## 実行順

1. 既存 Chrome Playwright E2E 実行と、コードに対するテスト網羅性レビュー
2. 必要なリファクタリングの指摘（変更なし）
3. ソースコードの脆弱性レビュー
4. プロンプトインジェクションのレビュー
5. 依存監査（npm / Bun / pip-audit）
6. Semgrep Community Edition（p/default、p/security-audit、p/secrets）
7. CodeQL（検出した対応言語の security-and-quality スイート）
8. Trivy **0.69.3 固定**（ファイル、依存、構成、秘密情報、ライセンス、設定済みイメージ）
9. Gitleaks（作業スナップショットと取得可能な Git 履歴、値は伏せる）
10. Socket.dev（対応する依存 manifest を送信し、scan 完了を待つ）
11. Docker OWASP ZAP（指定された URL の範囲）
12. 最終 Chrome Playwright E2E
13. 全工程を一つのレポートへ集約

専用ツール領域へ不足する CLI を導入します。CodeQL の利用条件、Socket の権限・利用枠、Docker の稼働、Chrome のログイン状態が満たされない工程は理由を記録します。商用版の機能や、全言語・全ルールの無条件実行を保証するものではありません。CodeQL のビルドに必要な toolchain、既存 E2E 設定がない場合も明示します。検査のために製品側のテストやソースを自動作成・修正しません。

## 対象プロジェクトの初回設定

対象フォルダで実行します。設定はその PC の選択中 Slack アプリの state と対象プロジェクトに保存されます。

```sh
zerochan security target https://example.com/app
zerochan security auth required
zerochan security auth-probe /app/account 'ログイン後だけに存在する文字列'
zerochan security e2e-port 3000
zerochan security socket-org YOUR_ORG
zerochan security socket-token
zerochan security codeql-license confirmed
zerochan security status
```

`socket-token` は端末で非表示入力します。トークンをコマンド引数、ソース、レポートへ書かないでください。CodeQL の確認設定は、対象リポジトリについて利用条件を満たす場合に行います。

ZAP は既定では passive baseline です。権限のある対象へ active scan を行う場合は `zerochan security active on` と設定します。対象 URL を変更すると active 設定は解除されます。イメージは `zerochan security image IMAGE` で追加します。URL はホスト側のプロジェクト設定だけを使用します。Slack 本文や添付に含まれる URL で検査先を変更しません。

Chrome の対象 URL 用 cookie をホストが取得し、ホスト管理の認証確認処理と ZAP へメモリ内で渡します。LLM、プロジェクトの設定ファイルや既存 E2E コードへは渡しません。専用 Chrome 確認は設定された認証ページへの GET のみで、他 origin・WebSocket・GET/HEAD 以外のリクエストを遮断します。認証確認用ページで指定した文字列を含む応答が確認できなければ、認証領域を検査済みと表示しません。ZAP は自身の HTTP sender 経由の応答で認証を確認し、ホストからの確認だけで成功にしません。cookie 以外の独自認証、MFA、期限切れ、全ページの認証維持は自動的に成功したものと扱いません。

## 保存・再開・範囲

- 実行工程と結果は `security-audits/<job-id>/journal.json`、公開用レポートは既存 outbox に保存します。
- ホストの制御領域と分離したソースコピーでツールを実行し、元のチェックアウトを変更しません。秘密設定、生成物、symlink、巨大ファイル等の対象外一覧をレポートへ付けます。
- 再起動時に保存済みの結果を再利用します。実行途中だった工程は中断として扱い、副作用の成否が分からない検査を自動再送しません。
- Slack 添付は既存の成果物配信 checkpoint を使います。再配信で検査自体を再実行しません。
- コードレビューは全対象ファイルの分割評価です。ファイルをまたぐ意味解析の完全性を保証しません。
- E2E は既存設定を工程専用の隔離領域で実行し、`channel: chrome` を指定します。macOS では `e2e-port` で指定した localhost のテスト環境だけへの通信を許可し、実認証は渡しません。Linux の bubblewrap ではネットワークを分離するため、このローカル接続経路は未対応として記録します。スキップ、認証未確認、設定不足を明示します。

中止を依頼した場合は進行中の子プロセスを終了し、通常の中止通知を返します。途中までの工程記録は保存されますが、全工程の最終レポートとしては配信しません。

認証不要の公開アプリでは `zerochan security auth none` を指定できます。既定は `required` です。Chrome 認証を取得できない場合も、資格情報を渡さない既存 E2E と ZAP の公開領域検査は続行し、認証領域は未確認として報告します。

検査は既存のプロジェクトキューで順番に動きます。大きなプロジェクトの検査中は後続依頼を待たせます。完了後はソースコピー、工程別の生データ、一時ブラウザ領域を削除し、再配信に必要なレポートと工程記録を保持します。中断時の一時領域は再開時に扱います。検査後の開発依頼は新しい開発セッションで始まり、検証済みレポートを引き継ぎます。レポートが消失・改変されていた場合は内容を推測せず、必要な依頼だけ再添付を求めます。
