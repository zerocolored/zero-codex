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
        '  zerochan unset slack-channel  チャンネル紐付けを解除' \
        '  zerochan cloud login|activate|status  クラウド引き継ぎ設定' \
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
