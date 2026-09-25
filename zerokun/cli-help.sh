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
        '  zerochan status           接続先アプリ・チャンネルを確認' \
        '  zerokun-status            gateway・処理担当の稼働状態を確認' \
        '  zerochan stop             作業中でなければ停止' \
        '  zerochan stop --force     実行中の作業も中断して停止' \
        '  zerochan --restart        再起動' \
        '  zerochan update           更新・検証・再起動' \
        '  zerochan auto-update on|off|status  自動更新の設定・確認' \
        '  zerochan unset slack-channel  チャンネル紐付けを解除' \
        '  zerochan cloud login|activate|status  クラウド引き継ぎ設定' \
        '  zerochan fleet status     稼働状況ページへの送信設定を確認' \
        '' \
        'チャンネルは参加者全員が利用・書き込み可能です。個別登録は不要です。' \
        'DMの利用者設定（Slackアプリを紐付けたプロジェクトのフォルダで実行）:' \
        '  zerochan-access status                    許可設定を確認' \
        '  zerochan-access pair <code>               DMのペアリングを承認' \
        '  zerochan-access allow <user-id>           DMの許可リストへ追加' \
        '  zerochan-access deny <user-id>            DMの許可リストから削除' \
        '  zerochan-access write allow <user-id>     DMの書き込みを許可' \
        '  zerochan-access write deny <user-id>      DMの書き込み許可を解除' \
        'DMの利用許可と書き込み許可は別です。これらの設定はチャンネルの参加者には適用されません。' \
        '設定は紐付いたSlackアプリ単位で、同じアプリを使う他のプロジェクトにも適用されます。' \
        '' \
        '詳細: zerochan <command> --help' \
        'Slackアプリの登録は任意のフォルダで可能です。トークンを引数へ渡さないでください。'
      ;;
    start)
      printf '%s\n' '使い方: zerochan start' \
        '対象プロジェクトへ cd して実行します。紐付いたSlackアプリで起動します。' \
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
        '対象プロジェクトのSlackチャンネル紐付けを確認します。' \
        '紐付け: zerochan set slack-channel C0123456789' \
        '解除: zerochan unset slack-channel'
      ;;
    auto-update)
      printf '%s\n' '使い方: zerochan auto-update on|off|status' \
        '既定は有効。起動中に30分ごとに確認し、全アプリの作業完了後に更新・再起動します。' \
        'このMacの全Slackアプリに共通の設定です。変更は再起動不要です。' \
        'offは新しい自動更新を止めます。既に開始した更新は中断しません。' \
        '結果だけを登録済みユーザー（いなければ設定済みチャンネル）へ通知します。'
      ;;
    update)
      printf '%s\n' '使い方: zerochan update [--recover-only]' \
        'ソース更新・検証・稼働環境への反映を行います。' \
        '実行中の作業がある場合は終了を待ちます。待機期限を超えた場合は更新しません。' \
        '同じソースを使う登録済みアプリをまとめて更新し、起動中だったアプリだけ再起動します。' \
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
      printf '%s\n' '使い方: zerochan unset slack-channel' \
        '現在のプロジェクトのチャンネル紐付けを解除します。アプリの登録情報は削除しません。' \
        '確認: zerochan status'
      ;;
    fleet)
      printf '%s\n' '使い方: zerochan fleet identity|status|off|register <instance-id> <auth-app-id>' \
        'identity: このPCの監視用IDを表示。PC名やフルパスは送信しません。' \
        'register: 管理者が発行したinstance IDと、このPCの認証済みアプリIDを登録。' \
        'status: 対象プロジェクトの送信設定を確認。off: 送信を無効化。' \
        '通常は起動時に自動登録します。アプリごとのinstance ID発行・registerは不要です。' \
        '認証は既存のcloud login設定を共有し、引き継ぎ機能を勝手に有効化しません。' \
        '各PCでクラウド認証を一度設定してください。別PCへ認証ファイルをコピーしないでください。' \
        '管理者向けの初回設定は docs/fleet-dashboard.md を参照してください。'
      ;;
    cloud)
      printf '%s\n' '使い方: zerochan cloud login|activate|status' \
        'login: クラウド引き継ぎ用の認証を設定します。' \
        'activate: クラウド引き継ぎを有効にします。' \
        'status: クラウド引き継ぎの設定状態を確認します。' \
        '通常のローカル起動だけなら、この設定は不要です。'
      ;;
    *) printf '不明なヘルプ項目です: %s\n' "$1" >&2; return 2 ;;
  esac
}
