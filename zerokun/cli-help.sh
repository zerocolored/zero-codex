#!/usr/bin/env bash
# Help deliberately needs neither Bun, credentials, nor a running service.
zerochan_help() {
  case "${1:-}" in
    ''|help)
      printf '%s\n' \
        '使い方: zerochan <command>' \
        '' \
        '初回設定（対象プロジェクトのフォルダで実行）:' \
        '  zerochan set slack-app                 Slackアプリを登録・選択' \
        '  zerochan set slack-channel C0123456789 チャンネルを紐付け' \
        '  zerochan start                         起動' \
        '' \
        '日常の操作:' \
        '  zerochan                  従来起動・互換gatewayへ接続（置換時は端末で確認）' \
        '  zerochan status           接続先アプリ・チャンネルを確認' \
        '  zerokun-status            gateway・処理担当の稼働状態を確認' \
        '  zerochan stop             作業中でなければ停止' \
        '  zerochan stop --force     実行中の作業も中断して停止' \
        '  zerochan --restart        再起動' \
        '  zerochan update           更新・検証・再起動' \
        '  zerochan update --recover-only  中断された更新の復旧だけを実行' \
        '  zerochan auto-update on|off|status  自動更新の設定・確認' \
        '  zerochan unset slack-app      現在projectのアプリ・チャンネル紐付けを解除' \
        '  zerochan unset slack-channel  チャンネル紐付けを解除' \
        '  zerochan cloud login|activate|status  クラウド引き継ぎ設定' \
        '  zerochan fleet identity   このPCの監視用IDを表示' \
        '  zerochan fleet status     稼働状況ページへの送信設定を確認' \
        '  zerochan fleet off        稼働状況の送信を無効化' \
        '  zerochan fleet register <instance-id> <auth-app-id>  管理者用の旧方式登録' \
        '' \
        'セキュリティ検査の設定（対象プロジェクトのフォルダで実行）:' \
        '  zerochan security status                     検査設定を確認' \
        '  zerochan security target <URL>               検査対象URLを設定' \
        '  zerochan security active on|off              能動的な検査の有効・無効' \
        '  zerochan security auth required|none         対象の認証要否を設定' \
        '  zerochan security e2e-port <PORT>             ローカルE2E用ポートを設定' \
        '  zerochan security auth-probe <PATH> <LOGGED_IN_PATTERN>  ログイン確認条件を設定' \
        '  zerochan security socket-org <ORG>           Socketの組織を設定' \
        '  zerochan security socket-token               Socketトークンを非表示の対話入力で登録' \
        '  zerochan security codeql-license confirmed|off  CodeQL利用ライセンスの確認状態' \
        '  zerochan security image <IMAGE>              検査対象コンテナイメージを追加' \
        '' \
        'チャンネルは参加者全員が利用・書き込み可能です。個別登録は不要です。' \
        'DMの利用者設定（Slackアプリを紐付けたプロジェクトのフォルダで実行）:' \
        '  zerochan-access status                    許可設定を確認' \
        '  zerochan-access pair <code>               DMのペアリングを承認' \
        '  zerochan-access allow <user-id>           DMの許可リストへ追加' \
        '  zerochan-access deny <user-id>            DMの許可リストから削除' \
        '  zerochan-access write allow <user-id>     DMの書き込みを許可' \
        '  zerochan-access write deny <user-id>      DMの書き込み許可を解除' \
        '  zerochan-access policy pairing|allowlist|disabled  DMの受付方式を設定' \
        'DMの利用許可と書き込み許可は別です。これらの設定はチャンネルの参加者には適用されません。' \
        '設定は紐付いたSlackアプリ単位で、同じアプリを使う他のプロジェクトにも適用されます。' \
        '' \
        '関連する運用・互換コマンド:' \
        '  zerokun-jobs status        ジョブ一覧を確認' \
        '  zerokun-jobs runtime-info  実行環境・処理中件数を確認' \
        '  zerokun-jobs gc            保存期間に従ってローカル履歴・成果物を整理' \
        '  zerokun                    互換の起動入口' \
        '  codex-channel [project-directory]  起動プロジェクトを指定する互換入口' \
        '' \
        'ヘルプ:' \
        '  zerochan help [command]    コマンド一覧・詳細を表示' \
        '  zerochan --help / zerochan -h' \
        '  zerochan <command> --help / zerochan <command> -h' \
        '詳細: zerochan <command> --help' \
        'Slackアプリの登録は任意のフォルダで可能です。トークンを引数へ渡さないでください。'
      ;;
    start)
      printf '%s\n' '使い方: zerochan start' \
        '対象プロジェクトへ cd して実行します。紐付いたSlackアプリを管理起動します。' \
        'Herdr外では専用workspaceを作成します。互換gatewayが稼働中なら共有します。' \
        '初回: zerochan set slack-app → zerochan set slack-channel C0123456789 → zerochan start' \
        '停止: zerochan stop（作業を中断する場合のみ zerochan stop --force）'
      ;;
    stop)
      printf '%s\n' '使い方: zerochan stop [--force]' \
        '現在のプロジェクトに紐付いたSlackアプリを停止します。' \
        '通常の stop は実行中の作業がある場合、停止せず案内します。' \
        'zerochan stop --force は実行中の作業も中断します。未完了の変更は残る場合があります。' \
        '再開: zerochan start'
      ;;
    status)
      printf '%s\n' '使い方: zerochan status' \
        '対象プロジェクトのSlackアプリ・チャンネル紐付けとgateway状態を確認します。' \
        '紐付け: zerochan set slack-channel C0123456789' \
        '解除: zerochan unset slack-channel'
      ;;
    auto-update)
      printf '%s\n' '使い方: zerochan auto-update on|off|status' \
        '既定は有効。起動中に30分ごとに確認し、各アプリの作業完了を待って個別に更新・再起動します。' \
        'このMacの全Slackアプリに共通の設定です。変更は再起動不要です。' \
        'offは新しい自動更新を止めます。既に開始した更新は中断しません。' \
        '結果はDM許可リストの先頭の有効なユーザーへ通知します。宛先なし・DM失敗時は送信を省略し、チャンネルへは送信しません。'
      ;;
    update)
      printf '%s\n' '使い方: zerochan update [--recover-only]' \
        '最新mainを実行用releaseへ取得し、検証して稼働環境へ反映します。開発用cloneはpullしません。' \
        '実行中の作業がある場合は終了を待ちます。待機期限を超えた場合は更新しません。' \
        '登録済みアプリはそれぞれの作業完了を待って個別に更新し、起動中だったアプリだけ再起動します。' \
        '中断された更新の復旧だけを行う場合: zerochan update --recover-only' \
        '通常の起動・停止だけではソースの更新は行いません。'
      ;;
    --restart)
      printf '%s\n' '使い方: zerochan --restart' \
        '選択中のSlackアプリを保存済みの起動プロジェクトで再起動します。' \
        'ソース更新には zerochan update を使ってください。'
      ;;
    set)
      printf '%s\n' '使い方: zerochan set slack-app' \
        'Slackアプリを対話形式で登録、または登録済みアプリから選択します。' \
        '登録は任意のフォルダで可能です。プロジェクト内で選択すると、そのプロジェクトへ紐付きます。' \
        '別のアプリを選ぶと既存チャンネル設定を引き継いで接続先を変更します。旧アプリの履歴・作業は保持します。' \
        'トークンは非表示の端末入力で登録します。引数やチャットへ貼らないでください。' \
        '' '使い方: zerochan set slack-channel C0123456789' \
        '対象プロジェクトへ cd して、SlackのチャンネルID（名前ではありません）を指定します。' \
        '確認: zerochan status / 起動: zerochan start'
      ;;
    unset)
      printf '%s\n' '使い方: zerochan unset slack-app' \
        '現在のプロジェクトのアプリ・チャンネル紐付けを解除し、新規依頼（既存スレッド・DMを含む）の受付を停止します。' \
        '受付済み作業・結果通知・停止操作、アプリ登録・トークン・履歴、他のプロジェクトは保持します。' \
        '再接続: zerochan set slack-app → zerochan set slack-channel <channel-id>。解除中の投稿は実行しません。' \
        '' '使い方: zerochan unset slack-channel' \
        '現在のプロジェクトのチャンネル紐付けをすべて解除します。チャンネルIDは付けません。アプリの登録情報は削除しません。' \
        '確認: zerochan status'
      ;;
    fleet)
      printf '%s\n' '使い方: zerochan fleet identity|status|off|register <instance-id> <auth-app-id>' \
        'identity: このPCの監視用IDを表示。PC名やフルパスは送信しません。' \
        'register: 管理者が発行したinstance IDと、このPCの認証済みアプリIDを登録。' \
        'status: 対象プロジェクトの送信設定を確認。off: 送信を無効化。' \
        '通常は起動時に自動登録します。アプリごとのinstance ID発行・registerは不要です。' \
        '通常の自動登録は登録済みSlackアプリ認証を使うため、cloud loginは不要です。' \
        '管理者用の旧方式registerは既存のcloud login設定を使います。引き継ぎの有効・無効は変更しません。' \
        '管理者向けの初回設定は docs/fleet-dashboard.md を参照してください。'
      ;;
    security)
      printf '%s\n' '使い方: zerochan security <command>' \
        '対象プロジェクトの検査設定を保存します。このコマンド自体は検査を実行しません。' \
        '  status                          設定とSocket認証情報の登録有無を表示' \
        '  target <URL>                    対象URLを設定し、activeをoffへ戻す' \
        '  active on|off                   能動的な検査の有効・無効（先にtargetが必要）' \
        '  auth required|none              対象の認証要否を設定' \
        '  e2e-port <PORT>                 ローカルE2E用ポートを設定' \
        '  auth-probe <PATH> <LOGGED_IN_PATTERN>  ログイン確認用pathと判定patternを設定' \
        '  socket-org <ORG>                Socketの組織を設定' \
        '  socket-token                    トークンを非表示の対話入力で登録。引数へ渡さない' \
        '  codeql-license confirmed|off    CodeQL利用ライセンスの確認状態を設定' \
        '  image <IMAGE>                   対象コンテナイメージを追加（既存一覧は保持）' \
        '空白を含むPATHやLOGGED_IN_PATTERNは引用符で囲んでください。'
      ;;
    cloud)
      printf '%s\n' '使い方: zerochan cloud login|activate|status' \
        'login: 対話端末でクラウド認証を登録します。この時点では引き継ぎは有効になりません。' \
        'activate: 管理者のbot登録を確認して設定を有効化します。その後 zerochan stop → zerochan start が必要です。' \
        'status: クラウド引き継ぎの設定状態を確認します。' \
        '通常のローカル起動だけなら、この設定は不要です。'
      ;;
    *) printf '不明なヘルプ項目です: %s\n' "$1" >&2; return 2 ;;
  esac
}
